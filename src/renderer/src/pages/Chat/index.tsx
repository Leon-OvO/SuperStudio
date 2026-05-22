import React, { useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat'
import { useUIStore } from '../../stores/ui'
import { resolveModel } from '../../lib/auto-router'
import { SessionList } from './SessionList'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { AgentProgress } from './AgentProgress'
import { ChatHeader, computeImageSize, DEFAULT_IMAGE_PARAMS } from './ChatHeader'
import type { ImageParams } from './ChatHeader'
import type { AgentProgressEvent, Message } from '../../../../shared/ipc-types'
import { randomId } from '../../lib/id'
import { ImageEditor } from '../../components/ui/ImageEditor'
import { buildExportTarget } from '../../lib/session-export'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

interface Attachment { name: string; path: string; mimeType: string }

export function ChatPage() {
  const {
    sessions, activeSessionId, messages, isRunning, sessionModel, mountedSpaceIds,
    setSessions, setActiveSession, addSession, removeSession, updateSessionTitle,
    setMessages, addMessage, removeMessage, removeMessagesFrom, updateMessageContent,
    setRunning, updateStep, clearSteps,
    setSessionModel, setMountedSpaces
  } = useChatStore()

  const {
    pendingChatAttachments, setPendingChatAttachments,
    pendingChatImageMode, setPendingChatImageMode
  } = useUIStore()

  const unsubRef = useRef<Array<() => void>>([])
  const defaultModelRef = useRef<{ providerId: string; model: string } | null>(null)
  const defaultImageModelRef = useRef<{ providerId: string; model: string } | null>(null)
  const lastSentRef = useRef<{ text: string; attachments?: Array<{ name: string; path: string; mimeType: string }> } | null>(null)
  const pendingAutoRouteRef = useRef<{ intent: string } | null>(null)
  const [imageParamsMap, setImageParamsMap] = React.useState<Record<string, ImageParams>>({})
  const [defaultImageModel, setDefaultImageModel] = React.useState<string>('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  // Top-level ImageEditor — any image in the chat surface can open it.
  const [editorSrc, setEditorSrc] = React.useState<string | null>(null)
  const [providersCount, setProvidersCount] = React.useState<number | null>(null)
  const [defaultChatModel, setDefaultChatModelState] = React.useState<string>('')
  const dlg = useConfirmDialog()

  useEffect(() => {
    loadSessions()
    const loadSettings = () => window.api.getSettings().then((s: { defaultChatProviderId: string; defaultChatModel: string; defaultImageModel?: string; defaultImageProviderId?: string }) => {
      defaultModelRef.current = { providerId: s.defaultChatProviderId, model: s.defaultChatModel }
      setDefaultChatModelState(s.defaultChatModel || '')
      setDefaultImageModel(s.defaultImageModel || '')
      if (s.defaultImageProviderId && s.defaultImageModel) {
        defaultImageModelRef.current = { providerId: s.defaultImageProviderId, model: s.defaultImageModel }
      }
    })
    loadSettings()
    // Re-read settings when window gets focus — picks up changes made in Settings tab
    const settingsFocusHandler = () => loadSettings()
    window.addEventListener('focus', settingsFocusHandler)
    unsubRef.current.push(() => window.removeEventListener('focus', settingsFocusHandler))
    // Track provider count for the empty-state onboarding
    const refreshProviders = () => window.api.listProviders().then((p: unknown[]) => setProvidersCount(p.length))
    refreshProviders()
    const focusHandler = () => refreshProviders()
    window.addEventListener('focus', focusHandler)
    const detach = () => window.removeEventListener('focus', focusHandler)
    unsubRef.current.push(detach)

    // Global "new chat" shortcut → trigger our local handler
    const newChatHandler = () => { handleNewSession() }
    window.addEventListener('app:new-chat', newChatHandler)
    unsubRef.current.push(() => window.removeEventListener('app:new-chat', newChatHandler))

    // Reload sessions when chat import completes in Settings
    const reloadChatsHandler = () => { loadSessions() }
    window.addEventListener('app:chats-reloaded', reloadChatsHandler)
    unsubRef.current.push(() => window.removeEventListener('app:chats-reloaded', reloadChatsHandler))

    // Command palette → jump to a specific session
    const selectSessionHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string }
      if (detail?.sessionId) handleSelectSession(detail.sessionId)
    }
    window.addEventListener('app:select-session', selectSessionHandler)
    unsubRef.current.push(() => window.removeEventListener('app:select-session', selectSessionHandler))

    const u1 = window.api.onAgentProgress((event) => {
      updateStep(event as AgentProgressEvent)
    })
    const u2 = window.api.onAgentDone((data: unknown) => {
      const d = data as { sessionId: string; content: string; messageId: string; toolCallLog?: Array<{ toolName: string; args: unknown; result: unknown }>; cancelled?: boolean; sessionTitle?: string; meta?: { model?: string; providerId?: string; providerName?: string; durationMs?: number } }
      setRunning(false)
      if (d.sessionTitle) updateSessionTitle(d.sessionId, d.sessionTitle)
      if (d.content) {
        const autoRoute = pendingAutoRouteRef.current
        pendingAutoRouteRef.current = null
        addMessage(d.sessionId, {
          id: d.messageId || randomId(),
          sessionId: d.sessionId,
          role: 'assistant',
          content: d.content,
          toolCalls: d.toolCallLog?.map(tc => ({
            toolName: tc.toolName,
            args: tc.args as Record<string, unknown>,
            result: tc.result,
            status: 'done' as const
          })),
          meta: {
            ...d.meta,
            ...(autoRoute ? { autoRoutedModel: true, autoRoutedIntent: autoRoute.intent } : {})
          },
          createdAt: Date.now()
        })
      }
    })
    const u3 = window.api.onAgentError((err: unknown) => {
      setRunning(false)
      const e = err as { sessionId?: string; error?: string }
      console.error('Agent error:', err)
      const targetSessionId = e?.sessionId || useChatStore.getState().activeSessionId
      const errorText = e?.error || (typeof err === 'string' ? err : JSON.stringify(err))
      const isRetryable = isTransientError(errorText)
      if (targetSessionId) {
        addMessage(targetSessionId, {
          id: randomId(),
          sessionId: targetSessionId,
          role: 'assistant',
          content: `⚠️ 执行出错\n\n${errorText}`,
          // Store retry hint in a custom field via createdAt trick — we use a special negative marker
          // Actually, we store it cleanly as a toolCall with a special name
          toolCalls: isRetryable ? [{ toolName: '__retry__', args: {}, result: null, status: 'error' as const }] : undefined,
          createdAt: Date.now()
        })
      }
    })

    unsubRef.current = [u1, u2, u3]
    return () => { unsubRef.current.forEach(fn => fn?.()) }
  }, [])

  // Consume pending attachments / image-mode set by Gallery "use as reference"
  useEffect(() => {
    if (pendingChatAttachments && pendingChatAttachments.length > 0) {
      setAttachments(prev => [...prev, ...pendingChatAttachments])
      setPendingChatAttachments(null)
    }
  }, [pendingChatAttachments, setPendingChatAttachments])

  useEffect(() => {
    if (pendingChatImageMode && activeSessionId && defaultImageModelRef.current) {
      const { providerId, model } = defaultImageModelRef.current
      setSessionModel(activeSessionId, providerId, model)
      setPendingChatImageMode(false)
    }
  }, [pendingChatImageMode, activeSessionId, setSessionModel, setPendingChatImageMode])

  // Clear attachments when switching sessions
  useEffect(() => {
    setAttachments([])
  }, [activeSessionId])

  async function loadSessions() {
    const data = await window.api.listSessions()
    setSessions(data)
    if (data.length > 0 && !activeSessionId) {
      setActiveSession(data[0].id)
      loadMessages(data[0].id)
    }
  }

  async function loadMessages(sessionId: string) {
    const msgs = await window.api.listMessages(sessionId)
    setMessages(sessionId, msgs)
  }

  async function handleNewSession() {
    const session = await window.api.createSession()
    addSession(session)
    setActiveSession(session.id)
    setMessages(session.id, [])
    if (defaultModelRef.current) {
      setSessionModel(session.id, defaultModelRef.current.providerId, defaultModelRef.current.model)
    }
  }

  async function handleSelectSession(id: string) {
    if (isRunning) return
    setActiveSession(id)
    if (!messages[id]) loadMessages(id)
    if (!sessionModel[id] && defaultModelRef.current) {
      setSessionModel(id, defaultModelRef.current.providerId, defaultModelRef.current.model)
    }
  }

  async function handleDeleteSession(id: string) {
    await window.api.deleteSession(id)
    removeSession(id)
  }

  async function handleArchiveSession(id: string, archived: boolean) {
    await window.api.archiveSession(id, archived)
    const data = await window.api.listSessions()
    setSessions(data)
  }

  async function doSend(sessionId: string, text: string, attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    clearSteps()
    setRunning(true)
    const override = sessionModel[sessionId]
    const imgParams = imageParamsMap[sessionId] || DEFAULT_IMAGE_PARAMS
    const imageSize = computeImageSize(imgParams.resolution, imgParams.ratio)
    const imageQuality = imgParams.quality
    const imageCount = imgParams.count
    await window.api.runAgent(
      sessionId,
      text,
      attachments,
      {
        ...(override ? { providerId: override.providerId, model: override.model } : {}),
        mountedSpaceIds: mountedSpaceIds.length ? mountedSpaceIds : undefined,
        imageSize,
        imageQuality,
        imageCount
      }
    )
  }

  async function handleSend(text: string, attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    if (!activeSessionId || isRunning) return
    lastSentRef.current = { text, attachments }

    // Auto-model routing: resolve before adding user message to avoid UI flicker
    try {
      const [settings, providers] = await Promise.all([
        window.api.getSettings(),
        window.api.listProviders()
      ])
      if (settings.autoModelEnabled) {
        const route = await resolveModel(text, attachments ?? [], settings, providers)
        if (route) {
          setSessionModel(activeSessionId, route.providerId, route.model)
          pendingAutoRouteRef.current = { intent: route.intent }
        }
      }
    } catch { /* routing failure is non-fatal */ }

    const userMsg: Message = {
      id: randomId(),
      sessionId: activeSessionId,
      role: 'user',
      content: text,
      attachments: attachments?.map(a => ({ ...a, type: 'file' as const })),
      createdAt: Date.now()
    }
    addMessage(activeSessionId, userMsg)
    await doSend(activeSessionId, text, attachments)
  }

  async function handleRetry() {
    if (!activeSessionId || isRunning || !lastSentRef.current) return
    const { text, attachments } = lastSentRef.current
    await doSend(activeSessionId, text, attachments)
  }

  async function handleStop() {
    if (!activeSessionId) return
    // Unblock the UI immediately — the engine may still be stuck awaiting a
    // hung tool call, in which case no AGENT_DONE/AGENT_ERROR would ever
    // arrive to clear isRunning. The engine discards its (now stale) result.
    setRunning(false)
    clearSteps()
    await window.api.stopAgent(activeSessionId)
  }

  /** Delete a single message (both DB + store). No cascade. */
  async function handleDeleteMessage(messageId: string) {
    if (!activeSessionId || isRunning) return
    if (!(await dlg.confirm({ message: '确定删除这条消息？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteMessage(messageId)
    removeMessage(activeSessionId, messageId)
  }

  /**
   * Regenerate the last assistant response.
   *  1. Drop the assistant message (DB + store)
   *  2. Re-run the agent with the prior user message intact
   */
  async function handleRegenerate(assistantMessageId: string) {
    if (!activeSessionId || isRunning) return
    const list = messages[activeSessionId] ?? []
    const idx = list.findIndex(m => m.id === assistantMessageId)
    if (idx < 0) return
    // Find the user message immediately before
    let userIdx = idx - 1
    while (userIdx >= 0 && list[userIdx].role !== 'user') userIdx--
    if (userIdx < 0) return
    const userMsg = list[userIdx]

    await window.api.deleteMessage(assistantMessageId)
    removeMessage(activeSessionId, assistantMessageId)

    const attachments = userMsg.attachments?.filter(a => a.type === 'file').map(a => ({
      name: a.name, path: a.path, mimeType: a.mimeType
    }))
    lastSentRef.current = { text: userMsg.content, attachments }
    await doSend(activeSessionId, userMsg.content, attachments)
  }

  /**
   * Edit a user message: drops the edited message and everything after it,
   * persists the new content, then re-sends through the agent.
   */
  async function handleEditUserMessage(messageId: string, newContent: string) {
    if (!activeSessionId || isRunning) return
    const list = messages[activeSessionId] ?? []
    const target = list.find(m => m.id === messageId)
    if (!target || target.role !== 'user') return
    const trimmed = newContent.trim()
    if (!trimmed || trimmed === target.content) return

    // Cascade: nuke this msg + every subsequent msg in this session
    await window.api.deleteMessagesFrom(messageId)
    removeMessagesFrom(activeSessionId, messageId)

    // Send fresh
    await handleSend(trimmed, target.attachments?.filter(a => a.type === 'file').map(a => ({
      name: a.name, path: a.path, mimeType: a.mimeType
    })))
    // handleSend will write the new user message; updateMessageContent isn't
    // used here because the new user msg gets a fresh id (cleaner timeline).
    void updateMessageContent  // keep import alive
  }

  /** Serialize current session to MD or JSON and write to a user-picked path. */
  async function handleExportSession(format: 'markdown' | 'json') {
    if (!activeSessionId) return
    const title = activeSession?.title || '未命名对话'
    const target = buildExportTarget(format, title, currentMessages)
    try {
      const result = await window.api.saveTextAs({
        defaultName: target.defaultName,
        content: target.content,
        filters: target.filters
      })
      if (!result.canceled) console.log('[export] session saved to', result.filePath)
    } catch (e) {
      toast.error('导出失败：' + (e as Error).message)
    }
  }

  async function handleSaveAsWorkflow() {
    if (!activeSessionId) return
    try {
      const result = await window.api.workflowFromChat(activeSessionId)
      if (result?.nodes?.length) {
        const saved = await window.api.saveWorkflow({
          name: '从对话生成的工作流',
          description: '',
          definition: result
        })
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'workflow', workflowId: saved?.id } }))
      } else {
        toast.info('当前会话没有可提取的工具调用记录。')
      }
    } catch (e) {
      toast.error('生成工作流失败：' + (e as Error).message)
    }
  }

  const currentMessages = activeSessionId ? (messages[activeSessionId] || []) : []
  const currentOverride = activeSessionId ? sessionModel[activeSessionId] : null
  const canRetry = !isRunning && !!lastSentRef.current
  const isImageMode = !!(currentOverride?.model && defaultImageModel && currentOverride.model === defaultImageModel)
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const currentImageParams = activeSessionId ? (imageParamsMap[activeSessionId] || DEFAULT_IMAGE_PARAMS) : DEFAULT_IMAGE_PARAMS

  return (
    <div className="flex h-full">
      <SessionList
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        onDelete={handleDeleteSession}
        onArchive={handleArchiveSession}
        isRunning={isRunning}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <ChatHeader
          sessionId={activeSessionId}
          sessionTitle={activeSession?.title || ''}
          onSaveAsWorkflow={handleSaveAsWorkflow}
          onExport={activeSessionId ? handleExportSession : undefined}
          onRename={activeSessionId ? async (newTitle) => {
            await window.api.renameSession(activeSessionId, newTitle)
            updateSessionTitle(activeSessionId, newTitle)
          } : undefined}
        />
        <MessageList
          messages={currentMessages}
          sessionId={activeSessionId}
          onRetry={canRetry ? handleRetry : undefined}
          onEditImage={setEditorSrc}
          providersCount={providersCount}
          defaultChatModel={defaultChatModel}
          onDeleteMessage={handleDeleteMessage}
          onRegenerate={handleRegenerate}
          onEditUserMessage={handleEditUserMessage}
          isRunning={isRunning}
        />
        <AgentProgress />
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isRunning={isRunning}
          disabled={!activeSessionId}
          mountedSpaceIds={mountedSpaceIds}
          onMountedSpacesChange={setMountedSpaces}
          attachments={attachments}
          setAttachments={setAttachments}
          imageMode={isImageMode}
          providerId={currentOverride?.providerId || ''}
          model={currentOverride?.model || ''}
          onModelChange={(p, m) => activeSessionId && setSessionModel(activeSessionId, p, m)}
          imageParams={currentImageParams}
          onImageParamsChange={params => activeSessionId && setImageParamsMap(prev => ({ ...prev, [activeSessionId]: params }))}
          onEditImage={setEditorSrc}
        />
      </div>

      {editorSrc && (
        <ImageEditor
          src={editorSrc}
          sessionId={activeSessionId ?? undefined}
          onClose={() => setEditorSrc(null)}
        />
      )}
      {dlg.element}
    </div>
  )
}

function isTransientError(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('503') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('service unavailable') ||
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('connection')
  )
}
