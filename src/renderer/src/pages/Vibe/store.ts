import { create } from 'zustand'
import type {
  FileTreeNode, VibeProgressEvent, VibeRequestInfo, VibeTaskInfo, VibeMessageInfo, VibeProjectInfo
} from '../../../../shared/ipc-types'

export type OpenTab =
  | { kind: 'file'; key: string; path: string; content: string; diskContent: string; dirty: boolean }
  | { kind: 'request'; key: string; requestId: string }

export function fileTabKey(p: string): string { return `file:${p}` }
export function requestTabKey(id: string): string { return `request:${id}` }

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
  previewToken: number
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  errorBanner: string | null

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

  // Tab mutators
  openFileTab: (path: string, content: string) => void
  openRequestTab: (requestId: string) => void
  switchTab: (key: string) => void
  closeTab: (key: string) => void
  setFileTabContent: (path: string, next: string) => void
  markFileTabClean: (path: string) => void

  // Preview
  togglePreview: () => void
  bumpPreview: () => void

  // File explorer collapse
  toggleFileExplorer: () => void

  // Terminal drawer
  toggleTerminal: () => void
  setShowTerminal: (v: boolean) => void

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
  previewToken: 0,
  running: null as 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null,
  errorBanner: null as string | null
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
        streamingTaskId: e.taskStatus === 'running' ? e.taskId! : (e.taskStatus === 'done' ? null : s.streamingTaskId)
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
    const synthetic: VibeMessageInfo = {
      id: `live-${Date.now()}-${Math.random()}`,
      requestId: s.activeRequestId ?? '',
      role: e.type === 'text' ? 'assistant' : (e.type === 'system' ? 'system' : 'tool'),
      content:
        e.type === 'text' ? (e.text ?? '') :
        e.type === 'tool_use' ? (e.toolArgsPreview ?? '') :
        e.type === 'tool_result' ? (e.toolResultPreview ?? '') :
        e.type === 'system' ? (e.text ?? '') :
        '',
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
        const merged = { ...last, content: last.content + (e.text ?? '') }
        set({ messages: [...s.messages.slice(0, -1), merged] })
        return
      }
    }
    set({ messages: [...s.messages, synthetic] })
  },

  setRunning: (r) => set({ running: r }),
  setErrorBanner: (s) => set({ errorBanner: s }),

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

  togglePreview: () => set(s => ({ showPreview: !s.showPreview })),
  bumpPreview: () => set(s => ({ previewToken: s.previewToken + 1 })),

  toggleFileExplorer: () => set(s => ({ showFileExplorer: !s.showFileExplorer })),

  toggleTerminal: () => set(s => ({ showTerminal: !s.showTerminal })),
  setShowTerminal: (v) => set({ showTerminal: v }),

  // Preserve `showTerminal` — it's a UI preference, not project state.
  reset: () => set(s => ({ ...initial, showTerminal: s.showTerminal }))
}))
