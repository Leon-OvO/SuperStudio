import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BRAND } from '@shared/brand'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Message, ToolCallRecord, AskUserPayload, EmployeeInfo } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'
import { dept } from '../../lib/departments'
import { copyImageToClipboard } from '../../lib/clipboard'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { toast } from '../../components/ui/Toast'
import { Markdown } from '../../lib/markdown'
import { Play, X, RotateCcw, Clock, Cpu, Copy, Check, Download, Wand2, Brain, ChevronRight, ChevronDown, ChevronUp, Pencil, Trash2, RefreshCw, Coins, ImagePlus, Wrench, CheckCircle2, XCircle, Loader2, Quote, Server, MessagesSquare, FileText } from 'lucide-react'
import { formatUsageLine } from '../../lib/format-cost'
import { scrubAddresses } from '../../../../shared/scrub'

function toFileUrl(p: string): string {
  // Three slashes: local-file:///F:/path — empty authority avoids Chromium treating "F:" as host
  const fwd = p.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

/** Short Chinese labels for the per-phase timing footnote (meta.phases). */
const PHASE_FOOT_LABEL: Record<string, string> = {
  connecting: '等待', thinking: '思考', responding: '输出',
  tool: '工具', generating: '生成', waiting: '等待'
}

const MENTION_TOKEN_RE = /【(图:[^】]+|图片\d+|文件:[^】]+|服务器:[^】]+|引用:[^】]+|对话摘要)】/g

/** Render a sent user message, turning inline @-reference tokens
 *  (【图片N】/【文件:x】/【服务器:x】/【引用:…】/【对话摘要】) into chips that match how the
 *  composer showed them. Image tokens map to the message's image attachments (in
 *  order) for a real thumbnail + hover preview. */
function MessageWithChips({ content, attachments }: {
  content: string
  attachments?: Array<{ name: string; path: string; mimeType: string }>
}) {
  const imgs = (attachments ?? []).filter(a => a.mimeType?.startsWith('image/'))
  if (!content.includes('【')) return <>{content}</>
  const nodes: ReactNode[] = []
  const re = new RegExp(MENTION_TOKEN_RE)
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) nodes.push(content.slice(last, m.index))
    nodes.push(<InlineToken key={`t${k++}`} token={m[1]} imgs={imgs} />)
    last = m.index + m[0].length
  }
  if (last < content.length) nodes.push(content.slice(last))
  return <>{nodes}</>
}

function InlineToken({ token, imgs }: { token: string; imgs: Array<{ name: string; path: string }> }) {
  const chip = (icon: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1 align-baseline mx-0.5 px-1.5 py-0.5 rounded-md bg-primary-foreground/15 border border-primary-foreground/25 text-[0.82em] leading-none">
      <span className="opacity-90 shrink-0">{icon}</span>
      <span className="max-w-[180px] truncate">{label}</span>
    </span>
  )
  // Image token: name-based 【图:文件名】 (current) or positional 【图片N】 (legacy).
  const isImgToken = token.startsWith('图:') || /^图片\d+$/.test(token)
  if (isImgToken) {
    const imgLabel = token.startsWith('图:') ? token.slice(2) : token
    const path = token.startsWith('图:')
      ? imgs.find(a => a.name === imgLabel)?.path
      : imgs[parseInt(token.slice(2), 10) - 1]?.path
    return (
      <span className="relative inline-flex group/itok align-baseline mx-0.5">
        <span className="inline-flex items-center gap-1 px-1 py-0.5 rounded-md bg-primary-foreground/15 border border-primary-foreground/25 text-[0.82em] leading-none">
          {path ? <img src={toFileUrl(path)} className="w-4 h-4 rounded object-cover" alt={imgLabel} /> : <ImagePlus size={11} />}
          <span className="max-w-[160px] truncate">{imgLabel}</span>
        </span>
        {path && (
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/itok:block z-40 pointer-events-none">
            <img src={toFileUrl(path)} className="max-w-[240px] max-h-[180px] rounded-lg border border-border shadow-xl bg-card object-contain" alt={imgLabel} />
          </span>
        )}
      </span>
    )
  }
  if (token.startsWith('文件:')) return chip(<FileText size={11} />, token.slice(3))
  if (token.startsWith('服务器:')) return chip(<Server size={11} />, token.slice(4))
  if (token.startsWith('引用:')) return chip(<Quote size={11} />, token.slice(3))
  if (token === '对话摘要') return chip(<MessagesSquare size={11} />, '对话摘要')
  return <>{`【${token}】`}</>
}

