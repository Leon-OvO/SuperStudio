import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUIStore, SKIN_IS_DARK } from './stores/ui'
import { useAuthStore } from './stores/auth'
import { useVibeStore } from './pages/Vibe/store'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatPage } from './pages/Chat'
import { StudioPage } from './pages/Studio'
import { GalleryPage } from './pages/Gallery'
import { MemoryPage } from './pages/Memory'
import { VibePage } from './pages/Vibe'
import { SkillsPage } from './pages/Skills'
import { SchedulerPage } from './pages/Scheduler'
import { SettingsPage } from './pages/Settings'
import { ShortcutsHelp } from './components/ui/ShortcutsHelp'
import { CommandPalette } from './components/ui/CommandPalette'
import { ToastHost, toast } from './components/ui/Toast'
import { useConfirmDialog } from './components/ui/ConfirmDialog'
import { DataDirectorySetup } from './components/DataDirectorySetup'
import { ChatModelSetup } from './components/ChatModelSetup'
import { UpdateNotifier } from './components/UpdateNotifier'
import { useScheduledNotifications } from './stores/scheduledNotifications'
import { BRAND } from '@shared/brand'
import { ACCOUNT_MODE } from '@shared/flavor'
import { getAccountUI } from './lib/account-ui'

type PageId = 'dashboard' | 'chat' | 'studio' | 'gallery' | 'memory' | 'vibe' | 'skills' | 'scheduler' | 'video' | 'settings'

