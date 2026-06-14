import { useEffect, useRef, useState } from 'react'
import { useVibeStore, fileTabKey, requestTabKey } from './store'
import { useUIStore } from '../../stores/ui'
import { MenuBar } from './MenuBar'
import { StatusBar } from './StatusBar'
import { PanelTabs } from './PanelTabs'
import { NoProjectLanding } from './NoProjectLanding'
import { ActivityBar } from './ActivityBar'
import { RequestList } from './Sidebar/RequestList'
import { FileExplorer } from './Sidebar/FileExplorer'
import { ChangesList } from './Sidebar/ChangesList'
import { EditorTabs } from './Editor/EditorTabs'
import { PreviewPane } from './PreviewPane'
import { NewProjectDialog } from './NewProjectDialog'
import { TerminalPanel } from './Terminal/TerminalPanel'
import { TerminalResizeHandle } from './Terminal/ResizeHandle'
import { SidebarResizer } from './SidebarResizer'
import type {
  FileTreeNode, RecentProject, VibeProgressEvent,
  VibeRequestInfo, VibeTaskInfo, VibeMessageInfo, VibeProjectInfo, ProviderConfig,
  ShellOpenTarget, GitStatusInfo
} from '../../../../shared/ipc-types'

// The Vibe IDE itself (editor / terminal / requests). Wrapped by WorkbenchPage
// (Workbench.tsx) which adds the workbench-level tab bar (IDE + company views).
export function VibeWorkbench() {
  const s = useVibeStore()
  const isDark = useUIStore(u => u.theme === 'dark')
  const terminalHeight = useUIStore(u => u.terminalHeight)
  const vibeActivity = useUIStore(u => u.vibeActivity)
  const vibeSidebarOpen = useUIStore(u => u.vibeSidebarOpen)
  const vibeSidebarWidth = useUIStore(u => u.vibeSidebarWidth)
  const setVibeActivity = useUIStore(u => u.setVibeActivity)
  const setVibeSidebarOpen = useUIStore(u => u.setVibeSidebarOpen)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  // Git review layer: changed-files status (for the 「更改」 panel) + a token that
  // forces open diff tabs to re-fetch after a run / mutation completes.
  const [gitStatus, setGitStatus] = useState<GitStatusInfo | null>(null)
  const [gitRefreshToken, setGitRefreshToken] = useState(0)

  // Resolve providerId+modelId to "ProviderName · modelId" for the status bar.
  // Pulls the provider list once and re-renders the label whenever the
  // project's model assignment changes.
  useEffect(() => {
    let cancelled = false
    if (!s.projectInfo?.providerId || !s.projectInfo?.modelId) {
      setProviderLabel(null)
      return
    }
    ;(async () => {
      try {
        const ps = await window.api.listProviders?.() as ProviderConfig[] | undefined
        if (cancelled) return
        const prov = ps?.find(p => p.id === s.projectInfo!.providerId)
        setProviderLabel(prov ? `${prov.name} · ${s.projectInfo!.modelId}` : s.projectInfo!.modelId ?? null)
      } catch {
        if (!cancelled) setProviderLabel(s.projectInfo?.modelId ?? null)
      }
    })()
    return () => { cancelled = true }
  }, [s.projectInfo?.providerId, s.projectInfo?.modelId])

  // Stable ref to the latest handleStop — the keyboard listener captures it
  // once but should always call through to the current closure.
  const stopRef = useRef<(() => void) | null>(null)

  // Vibe-page-scoped keyboard shortcuts (VS Code parity). Globals like Ctrl+K
  // (palette) and Ctrl+, (settings) live in App.tsx so they work everywhere;
  // these are editor-context bindings that only make sense here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable

      // Ctrl+` → toggle terminal. Skip in text fields so the keystroke still types ` there.
      if (e.ctrlKey && e.key === '`') {
        if (editable) return
        e.preventDefault()
        s.toggleTerminal()
        return
      }
      // Ctrl+B → toggle the whole sidebar (VS Code default)
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        if (editable) return
        e.preventDefault()
        setVibeSidebarOpen(!vibeSidebarOpen)
        return
      }
      // Ctrl+W → close active tab. Monaco intercepts most things, but tabs are app-level.
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
        if (!s.activeTabKey) return
        e.preventDefault()
        s.closeTab(s.activeTabKey)
        return
      }
      // Esc → stop any running task. Don't preventDefault so Monaco's own Esc
      // (close find/replace etc) still works when nothing's running.
      if (e.key === 'Escape' && s.running) {
        if (editable) return
        stopRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.toggleTerminal, setVibeSidebarOpen, vibeSidebarOpen, s.closeTab, s.activeTabKey, s.running])

  // No auto-pick on mount — user explicitly selects a project from the TopBar
  // dropdown (or 打开/新建). Once selected the Zustand store retains the choice
  // across tab switches within the same session; restarting the app clears it.

  // ───────────── Event subscriptions ─────────────
  // Debounce tree refresh — agent can edit many files in quick succession
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function scheduleTreeRefresh() {
    if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current)
    treeRefreshTimer.current = setTimeout(() => { refreshTree() }, 400)
  }
  // Same debounce for the git "更改" panel — the agent can touch many files fast.
  const gitRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function scheduleGitRefresh() {
    if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current)
    gitRefreshTimer.current = setTimeout(() => { loadGitStatus() }, 500)
  }

  useEffect(() => {
    const offProgress = window.api.onVibeProgress?.((data: unknown) => {
      const e = data as VibeProgressEvent
      if (s.projectPath && e.projectPath !== s.projectPath) return
      s.applyProgressEvent(e)
      // LIVE: when agent writes/edits a file, refresh the tree (debounced)
      // — store already bumps previewToken to live-reload the iframe.
      if (
        e.type === 'tool_result' && !e.isError &&
        (e.toolName === 'code_write' || e.toolName === 'code_edit')
      ) {
        scheduleTreeRefresh()
        scheduleGitRefresh()
        // Refresh any OPEN editor tab for the file the agent just wrote so it
        // doesn't show stale content (writes go straight to disk, bypassing
        // Monaco). Re-read from disk; the store keeps unsaved user edits.
        if (e.filePath) {
          void (window.api.vibeReadFile?.(e.filePath) as Promise<string> | undefined)
            ?.then(content => useVibeStore.getState().refreshFileTabFromDisk(e.filePath!, content))
            .catch(() => { /* file may be gone/binary; ignore */ })
        }
      }
      // PROPOSE done — open the new request as a tab
      if (e.type === 'request_ready' && e.requestId) {
        loadRequests()
        openRequest(e.requestId)
      }
    })
    const offDone = window.api.onVibeDone?.(async (data: unknown) => {
      const d = data as { projectPath?: string; requestId?: string; cancelled?: boolean; autoApplyStarting?: boolean }
      if (s.projectPath && d.projectPath !== s.projectPath) return
      // When propose finishes and auto-apply is enabled, transition the running
      // indicator from 'propose' → 'apply' instead of resetting to idle —
      // backend will keep emitting progress events under the same requestId.
      if (d.autoApplyStarting) {
        s.setRunning('apply')
      } else {
        s.setRunning(null)
      }
      s.setStreamingTask(null)
      await refreshTree()
      await loadRequests()
      void gitRefreshAll()
      if (d.requestId) {
        await loadMessagesAndTasks(d.requestId)
        // Auto-apply takes over the same requestId — open its tab so user sees execution live
        if (d.autoApplyStarting) openRequest(d.requestId)
      } else if (s.activeRequestId) {
        await loadMessagesAndTasks(s.activeRequestId)
      }
      // Refresh preview iframe — AI may have modified files
      s.bumpPreview()
    })
    const offError = window.api.onVibeError?.((data: unknown) => {
      const d = data as { error?: string }
      s.setRunning(null)
      s.setStreamingTask(null)
      s.setErrorBanner(d.error || '执行失败')
    })
    return () => {
      offProgress?.()
      offDone?.()
      offError?.()
    }
  }, [s.projectPath, s.activeRequestId])

  // Load git status when the user opens the 「更改」 panel (it's otherwise kept
  // fresh by the write / done hooks above).
  useEffect(() => {
    if (vibeActivity === 'changes' && s.projectPath) loadGitStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vibeActivity, s.projectPath])

  // ───────────── Helpers ─────────────
  // NOTE: these read projectPath from the store via getState() rather than the
  // captured `s` snapshot. switchProject() calls setProject() then immediately
  // awaits refreshTree/loadRequests within the same render — the local `s`
  // would still see the OLD projectPath (null on first open), causing them to
  // bail. getState() always returns the current store value.
  async function refreshTree() {
    const pp = useVibeStore.getState().projectPath
    if (!pp) { s.setTree(null); return }
    try {
      const t = await window.api.vibeListTree?.(pp) as FileTreeNode
      s.setTree(t)
    } catch (e) {
      s.setTree(null)
      console.warn('[vibe] tree load failed:', (e as Error).message)
    }
  }

  async function loadRequests() {
    const pp = useVibeStore.getState().projectPath
    if (!pp) { s.setRequests([]); return }
    const rs = await window.api.vibeRequestList?.(pp) as VibeRequestInfo[] | undefined
    s.setRequests(rs ?? [])
  }

  // ── Git review layer ───────────────────────────────────────────────────
  async function loadGitStatus() {
    const pp = useVibeStore.getState().projectPath
    if (!pp) { setGitStatus(null); s.setChangesCount(0); return }
    try {
      const st = await window.api.vibeGitStatus?.(pp) as GitStatusInfo | undefined
      setGitStatus(st ?? null)
      s.setChangesCount(st?.files.length ?? 0)
    } catch {
      setGitStatus(null); s.setChangesCount(0)
    }
  }
  /** Refresh the changes panel + force open diff tabs to reload. */
  async function gitRefreshAll() {
    await loadGitStatus()
    setGitRefreshToken(t => t + 1)
  }
  /** Called by the diff editor after its own stage/revert — refresh sidebar,
   *  tree and preview (a revert changes files on disk) without double-reloading
   *  the diff tab (it already reloaded itself). */
  async function handleGitMutate() {
    await loadGitStatus()
    await refreshTree()
    s.bumpPreview()
  }
  function handleOpenDiff(filePath: string) { s.openDiffTab(filePath) }
  async function handleGitStage(p: string) { await window.api.vibeGitStage?.(s.projectPath!, p); await loadGitStatus() }
  async function handleGitUnstage(p: string) { await window.api.vibeGitUnstage?.(s.projectPath!, p); await loadGitStatus() }
  async function handleGitRevertFile(p: string) {
    const r = await window.api.vibeGitRevertFile?.(s.projectPath!, p) as { error?: string } | undefined
    if (r?.error) s.setErrorBanner('还原失败：' + r.error)
    await gitRefreshAll(); await refreshTree(); s.bumpPreview()
  }
  async function handleGitCommit(message: string) {
    const r = await window.api.vibeGitCommit?.(s.projectPath!, message) as { error?: string } | undefined
    if (r?.error) s.setErrorBanner('提交失败：' + r.error)
    await gitRefreshAll()
  }
  async function handleGitRollback() {
    const r = await window.api.vibeGitRollback?.(s.projectPath!) as { error?: string } | undefined
    if (r?.error) s.setErrorBanner('回滚失败：' + r.error)
    await gitRefreshAll(); await refreshTree(); s.bumpPreview()
  }
  async function handleGitInit() {
    const r = await window.api.vibeGitInit?.(s.projectPath!) as { error?: string } | undefined
    if (r?.error) s.setErrorBanner('启用版本快照失败：' + r.error)
    await gitRefreshAll()
  }

  async function loadMessagesAndTasks(requestId: string) {
    const [ts, ms] = await Promise.all([
      window.api.vibeTaskList?.(requestId) as Promise<VibeTaskInfo[] | undefined>,
      window.api.vibeMessageList?.(requestId) as Promise<VibeMessageInfo[] | undefined>
    ])
    s.setTasks(ts ?? [])
    s.setMessages(ms ?? [])
  }

  async function switchProject(path: string) {
    s.reset()
    s.setProject(path)
    s.setErrorBanner(null)
    try {
      const info = await window.api.vibeProjectGet?.(path) as VibeProjectInfo
      s.setProjectInfo(info)
    } catch (e) {
      s.setErrorBanner((e as Error).message)
      return
    }
    await refreshTree()
    await loadRequests()
    await loadGitStatus()
  }

  // OS shell: Explorer right-click "用 SuperStudio 打开" parks the requested
  // path on the Vibe store via App.tsx; we consume it here. Done as a store
  // subscription rather than a one-shot DOM event so it works whether
  // VibePage was already mounted (live update) or just mounted in response
  // to the shell event (consumed on first run). Files reuse their parent
  // directory as the project root so path-allow + recent-projects pick it up.
  useEffect(() => {
    let handling = false
    async function handle(target: ShellOpenTarget) {
      if (handling) return
      handling = true
      try {
        const projectRoot = target.kind === 'dir' ? target.path : (target.parent ?? target.path)
        const current = useVibeStore.getState().projectPath
        if (current !== projectRoot) {
          const result = await window.api.vibeOpenExisting?.(projectRoot) as { path: string } | undefined
          if (result?.path) await switchProject(result.path)
        }
        if (target.kind === 'file') {
          // vibeOpenExisting already registered path-allow synchronously, so
          // vibeReadFile is safe to call immediately — no setTimeout needed.
          await handleOpenFile(target.path)
        }
      } catch (err) {
        console.error('[vibe-ui] shell-open failed:', err)
        useVibeStore.getState().setErrorBanner('打开失败：' + (err as Error).message)
      } finally {
        useVibeStore.getState().setPendingShellOpen(null)
        handling = false
      }
    }

    // Catch anything already queued at mount time (cold start, first nav to Vibe).
    const initial = useVibeStore.getState().pendingShellOpen
    if (initial) handle(initial)

    // Plus live updates while we're mounted.
    return useVibeStore.subscribe((state, prev) => {
      if (state.pendingShellOpen && state.pendingShellOpen !== prev.pendingShellOpen) {
        handle(state.pendingShellOpen)
      }
    })
  }, [])

  async function openRequest(id: string) {
    s.openRequestTab(id)
    await loadMessagesAndTasks(id)
  }

  async function handleOpenExisting() {
    try {
      const picked = await window.api.openFileDialog({ properties: ['openDirectory'] })
      if (!picked?.[0]) return
      const result = await window.api.vibeOpenExisting?.(picked[0]) as { path: string }
      if (result?.path) await switchProject(result.path)
    } catch (e) {
      s.setErrorBanner((e as Error).message)
    }
  }

  async function handleRemoveRecent(path: string) {
    await window.api.vibeRemoveRecent?.(path)
    if (s.projectPath === path) {
      const rs = await window.api.vibeListRecent?.() as RecentProject[] | undefined
      const next = rs?.[0]?.path
      if (next) await switchProject(next)
      else { s.reset() }
    }
  }

  async function handleModelChange(providerId: string, modelId: string) {
    if (!s.projectPath) return
    await window.api.vibeProjectSetModel?.({ projectPath: s.projectPath, providerId, modelId })
    s.setProjectInfo(s.projectInfo ? { ...s.projectInfo, providerId, modelId } : null)
  }

  async function handleOpenFile(filePath: string) {
    const existing = s.openTabs.find(t => t.kind === 'file' && t.path === filePath)
    if (existing) {
      s.switchTab(fileTabKey(filePath))
      return
    }
    try {
      console.log('[vibe-ui] opening file:', filePath)
      const content = await window.api.vibeReadFile?.(filePath) as string
      console.log('[vibe-ui] file content length:', content?.length ?? 0)
      s.openFileTab(filePath, content ?? '')
    } catch (e) {
      console.error('[vibe-ui] open file failed:', e)
      s.setErrorBanner('打开文件失败：' + (e as Error).message)
    }
  }

  async function handleSaveFile(filePath: string) {
    const tab = s.openTabs.find(t => t.kind === 'file' && t.path === filePath)
    if (!tab || tab.kind !== 'file') return
    try {
      await window.api.vibeFileSave?.({ path: filePath, content: tab.content })
      s.markFileTabClean(filePath)
      await refreshTree()
      s.bumpPreview()  // reload iframe to reflect saved file
    } catch (e) {
      s.setErrorBanner('保存失败：' + (e as Error).message)
    }
  }

  // Unified send: backend auto-classifies (or honors forceIntent) and dispatches.
  // We optimistically show a generic running state, then refine it from the
  // returned intent so the banner reads correctly.
  function handleRun(prompt: string, requestId?: string, forceIntent?: 'chat' | 'explore' | 'bugfix' | 'change', attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    if (!s.projectPath) return
    s.setErrorBanner(null)
    if (!requestId) {
      useVibeStore.setState({ activeTabKey: null, activeRequestId: null })
      s.setMessages([])
      s.setTasks([])
    }
    // Optimistic: assume the lightest mode until the classifier returns.
    s.setRunning(forceIntent === 'change' ? 'propose' : (forceIntent ?? 'chat'))
    window.api.vibeRun?.({ projectPath: s.projectPath, prompt, requestId, forceIntent, attachments })
      .then((res: { intent?: 'chat' | 'explore' | 'bugfix' | 'change'; error?: string }) => {
        if (res?.error) { s.setRunning(null); s.setErrorBanner(res.error); return }
        // change → propose running label (apply may follow); others map 1:1.
        if (res?.intent) s.setRunning(res.intent === 'change' ? 'propose' : res.intent)
      })
      .catch((e: Error) => {
        s.setRunning(null)
        s.setErrorBanner(e.message)
      })
  }

  function handleApply() {
    if (!s.activeRequestId) return
    s.setErrorBanner(null)
    s.setRunning('apply')
    window.api.vibeApply?.({ requestId: s.activeRequestId }).catch((e: Error) => {
      s.setRunning(null)
      s.setErrorBanner(e.message)
    })
  }

  function handleStop() {
    // 乐观地立即清运行态，按钮即时响应——即便后端要等卡住的流醒来才真正 abort，
    // UI 也不会显得「点了没反应」。随后到达的 VIBE_DONE/ERROR 是幂等的。
    s.setRunning(null)
    s.setStreamingTask(null)
    if (!s.projectPath) return
    window.api.vibeStop?.({ projectPath: s.projectPath }).catch(() => {/* ignore */})
  }
  // Keep the stable ref pointed at the latest closure for the Esc shortcut.
  stopRef.current = handleStop

  function handleSaveActive() {
    const tab = s.openTabs.find(t => t.key === s.activeTabKey)
    if (tab?.kind === 'file') handleSaveFile(tab.path)
  }

  async function handleSaveAll() {
    for (const tab of s.openTabs) {
      if (tab.kind === 'file' && tab.dirty) {
        await handleSaveFile(tab.path)
      }
    }
  }

  function handleCloseProject() {
    s.reset()
  }

  function handleRunIntent(kind: 'chat' | 'explore' | 'bugfix' | 'propose') {
    // The menu items can't know the prompt — surface focus to the request
    // input so the user can type immediately. The hero/input listens for this
    // event and focuses + remembers the chosen intent.
    window.dispatchEvent(new CustomEvent('vibe:focus-request', { detail: { intent: kind } }))
  }

  async function handleToggleTaskStatus(taskId: string, status: 'pending' | 'done' | 'skipped') {
    await window.api.vibeTaskToggle?.({ taskId, status })
    if (s.activeRequestId) await loadMessagesAndTasks(s.activeRequestId)
  }

  async function handleReassignTask(taskId: string, employeeId: string | null) {
    await window.api.vibeTaskSetAssignee?.(taskId, employeeId)
    // Reload tasks so the dropdown reflects the new assignee (was only
    // refreshing the employee list before — the change looked like a no-op).
    if (s.activeRequestId) await loadMessagesAndTasks(s.activeRequestId)
  }

  // Revert ONLY this task's file changes (keep other tasks' work). Restores its
  // touched files to the pre-apply snapshot, then refreshes the tree / git /
  // open editor tabs so the UI reflects the undo immediately.
  async function handleRevertTask(taskId: string) {
    const pp = useVibeStore.getState().projectPath
    if (!pp) return
    const r = await window.api.vibeTaskRevert?.(taskId, pp) as { ok?: boolean; error?: string; files?: string[] } | undefined
    if (r?.error) { s.setErrorBanner('撤销失败：' + r.error); return }
    for (const abs of (r?.files ?? [])) {
      void (window.api.vibeReadFile?.(abs) as Promise<string> | undefined)
        ?.then(content => useVibeStore.getState().refreshFileTabFromDisk(abs, content))
        .catch(() => { /* file was newly-created and got deleted by the revert */ })
    }
    await gitRefreshAll().catch(() => {})
    await refreshTree()
    s.bumpPreview()
    if (s.activeRequestId) await loadMessagesAndTasks(s.activeRequestId)
  }

  async function handleDeleteRequest(id: string) {
    await window.api.vibeRequestDelete?.(id)
    // Close any tab for this request
    s.closeTab(requestTabKey(id))
    await loadRequests()
  }

  function handleSelectRequest(id: string) {
    openRequest(id)
  }

  // ───────────── Render ─────────────
  const dirtyPaths = new Set(s.openTabs.filter(t => t.kind === 'file' && t.dirty).map(t => t.kind === 'file' ? t.path : ''))
  const activeFilePath = s.openTabs.find(t => t.key === s.activeTabKey && t.kind === 'file')?.kind === 'file'
    ? (s.openTabs.find(t => t.key === s.activeTabKey) as { path: string }).path
    : null

  // No project = no editor / sidebar / terminal — show a real landing page
  // with quick-pick recent projects and the two primary CTAs. MenuBar +
  // StatusBar still render so the chrome stays consistent.
  if (!s.projectPath) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <MenuBar
          projectPath={null}
          providerId={null}
          modelId={null}
          onSwitchProject={switchProject}
          onOpenExisting={handleOpenExisting}
          onNewProject={() => setNewProjectOpen(true)}
          onRemoveRecent={handleRemoveRecent}
          onModelChange={handleModelChange}
          openTabs={[]}
          activeTabKey={null}
          onSaveActive={() => {}}
          onSaveAll={() => {}}
          onCloseTab={() => {}}
          onCloseProject={handleCloseProject}
          sidebarOpen={vibeSidebarOpen}
          sidebarActivity={vibeActivity}
          showTerminal={false}
          showPreview={false}
          onToggleSidebar={() => setVibeSidebarOpen(!vibeSidebarOpen)}
          onShowActivity={(a) => { setVibeActivity(a); setVibeSidebarOpen(true) }}
          onToggleTerminal={s.toggleTerminal}
          onTogglePreview={s.togglePreview}
          running={null}
          hasActiveRequest={false}
          onRunIntent={handleRunIntent}
          onApply={handleApply}
          onStop={handleStop}
        />
        {s.errorBanner && (
          <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
            <span className="flex-1">{s.errorBanner}</span>
            <button onClick={() => s.setErrorBanner(null)} className="text-destructive/70 hover:text-destructive">×</button>
          </div>
        )}
        <NoProjectLanding
          onSwitchProject={switchProject}
          onOpenExisting={handleOpenExisting}
          onNewProject={() => setNewProjectOpen(true)}
          onRemoveRecent={handleRemoveRecent}
        />
        <StatusBar providerLabel={null} />

        <NewProjectDialog
          open={newProjectOpen}
          onClose={() => setNewProjectOpen(false)}
          onCreated={async (path) => { await switchProject(path) }}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      <MenuBar
        projectPath={s.projectPath}
        providerId={s.projectInfo?.providerId ?? null}
        modelId={s.projectInfo?.modelId ?? null}
        onSwitchProject={switchProject}
        onOpenExisting={handleOpenExisting}
        onNewProject={() => setNewProjectOpen(true)}
        onRemoveRecent={handleRemoveRecent}
        onModelChange={handleModelChange}
        openTabs={s.openTabs}
        activeTabKey={s.activeTabKey}
        onSaveActive={handleSaveActive}
        onSaveAll={handleSaveAll}
        onCloseTab={s.closeTab}
        onCloseProject={handleCloseProject}
        sidebarOpen={vibeSidebarOpen}
        sidebarActivity={vibeActivity}
        showTerminal={s.showTerminal}
        showPreview={s.showPreview}
        onToggleSidebar={() => setVibeSidebarOpen(!vibeSidebarOpen)}
        onShowActivity={(a) => { setVibeActivity(a); setVibeSidebarOpen(true) }}
        onToggleTerminal={s.toggleTerminal}
        onTogglePreview={s.togglePreview}
        running={s.running}
        hasActiveRequest={!!s.activeRequestId}
        onRunIntent={handleRunIntent}
        onApply={handleApply}
        onStop={handleStop}
      />

      {s.errorBanner && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
          <span className="flex-1">{s.errorBanner}</span>
          <button onClick={() => s.setErrorBanner(null)} className="text-destructive/70 hover:text-destructive">×</button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Activity bar + single-panel sidebar (VS Code pattern — only one of
            requests / files visible at a time, not stacked). */}
        <ActivityBar />
        {vibeSidebarOpen && (
          <>
            <div
              style={{ width: vibeSidebarWidth }}
              className="shrink-0 bg-card flex flex-col"
            >
              {vibeActivity === 'requests' && (
                <RequestList
                  requests={s.requests}
                  activeRequestId={s.activeRequestId}
                  onSelect={handleSelectRequest}
                  onDelete={handleDeleteRequest}
                  onNew={() => {
                    // Clear active tab so the empty-state hero shows (with input)
                    s.setActiveRequest(null)
                    s.setMessages([])
                    s.setTasks([])
                    if (s.activeTabKey) {
                      useVibeStore.setState({ activeTabKey: null })
                    }
                  }}
                />
              )}
              {vibeActivity === 'files' && (
                <FileExplorer
                  root={s.tree}
                  activeFilePath={activeFilePath}
                  dirtyPaths={dirtyPaths}
                  onOpenFile={handleOpenFile}
                  onRefresh={refreshTree}
                />
              )}
              {vibeActivity === 'changes' && (
                <ChangesList
                  status={gitStatus}
                  onOpenDiff={handleOpenDiff}
                  onStage={handleGitStage}
                  onUnstage={handleGitUnstage}
                  onRevertFile={handleGitRevertFile}
                  onCommit={handleGitCommit}
                  onRollback={handleGitRollback}
                  onInit={handleGitInit}
                  onRefresh={loadGitStatus}
                />
              )}
            </div>
            <SidebarResizer />
          </>
        )}

        {/* Center: tabs (files + requests, full-page each) + optional terminal drawer below */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex flex-col">
            <EditorTabs
              tabs={s.openTabs}
              activeTabKey={s.activeTabKey}
              isDark={isDark}
              onSwitchTab={async (key) => {
                // When switching to a request tab, reload its messages/tasks from DB
                // so the user sees fresh state (not stale streaming chunks from another request).
                const tab = s.openTabs.find(t => t.key === key)
                s.switchTab(key)
                if (tab?.kind === 'request') {
                  await loadMessagesAndTasks(tab.requestId)
                }
              }}
              onCloseTab={s.closeTab}
              onChangeContent={s.setFileTabContent}
              onSave={handleSaveFile}
              onCloseOthers={s.closeOtherTabs}
              onCloseToRight={s.closeTabsToRight}
              onCloseAll={s.closeAllTabs}
              onSaveAll={handleSaveAll}
              onReorder={s.reorderTab}
              onRevealInSidebar={(path) => {
                // VS Code "Reveal in Side Bar" — open the sidebar if collapsed,
                // switch the activity to file explorer, and dispatch an event
                // so the explorer expands every parent folder of `path`.
                if (!vibeSidebarOpen) setVibeSidebarOpen(true)
                setVibeActivity('files')
                window.dispatchEvent(new CustomEvent('vibe:reveal-file', { detail: { path } }))
              }}
              projectPath={s.projectPath}
              requests={s.requests}
              tasks={s.tasks}
              messages={s.messages}
              streamingTaskId={s.streamingTaskId}
              running={s.running}
              onRun={handleRun}
              onApply={handleApply}
              onStop={handleStop}
              onToggleTaskStatus={handleToggleTaskStatus}
              onReassignTask={handleReassignTask}
              onRevertTask={handleRevertTask}
              hasProject={!!s.projectPath}
              gitRefreshToken={gitRefreshToken}
              onGitMutate={handleGitMutate}
            />
          </div>
          {s.showTerminal && s.projectPath && (
            <>
              <TerminalResizeHandle />
              <div className="shrink-0 flex flex-col min-h-0" style={{ height: terminalHeight }}>
                <PanelTabs onClose={() => s.setShowTerminal(false)} />
                <div className="flex-1 min-h-0 relative">
                  {/* Mount the terminal once and toggle visibility — disposing
                      and re-spawning a PTY on every tab switch would lose
                      scrollback and any running command. */}
                  <div className={s.panelTab === 'terminal' ? 'absolute inset-0' : 'hidden'}>
                    <TerminalPanel projectPath={s.projectPath} />
                  </div>
                  {s.panelTab === 'output' && (
                    <PanelPlaceholder label="输出" hint="构建 / 运行 输出会显示在这里（即将上线）" />
                  )}
                  {s.panelTab === 'problems' && (
                    <PanelPlaceholder label="问题" hint="编辑器诊断、Lint 报告会汇总在这里（即将上线）" />
                  )}
                  {s.panelTab === 'debug' && (
                    <PanelPlaceholder label="调试控制台" hint="附加调试器后可用（即将上线）" />
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right: preview toggleable */}
        {s.showPreview && (
          <div className="w-[40%] min-w-[320px] border-l border-border">
            <PreviewPane projectPath={s.projectPath} refreshToken={s.previewToken} />
          </div>
        )}
      </div>

      <StatusBar providerLabel={providerLabel} />

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (path) => { await switchProject(path) }}
      />
    </div>
  )
}

function PanelPlaceholder({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-card text-center px-6 gap-1.5">
      <div className="text-xs uppercase tracking-wider text-muted-foreground/60">{label}</div>
      <div className="text-[11px] text-muted-foreground/80">{hint}</div>
    </div>
  )
}

// Page entry: the workbench shell (IDE tab + 公司视图 tabs). Kept named VibePage
// so App.tsx's import + page switch stay unchanged.
export { WorkbenchPage as VibePage } from './Workbench'
