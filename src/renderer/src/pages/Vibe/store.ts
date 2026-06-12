import { create } from 'zustand'
import { scrubAddresses } from '../../../../shared/scrub'
import type {
  FileTreeNode, VibeProgressEvent, VibeRequestInfo, VibeTaskInfo, VibeMessageInfo, VibeProjectInfo,
  ShellOpenTarget
} from '../../../../shared/ipc-types'

export type OpenTab =
  | { kind: 'file'; key: string; path: string; content: string; diskContent: string; dirty: boolean }
  | { kind: 'request'; key: string; requestId: string }
  | { kind: 'diff'; key: string; path: string }

export function fileTabKey(p: string): string { return `file:${p}` }
export function requestTabKey(id: string): string { return `request:${id}` }
export function diffTabKey(p: string): string { return `diff:${p}` }

interface VibeState {
  // Current project
  projectPath: string | null
  projectInfo: VibeProjectInfo | null
  tree: FileTreeNode | null

  // Requests
  requests: VibeRequestInfo[]
  activeRequestId: string | null
  tasks: VibeTaskInfo[]
  messages: VibeMessageInfo[]
  streamingTaskId: string | null

  // Tabs (unified — files AND requests)
  openTabs: OpenTab[]
  activeTabKey: string | null

  // UI
  showPreview: boolean
  /** File explorer in the left sidebar — collapsed by default so the request
   *  workflow stays visually primary. User opens it on demand when they need
   *  to browse files (IDE-as-plugin model). */
  showFileExplorer: boolean
  /** VS Code-style bottom terminal drawer. Toggle via TopBar button or Ctrl+`. */
  showTerminal: boolean
  /** Active tab on the bottom panel (terminal / output / problems / debug).
   *  Only 'terminal' is wired today; the others are placeholders for parity. */
  panelTab: 'terminal' | 'output' | 'problems' | 'debug'
  previewToken: number
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  errorBanner: string | null
  /** Number of changed files (git status) — drives the 「更改」 activity-bar badge. */
  changesCount: number

  // Status bar fields — populated by MonacoFileEditor on focus / cursor move.
  cursorLine: number
  cursorCol: number
  cursorLanguage: string

  /** Path the OS shell asked us to open (Explorer right-click). Set by App.tsx
   *  when the IPC event arrives; consumed + cleared by VibePage on mount or
   *  while live. Using a store field instead of a CustomEvent eliminates the
   *  mount-timing race — VibePage might not be mounted yet when the event
   *  fires from main (e.g. cold start, or user is on a different page). */
  pendingShellOpen: ShellOpenTarget | null

  // Mutators
  setProject: (path: string | null) => void
  setProjectInfo: (info: VibeProjectInfo | null) => void
  setTree: (tree: FileTreeNode | null) => void
  setRequests: (rs: VibeRequestInfo[]) => void
  setActiveRequest: (id: string | null) => void
  setTasks: (ts: VibeTaskInfo[]) => void
  setMessages: (ms: VibeMessageInfo[]) => void
  setStreamingTask: (id: string | null) => void
  applyProgressEvent: (e: VibeProgressEvent) => void
  setRunning: (r: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null) => void
  setErrorBanner: (s: string | null) => void
  setChangesCount: (n: number) => void

  // Tab mutators
  openFileTab: (path: string, content: string) => void
  openRequestTab: (requestId: string) => void
  /** Open (or focus) a read-only diff tab for `path` — content is fetched by the
   *  diff editor itself via the git IPC. */
  openDiffTab: (path: string) => void
  switchTab: (key: string) => void
  closeTab: (key: string) => void
  /** Close every tab except the one identified by `key`. VS Code parity. */
  closeOtherTabs: (key: string) => void
  /** Close every tab to the right of `key` (keys after it in `openTabs`). */
  closeTabsToRight: (key: string) => void
  /** Close every tab, period. Active tab and active request both clear. */
  closeAllTabs: () => void
  /** Drag-and-drop reorder: move `fromKey` next to `toKey`. `side` is the half
   *  of the target tab the cursor was over at drop time. */
  reorderTab: (fromKey: string, toKey: string, side: 'left' | 'right') => void
  setFileTabContent: (path: string, next: string) => void
  markFileTabClean: (path: string) => void
  refreshFileTabFromDisk: (path: string, newContent: string) => void

