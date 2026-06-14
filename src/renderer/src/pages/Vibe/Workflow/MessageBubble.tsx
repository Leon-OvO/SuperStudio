import { useState } from 'react'
import { Wrench, Check, AlertCircle, User, Bot, Info, Coins, Brain, ChevronRight, FileText } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Markdown } from '../../../lib/markdown'
import { formatUsageLine } from '../../../lib/format-cost'
import { toLocalFileUrl, isImageMime } from '../../../lib/attachments'
import type { VibeMessageInfo } from '../../../../../shared/ipc-types'

interface Props { msg: VibeMessageInfo }

// Split <think>/<thinking>/<reasoning> blocks off the answer. Mirrors the main
// chat's splitThinking (MessageList.tsx); kept local to avoid coupling. Tolerates
// a half-open trailing block while the reasoning is still streaming.
function splitThinking(content: string): { reasoning: string; answer: string; streaming: boolean } {
  const blocks: string[] = []
  let answer = content.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g, (_m, _tag, body) => {
    blocks.push(String(body).trim())
    return ''
  })
  let streaming = false
  const halfOpen = answer.match(/<(think|thinking|reasoning)>([\s\S]*)$/)
  if (halfOpen) {
    blocks.push(halfOpen[2].trim())
    answer = answer.slice(0, halfOpen.index)
    streaming = true
  }
  return { reasoning: blocks.filter(Boolean).join('\n\n').trim(), answer: answer.trim(), streaming }
}

// Compact collapsible "思考过程" — auto-open while the model is still thinking so
// the user sees live progress instead of a frozen "AI 正在回复…", collapses once
// the answer starts.
function ThinkBlock({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)
  return (
    <div className="mb-1.5 rounded-md border border-border/50 bg-muted/30 text-[11px]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain size={10} className="shrink-0 text-primary/70" />
        <span className="font-medium">思考过程</span>
        {streaming && <span className="text-[10px] text-primary/80 animate-pulse">思考中…</span>}
        <ChevronRight size={10} className={cn('ml-auto transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="px-2.5 pb-1.5 pt-0.5 border-t border-border/40 text-muted-foreground/85 leading-relaxed whitespace-pre-wrap break-words italic max-h-[220px] overflow-auto">
          {content}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ msg }: Props) {
  if (msg.role === 'user') {
    const atts = msg.attachments ?? []
    return (
      <div className="flex items-start gap-2 py-1">
        <User size={12} className="text-muted-foreground mt-1 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          {atts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {atts.map((a, i) => (
                isImageMime(a.mimeType) ? (
                  <img
                    key={i}
                    src={toLocalFileUrl(a.path)}
                    alt={a.name}
                    title={a.name}
                    className="h-16 w-16 rounded-lg object-cover border border-border"
                  />
                ) : (
                  <span key={i} className="inline-flex items-center gap-1 px-1.5 py-1 rounded-lg bg-muted border border-border/60 text-[10px] text-foreground/80 max-w-[150px]">
                    <FileText size={10} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{a.name}</span>
                  </span>
                )
              ))}
            </div>
          )}
          {msg.content && <div className="text-xs text-foreground whitespace-pre-wrap">{msg.content}</div>}
        </div>
      </div>
    )
  }
  if (msg.role === 'assistant') {
    const usage = formatUsageLine({
      inputTokens: msg.inputTokens,
      outputTokens: msg.outputTokens,
      costUsd: msg.costUsd
    })
    const { reasoning, answer, streaming } = splitThinking(msg.content)
    return (
      <div className="flex items-start gap-2 py-1">
        <Bot size={12} className="text-primary mt-1 shrink-0" />
        <div className="flex-1 min-w-0 text-xs text-foreground/90 leading-relaxed">
          {reasoning && <ThinkBlock content={reasoning} streaming={streaming} />}
          {answer && <Markdown content={answer} compact />}
          {usage && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/80 tabular-nums">
              <Coins size={9} className="opacity-70" />
              <span>{usage}</span>
              {msg.model && <span className="opacity-60">· {msg.model}</span>}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (msg.role === 'tool') {
    const isResult = !!msg.content && msg.content !== msg.toolName
    return (
      <div className="flex items-start gap-2 py-0.5 pl-4">
        {msg.isError
          ? <AlertCircle size={11} className="text-destructive mt-0.5 shrink-0" />
          : isResult
            ? <Check size={11} className="text-emerald-500 mt-0.5 shrink-0" />
            : <Wrench size={11} className="text-blue-500 mt-0.5 shrink-0" />
        }
        <div className={cn(
          'flex-1 min-w-0 text-[11px] font-mono truncate',
          msg.isError ? 'text-destructive' : 'text-muted-foreground'
        )}>
          {msg.toolName && <span className="font-semibold text-foreground/70 mr-1.5">{msg.toolName}</span>}
          <span className="opacity-80">{msg.content || '(已完成)'}</span>
        </div>
      </div>
    )
  }
  if (msg.role === 'system') {
    return (
      <div className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground/60 italic">
        <Info size={10} className="shrink-0" />
        <span>{msg.content}</span>
      </div>
    )
  }
  return null
}
