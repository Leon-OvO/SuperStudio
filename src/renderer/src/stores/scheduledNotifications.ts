import { create } from 'zustand'

interface State {
  /** taskId → true when a scheduled run wrote new content but the user
   *  hasn't opened that task's detail since. Cleared on visit. */
  unread: Record<string, boolean>
  markUnread: (taskId: string) => void
  clear: (taskId: string) => void
  clearAll: () => void
}

export const useScheduledNotifications = create<State>((set) => ({
  unread: {},
  markUnread: (taskId) =>
    set(s => s.unread[taskId] ? s : { unread: { ...s.unread, [taskId]: true } }),
  clear: (taskId) =>
    set(s => {
      if (!s.unread[taskId]) return s
      const next = { ...s.unread }
      delete next[taskId]
      return { unread: next }
    }),
  clearAll: () => set({ unread: {} })
}))