  // Preview
  togglePreview: () => void
  bumpPreview: () => void

  // File explorer collapse
  toggleFileExplorer: () => void

  // Terminal drawer
  toggleTerminal: () => void
  setShowTerminal: (v: boolean) => void
  setPanelTab: (t: 'terminal' | 'output' | 'problems' | 'debug') => void

  // Status bar
  setCursor: (line: number, col: number) => void
  setCursorLanguage: (lang: string) => void

  // Shell-open queue (Explorer right-click → APP_OPEN_PATH_FROM_SHELL)
  setPendingShellOpen: (target: ShellOpenTarget | null) => void

  // Reset (project switch)
  reset: () => void
}

const initial = {
  projectPath: null,
  projectInfo: null,
  tree: null,
  requests: [] as VibeRequestInfo[],
  activeRequestId: null,
  tasks: [] as VibeTaskInfo[],
  messages: [] as VibeMessageInfo[],
  streamingTaskId: null,
  openTabs: [] as OpenTab[],
  activeTabKey: null,
  showPreview: false,
  showFileExplorer: false,
  showTerminal: false,
  panelTab: 'terminal' as 'terminal' | 'output' | 'problems' | 'debug',
  previewToken: 0,
  running: null as 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null,
  errorBanner: null as string | null,
  changesCount: 0,
  cursorLine: 0,
  cursorCol: 0,
  cursorLanguage: '',
  pendingShellOpen: null as ShellOpenTarget | null
}