/**
 * Per-message timestamp. Shows bare "HH:MM" for today (the common case in a
 * live chat), and "MM-DD HH:MM" once the message is from another day — which
 * is exactly the scheduled-task case, where a conversation can span days. The
 * tooltip always carries the full second-precision stamp.
 */
function formatMsgTime(ts?: number): { short: string; full: string } | null {
  if (!ts) return null
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const full = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const short = sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return { short, full }
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
  /** Hired employees — resolves a group message's speaker to an avatar + name. */
  employees?: EmployeeInfo[]
  onRetry?: () => void
  /** Open the global ImageEditor with the given src. Mounted at ChatPage level. */
  onEditImage: (src: string) => void
  /** Add a generated image as a reference for the next image turn (用作参考图). */
  onUseAsReference?: (path: string) => void
  /** Total configured LLM providers — drives the first-run onboarding. null = still loading. */
  providersCount?: number | null
  /** Currently configured default chat model id — empty string means none picked. */
  defaultChatModel?: string
  /** Delete a single message by id (no cascade). */
  onDeleteMessage?: (messageId: string) => void
  /** Regenerate a specific assistant response. */
  onRegenerate?: (assistantMessageId: string) => void
  /** Commit an edited user message + cascade re-run. */
  onEditUserMessage?: (messageId: string, newContent: string) => void
  /** Disable hover actions while the agent is running. */
  isRunning?: boolean
  /** User picked an option in an ask_user choice card — send it as a new message. */
  onChoose?: (value: string) => void
}

export function MessageList({
  messages, employees, onRetry, onEditImage, onUseAsReference, providersCount, defaultChatModel,
  onDeleteMessage, onRegenerate, onEditUserMessage, isRunning, onChoose
}: Props) {
  const ctxMenu = useImageContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const employeeMap = useMemo(() => {
    const m = new Map<string, EmployeeInfo>()
    for (const e of employees ?? []) m.set(e.id, e)
    return m
  }, [employees])

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
                {BRAND.displayName} 还不知道把请求发到哪。前往「设置 → 提供商」添加 OpenAI、Anthropic、Gemini 或任意 OpenAI 兼容的代理；填好 API Key 就能开始对话、生图、生视频。
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
    // Providers exist but no default chat model picked → guide to Settings → 模型
    if (providersCount != null && providersCount > 0 && !defaultChatModel) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/10 flex items-center justify-center">
              <Cpu size={26} className="text-amber-500" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold">还没有选择默认对话模型</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                已经识别到 <strong className="text-foreground">{providersCount}</strong> 个 Key，但还没选定要默认用哪个模型。
                前往「设置 → 模型」从 Key 列表里挑一个，并选择具体模型；之后所有新会话都会用它。
              </p>
            </div>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'settings' } }))}
                className="btn-primary"
              >
                去设置默认模型
              </button>
            </div>
            <p className="text-xs text-muted-foreground/70">
              提示：模型列表为空时，到「设置 → 模型」点击右侧 🔁 按钮可重新拉取。
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
                speaker={msg.speakerEmployeeId ? employeeMap.get(msg.speakerEmployeeId) : undefined}
                onRetry={showRetry ? onRetry : undefined}
                openContextMenu={ctxMenu.open}
                onEditImage={onEditImage}
                onUseAsReference={onUseAsReference}
                onDeleteMessage={onDeleteMessage}
                onRegenerate={onRegenerate}
                onEditUserMessage={onEditUserMessage}
                isRunning={!!isRunning}
                isLastMsg={isLastMsg}
                onChoose={onChoose}
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
  /** Group chat: the employee who spoke this message (for an identity header). */
  speaker?: EmployeeInfo
  onRetry?: () => void
  openContextMenu: ReturnType<typeof useImageContextMenu>['open']
  onEditImage: (src: string) => void
  onUseAsReference?: (path: string) => void
  onDeleteMessage?: (messageId: string) => void
  onRegenerate?: (assistantMessageId: string) => void
  onEditUserMessage?: (messageId: string, newContent: string) => void
  isRunning: boolean
  isLastMsg: boolean
  onChoose?: (value: string) => void
}

