import { useEffect, useRef, useState } from 'react'
import { Folder, ChevronRight } from 'lucide-react'
import { useVibeStore, fileTabKey, requestTabKey } from './store'
import { useUIStore } from '../../stores/ui'
import { TopBar } from './TopBar'
import { RequestList } from './Sidebar/RequestList'
import { FileExplorer } from './Sidebar/FileExplorer'
import { EditorTabs } from './Editor/EditorTabs'
import { PreviewPane } from './PreviewPane'
import { NewProjectDialog } from './NewProjectDialog'
import { TerminalPanel } from './Terminal/TerminalPanel'
import { TerminalResizeHandle } from './Terminal/ResizeHandle'
import type {
  FileTreeNode, RecentProject, VibeProgressEvent,
  VibeRequestInfo, VibeTaskInfo, VibeMessageInfo, VibeProjectInfo
} from '../../../../shared/ipc-types'

export function VibePage() {
  const s = useVibeStore()
  const isDark = useUIStore(u => u.theme === 'dark')
  const terminalHeight = useUIStore(u => u.terminalHeight)
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  // Ctrl+` toggles the terminal drawer (VS Code parity). Skip when focus is in
  // an editable field so the keystroke still types a backtick where expected.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.key !== '`') return
      const tag = (e.target as HTMLElement | null)?.tagName
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable
      if (editable) return
      e.preventDefault()
      s.toggleTerminal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.toggleTerminal])

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
  }

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

  function handleChat(prompt: string, requestId?: string) {
    if (!s.projectPath) return
    s.setErrorBanner(null)
    if (!requestId) {
      useVibeStore.setState({ activeTabKey: null, activeRequestId: null })
      s.setMessages([])
      s.setTasks([])
    }
    s.setRunning('chat')
    window.api.vibeChat?.({ projectPath: s.projectPath, prompt, requestId }).catch((e: Error) => {
      s.setRunning(null)
      s.setErrorBanner(e.message)
    })
  }

  function handleExplore(prompt: string, requestId?: string) {
    if (!s.projectPath) return
    s.setErrorBanner(null)
    if (!requestId) {
      useVibeStore.setState({ activeTabKey: null, activeRequestId: null })
      s.setMessages([])
      s.setTasks([])
    }
    s.setRunning('explore')
    window.api.vibeExplore?.({ projectPath: s.projectPath, prompt, requestId }).catch((e: Error) => {
      s.setRunning(null)
      s.setErrorBanner(e.message)
    })
  }

  function handleBugfix(prompt: string, requestId?: string) {
    if (!s.projectPath) return
    s.setErrorBanner(null)
    if (!requestId) {
      useVibeStore.setState({ activeTabKey: null, activeRequestId: null })
      s.setMessages([])
      s.setTasks([])
    }
    s.setRunning('bugfix')
    window.api.vibeBugfix?.({ projectPath: s.projectPath, prompt, requestId }).catch((e: Error) => {
      s.setRunning(null)
      s.setErrorBanner(e.message)
    })
  }

  function handlePropose(prompt: string, requestId?: string) {
    if (!s.projectPath) return
    s.setErrorBanner(null)
    if (requestId) {
      // Promotion: stay on the current tab. The same request now gets tasks added.
      // Don't clear messages — the explore conversation is the context.
    } else {
      // New request: deselect current tab so EmptyStateHero displays loading banner.
      useVibeStore.setState({ activeTabKey: null, activeRequestId: null })
      s.setMessages([])
      s.setTasks([])
    }
    s.setRunning('propose')
    window.api.vibePropose?.({ projectPath: s.projectPath, prompt, requestId }).catch((e: Error) => {
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
    if (!s.projectPath) return
    window.api.vibeStop?.({ projectPath: s.projectPath }).catch(() => {/* ignore */})
  }

  async function handleToggleTaskStatus(taskId: string, status: 'pending' | 'done' | 'skipped') {
    await window.api.vibeTaskToggle?.({ taskId, status })
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

  return (
    <div className="flex flex-col h-full overflow-hidden">

      <TopBar
        projectPath={s.projectPath}
        providerId={s.projectInfo?.providerId ?? null}
        modelId={s.projectInfo?.modelId ?? null}
        showPreview={s.showPreview}
        showTerminal={s.showTerminal}
        onSwitchProject={switchProject}
        onOpenExisting={handleOpenExisting}
        onNewProject={() => setNewProjectOpen(true)}
        onRemoveRecent={handleRemoveRecent}
        onModelChange={handleModelChange}
        onTogglePreview={s.togglePreview}
        onToggleTerminal={s.toggleTerminal}
      />

      {s.errorBanner && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex items-center gap-2">
          <span className="flex-1">{s.errorBanner}</span>
          <button onClick={() => s.setErrorBanner(null)} className="text-destructive/70 hover:text-destructive">×</button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar: Requests primary; Files collapsible (workflow-first) */}
        <div className="w-[240px] shrink-0 border-r border-border bg-card flex flex-col">
          {/* Requests — always visible; grows to fill when files are collapsed */}
          <div className={s.showFileExplorer ? 'h-3/5 min-h-0' : 'flex-1 min-h-0'}>
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
                  // Just deselect — keep existing tabs but switch to "no active"
                  useVibeStore.setState({ activeTabKey: null })
                }
              }}
            />
          </div>
          {/* Files — opt-in. Collapsed: small expand strip. Expanded: tree + collapse button. */}
          {s.showFileExplorer ? (
            <div className="flex-1 min-h-0 border-t border-border">
              <FileExplorer
                root={s.tree}
                activeFilePath={activeFilePath}
                dirtyPaths={dirtyPaths}
                onOpenFile={handleOpenFile}
                onRefresh={refreshTree}
                onCollapse={s.toggleFileExplorer}
              />
            </div>
          ) : (
            <button
              onClick={s.toggleFileExplorer}
              className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/30 flex items-center gap-1.5 border-t border-border"
              title="展开文件浏览器"
            >
              <Folder size={11} />
              <span className="flex-1 text-left">文件</span>
              <ChevronRight size={11} />
            </button>
          )}
        </div>

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
              requests={s.requests}
              tasks={s.tasks}
              messages={s.messages}
              streamingTaskId={s.streamingTaskId}
              running={s.running}
              onChat={handleChat}
              onExplore={handleExplore}
              onBugfix={handleBugfix}
              onPropose={handlePropose}
              onApply={handleApply}
              onStop={handleStop}
              onToggleTaskStatus={handleToggleTaskStatus}
              hasProject={!!s.projectPath}
            />
          </div>
          {s.showTerminal && s.projectPath && (
            <>
              <TerminalResizeHandle />
              <div className="shrink-0 flex flex-col min-h-0" style={{ height: terminalHeight }}>
                <TerminalPanel projectPath={s.projectPath} onClose={() => s.setShowTerminal(false)} />
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

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (path) => { await switchProject(path) }}
      />
    </div>
  )
}
