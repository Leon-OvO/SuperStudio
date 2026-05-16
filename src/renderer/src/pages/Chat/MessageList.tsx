import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message, ToolCallRecord } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'
import { copyImageToClipboard } from '../../lib/clipboard'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { ImageEditor } from '../../components/ui/ImageEditor'
import { Markdown } from '../../lib/markdown'
import { Play, X, RotateCcw, Clock, Cpu, Copy, Check, Download, Wand2, Brain, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'

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

interface Props {
  messages: Message[]
  sessionId: string | null
  onRetry?: () => void
}

export function MessageList({ messages, sessionId, onRetry }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const ctxMenu = useImageContextMenu()
  const [editorImage, setEditorImage] = useState<string | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  if (messages.length === 0) {
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
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg, idx) => {
        const isLastMsg = idx === messages.length - 1
        const showRetry = isLastMsg && onRetry && msg.role === 'assistant' && msg.content.startsWith('⚠️')
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            onRetry={showRetry ? onRetry : undefined}
            openContextMenu={ctxMenu.open}
            onEditImage={setEditorImage}
          />
        )
      })}
      <div ref={bottomRef} />
      {ctxMenu.element}

      {editorImage && (
        <ImageEditor
          src={editorImage}
          sessionId={sessionId ?? undefined}
          onClose={() => setEditorImage(null)}
        />
      )}
    </div>
  )
}

interface BubbleProps {
  message: Message
  onRetry?: () => void
  openContextMenu: ReturnType<typeof useImageContextMenu>['open']
  onEditImage: (src: string) => void
}

function MessageBubble({ message, onRetry, openContextMenu, onEditImage }: BubbleProps) {
  const isUser = message.role === 'user'
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; filePath: string } | null>(null)
  const [copied, setCopied] = useState(false)

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

  // Extract image and video artifacts from tool calls (skip internal __retry__ marker)
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
    }
  }

  const isError = message.content.startsWith('⚠️')

  const meta = message.meta

  return (
    <>
      <div className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}>
        <div className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3 text-base leading-relaxed',
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
                  <div
                    key={i}
                    className="relative group cursor-pointer shrink-0"
                    onClick={() => setLightboxSrc({ src: toFileUrl(att.path), filePath: att.path })}
                    onContextMenu={e => openContextMenu(e, {
                      filePath: att.path,
                      src: toFileUrl(att.path),
                      onPreview: () => setLightboxSrc({ src: toFileUrl(att.path), filePath: att.path })
                    })}
                  >
                    <img
                      src={toFileUrl(att.path)}
                      alt={att.name}
                      className="h-16 w-16 object-cover rounded-lg border border-white/20 hover:opacity-90 transition-opacity"
                    />
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/0 group-hover:bg-black/20 transition-colors" />
                  </div>
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
          {answer ? (
            isUser || isError ? (
              // User text and error banners stay plain — no Markdown parsing
              <p className="whitespace-pre-wrap break-words">{answer}</p>
            ) : (
              <AssistantAnswer content={answer} />
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
                    onPreview: () => setLightboxSrc({ src: toFileUrl(imgPath), filePath: imgPath })
                  })}
                  title="点击放大 · 右键复制 / 另存为"
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
              openContextMenu(e, { filePath: lightboxSrc.filePath, src: lightboxSrc.src })
            }}
          />
        </div>
      )}
    </>
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
function AssistantAnswer({ content }: { content: string }) {
  const COLLAPSE_LINE_THRESHOLD = 25
  const COLLAPSE_CHAR_THRESHOLD = 1500
  const lines = content.split('\n').length
  const isLong = lines > COLLAPSE_LINE_THRESHOLD || content.length > COLLAPSE_CHAR_THRESHOLD

  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const collapsed = isLong && !expanded
  const display = collapsed
    ? content.split('\n').slice(0, COLLAPSE_LINE_THRESHOLD).join('\n')
    : content

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