/** One-line preview of a tool call for the persisted 工作过程 panel: error message,
 *  else the most informative argument, else a compact JSON of args. Addresses are
 *  scrubbed so IPs/hosts don't leak into the chat history. */
function toolPreview(tc: ToolCallRecord): string {
  if (tc.status === 'error' && tc.error) return scrubAddresses(String(tc.error)).slice(0, 140)
  const a = (tc.args || {}) as Record<string, unknown>
  for (const k of ['query', 'path', 'filePath', 'command', 'cmd', 'url', 'prompt', 'name', 'pattern', 'connId']) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) return scrubAddresses(v).slice(0, 140)
  }
  try { const s = JSON.stringify(a); if (s && s !== '{}') return scrubAddresses(s).slice(0, 140) } catch { /* ignore */ }
  return ''
}

/** Persisted "work process" for a completed assistant turn: a collapsible list of
 *  the tool calls (with status) it made. Restores the in-flight AgentProgress view
 *  after the run ends and on session reload (toolCalls are stored on the message,
 *  but AgentProgress only renders while running). */
function ToolCallProcess({ toolCalls }: { toolCalls: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false)
  const steps = toolCalls.filter(tc => tc.toolName !== '__retry__')
  if (!steps.length) return null
  const errCount = steps.filter(s => s.status === 'error').length
  return (
    <div className="mt-2 mb-1 text-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Wrench size={12} />
        工作过程（{steps.length} 步{errCount ? ` · ${errCount} 个出错` : ''}）
      </button>
      {open && (
        <div className="mt-1.5 ml-1.5 pl-3 border-l border-border space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 leading-relaxed">
              {s.status === 'done' && <CheckCircle2 size={12} className="text-emerald-500 mt-0.5 shrink-0" />}
              {s.status === 'error' && <XCircle size={12} className="text-destructive mt-0.5 shrink-0" />}
              {s.status === 'running' && <Loader2 size={12} className="animate-spin text-primary mt-0.5 shrink-0" />}
              <div className="min-w-0 flex-1">
                <span className="font-mono text-[11px] text-foreground/80">{s.toolName}</span>
                {toolPreview(s) && <span className="ml-1.5 text-muted-foreground break-all">{toolPreview(s)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message, speaker, onRetry, openContextMenu, onEditImage, onUseAsReference,
  onDeleteMessage, onRegenerate, onEditUserMessage, isRunning, isLastMsg, onChoose
}: BubbleProps) {
  const isUser = message.role === 'user'
  const speakerDept = speaker ? dept(speaker.dept) : null
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; filePath: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  // Right-click「引用追问」menu on the text bubble. Quotes the selection (if any
  // inside this bubble) else the whole message; the composer turns it into an
  // inline 「引用」 chip via the `chat:quote` event.
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; text: string } | null>(null)

  // Split <think>/<thinking> blocks off the answer (assistant messages only)
  const { reasoning, answer, streaming } = useMemo(
    () => isUser ? { reasoning: '', answer: message.content, streaming: false } : splitThinking(message.content),
    [isUser, message.content]
  )
  // Some reasoning models / proxies (e.g. MiniMax-M3) put their ENTIRE reply in
  // the <think> channel and leave the answer empty. Once the run is done with no
  // separate answer, surface the thinking AS the answer instead of a blank bubble
  // (and suppress the now-duplicate 思考过程 block).
  const onlyThinking = !!reasoning && !answer.trim()
  const liveStreaming = !isUser && isRunning && isLastMsg
  const thinkingAsAnswer = onlyThinking && !liveStreaming

  // The text this message contributes when quoted (selection wins, else full text).
  const quotableText = (isUser ? message.content : answer).trim()
  const openQuoteMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()
    const selText = sel && !sel.isCollapsed && bubbleRef.current?.contains(sel.anchorNode)
      ? sel.toString().trim() : ''
    const text = selText || quotableText
    if (!text) return
    e.preventDefault()
    setQuoteMenu({ x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 110), text })
  }
  const fireQuote = (text: string) => {
    window.dispatchEvent(new CustomEvent('chat:quote', { detail: { text } }))
    setQuoteMenu(null)
  }
  useEffect(() => {
    if (!quoteMenu) return
    const onDown = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest('[data-quote-menu]')) setQuoteMenu(null) }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setQuoteMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [quoteMenu])

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
  const ts = formatMsgTime(message.createdAt)

  return (
    <>
      <div className={cn('group/msg flex flex-col', isUser ? 'items-end' : 'items-start')}>
        {/* Group chat: who said this — dept emoji + name above the bubble. If the
            speaker was fired since, label it so the message isn't shown unattributed. */}
        {!isUser && speaker && speakerDept ? (
          <div className="flex items-center gap-1.5 mb-1 pl-1">
            <span className="w-5 h-5 rounded-md grid place-items-center text-[12px] border border-border shrink-0" style={{ background: speakerDept.color + '22' }}>{speakerDept.emoji}</span>
            <span className="text-xs font-medium text-foreground/90">{speaker.name}</span>
            <span className="text-[10px] text-muted-foreground/70">{speakerDept.label}</span>
          </div>
        ) : (!isUser && message.speakerEmployeeId) ? (
          <div className="flex items-center gap-1.5 mb-1 pl-1 opacity-70">
            <span className="text-[11px] text-muted-foreground">（已离职员工）</span>
          </div>
        ) : null}
        <div
          ref={bubbleRef}
          onContextMenu={openQuoteMenu}
          className={cn(
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
          {reasoning && !thinkingAsAnswer && (
            <ReasoningBlock content={reasoning} streaming={streaming} />
          )}
          {!isUser && message.toolCalls && message.toolCalls.some(tc => tc.toolName !== '__retry__') && (
            <ToolCallProcess toolCalls={message.toolCalls} />
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
            isUser ? (
              // User text stays plain (no Markdown), but inline @-reference tokens
              // (【图片N】/【服务器:x】/【引用:…】/【对话摘要】) render as chips — same as
              // the composer showed them before sending.
              <p className="whitespace-pre-wrap break-words"><MessageWithChips content={answer} attachments={message.attachments} /></p>
            ) : isError ? (
              <p className="whitespace-pre-wrap break-words">{answer}</p>
            ) : (
              <AssistantAnswer content={answer} duplicatePaths={[...imageArtifacts, ...videoArtifacts]} />
            )
          ) : thinkingAsAnswer ? (
            // Model produced only thinking and no separate answer → show it as the reply.
            <AssistantAnswer content={reasoning} duplicatePaths={[...imageArtifacts, ...videoArtifacts]} />
          ) : !reasoning ? (
            // No answer and no reasoning yet. If this is the live run still waiting
            // on its first token (e.g. Opus 4.8 thinking before it streams), show an
            // immediate "思考中…" affordance instead of a blank bubble.
            (!isUser && isRunning && isLastMsg && !message.content.trim()) ? (
              <ThinkingIndicator />
            ) : (
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            )
          ) : null}

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
                      onEdit: () => onEditImage(toFileUrl(imgPath)),
                      ...(onUseAsReference ? { onUseAsReference: () => onUseAsReference(imgPath) } : {})
                    })}
                  title="点击放大 · 右键 用作参考图 / 编辑 / 复制 / 另存为"
                  />
                  <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
                    {onUseAsReference && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onUseAsReference(imgPath) }}
                        title="用作参考图：基于这张图继续生成"
                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-black/55 text-white text-[11px] hover:bg-black/75 backdrop-blur-sm"
                      >
                        <ImagePlus size={11} />
                        参考图
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onEditImage(toFileUrl(imgPath)) }}
                      title="编辑这张图（局部修改 / 抠图 / 改字 / 扩图）"
                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-black/55 text-white text-[11px] hover:bg-black/75 backdrop-blur-sm"
                    >
                      <Wand2 size={11} />
                      编辑
                    </button>
                  </div>
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

          {/* Tool error detail — surfaced verbatim so the model's summary
              can't bury it (e.g. image_generate provider/model errors). */}
          {message.toolCalls?.map((tc, i) => {
            const err = (tc.result as { error?: string } | null)?.error
            return err ? <ToolErrorCard key={`err-${i}`} toolName={tc.toolName} error={err} /> : null
          })}

          {/* ask_user choice card — interactive only while this is the last
              message and nothing's running. Once the user picks, their choice
              becomes a new user message, this stops being last → card locks. */}
          {message.toolCalls?.map((tc, i) => (
            tc.toolName === 'ask_user' && tc.result ? (
              <ChoiceCard
                key={`ask-${i}`}
                payload={tc.result as AskUserPayload}
                interactive={isLastMsg && !isRunning && !!onChoose}
                onChoose={(value) => onChoose?.(value)}
              />
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
            {quotableText && (
              <ActionIcon
                title="引用追问（把这条内容作为追问对象，引到输入框）"
                onClick={() => fireQuote(quotableText)}
                icon={<Quote size={11} />}
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 px-1 text-[11px] text-muted-foreground select-none">
            {meta.autoRoutedModel && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                ⚡ 自动路由{meta.autoRoutedIntent ? ` · ${meta.autoRoutedIntent}` : ''}
              </span>
            )}
            {meta.model && (
              <span className="flex items-center gap-1 text-foreground/75 font-medium">
                <Cpu size={10} />
                {meta.model}
              </span>
            )}
            {meta.providerName && meta.providerName !== meta.model && (
              <span className="text-muted-foreground/75">{meta.providerName}</span>
            )}
            {meta.durationMs != null && (
              <span className="flex items-center gap-1 text-muted-foreground/75">
                <Clock size={10} />
                {(meta.durationMs / 1000).toFixed(1)}s
              </span>
            )}
            {meta.phases && meta.phases.length > 1 && (
              <span className="text-muted-foreground/60 tabular-nums" title="本轮各阶段耗时">
                {meta.phases
                  .map(p => `${PHASE_FOOT_LABEL[p.phase] ?? p.phase} ${(p.ms / 1000).toFixed(1)}s`)
                  .join(' · ')}
              </span>
            )}
            {(() => {
              const usage = formatUsageLine({
                inputTokens: meta.inputTokens,
                outputTokens: meta.outputTokens,
                cacheReadTokens: meta.cacheReadTokens,
                costUsd: meta.costUsd
              })
              const inTok = Number.isFinite(meta.inputTokens) ? meta.inputTokens : null
              const outTok = Number.isFinite(meta.outputTokens) ? meta.outputTokens : null
              return usage ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium tabular-nums"
                  title={`输入 ${inTok ?? 0} tokens · 输出 ${outTok ?? 0} tokens`}
                >
                  <Coins size={10} />
                  {usage}
                </span>
              ) : null
            })()}
          </div>
        )}

        {/* Per-message timestamp (covers regular chat and the scheduled-task
            conversation, which reuses this component). */}
        {ts && (
          <div
            className="mt-1 px-1 text-[10px] text-muted-foreground/60 select-none tabular-nums"
            title={ts.full}
          >
            {ts.short}
          </div>
        )}
      </div>

      {/* Right-click「引用追问」menu — portaled (the virtualized row's transform
          would otherwise break `fixed` positioning). */}
      {quoteMenu && createPortal(
        <div
          data-quote-menu
          className="fixed z-[100] min-w-[160px] bg-popover border border-border rounded-lg shadow-xl py-1 text-sm select-none origin-top-left animate-menu-in"
          style={{ left: quoteMenu.x, top: quoteMenu.y }}
        >
          <button
            onClick={() => fireQuote(quoteMenu.text)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent text-foreground/90 hover:text-foreground transition-colors"
          >
            <span className="text-muted-foreground"><Quote size={13} /></span>
            <span className="text-xs">引用追问</span>
          </button>
          <button
            onClick={() => { void navigator.clipboard.writeText(quoteMenu.text); setQuoteMenu(null) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent text-foreground/90 hover:text-foreground transition-colors"
          >
            <span className="text-muted-foreground"><Copy size={13} /></span>
            <span className="text-xs">复制</span>
          </button>
        </div>,
        document.body
      )}

      {/* Image lightbox — portaled to body because the virtualized row's
          transform would otherwise become the containing block for `fixed`. */}
      {lightboxSrc && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/85 flex flex-col p-4 gap-3"
          onClick={() => setLightboxSrc(null)}
        >
          {/* Image area — takes remaining vertical space above the toolbar */}
          <div className="flex-1 min-h-0 flex items-center justify-center">
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
          {/* Toolbar — centered below the image */}
          <div className="shrink-0 flex items-center justify-center gap-2" onClick={e => e.stopPropagation()}>
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
        </div>,
        document.body
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
 * Immediate "正在思考" affordance shown the moment a run starts, before the model
 * has streamed its first token. Without this, a model that thinks before answering
 * (Opus 4.8) leaves the bubble blank for what can be minutes — looks frozen.
 */
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground py-0.5">
      <span className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
      </span>
      <span className="text-[13px]">思考中…</span>
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
      toast.error('还原失败：' + (e as Error).message)
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

const TOOL_ERROR_LABELS: Record<string, string> = {
  image_generate: '生成图片',
  video_generate: '生成视频',
  web_open: '打开网页',
  vision_analyze: '图片识别'
}

/** Shows a tool call's raw error verbatim. Without this the model's prose
 *  summary is the only thing the user sees, which hides the real cause
 *  (provider / baseUrl / model in image_generate failures, etc.). */
function ToolErrorCard({ toolName, error }: { toolName: string; error: string }) {
  const label = TOOL_ERROR_LABELS[toolName] || toolName
  return (
    <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
      <div className="font-medium text-destructive mb-1">{label} 失败</div>
      <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive/90">
        {error}
      </div>
    </div>
  )
}

/** Renders an ask_user choice as clickable option buttons + an optional
 *  free-text "其他…" input. Interactive only when `interactive` is true (i.e.
 *  this is still the last message and the agent isn't running); otherwise it
 *  shows a disabled, history-only view. */
function ChoiceCard({
  payload, interactive, onChoose
}: { payload: AskUserPayload; interactive: boolean; onChoose: (value: string) => void }) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const options = Array.isArray(payload.options) ? payload.options : []

  function submitCustom() {
    const v = customText.trim()
    if (!v) return
    onChoose(v)
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {options.map((opt, i) => (
        <button
          key={i}
          disabled={!interactive}
          onClick={() => interactive && onChoose(opt.label)}
          className={cn(
            'text-left px-3 py-2 rounded-lg border transition-colors',
            interactive
              ? 'border-border bg-background hover:bg-primary/10 hover:border-primary/40 cursor-pointer'
              : 'border-border/50 bg-muted/30 opacity-60 cursor-default'
          )}
        >
          <div className="text-sm font-medium">{opt.label}</div>
          {opt.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{opt.description}</div>
          )}
        </button>
      ))}

      {payload.allowCustom && (
        customOpen ? (
          <div className="flex items-center gap-1.5 mt-0.5">
            <input
              autoFocus
              value={customText}
              disabled={!interactive}
              onChange={e => setCustomText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitCustom() } }}
              placeholder="输入你的答案…"
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm outline-none focus:border-primary/50"
            />
            <button
              disabled={!interactive || !customText.trim()}
              onClick={submitCustom}
              className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50 transition-colors"
            >
              发送
            </button>
          </div>
        ) : (
          <button
            disabled={!interactive}
            onClick={() => interactive && setCustomOpen(true)}
            className={cn(
              'text-left px-3 py-2 rounded-lg border border-dashed transition-colors',
              interactive
                ? 'border-border text-muted-foreground hover:bg-primary/10 hover:border-primary/40 cursor-pointer'
                : 'border-border/50 text-muted-foreground/60 opacity-60 cursor-default'
            )}
          >
            其他…（自定义输入）
          </button>
        )
      )}
    </div>
  )
}