export const useVibeStore = create<VibeState>((set, get) => ({
  ...initial,

  setProject: (path) => set({ projectPath: path }),
  setProjectInfo: (info) => set({ projectInfo: info }),
  setTree: (tree) => set({ tree }),
  setRequests: (rs) => set({ requests: rs }),
  setActiveRequest: (id) => set({ activeRequestId: id }),
  setTasks: (ts) => set({ tasks: ts }),
  setMessages: (ms) => set({ messages: ms }),
  setStreamingTask: (id) => set({ streamingTaskId: id }),

  applyProgressEvent: (e) => {
    const s = get()
    if (e.type === 'task_status' && e.taskId && e.taskStatus) {
      const next = s.tasks.map(t => t.id === e.taskId
        ? { ...t, status: e.taskStatus! }
        : t
      )
      set({
        tasks: next,
        // Parallel apply: only clear the streamed-text highlight when the task
        // that finished IS the one we were highlighting; a running event always
        // takes the highlight. Per-task spinners are driven by task.status, so
        // multiple concurrent running tasks render correctly regardless.
        streamingTaskId: e.taskStatus === 'running'
          ? e.taskId!
          : ((e.taskStatus === 'done' || e.taskStatus === 'error') && s.streamingTaskId === e.taskId ? null : s.streamingTaskId)
      })
      return
    }
    // LIVE preview: whenever the agent successfully writes/edits a file, bump
    // the preview token so the iframe reloads immediately — user sees the
    // change WHILE the agent is still working, not only after the turn ends.
    if (
      e.type === 'tool_result' && !e.isError &&
      (e.toolName === 'code_write' || e.toolName === 'code_edit')
    ) {
      set({ previewToken: s.previewToken + 1 })
    }
    // 跨需求护栏：某需求的流可能还在发，但用户已切到别的需求标签。task_status
    // 按 taskId 匹配（外来的不会命中，无害）、preview 是项目级——都已在上面处理；
    // 但 append 流式文本/工具气泡必须只进当前屏幕上的需求，否则需求 A 的输出会
    // 漏进需求 B 的对话。事件后端统一盖了 requestId；仅当已知且与当前 active
    // 不同才丢弃（propose 期间 requestId 未定、或 request_ready 已先切 tab 都不受影响）。
    if (e.requestId && e.requestId !== s.activeRequestId) return
    const synthetic: VibeMessageInfo = {
      id: `live-${Date.now()}-${Math.random()}`,
      requestId: s.activeRequestId ?? '',
      role: e.type === 'text' ? 'assistant' : (e.type === 'system' ? 'system' : 'tool'),
      // Scrub URLs/IPs/domains from anything surfaced in the live run log — tool
      // arg/result previews and streamed text can carry the provider host or
      // fetched URLs. Only the transient `live-` messages are affected; the
      // final DB-persisted messages (re-fetched on done) stay faithful.
      content: scrubAddresses(
        e.type === 'text' ? (e.text ?? '') :
        e.type === 'tool_use' ? (e.toolArgsPreview ?? '') :
        e.type === 'tool_result' ? (e.toolResultPreview ?? '') :
        e.type === 'system' ? (e.text ?? '') :
        ''
      ),
      toolName: e.toolName ?? null,
      toolArgs: null,
      isError: !!e.isError,
      taskId: e.taskId ?? null,
      createdAt: Date.now()
    }
    // Merge contiguous text streams
    if (e.type === 'text' && s.messages.length > 0) {
      const last = s.messages[s.messages.length - 1]
      if (last.role === 'assistant' && last.taskId === (e.taskId ?? null) && last.id.startsWith('live-')) {
        const merged = { ...last, content: last.content + scrubAddresses(e.text ?? '') }
        set({ messages: [...s.messages.slice(0, -1), merged] })
        return
      }
    }
    set({ messages: [...s.messages, synthetic] })
  },

  setRunning: (r) => set({ running: r }),
  setErrorBanner: (s) => set({ errorBanner: s }),
  setChangesCount: (n) => set({ changesCount: n }),

  openFileTab: (filePath, content) => {
    const s = get()
    const key = fileTabKey(filePath)
    const existing = s.openTabs.find(t => t.key === key)
    if (existing) {
      set({ activeTabKey: key })
      return
    }
    const newTab: OpenTab = {
      kind: 'file', key, path: filePath,
      content, diskContent: content, dirty: false
    }
    set({ openTabs: [...s.openTabs, newTab], activeTabKey: key })
  },

  openDiffTab: (filePath) => {
    const s = get()
    const key = diffTabKey(filePath)
    const existing = s.openTabs.find(t => t.key === key)
    if (existing) { set({ activeTabKey: key }); return }
    const newTab: OpenTab = { kind: 'diff', key, path: filePath }
    set({ openTabs: [...s.openTabs, newTab], activeTabKey: key })
  },

  openRequestTab: (requestId) => {
    const s = get()
    const key = requestTabKey(requestId)
    const existing = s.openTabs.find(t => t.key === key)
    if (existing) {
      set({ activeTabKey: key, activeRequestId: requestId })
      return
    }
    const newTab: OpenTab = { kind: 'request', key, requestId }
    set({
      openTabs: [...s.openTabs, newTab],
      activeTabKey: key,
      activeRequestId: requestId
    })
  },

  switchTab: (key) => {
    const s = get()
    const tab = s.openTabs.find(t => t.key === key)
    if (!tab) return
    set({
      activeTabKey: key,
      activeRequestId: tab.kind === 'request' ? tab.requestId : s.activeRequestId
    })
  },

  closeTab: (key) => {
    const s = get()
    const tabs = s.openTabs.filter(t => t.key !== key)
    let active = s.activeTabKey
    if (s.activeTabKey === key) {
      const idx = s.openTabs.findIndex(t => t.key === key)
      active = tabs[idx]?.key ?? tabs[idx - 1]?.key ?? tabs[0]?.key ?? null
    }
    // If we closed the request tab whose request was active, clear active request
    const closedTab = s.openTabs.find(t => t.key === key)
    const stillHasRequestTab = closedTab?.kind === 'request'
      ? tabs.some(t => t.kind === 'request' && t.requestId === closedTab.requestId)
      : true
    set({
      openTabs: tabs,
      activeTabKey: active,
      activeRequestId: stillHasRequestTab ? s.activeRequestId : null
    })
  },

  closeOtherTabs: (key) => {
    const s = get()
    const kept = s.openTabs.find(t => t.key === key)
    if (!kept) return
    set({
      openTabs: [kept],
      activeTabKey: key,
      activeRequestId: kept.kind === 'request' ? kept.requestId : null
    })
  },

  closeTabsToRight: (key) => {
    const s = get()
    const idx = s.openTabs.findIndex(t => t.key === key)
    if (idx < 0) return
    const tabs = s.openTabs.slice(0, idx + 1)
    // If the previously-active tab survived, keep it focused; otherwise focus
    // the anchor tab the user right-clicked on.
    const stillActive = tabs.find(t => t.key === s.activeTabKey)
    const nextActive = stillActive?.key ?? key
    const activeTab = tabs.find(t => t.key === nextActive)
    set({
      openTabs: tabs,
      activeTabKey: nextActive,
      activeRequestId: activeTab?.kind === 'request' ? activeTab.requestId : null
    })
  },

  closeAllTabs: () => {
    set({ openTabs: [], activeTabKey: null, activeRequestId: null })
  },

  reorderTab: (fromKey, toKey, side) => {
    if (fromKey === toKey) return
    const s = get()
    const fromIdx = s.openTabs.findIndex(t => t.key === fromKey)
    if (fromIdx < 0) return
    const tabs = s.openTabs.slice()
    const [moved] = tabs.splice(fromIdx, 1)
    // Recompute the target index *after* removal so the insert lands where the
    // user actually pointed, even when dragging rightward past the target.
    const newTargetIdx = tabs.findIndex(t => t.key === toKey)
    const insertAt = newTargetIdx < 0
      ? tabs.length
      : (side === 'left' ? newTargetIdx : newTargetIdx + 1)
    tabs.splice(insertAt, 0, moved)
    set({ openTabs: tabs })
  },

  setFileTabContent: (path, next) => {
    const s = get()
    const key = fileTabKey(path)
    const updated = s.openTabs.map(t =>
      t.kind === 'file' && t.key === key
        ? { ...t, content: next, dirty: next !== t.diskContent }
        : t
    )
    set({ openTabs: updated })
  },

  markFileTabClean: (path) => {
    const s = get()
    const key = fileTabKey(path)
    const updated = s.openTabs.map(t =>
      t.kind === 'file' && t.key === key
        ? { ...t, diskContent: t.content, dirty: false }
        : t
    )
    set({ openTabs: updated })
  },

  // Agent wrote this file on disk → reflect it in an open tab. Clean tab adopts
  // the new content (so it's never stale); a dirty tab keeps the user's unsaved
  // edits but updates diskContent (stays dirty, next save still wins).
  refreshFileTabFromDisk: (path, newContent) => {
    const s = get()
    const key = fileTabKey(path)
    let hit = false
    const updated = s.openTabs.map(t => {
      if (t.kind !== 'file' || t.key !== key) return t
      hit = true
      return t.dirty
        ? { ...t, diskContent: newContent }
        : { ...t, content: newContent, diskContent: newContent, dirty: false }
    })
    if (hit) set({ openTabs: updated })
  },

  togglePreview: () => set(s => ({ showPreview: !s.showPreview })),
  bumpPreview: () => set(s => ({ previewToken: s.previewToken + 1 })),

  toggleFileExplorer: () => set(s => ({ showFileExplorer: !s.showFileExplorer })),

  toggleTerminal: () => set(s => ({ showTerminal: !s.showTerminal })),
  setShowTerminal: (v) => set({ showTerminal: v }),
  setPanelTab: (t) => set({ panelTab: t }),

  setCursor: (line, col) => set({ cursorLine: line, cursorCol: col }),
  setCursorLanguage: (lang) => set({ cursorLanguage: lang }),

  setPendingShellOpen: (target) => set({ pendingShellOpen: target }),

  // Preserve `showTerminal` and `pendingShellOpen` — the first is a UI
  // preference, the second is a queued event that the new project must still
  // see (otherwise opening a file via Explorer would silently drop on the
  // subsequent project switch this very call triggers).
  reset: () => set(s => ({ ...initial, showTerminal: s.showTerminal, pendingShellOpen: s.pendingShellOpen }))
}))
