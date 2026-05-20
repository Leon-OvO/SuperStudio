import { Wrench, Check, AlertCircle, User, Bot, Info } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Markdown } from '../../../lib/markdown'
import type { VibeMessageInfo } from '../../../../../shared/ipc-types'

interface Props { msg: VibeMessageInfo }

export function MessageBubble({ msg }: Props) {
  if (msg.role === 'user') {
    return (
      <div className="flex items-start gap-2 py-1">
        <User size={12} className="text-muted-foreground mt-1 shrink-0" />
        <div className="flex-1 min-w-0 text-xs text-foreground whitespace-pre-wrap">{msg.content}</div>
      </div>
    )
  }
  if (msg.role === 'assistant') {
    return (
      <div className="flex items-start gap-2 py-1">
        <Bot size={12} className="text-primary mt-1 shrink-0" />
        <div className="flex-1 min-w-0 text-xs text-foreground/90 leading-relaxed">
          <Markdown content={msg.content} compact />
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
