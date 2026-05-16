import { create } from 'zustand'
import type { Session, Message, AgentProgressEvent } from '../../../shared/ipc-types'

interface AgentStep {
  index: number
  name: string
  toolName?: string
  status: 'running' | 'done' | 'error'
  message?: string
  artifact?: { type: 'image' | 'video'; path: string }
}

interface ChatState {
  sessions: Session[]
  activeSessionId: string | null
  messages: Record<string, Message[]>
  isRunning: boolean
  currentSteps: AgentStep[]
  mountedSpaceIds: string[]
  /** Per-session model override: sessionId -> { providerId, model } */
  sessionModel: Record<string, { providerId: string; model: string }>

  setSessions: (sessions: Session[]) => void
  setActiveSession: (id: string) => void
  addSession: (session: Session) => void
  removeSession: (id: string) => void
  updateSessionTitle: (id: string, title: string) => void
  setMessages: (sessionId: string, messages: Message[]) => void
  addMessage: (sessionId: string, message: Message) => void
  removeMessage: (sessionId: string, messageId: string) => void
  removeMessagesFrom: (sessionId: string, messageId: string) => void
  updateMessageContent: (sessionId: string, messageId: string, content: string) => void
  setRunning: (running: boolean) => void
  updateStep: (step: AgentProgressEvent) => void
  clearSteps: () => void
  setMountedSpaces: (ids: string[]) => void
  setSessionModel: (sessionId: string, providerId: string, model: string) => void
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  isRunning: false,
  currentSteps: [],
  mountedSpaceIds: [],
  sessionModel: {},

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  addSession: (session) => set(s => ({ sessions: [session, ...s.sessions] })),
  updateSessionTitle: (id, title) => set(s => ({
    sessions: s.sessions.map(sess => sess.id === id ? { ...sess, title } : sess)
  })),
  removeSession: (id) => set(s => ({
    sessions: s.sessions.filter(sess => sess.id !== id),
    activeSessionId: s.activeSessionId === id ? (s.sessions.find(sess => sess.id !== id)?.id ?? null) : s.activeSessionId
  })),
  setMessages: (sessionId, messages) => set(s => ({ messages: { ...s.messages, [sessionId]: messages } })),
  addMessage: (sessionId, message) => set(s => ({
    messages: { ...s.messages, [sessionId]: [...(s.messages[sessionId] || []), message] }
  })),
  removeMessage: (sessionId, messageId) => set(s => ({
    messages: { ...s.messages, [sessionId]: (s.messages[sessionId] || []).filter(m => m.id !== messageId) }
  })),
  removeMessagesFrom: (sessionId, messageId) => set(s => {
    const list = s.messages[sessionId] || []
    const idx = list.findIndex(m => m.id === messageId)
    if (idx < 0) return s
    return { messages: { ...s.messages, [sessionId]: list.slice(0, idx) } }
  }),
  updateMessageContent: (sessionId, messageId, content) => set(s => ({
    messages: {
      ...s.messages,
      [sessionId]: (s.messages[sessionId] || []).map(m => m.id === messageId ? { ...m, content } : m)
    }
  })),
  setRunning: (running) => set({ isRunning: running, currentSteps: running ? [] : [] }),
  updateStep: (event) => set(s => {
    const steps = [...s.currentSteps]
    const idx = steps.findIndex(st => st.index === event.stepIndex)
    const step: AgentStep = {
      index: event.stepIndex,
      name: event.stepName,
      toolName: event.toolName,
      status: event.status,
      message: event.message,
      artifact: event.artifact
    }
    if (idx >= 0) steps[idx] = step
    else steps.push(step)
    return { currentSteps: steps }
  }),
  clearSteps: () => set({ currentSteps: [] }),
  setMountedSpaces: (ids) => set({ mountedSpaceIds: ids }),
  setSessionModel: (sessionId, providerId, model) => set(s => ({
    sessionModel: { ...s.sessionModel, [sessionId]: { providerId, model } }
  }))
}))
