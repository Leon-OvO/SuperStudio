import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message, ToolCallRecord } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'
import { copyImageToClipboard } from '../../lib/clipboard'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { Markdown } from '../../lib/markdown'
import { Play, X, RotateCcw, Clock, Cpu, Copy, Check, Download, Wand2, Brain, ChevronRight, ChevronDown, ChevronUp, Pencil, Trash2, RefreshCw } from 'lucide-react'

function toFileUrl(p: string): string {
  // Three slashes: local-file:///F:/path — empty authority avoids Chromium treating "F:" as host
  const fwd = p.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

/**
 * Extract reasoning/thinking blocks from message content.
 * Many LLMs emit chain-of-thought wrapped in tags:
 *   <think>...</think>           — DeepSeek R1, Qwen
 *   <thinking>...</thinking>     — Claude
 *   <reasoning>...</reasoning>   — some others
 * We strip these from the main answer and surface them in a collapsible panel.
 * Also tolerates a half-open trailing block during streaming (still inside <think>).
 */
function splitThinking(content: string): { reasoning: string; answer: string; streaming: boolean } {
  const blocks: string[] = []
  let answer = content.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g, (_m, _tag, body) => {
    blocks.push(body.trim())
    return ''
  })
  // Half-open trailing block (model still emitting reasoning, hasn't closed yet)
  let streaming = false
  const halfOpen = answer.match(/<(think|thinking|reasoning)>([\s\S]*)$/)
  if (halfOpen) {
    blocks.push(halfOpen[2].trim())
    answer = answer.slice(0, halfOpen.index)
    streaming = true
  }
  return {
    reasoning: blocks.filter(Boolean).join('\n\n').trim(),
    answer: answer.trim(),
    streaming
  }
}

/**
 * Normalize an image path/URL for cross-comparison:
 *   F:\path\img.png        →  f:/path/img.png
 *   file:///F:/path/img.png →  f:/path/img.png
 *   local-file:///F:/path/img.png → f:/path/img.png
 *   https://cdn.x/img.png?v=1 → https://cdn.x/img.png (query stripped)
 */