export default function App() {
  const { currentPage, setPage, skin, setPendingWorkflowId } = useUIStore()
  const { isLoggedIn, isInitializing, restoreSession } = useAuthStore()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // null = still loading settings; true/false = whether the user has set
  // a custom data directory. We block the main UI until it's true so users
  // make a conscious storage choice on first run instead of silently writing
  // gigabytes of media into AppData.
  const [dataDirReady, setDataDirReady] = useState<boolean | null>(null)
  // Same pattern for the default chat model. Checked only after dataDirReady
  // is true, so the two gates render sequentially rather than fighting each
  // other. `true` means either the user has saved a default or they chose to
  // skip (in which case Chat/Vibe will surface the picker on demand).
  const [chatModelReady, setChatModelReady] = useState<boolean | null>(null)
  // Guard so the configured startupPage is applied at most once per session —
  // we don't want to yank the user back to the homepage every time settings
  // reload (e.g. on login/logout cycles), nor override a page that shell-open
  // already navigated to.
  const didApplyStartupPageRef = useRef(false)
  const cuConfirm = useConfirmDialog()

  useEffect(() => {
    restoreSession()
  }, [])

  // Computer Use arming: main asks here so the confirm uses the app's styled
  // dialog (not a native OS box). Reply with the user's choice.
  useEffect(() => {
    const off = window.api.onComputerUseConfirm?.(async (req) => {
      const ok = await cuConfirm.confirm({
        title: '允许 AI 操控你的电脑？',
        message: 'AI 即将开始操控你的鼠标、键盘和屏幕，能点击、输入到本机任意程序。仅在你信任当前任务时允许；操作期间屏幕顶部会有红色提示，按 Esc 可随时立即急停。',
        tone: 'danger',
        confirmLabel: '允许 AI 操控',
        cancelLabel: '取消',
      })
      window.api.respondComputerUseConfirm?.(req.id, ok)
    })
    return () => { off?.() }
  }, [cuConfirm])

  // SSH remote execution confirmation. cuConfirm shows ONE dialog at a time, so
  // concurrent requests (e.g. running on several servers at once) must be QUEUED —
  // otherwise later requests would overwrite the dialog and silently hang. We chain
  // them so every server gets its own prompt in turn.
  const sshConfirmQueue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    const off = window.api.onSshExecConfirm?.((req) => {
      sshConfirmQueue.current = sshConfirmQueue.current.then(async () => {
        const ok = await cuConfirm.confirm({
          title: '允许 Agent 在远程服务器执行命令？',
          message: `主机：${req.host}\n命令：${req.command}\n\n` + (req.write
            ? '⚠️ 这是会修改/删除的写操作，将在远程服务器真实执行。只读命令已自动放行，写操作需逐次确认。'
            : '将在远程服务器真实执行，仅在你信任该任务时允许。批准后本次运行内该连接的后续命令自动放行。'),
          tone: 'danger',
          confirmLabel: '允许执行',
          cancelLabel: '取消',
        })
        window.api.respondSshExecConfirm?.(req.id, ok)
      }).catch(() => { window.api.respondSshExecConfirm?.(req.id, false) })
    })
    return () => { off?.() }
  }, [cuConfirm])

  // Local script execution: runs without prompting by default. This confirm
  // dialog only fires when the user opts into localScriptsConfirmEachRun.
  useEffect(() => {
    const off = window.api.onLocalScriptConfirm?.(async (req) => {
      const ok = await cuConfirm.confirm({
        title: '允许 AI 在本机执行脚本 / 命令？',
        message: `命令：${req.command}\n目录：${req.cwd}\n\n这会在你的电脑上真实执行，仅在你信任该任务时允许。`,
        tone: 'danger',
        confirmLabel: '允许执行',
        cancelLabel: '取消',
      })
      window.api.respondLocalScriptConfirm?.(req.id, ok)
    })
    return () => { off?.() }
  }, [cuConfirm])

  // Long-term memory captured anywhere (chat archive / company delivery / manual)
  // → surface a single app-wide toast so "越用越聪明" is visible regardless of page.
  useEffect(() => {
    const off = window.api.onMemoryCaptured?.((info) => {
      if (info?.count > 0) toast.success(`🧠 已记住 ${info.count} 条`)
    })
    return () => { off?.() }
  }, [])

  // Re-check the data-directory setting whenever the user transitions into a
  // logged-in state. Logged-out users see the login screen first; we only
  // gate the main UI behind the directory choice, not the login itself.
  useEffect(() => {
    // BYOK (DWork) has no login, so don't wait on isLoggedIn — proceed straight
    // to the data-dir / model gates. supercode still gates on login.
    if (ACCOUNT_MODE !== 'byok' && !isLoggedIn) { setDataDirReady(null); setChatModelReady(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const s = await window.api.getSettings()
        if (!cancelled) {
          setDataDirReady(!!s.dataDirectory)
          setChatModelReady(!!(s.defaultChatProviderId && s.defaultChatModel))
          // Apply configured startup page once — but skip if something else
          // (shell-open, prior session) has already moved off the default.
          if (!didApplyStartupPageRef.current) {
            didApplyStartupPageRef.current = true
            const target = s.startupPage === 'vibe' ? 'vibe' : s.startupPage === 'studio' ? 'studio' : 'chat'
            if (useUIStore.getState().currentPage === 'chat' && target !== 'chat') {
              setPage(target)
            }
          }
        }
      } catch {
        // If settings can't be read at all, don't lock the user out — fall
        // through to the main UI so they can recover via Settings manually.
        if (!cancelled) { setDataDirReady(true); setChatModelReady(true) }
      }
    })()
    return () => { cancelled = true }
  }, [isLoggedIn])

  // Remote model.conf may update the recommended default models a few seconds
  // after launch. When it does, re-read settings (so the chat-setup gate clears)
  // and nudge the pages that cache defaults to refresh via their existing
  // focus-refresh path — without changing how the user manually edits defaults.
  useEffect(() => {
    const unsub = window.api.onModelConfApplied?.(() => {
      window.api.getSettings().then((s) => {
        setChatModelReady(!!(s.defaultChatProviderId && s.defaultChatModel))
      }).catch(() => { /* non-fatal */ })
      window.dispatchEvent(new Event('focus'))
    })
    return () => { unsub?.() }
  }, [])

  // Apply skin class + .dark before first paint to avoid flash. The `.dark`
  // class stays in sync so existing `dark:` Tailwind variants keep working on
  // dark-base skins (cold/twilight).
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.remove('skin-classic', 'skin-warm', 'skin-cold', 'skin-twilight', 'skin-terminal', 'skin-dwork')
    root.classList.add(`skin-${skin}`)
    const isDark = SKIN_IS_DARK[skin]
    if (isDark) root.classList.add('dark')
    else root.classList.remove('dark')
  }, [skin])

  // Window/document title is brand-driven (index.html's static title is just
  // the pre-hydration fallback). DWork builds show "DWork", SuperStudio "SuperStudio".
  useLayoutEffect(() => {
    document.title = BRAND.productName
  }, [])

  // Tag <html> with the OS so platform-specific font-smoothing rules apply
  useLayoutEffect(() => {
    const root = document.documentElement
    const platform = window.api?.platform
    root.classList.remove('platform-win', 'platform-mac', 'platform-linux')
    if (platform === 'win32') root.classList.add('platform-win')
    else if (platform === 'darwin') root.classList.add('platform-mac')
    else root.classList.add('platform-linux')
    // Only when the OS actually composites a vibrancy/acrylic backdrop (macOS, or
    // Windows 11+) do we let the chrome go translucent — otherwise a transparent
    // window would just show the bare desktop. Win10/Linux stay fully opaque.
    if (window.api?.vibrancy) root.classList.add('platform-vibrancy')
    else root.classList.remove('platform-vibrancy')
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { page: string; workflowId?: string }
      if (detail?.page) {
        // 「工作流」「图片画布」「视频」已合并进「创作」(studio)。把旧 page 名透明重定向，
        // 并保留 workflowId → StudioPage 切到工作流模式并打开它。
        if (detail.page === 'workflow' && detail.workflowId) setPendingWorkflowId(detail.workflowId)
        const page = (detail.page === 'workflow' || detail.page === 'canvas' || detail.page === 'video') ? 'studio' : detail.page
        setPage(page as Parameters<typeof setPage>[0])
      }
    }
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [setPage, setPendingWorkflowId])

  // --- Global keyboard shortcuts ---
  // Skipped when the user is in a text input / textarea / contenteditable, so
  // we don't intercept Ctrl+N inside a textarea (etc). Single-key shortcuts
  // would be hostile inside text inputs — only handle modifier combos here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const target = e.target as HTMLElement | null
      const inTextField = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )

      const key = e.key.toLowerCase()

      // Mod + / : show shortcuts help (works everywhere)
      if (key === '/' || (e.shiftKey && key === '?')) {
        e.preventDefault()
        setShortcutsOpen(o => !o)
        return
      }

      // Mod + , : open settings
      if (key === ',') {
        e.preventDefault()
        setPage('settings')
        return
      }

      // Mod + 0-7 : nav to main pages
      const pageMap: Record<string, PageId> = { '0': 'dashboard', '1': 'chat', '2': 'studio', '3': 'gallery', '4': 'memory', '5': 'vibe', '6': 'skills', '7': 'scheduler' }
      if (pageMap[e.key]) {
        // Don't hijack number input inside text fields
        if (inTextField) return
        e.preventDefault()
        setPage(pageMap[e.key])
        return
      }

      // Mod + N : new chat (dispatch event ChatPage listens for)
      if (key === 'n') {
        if (inTextField) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'chat' } }))
        window.dispatchEvent(new CustomEvent('app:new-chat'))
        return
      }

      // Mod + K : toggle command palette (works inside text fields too)
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPage])

  // MenuBar (Vibe page) dispatches these so menu items can open globally-
  // owned modals without prop-drilling. Toggle is intentional — clicking the
  // menu item twice should close it again.
  useEffect(() => {
    const onPalette = () => setPaletteOpen(o => !o)
    const onShortcuts = () => setShortcutsOpen(o => !o)
    window.addEventListener('app:open-palette', onPalette)
    window.addEventListener('app:open-shortcuts', onShortcuts)
    return () => {
      window.removeEventListener('app:open-palette', onPalette)
      window.removeEventListener('app:open-shortcuts', onShortcuts)
    }
  }, [])

  // Scheduled-task run signals: mark task as unread + handle notification-click
  // navigation (open the task's detail view inside the Scheduler page).
  useEffect(() => {
    const offRun = window.api.onScheduledRunCompleted?.((e) => {
      if (e.status === 'success') {
        useScheduledNotifications.getState().markUnread(e.taskId)
      }
    })
    const offFocus = window.api.onSchedulerFocusTask?.((e) => {
      if (!e.taskId) return
      setPage('scheduler')
      window.dispatchEvent(new CustomEvent('app:scheduler-open-task', { detail: { taskId: e.taskId } }))
    })
    return () => { offRun?.(); offFocus?.() }
  }, [setPage])

  // OS-level "用 SuperStudio 打开" — Explorer right-click forwards a path here.
  // We park the target on the Vibe store and switch the active page; VibePage
  // picks the target up on (re)mount. Storing in the store instead of firing
  // a DOM event removes the mount-timing race — the event used to fire 60ms
  // after setPage('vibe'), which sometimes beat VibePage's listener attach,
  // and the file silently failed to open.
  useEffect(() => {
    const off = window.api.onOpenPathFromShell?.((payload: unknown) => {
      const target = typeof payload === 'string'
        ? { path: payload, kind: 'dir' as const }
        : payload as { path: string; kind: 'file' | 'dir'; parent?: string }
      useVibeStore.getState().setPendingShellOpen(target)
      setPage('vibe')
    })
    return off
  }, [setPage])

  if (isInitializing) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          正在启动…
        </div>
      </div>
    )
  }

  // Login gate applies only to the account-based flavor (supercode). The login
  // screen is provided by the account UI seam (registered by the overlay); the
  // BYOK flavor (DWork) registers none and skips straight to onboarding.
  const LoginComponent = getAccountUI().LoginComponent
  const DashboardComponent = getAccountUI().DashboardComponent
  if (ACCOUNT_MODE === 'hosted' && !isLoggedIn && LoginComponent) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <LoginComponent />
      </div>
    )
  }

  // Logged in but data directory check hasn't resolved yet — render the
  // chrome but not the main UI to avoid a flash of the wrong screen.
  if (dataDirReady === null) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
      </div>
    )
  }

  if (!dataDirReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <DataDirectorySetup onDone={() => setDataDirReady(true)} />
      </div>
    )
  }

  // Once the data directory is set, ensure the user has picked a default
  // chat model. We deliberately don't gate image/video/embedding here —
  // most users won't touch those tabs on day one.
  if (chatModelReady === null) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
      </div>
    )
  }

  if (!chatModelReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <ChatModelSetup onDone={() => setChatModelReady(true)} />
      </div>
    )
  }

  return (
    <div className="app-shell flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="app-content flex-1 overflow-hidden bg-background">
          {currentPage === 'dashboard' && DashboardComponent && <DashboardComponent />}
          {currentPage === 'chat' && <ChatPage />}
          {currentPage === 'studio' && <StudioPage />}
          {currentPage === 'gallery' && <GalleryPage />}
          {currentPage === 'memory' && <MemoryPage />}
          {currentPage === 'vibe' && <VibePage />}
          {currentPage === 'skills' && <SkillsPage />}
          {currentPage === 'scheduler' && <SchedulerPage />}
          {currentPage === 'settings' && <SettingsPage />}
        </main>
      </div>

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
      {cuConfirm.element}
      <UpdateNotifier />
    </div>
  )
}
