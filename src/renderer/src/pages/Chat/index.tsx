import React, { useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat'
import { useUIStore } from '../../stores/ui'
import { resolveModel } from '../../lib/auto-router'
import { SessionList } from './SessionList'
import { SessionListResizer } from './SessionListResizer'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { AgentProgress } from './AgentProgress'
import { ChatHeader, computeImageSize, DEFAULT_IMAGE_PARAMS } from './ChatHeader'
import type { ImageParams } from './ChatHeader'
import { extractGeneratedImages } from './extractGeneratedImages'
import type { AgentProgressEvent, Message } from '../../../../shared/ipc-types'
import { randomId } from '../../lib/id'
import { ImageEditor } from '../../components/ui/ImageEditor'
import { buildExportTarget } from '../../lib/session-export'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

interface Attachment { name: string; path: string; mimeType: string }

export function ChatPage() {
  const {
    sessions, activeSessionId, messages, runningSessionIds, sessionModel, computerMode,
    setSessions, setActiveSession, addSession, removeSession, updateSessionTitle,
    setMessages, addMessage, upsertMessage, appendStreamDelta, removeMessage, removeMessagesFrom, updateMessageContent,
    startRun, stopRun, updateStep,
    setSessionModel, setComputerMode, setSessionWorkingDir
  } = useChatStore()

  // "Running" from the active session's point of view — used to gate sending /
  // editing in the current conversation. Navigation between sessions is NOT
  // gated on this, so a stalled run never locks the user out of other chats.
  const isRunning = activeSessionId !== null && runningSessionIds.includes(activeSessionId)

  const {
    pendingChatAttachments, setPendingChatAttachments,
    pendingChatImageMode, setPendingChatImageMode
  } = useUIStore()

  const unsubRef = useRef<Array<() => void>>([])
  const defaultModelRef = useRef<{ providerId: string; model: string } | null>(null)
  const defaultImageModelRef = useRef<{ providerId: string; model: string } | null>(null)
  // Keyed by sessionId — concurrent runs across sessions must not clobber each
  // other's last-sent text (retry) or pending auto-route intent (DONE tagging).
  const lastSentRef = useRef<Record<string, { text: string; attachments?: Array<{ name: string; path: string; mimeType: string }> }>>({})
  const pendingAutoRouteRef = useRef<Record<string, { intent: string }>>({})
  const [imageParamsMap, setImageParamsMap] = React.useState<Record<string, ImageParams>>({})
  const [defaultImageModel, setDefaultImageModel] = React.useState<string>('')
  // Global default image rules (Settings → 模型); seeds each session's per-turn params.
  const [defaultImageRules, setDefaultImageRules] = React.useState<ImageParams>(DEFAULT_IMAGE_PARAMS)
  // Per-turn "强制本轮生成图片" toggle — lets a chat-model session generate an image
  // this turn. Reset on session switch.
  const [forceImage, setForceImage] = React.useState(false)
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  // Top-level ImageEditor — any image in the chat surface can open it.
  const [editorSrc, setEditorSrc] = React.useState<string | null>(null)
  const [providersCount, setProvidersCount] = React.useState<number | null>(null)
  const [defaultChatModel, setDefaultChatModelState] = React.useState<string>('')
  const [computerUseEnabled, setComputerUseEnabled] = React.useState<boolean>(false)
  // If the user disables the Computer Use plugin, drop any leftover per-turn
  // computerMode so it doesn't silently re-arm when the plugin is turned back on.
  useEffect(() => {
    if (!computerUseEnabled && computerMode) setComputerMode(false)
  }, [computerUseEnabled, computerMode, setComputerMode])
  const dlg = useConfirmDialog()

  useEffect(() => {
    loadSessions()
    const loadSettings = () => window.api.getSettings().then((s: { defaultChatProviderId: string; defaultChatModel: string; defaultImageModel?: string; defaultImageProviderId?: string; computerUseEnabled?: boolean; defaultImageRules?: ImageParams }) => {
      defaultModelRef.current = { providerId: s.defaultChatProviderId, model: s.defaultChatModel }
      setDefaultChatModelState(s.defaultChatModel || '')
      setDefaultImageModel(s.defaultImageModel || '')
      setDefaultImageRules(s.defaultImageRules ?? DEFAULT_IMAGE_PARAMS)
      setComputerUseEnabled(s.computerUseEnabled === true)
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
    // Live token streaming — append chunks to a placeholder message keyed by the
    // run's messageId; AGENT_DONE then reconciles it into the final message.
    const uDelta = window.api.onAgentDelta((d) => {
      if (d?.sessionId && d?.messageId) appendStreamDelta(d.sessionId, d.messageId, d.delta)
    })
    const u2 = window.api.onAgentDone((data: unknown) => {
      const d = data as { sessionId: string; content: string; messageId: string; toolCallLog?: Array<{ toolName: string; args: unknown; result: unknown }>; cancelled?: boolean; sessionTitle?: string; meta?: { model?: string; providerId?: string; providerName?: string; durationMs?: number } }
      stopRun(d.sessionId)
      if (d.sessionTitle) updateSessionTitle(d.sessionId, d.sessionTitle)
      if (d.content) {
        const autoRoute = pendingAutoRouteRef.current[d.sessionId]
        delete pendingAutoRouteRef.current[d.sessionId]
        // upsert (not add): replaces the streamed placeholder of the same id, or
        // appends when this path didn't stream (e.g. direct image generation).
        upsertMessage(d.sessionId, {
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
      const e = err as { sessionId?: string; error?: string }
      console.error('Agent error:', err)
      const targetSessionId = e?.sessionId || useChatStore.getState().activeSessionId
      if (targetSessionId) stopRun(targetSessionId)
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

    unsubRef.current = [u1, uDelta, u2, u3]
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

  // Clear attachments + the per-turn force-image toggle when switching sessions
  useEffect(() => {
    setAttachments([])
    setForceImage(false)
  }, [activeSessionId])

  async function loadSessions() {
    const data = await window.api.listSessions()
    setSessions(data)
    // Default-pick must skip scheduled-task sessions: they're hidden from the
    // sidebar (SessionList filters isScheduled), but they bubble to the top of
    // this list by updated_at right after a task fires — picking data[0] blindly
    // would show the task's conversation with nothing selected in the sidebar.
    if (!activeSessionId) {
      const firstNormal = data.find(s => s.isScheduled !== 1)
      if (firstNormal) {
        setActiveSession(firstNormal.id)
        loadMessages(firstNormal.id)
      }
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

  /** Return the active session id, lazily creating + activating a fresh one if
   *  there is none yet (first launch, or after deleting all conversations). Lets
   *  the user just start typing in an empty app — a session is persisted only when
   *  they actually send, so we never leave behind phantom empty conversations. */
  async function ensureSession(): Promise<string> {
    if (activeSessionId) return activeSessionId
    const session = await window.api.createSession()
    addSession(session)
    setActiveSession(session.id)
    setMessages(session.id, [])
    if (defaultModelRef.current) {
      setSessionModel(session.id, defaultModelRef.current.providerId, defaultModelRef.current.model)
    }
    return session.id
  }

  // Pin / clear this conversation's working directory. Lazily creates a session
  // if there's none yet (same pattern as handleSend) so the user can set it on a
  // brand-new chat. Persisted in the main process (which validates the path) and
  // mirrored into the store so the chip + next run pick it up immediately.
  async function handleSetWorkingDir(dir: string) {
    const sid = await ensureSession()
    const res = await window.api.setSessionWorkingDir(sid, dir)
    if (res?.ok) setSessionWorkingDir(sid, res.workingDir ?? dir)
    else toast.error(res?.error || '设置工作目录失败')
  }

  async function handleSelectSession(id: string) {
    // Navigation is always allowed — even while a run is in flight. The running
    // agent keeps streaming into its own session (events are keyed by sessionId),
    // so switching away never loses its result and never locks the user out.
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
    startRun(sessionId)
    const override = sessionModel[sessionId]
    const imgParams = imageParamsMap[sessionId] || defaultImageRules
    const imageSize = computeImageSize(imgParams.resolution, imgParams.ratio)
    const imageQuality = imgParams.quality
    const imageCount = imgParams.count
    await window.api.runAgent(
      sessionId,
      text,
      attachments,
      {
        ...(override ? { providerId: override.providerId, model: override.model } : {}),
        imageSize,
        imageQuality,
        imageCount,
        computerMode: computerMode || undefined,
        forceImage: forceImage || undefined
      }
    )
  }

  async function handleSend(text: string, attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    if (isRunning) return
    // No active session yet (first use)? Create one on the fly so the user can
    // type+send straight away without first clicking 「新建对话」.
    const sessionId = await ensureSession()
    lastSentRef.current[sessionId] = { text, attachments }

    // Auto-model routing: resolve before adding user message to avoid UI flicker
    try {
      const [settings, providers] = await Promise.all([
        window.api.getSettings(),
        window.api.listProviders()
      ])
      if (settings.autoModelEnabled) {
        const route = await resolveModel(text, attachments?.map(a => ({ ...a, type: 'file' as const })) ?? [], settings, providers)
        if (route) {
          setSessionModel(sessionId, route.providerId, route.model)
          pendingAutoRouteRef.current[sessionId] = { intent: route.intent }
        }
      }
    } catch { /* routing failure is non-fatal */ }

    const userMsg: Message = {
      id: randomId(),
      sessionId,
      role: 'user',
      content: text,
      attachments: attachments?.map(a => ({ ...a, type: 'file' as const })),
      createdAt: Date.now()
    }
    addMessage(sessionId, userMsg)
    await doSend(sessionId, text, attachments)
  }

  async function handleRetry() {
    if (!activeSessionId || isRunning) return
    const last = lastSentRef.current[activeSessionId]
    if (!last) return
    await doSend(activeSessionId, last.text, last.attachments)
  }

  async function handleStop() {
    // The Stop button belongs to the active conversation, so stop that session's
    // run. Unblock the UI immediately — the engine may still be stuck awaiting a
    // hung tool call, in which case no AGENT_DONE/AGENT_ERROR would ever arrive to
    // clear the running state. The engine discards its (now stale) result.
    if (!activeSessionId) return
    stopRun(activeSessionId)
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
    lastSentRef.current[activeSessionId] = { text: userMsg.content, attachments }
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

  // Add a generated (or any) image as a reference for the next image turn, and flip
  // on the 生成图片 toggle (strong "I want to build on this" intent). No model switch —
  // the engine uses image attachments as references in the forced / tool path.
  const handleUseAsReference = React.useCallback((imgPath: string) => {
    const name = imgPath.split(/[\\/]/).pop() || 'reference.png'
    const ext = (name.split('.').pop() || 'png').toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif'
      : ext === 'bmp' ? 'image/bmp' : 'image/png'
    setAttachments(prev => prev.some(a => a.path === imgPath) ? prev : [...prev, { name, path: imgPath, mimeType: mime }])
    setForceImage(true)
    toast.info('已加入参考图，继续输入提示词即可基于它生成')
  }, [])

  const currentMessages = activeSessionId ? (messages[activeSessionId] || []) : []
  // Images this conversation has generated — feeds the composer's @-mention picker.
  const generatedImages = React.useMemo(() => extractGeneratedImages(currentMessages), [currentMessages])
  const currentOverride = activeSessionId ? sessionModel[activeSessionId] : null
  const canRetry = !isRunning && !!(activeSessionId && lastSentRef.current[activeSessionId])
  const isImageMode = !!(currentOverride?.model && defaultImageModel && currentOverride.model === defaultImageModel)
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const currentImageParams = activeSessionId ? (imageParamsMap[activeSessionId] || defaultImageRules) : defaultImageRules

  return (
    <div className="flex h-full">
      <SessionList
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        onDelete={handleDeleteSession}
        onArchive={handleArchiveSession}
        runningSessionIds={runningSessionIds}
      />
      <SessionListResizer />
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
          onUseAsReference={handleUseAsReference}
          providersCount={providersCount}
          defaultChatModel={defaultChatModel}
          onDeleteMessage={handleDeleteMessage}
          onRegenerate={handleRegenerate}
          onEditUserMessage={handleEditUserMessage}
          isRunning={isRunning}
          onChoose={(value) => handleSend(value)}
        />
        <AgentProgress />
        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isRunning={isRunning}
          // Always typeable — first-use has no session yet; handleSend lazily
          // creates one on the first send. Only `isRunning` gates input (inside ChatInput).
          disabled={false}
          attachments={attachments}
          setAttachments={setAttachments}
          generatedImages={generatedImages}
          imageMode={isImageMode}
          forceImage={forceImage}
          onForceImageChange={setForceImage}
          computerMode={computerMode}
          onComputerModeChange={setComputerMode}
          computerUseEnabled={computerUseEnabled}
          workingDir={activeSession?.workingDir || ''}
          onSetWorkingDir={handleSetWorkingDir}
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