function normalizeMediaRef(p: string): string {
  return p
    .replace(/^local-file:\/\/\/?/i, '')
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .split(/[?#]/)[0]
    .toLowerCase()
    .trim()
}

/**
 * Remove any Markdown image syntax `![alt](src)` or bare image URLs whose
 * target matches one of the already-rendered artifact paths. Keeps the rest of
 * the prose intact. Run before Markdown parsing.
 */
function stripDuplicateMedia(text: string, duplicatePaths: string[]): string {
  if (!duplicatePaths.length) return text
  const normalized = duplicatePaths.map(normalizeMediaRef).filter(Boolean)
  const isDup = (ref: string) => {
    const n = normalizeMediaRef(ref)
    return normalized.some(d => d === n || d.endsWith(n) || n.endsWith(d))
  }

  let out = text
  // 1. Strip Markdown images
  out = out.replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, src) => {
    return isDup(src) ? '' : full
  })
  // 2. Strip standalone lines whose only content is a duplicate URL/path
  out = out.replace(/^[ \t]*([^\s]+)[ \t]*$/gm, (full, ref) => {
    if (/^https?:\/\//i.test(ref) || /^(file|local-file):\/\//i.test(ref) || /^[a-zA-Z]:[\\/]/.test(ref)) {
      return isDup(ref) ? '' : full
    }
    return full
  })
  // 3. Collapse extra blank lines created by the deletions above
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

interface Props {
  messages: Message[]
  sessionId: string | null
  onRetry?: () => void
  /** Open the global ImageEditor with the given src. Mounted at ChatPage level. */
  onEditImage: (src: string) => void
  /** Total configured LLM providers — drives the first-run onboarding. null = still loading. */
  providersCount?: number | null
  /** Delete a single message by id (no cascade). */
  onDeleteMessage?: (messageId: string) => void
  /** Regenerate a specific assistant response. */
  onRegenerate?: (assistantMessageId: string) => void
  /** Commit an edited user message + cascade re-run. */
  onEditUserMessage?: (messageId: string, newContent: string) => void
  /** Disable hover actions while the agent is running. */
  isRunning?: boolean
}

export function MessageList({
  messages, onRetry, onEditImage, providersCount,
  onDeleteMessage, onRegenerate, onEditUserMessage, isRunning
}: Props) {
  const ctxMenu = useImageContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Variable-height virtualizer — each message bubble can be anywhere from a
  // single line to many paragraphs with images / code / tool cards. We seed
  // an estimate, then let `measureElement` (the ref handed to each row in
  // render below) report the real height as soon as it mounts.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 4,
    getItemKey: (i) => messages[i]?.id ?? i,
    // Build-in measureElement reads getBoundingClientRect after layout
  })

  // Auto-stick to bottom when new messages arrive. We don't track a manual
  // pinned state here — the virtualizer scrolls to the last item which is
  // good enough for "new turn" updates and stop-mid-stream lands us at the
  // current end.
  useEffect(() => {
    if (messages.length === 0) return
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
  }, [messages.length, virtualizer])

  if (messages.length === 0) {
    // First-run onboarding: no providers configured → guide user to Settings.
    if (providersCount === 0) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
              <Cpu size={26} className="text-primary" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold">先配置一个模型提供商</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                SuperStudio 还不知道把请求发到哪。前往「设置 → 提供商」添加 OpenAI、Anthropic、Gemini 或任意 OpenAI 兼容的代理；填好 API Key 就能开始对话、生图、生视频。
              </p>
            </div>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'settings' } }))}
              className="btn-primary"
            >
              去设置
            </button>
            <p className="text-xs text-muted-foreground/70">
              已有可访问 OpenAI 协议的代理？把 baseUrl 填成代理地址，type 选「自定义」即可。
            </p>
          </div>
        </div>
      )
    }
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <p className="text-2xl">✨</p>
          <p>今天能帮你做点什么？</p>
          <p className="text-xs">我可以生成图片、创建视频、分析办公文件等等。</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map(vrow => {
          const idx = vrow.index
          const msg = messages[idx]
          if (!msg) return null
          const isLastMsg = idx === messages.length - 1
          const showRetry = isLastMsg && onRetry && msg.role === 'assistant' && msg.content.startsWith('⚠️')
          return (
            <div
              key={vrow.key}
              data-index={idx}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vrow.start}px)`,
                paddingBottom: 16
              }}
            >
              <MessageBubble
                message={msg}
                onRetry={showRetry ? onRetry : undefined}
                openContextMenu={ctxMenu.open}
                onEditImage={onEditImage}
                onDeleteMessage={onDeleteMessage}
                onRegenerate={onRegenerate}
                onEditUserMessage={onEditUserMessage}
                isRunning={!!isRunning}
              />
            </div>
          )
        })}
      </div>
      {ctxMenu.element}
    </div>
  )
}

interface BubbleProps {
  message: Message
  onRetry?: () => void
  openContextMenu: ReturnType<typeof useImageContextMenu>['open']
  onEditImage: (src: string) => void
  onDeleteMessage?: (messageId: string) => void
  onRegenerate?: (assistantMessageId: string) => void
  onEditUserMessage?: (messageId: string, newContent: string) => void
  isRunning: boolean
}

function MessageBubble({
  message, onRetry, openContextMenu, onEditImage,
  onDeleteMessage, onRegenerate, onEditUserMessage, isRunning
}: BubbleProps) {
  const isUser = message.role === 'user'
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; filePath: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')

  // Split <think>/<thinking> blocks off the answer (assistant messages only)
  const { reasoning, answer, streaming } = useMemo(
    () => isUser ? { reasoning: '', answer: message.content, streaming: false } : splitThinking(message.content),
    [isUser, message.content]
  )

  async function handleLightboxCopy() {
    if (!lightboxSrc) return
    const ok = await copyImageToClipboard(lightboxSrc.src)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  async function handleLightboxSaveAs() {
    if (!lightboxSrc) return
    try {
      await window.api.saveFileAs(lightboxSrc.filePath)
    } catch (e) {
      console.error('[save-as]', e)
    }
  }

  // Extract image and video artifacts from tool calls (skip internal __retry__ marker).
  // Sources covered:
  //  - builtin image_generate: result.images[].path
  //  - builtin video_generate: result.path
  //  - any MCP tool: result.artifacts[] with type=image|video
  const imageArtifacts: string[] = []
  const videoArtifacts: string[] = []
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      if (tc.toolName === '__retry__') continue
      if (tc.toolName === 'image_generate') {
        const result = tc.result as { images?: Array<{ path: string }> } | undefined
        result?.images?.forEach(img => imageArtifacts.push(img.path))
      }
      if (tc.toolName === 'video_generate') {
        const result = tc.result as { path?: string } | undefined
        if (result?.path) videoArtifacts.push(result.path)
      }
      // MCP tools (any name) — uniform { text, artifacts } shape
      const mcpResult = tc.result as { artifacts?: Array<{ type: string; path: string }> } | undefined
      if (mcpResult?.artifacts) {
        for (const a of mcpResult.artifacts) {
          if (a.type === 'image') imageArtifacts.push(a.path)
          else if (a.type === 'video') videoArtifacts.push(a.path)
        }
      }
    }
  }

  const isError = message.content.startsWith('⚠️')

  const meta = message.meta

  return (
    <>
      <div className={cn('group/msg flex flex-col', isUser ? 'items-end' : 'items-start')}>
        <div className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3 text-base leading-relaxed relative',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : isError
              ? 'bg-destructive/10 border border-destructive/30 rounded-bl-sm'
              : 'bg-card border border-border rounded-bl-sm'
        )}>
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.attachments.map((att, i) => (
                att.mimeType?.startsWith('image/') ? (
                  <AttachedImage
                    key={i}
                    att={att}
                    onPreview={() => setLightboxSrc({ src: toFileUrl(att.path), filePath: att.path })}
                    onContextMenu={e => openContextMenu(e, {
                      filePath: att.path,
                      src: toFileUrl(att.path),
                      onPreview: () => setLightboxSrc({ src: toFileUrl(att.path), filePath: att.path }),
                      onEdit: () => onEditImage(toFileUrl(att.path))
                    })}
                  />
                ) : (
                  <span key={i} className="text-xs px-2 py-0.5 rounded bg-white/20 text-primary-foreground/80">
                    📎 {att.name}
                  </span>
                )
              ))}
            </div>
          )}
          {reasoning && (
            <ReasoningBlock content={reasoning} streaming={streaming} />
          )}
          {editing && isUser ? (
            <InlineEditor
              initial={editDraft}
              onCancel={() => setEditing(false)}
              onSave={(text) => {
                setEditing(false)
                onEditUserMessage?.(message.id, text)
              }}
            />
          ) : answer ? (
            isUser || isError ? (
              // User text and error banners stay plain — no Markdown parsing
              <p className="whitespace-pre-wrap break-words">{answer}</p>
            ) : (
              <AssistantAnswer content={answer} duplicatePaths={[...imageArtifacts, ...videoArtifacts]} />
            )
          ) : !reasoning && (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          )}

          {/* Retry button for transient errors */}
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-colors"
            >
              <RotateCcw size={12} />
              重试上一条消息
            </button>
          )}

          {/* Image thumbnails */}
          {imageArtifacts.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {imageArtifacts.map((imgPath, i) => (
                <div key={i} className="relative group/img">
                  <img
                    src={toFileUrl(imgPath)}
                    alt="Generated"
                    className="max-w-[360px] max-h-[280px] rounded-lg border border-border cursor-pointer hover:opacity-90 transition-opacity object-cover"
                    onClick={() => setLightboxSrc({ src: toFileUrl(imgPath), filePath: imgPath })}
                    onContextMenu={e => openContextMenu(e, {
                      filePath: imgPath,
                      src: toFileUrl(imgPath),
                      onPreview: () => setLightboxSrc({ src: toFileUrl(imgPath), filePath: imgPath }),
                      onEdit: () => onEditImage(toFileUrl(imgPath))
                    })}
                  title="点击放大 · 右键编辑 / 复制 / 另存为"
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditImage(toFileUrl(imgPath)) }}
                    title="编辑这张图（局部修改 / 抠图 / 改字 / 扩图）"
                    className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-black/55 text-white text-[11px] opacity-0 group-hover/img:opacity-100 hover:bg-black/75 transition-opacity backdrop-blur-sm"
                  >
                    <Wand2 size={11} />
                    编辑
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Video thumbnails */}
          {videoArtifacts.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {videoArtifacts.map((vidPath, i) => (
                <VideoThumbnail key={i} path={vidPath} />
              ))}
            </div>
          )}

          {/* File write backup info */}
          {message.toolCalls?.map((tc, i) => (
            tc.toolName === 'file_write' && (tc.result as { backupPath?: string })?.backupPath ? (
              <FileRevertCard key={i} tc={tc} />
            ) : null
          ))}
        </div>

        {/* Hover-revealed action toolbar — different actions per role */}
        {!isRunning && !isError && (
          <div className={cn(
            'flex items-center gap-0.5 mt-1 px-1 text-[11px] text-muted-foreground/70 opacity-0 group-hover/msg:opacity-100 transition-opacity',
            isUser ? 'flex-row-reverse' : ''
          )}>
            {isUser && onEditUserMessage && (
              <ActionIcon
                title="编辑（会从此处重跑，删除后续消息）"
                onClick={() => { setEditDraft(message.content); setEditing(true) }}
                icon={<Pencil size={11} />}
              />
            )}
            {!isUser && onRegenerate && (
              <ActionIcon
                title="重新生成"
                onClick={() => onRegenerate(message.id)}
                icon={<RefreshCw size={11} />}
              />
            )}
            {onDeleteMessage && (
              <ActionIcon
                title="删除此条消息"
                onClick={() => onDeleteMessage(message.id)}
                icon={<Trash2 size={11} />}
                hoverClass="hover:text-destructive"
              />
            )}
          </div>
        )}

        {/* Meta footer for assistant messages */}
        {!isUser && meta && (
          <div className="flex items-center gap-2.5 mt-1 px-1 text-[11px] text-muted-foreground/55 select-none">
            {meta.model && (
              <span className="flex items-center gap-1">
                <Cpu size={9} />
                {meta.model}
              </span>
            )}
            {meta.providerName && meta.providerName !== meta.model && (
              <span>{meta.providerName}</span>
            )}
            {meta.durationMs != null && (
              <span className="flex items-center gap-1">
                <Clock size={9} />
                {(meta.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        )}
      </div>

      {/* Image lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
          onClick={() => setLightboxSrc(null)}
        >
          {/* Toolbar */}
          <div className="absolute top-4 right-4 flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <button
              onClick={handleLightboxCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              onClick={handleLightboxSaveAs}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors"
            >
              <Download size={13} />
              另存为
            </button>
            <button
              onClick={() => { if (lightboxSrc) { onEditImage(lightboxSrc.src); setLightboxSrc(null) } }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors"
            >
              <Wand2 size={13} />
              编辑
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
              onClick={() => setLightboxSrc(null)}
            >
              <X size={16} />
            </button>
          </div>
          <img
            src={lightboxSrc.src}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
            onClick={e => e.stopPropagation()}
            onContextMenu={e => {
              e.preventDefault()
              e.stopPropagation()
              openContextMenu(e, {
                filePath: lightboxSrc.filePath,
                src: lightboxSrc.src,
                onEdit: () => { onEditImage(lightboxSrc.src); setLightboxSrc(null) }
              })
            }}
          />
        </div>
      )}
    </>
  )
}

/**
 * Renders an attached image inside the user message bubble at a real preview
 * size (not the postage-stamp 64px from before) plus a visible fallback when
 * the file fails to load — diagnoses paste paths that didn't reach disk.
 */
function AttachedImage({
  att, onPreview, onContextMenu
}: {
  att: { name: string; path: string; mimeType: string }
  onPreview: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const [failed, setFailed] = useState(false)
  const src = toFileUrl(att.path)

  if (failed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/15 border border-destructive/40 text-xs text-destructive">
        <X size={13} />
        <span className="font-medium">{att.name} 加载失败</span>
        <span className="text-destructive/70 truncate max-w-[260px]" title={att.path}>· {att.path}</span>
      </div>
    )
  }

  return (
    <div
      className="relative group/att cursor-pointer shrink-0 max-w-full"
      onClick={onPreview}
      onContextMenu={onContextMenu}
      title={`${att.name} (点击放大 · 右键菜单可复制/编辑)`}
    >
      <img
        src={src}
        alt={att.name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-w-[320px] max-h-[240px] rounded-lg border border-white/15 object-contain bg-black/15 hover:opacity-95 transition-opacity"
      />
      <div className="absolute bottom-0 inset-x-0 px-2 py-1 rounded-b-lg bg-gradient-to-t from-black/55 to-transparent text-[10px] text-white/85 opacity-0 group-hover/att:opacity-100 transition-opacity truncate">
        {att.name}
      </div>
    </div>
  )
}

function ActionIcon({
  icon, title, onClick, hoverClass
}: {
  icon: React.ReactNode
  title: string
  onClick: () => void
  hoverClass?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'p-1 rounded transition-colors hover:bg-muted/80 hover:text-foreground',
        hoverClass
      )}
    >
      {icon}
    </button>
  )
}

/**
 * In-bubble editor for user messages. Auto-focuses, supports Enter to commit /
 * Esc to cancel, and grows with the content. Save triggers handleEditUserMessage
 * upstream which deletes this and every subsequent message before re-sending.
 */
function InlineEditor({
  initial, onSave, onCancel
}: {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 30)
    return () => clearTimeout(t)
  }, [])

  function handleSave() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSave(trimmed)
  }

  return (
    <div className="space-y-2 min-w-[260px]">
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave() }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        className="w-full bg-background/30 border border-white/30 rounded-md px-2 py-1.5 text-sm text-primary-foreground placeholder:text-primary-foreground/50 outline-none focus:ring-1 focus:ring-white/40 resize-none"
      />
      <div className="flex items-center justify-end gap-1.5 text-xs">
        <button
          onClick={onCancel}
          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-primary-foreground"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          className="px-2 py-0.5 rounded bg-white/90 hover:bg-white text-primary font-medium"
        >
          保存并重跑
        </button>
      </div>
      <p className="text-[10px] text-primary-foreground/60">Enter 保存 · Shift+Enter 换行 · Esc 取消</p>
    </div>
  )
}

function VideoThumbnail({ path }: { path: string }) {
  const [playing, setPlaying] = useState(false)

  if (playing) {
    return (
      <div className="relative">
        <video
          src={toFileUrl(path)}
          controls
          autoPlay
          className="max-w-[400px] max-h-[280px] rounded-lg border border-border"
        />
        <button
          className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-0.5 hover:bg-black/70"
          onClick={() => setPlaying(false)}
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="relative cursor-pointer group"
      onClick={() => setPlaying(true)}
      onContextMenu={async e => {
        e.preventDefault()
        try { await window.api.saveFileAs(path) } catch (err) { console.error('[save-as]', err) }
      }}
      title="点击播放 · 右键另存为"
    >
      <video
        src={toFileUrl(path)}
        className="max-w-[360px] max-h-[240px] rounded-lg border border-border object-cover"
        preload="metadata"
      />
      <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg group-hover:bg-black/40 transition-colors">
        <div className="bg-white/90 rounded-full p-2.5">
          <Play size={18} className="text-gray-800 ml-0.5" />
        </div>
      </div>
    </div>
  )
}

/**
 * Renders assistant answer as Markdown, with:
 *  - a per-message copy button (whole markdown source)
 *  - automatic collapse for long messages (> ~25 lines) with an expand toggle
 *  - per-code-block copy button comes from the Markdown component itself
 */
function AssistantAnswer({ content, duplicatePaths = [] }: { content: string; duplicatePaths?: string[] }) {
  // Defensive: even when the system prompt forbids it, some models still
  // embed `![alt](path)` or stray URLs referencing media we've already
  // rendered as thumbnails above. Strip those references so the user doesn't
  // see the same image twice.
  const cleaned = useMemo(() => stripDuplicateMedia(content, duplicatePaths), [content, duplicatePaths])

  const COLLAPSE_LINE_THRESHOLD = 25
  const COLLAPSE_CHAR_THRESHOLD = 1500
  const lines = cleaned.split('\n').length
  const isLong = lines > COLLAPSE_LINE_THRESHOLD || cleaned.length > COLLAPSE_CHAR_THRESHOLD

  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const collapsed = isLong && !expanded
  const display = collapsed
    ? cleaned.split('\n').slice(0, COLLAPSE_LINE_THRESHOLD).join('\n')
    : cleaned

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.error('[chat] copy failed:', e)
    }
  }

  return (
    <div className="group/answer">
      <div className="relative">
        <Markdown content={display} compact />
        {collapsed && (
          <div className="pointer-events-none absolute bottom-0 inset-x-0 h-16 bg-gradient-to-t from-card via-card/80 to-transparent" />
        )}
      </div>

      {/* Toolbar — visible on hover; expand/collapse is always shown when long */}
      <div className="mt-2 flex items-center gap-1.5">
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {expanded ? '收起' : `展开全部 (${lines} 行)`}
          </button>
        )}
        <button
          onClick={copyAll}
          title="复制全部内容"
          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors opacity-0 group-hover/answer:opacity-100"
        >
          {copied ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  )
}

/**
 * Collapsible panel that renders the model's chain-of-thought.
 * Auto-expanded while still streaming so the user sees progress;
 * once the answer arrives, defaults to collapsed.
 */
function ReasoningBlock({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)

  // When streaming flips to false (model finished), collapse by default
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])

  return (
    <div className="mb-2 rounded-lg bg-muted/40 border border-border/60 text-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain size={11} className="shrink-0 text-primary/70" />
        <span className="font-medium">思考过程</span>
        {streaming && (
          <span className="text-[10px] text-primary/80 animate-pulse">思考中…</span>
        )}
        <span className="flex-1" />
        <ChevronRight
          size={11}
          className={cn('transition-transform shrink-0', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-1 border-t border-border/50 text-muted-foreground/90 leading-relaxed">
          <div className="whitespace-pre-wrap break-words italic">{content}</div>
        </div>
      )}
    </div>
  )
}

function FileRevertCard({ tc }: { tc: ToolCallRecord }) {
  const [reverted, setReverted] = useState(false)
  const result = tc.result as { backupPath?: string; filePath?: string }
  const args = tc.args as { filePath?: string }

  async function handleRevert() {
    if (!result.backupPath) return
    try {
      await window.api.revertBackup(result.backupPath, args.filePath || '')
      setReverted(true)
    } catch (e) {
      alert('还原失败：' + (e as Error).message)
    }
  }

  if (!result.backupPath) return null

  return (
    <div className="mt-2 flex items-center gap-2 p-2 rounded bg-muted/50 text-xs">
      <span className="text-muted-foreground flex-1">已备份到 {result.backupPath.split(/[\\/]/).pop()}</span>
      {reverted ? (
        <span className="text-green-600">已还原</span>
      ) : (
        <button
          onClick={handleRevert}
          className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 transition-colors"
        >
          还原备份
        </button>
      )}
    </div>
  )
}
