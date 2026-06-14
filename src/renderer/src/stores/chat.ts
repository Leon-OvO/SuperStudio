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
  /** Ids of every session whose agent run is currently in flight. The engine
   *  runs one agent per session concurrently (Map<sessionId, AbortController>),
   *  so this must be a set — a single id would let a second session's run clobber
   *  the first's tracked state and leave its spinner stuck. */
  runningSessionIds: string[]
  /** Progress steps keyed by session. Global state here would mean switching to
   *  / starting another session wipes the in-flight session's step list. */
  stepsBySession: Record<string, AgentStep[]>
  mountedSpaceIds: string[]
  /** Per-turn "电脑操控" mode toggle (runs the screenshot loop on send). */
  computerMode: boolean
  /** Per-session model override: sessionId -> { providerId, model } */
  sessionModel: Record<string, { providerId: string; model: string }>

  setSessions: (sessions: Session[]) => void
  setActiveSession: (id: string) => void
  addSession: (session: Session) => void
  removeSession: (id: string) => void
  updateSessionTitle: (id: string, title: string) => void
  setMessages: (sessionId: string, messages: Message[]) => void
  addMessage: (sessionId: string, message: Message) => void
  /** Replace a message with the same id, or append if absent. Used by AGENT_DONE
   *  to reconcile a streamed placeholder into the authoritative final message. */
  upsertMessage: (sessionId: string, message: Message) => void
  /** Append a streamed assistant text chunk, creating a placeholder message on
   *  the first delta so tokens render live before AGENT_DONE arrives. In group
   *  chat, speakerEmployeeId tags the placeholder so the speaker shows immediately. */
  appendStreamDelta: (sessionId: string, messageId: string, delta: string, speakerEmployeeId?: string) => void
  removeMessage: (sessionId: string, messageId: string) => void
  removeMessagesFrom: (sessionId: string, messageId: string) => void
  updateMessageContent: (sessionId: string, messageId: string, content: string) => void
  /** Mark a session's run as started (also resets that session's step list). */
  startRun: (sessionId: string) => void
  /** Clear a session's running state. Only ever touches the given session, so a
   *  stale DONE/ERROR from one session can't unblock or disturb another. */
  stopRun: (sessionId: string) => void
  updateStep: (step: AgentProgressEvent) => void
  clearSteps: (sessionId: string) => void
  setMountedSpaces: (ids: string[]) => void
  setComputerMode: (on: boolean) => void
  setSessionModel: (sessionId: string, providerId: string, model: string) => void
  /** Update a session's working directory in the local list (after the main
   *  process has persisted it via setSessionWorkingDir IPC). */
  setSessionWorkingDir: (sessionId: string, dir: string) => void
  /** Update a session's bound employee in the local list (after the main process
   *  has persisted it via setSessionAssignee IPC). null = unbound. */
  setSessionAssignee: (sessionId: string, employeeId: string | null) => void
  /** Update a group session's member list locally (after add/remove member IPC). */
  setSessionGroupEmployees: (sessionId: string, ids: string[]) => void
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeSessionId: null,
  messages: {},
  runningSessionIds: [],
  stepsBySession: {},
  mountedSpaceIds: [],
  computerMode: false,
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
  upsertMessage: (sessionId, message) => set(s => {
    const list = s.messages[sessionId] || []
    const idx = list.findIndex(m => m.id === message.id)
    if (idx < 0) return { messages: { ...s.messages, [sessionId]: [...list, message] } }
    const next = [...list]
    next[idx] = message
    return { messages: { ...s.messages, [sessionId]: next } }
  }),
  appendStreamDelta: (sessionId, messageId, delta, speakerEmployeeId) => set(s => {
    const list = s.messages[sessionId] || []
    const idx = list.findIndex(m => m.id === messageId)
    if (idx >= 0) {
      const next = [...list]
      next[idx] = { ...next[idx], content: (next[idx].content || '') + delta }
      return { messages: { ...s.messages, [sessionId]: next } }
    }
    const placeholder: Message = {
      id: messageId, sessionId, role: 'assistant', content: delta, createdAt: Date.now(),
      ...(speakerEmployeeId ? { speakerEmployeeId } : {})
    }
    return { messages: { ...s.messages, [sessionId]: [...list, placeholder] } }
  }),
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
  startRun: (sessionId) => set(s => ({
    runningSessionIds: s.runningSessionIds.includes(sessionId)
      ? s.runningSessionIds
      : [...s.runningSessionIds, sessionId],
    stepsBySession: { ...s.stepsBySession, [sessionId]: [] }
  })),
  stopRun: (sessionId) => set(s => ({
    runningSessionIds: s.runningSessionIds.filter(id => id !== sessionId)
  })),
  updateStep: (event) => set(s => {
    const steps = [...(s.stepsBySession[event.sessionId] || [])]
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
    return { stepsBySession: { ...s.stepsBySession, [event.sessionId]: steps } }
  }),
  clearSteps: (sessionId) => set(s => ({
    stepsBySession: { ...s.stepsBySession, [sessionId]: [] }
  })),
  setMountedSpaces: (ids) => set({ mountedSpaceIds: ids }),
  setComputerMode: (on) => set({ computerMode: on }),
  setSessionModel: (sessionId, providerId, model) => set(s => ({
    sessionModel: { ...s.sessionModel, [sessionId]: { providerId, model } }
  })),
  setSessionWorkingDir: (sessionId, dir) => set(s => ({
    sessions: s.sessions.map(sess => sess.id === sessionId ? { ...sess, workingDir: dir } : sess)
  })),
  setSessionAssignee: (sessionId, employeeId) => set(s => ({
    sessions: s.sessions.map(sess => sess.id === sessionId ? { ...sess, employeeId } : sess)
  })),
  setSessionGroupEmployees: (sessionId, ids) => set(s => ({
    sessions: s.sessions.map(sess => sess.id === sessionId ? { ...sess, groupEmployeeIds: ids } : sess)
  }))
}))
