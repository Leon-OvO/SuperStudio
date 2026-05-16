import React, { useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat'
import { useUIStore } from '../../stores/ui'
import { SessionList } from './SessionList'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { AgentProgress } from './AgentProgress'
import { ChatHeader, computeImageSize, DEFAULT_IMAGE_PARAMS } from './ChatHeader'
import type { ImageParams } from './ChatHeader'
import type { AgentProgressEvent, Message } from '../../../../shared/ipc-types'
import { randomId } from '../../lib/id'

interface Attachment { name: string; path: string; mimeType: string }

export function ChatPage() {
  const {
    sessions, activeSessionId, messages, isRunning, sessionModel, mountedSpaceIds,
    setSessions, setActiveSession, addSession, removeSession, updateSessionTitle,
    setMessages, addMessage, setRunning, updateStep, clearSteps,
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
  const [imageParamsMap, setImageParamsMap] = React.useState<Record<string, ImageParams>>({})
  const [defaultImageModel, setDefaultImageModel] = React.useState<string>('')
  const [attachments, setAttachments] = React.useState<Attachment[]>([])

  useEffect(() => {
    loadSessions()
    window.api.getSettings().then((s: { defaultChatProviderId: string; defaultChatModel: string; defaultImageModel?: string; defaultImageProviderId?: string }) => {
      defaultModelRef.current = { providerId: s.defaultChatProviderId, model: s.defaultChatModel }
      setDefaultImageModel(s.defaultImageModel || '')
      if (s.defaultImageProviderId && s.defaultImageModel) {
        defaultImageModelRef.current = { providerId: s.defaultImageProviderId, model: s.defaultImageModel }
      }
    })

    const u1 = window.api.onAgentProgress((event) => {
      updateStep(event as AgentProgressEvent)
    })
    const u2 = window.api.onAgentDone((data: unknown) => {
      const d = data as { sessionId: string; content: string; messageId: string; toolCallLog?: Array<{ toolName: string; args: unknown; result: unknown }>; cancelled?: boolean; sessionTitle?: string; meta?: { model?: string; providerId?: string; providerName?: string; durationMs?: number } }
      setRunning(false)
      if (d.sessionTitle) updateSessionTitle(d.sessionId, d.sessionTitle)
      if (d.content) {
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
          meta: d.meta,
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

  async function doSend(sessionId: string, text: string, attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    clearSteps()
    setRunning(true)
    const override = sessionModel[sessionId]
    const imgParams = imageParamsMap[sessionId] || DEFAULT_IMAGE_PARAMS
    const imageSize = computeImageSize(imgParams.resolution, imgParams.ratio)
    const imageQuality = imgParams.quality
    await window.api.runAgent(
      sessionId,
      text,
      attachments,
      {
        ...(override ? { providerId: override.providerId, model: override.model } : {}),
        mountedSpaceIds: mountedSpaceIds.length ? mountedSpaceIds : undefined,
        imageSize,
        imageQuality
      }
    )
  }

  async function handleSend(text: string, attachments?: Array<{ name: string; path: string; mimeType: string }>) {
    if (!activeSessionId || isRunning) return
    lastSentRef.current = { text, attachments }

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
    if (activeSessionId) {
      await window.api.stopAgent(activeSessionId)
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
        alert('当前会话没有可提取的工具调用记录。')
      }
    } catch (e) {
      alert('生成工作流失败：' + (e as Error).message)
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
        isRunning={isRunning}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <ChatHeader
          sessionId={activeSessionId}
          sessionTitle={activeSession?.title || ''}
          onSaveAsWorkflow={handleSaveAsWorkflow}
          onRename={activeSessionId ? async (newTitle) => {
            await window.api.renameSession(activeSessionId, newTitle)
            updateSessionTitle(activeSessionId, newTitle)
          } : undefined}
        />
        <MessageList messages={currentMessages} sessionId={activeSessionId} onRetry={canRetry ? handleRetry : undefined} />
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
        />
      </div>
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
