import { useEffect, useRef, useState } from 'react'
import { GitBranch, MessageSquare, Pencil, Check, X, Download, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

// ImageParams + helpers live here for backward compat — used by ChatPage + ChatInput
export interface ImageParams {
  resolution: '1K' | '2K' | '4K'
  quality: 'standard' | 'hd'
  ratio: string
  count: 1 | 2 | 3 | 4
}

export const DEFAULT_IMAGE_PARAMS: ImageParams = {
  resolution: '1K',
  quality: 'standard',
  ratio: '1:1',
  count: 1,
}

export const IMAGE_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]

/** Compute pixel size string from resolution + ratio (longer edge = base) */
export function computeImageSize(resolution: '1K' | '2K' | '4K', ratio: string): string {
  const base = resolution === '4K' ? 4096 : resolution === '2K' ? 2048 : 1024
  const [w, h] = ratio.split(':').map(Number)
  if (w === h) return `${base}x${base}`
  if (w > h) return `${base}x${Math.round(base * h / w)}`
  return `${Math.round(base * w / h)}x${base}`
}

interface Props {
  sessionId: string | null
  sessionTitle: string
  onSaveAsWorkflow?: () => void
  /** Persist the renamed title. Called with the trimmed new title. */
  onRename?: (newTitle: string) => void
  /** Export the active session. Format chosen via dropdown. */
  onExport?: (format: 'markdown' | 'json') => void
}

/**
 * Slim chat header — shows the current session title prominently and a few
 * top-right actions. Click the title (or the pencil) to rename inline.
 */
export function ChatHeader({ sessionId, sessionTitle, onSaveAsWorkflow, onRename, onExport }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(sessionTitle)
  const [exportOpen, setExportOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const exportWrapRef = useRef<HTMLDivElement>(null)

  // Close export menu on outside click
  useEffect(() => {
    if (!exportOpen) return
    function onDown(e: MouseEvent) {
      if (exportWrapRef.current && !exportWrapRef.current.contains(e.target as Node)) setExportOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setExportOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [exportOpen])

  // Keep draft in sync if session changes externally
  useEffect(() => {
    setDraft(sessionTitle)
    setEditing(false)
  }, [sessionId, sessionTitle])

  // Auto-focus + select all when entering edit mode
  useEffect(() => {
    if (!editing) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
    return () => clearTimeout(t)
  }, [editing])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== sessionTitle && onRename) {
      onRename(trimmed)
    } else {
      setDraft(sessionTitle)
    }
    setEditing(false)
  }

  function cancel() {
    setDraft(sessionTitle)
    setEditing(false)
  }

  if (!sessionId) {
    return (
      <div className="px-5 py-3 border-b border-border/60 flex items-center gap-2 bg-card/30">
        <span className="text-xs text-muted-foreground/60">未选择对话</span>
      </div>
    )
  }

  return (
    <div className="relative z-20 px-5 py-3 border-b border-border/60 flex items-center gap-3 bg-card/30 backdrop-blur-sm">
      <MessageSquare size={15} className="text-muted-foreground shrink-0" />

      {editing ? (
        <>
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            onBlur={commit}
            maxLength={120}
            className="flex-1 min-w-0 bg-transparent text-base font-medium outline-none border-b border-border focus:border-ring transition-colors"
          />
          <button
            onMouseDown={(e) => e.preventDefault()}  // keep input focus, don't trigger onBlur first
            onClick={commit}
            title="保存 (Enter)"
            className="p-1 rounded text-green-600 hover:bg-green-500/10"
          >
            <Check size={14} />
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
            title="取消 (Esc)"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => onRename && setEditing(true)}
            title={onRename ? '点击重命名对话' : sessionTitle}
            disabled={!onRename}
            className="flex-1 min-w-0 group flex items-center gap-1.5 text-left disabled:cursor-default"
          >
            <h2 className="truncate text-base font-medium">
              {sessionTitle || '未命名对话'}
            </h2>
            {onRename && (
              <Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0 text-muted-foreground" />
            )}
          </button>
          {onExport && (
            <div ref={exportWrapRef} className="relative">
              <button
                onClick={() => setExportOpen(o => !o)}
                title="导出当前对话"
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors',
                  exportOpen && 'bg-muted/60 text-foreground'
                )}
              >
                <Download size={12} />
                导出
                <ChevronDown size={10} className={cn('transition-transform', exportOpen && 'rotate-180')} />
              </button>
              {exportOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-popover border border-border rounded-lg shadow-xl py-1">
                  <button
                    onClick={() => { onExport('markdown'); setExportOpen(false) }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                  >
                    Markdown (.md)
                    <span className="block text-[10px] text-muted-foreground/70">用于阅读 / 分享</span>
                  </button>
                  <button
                    onClick={() => { onExport('json'); setExportOpen(false) }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                  >
                    JSON (.json)
                    <span className="block text-[10px] text-muted-foreground/70">完整结构，可再导入</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {onSaveAsWorkflow && (
            <button
              onClick={onSaveAsWorkflow}
              title="把当前对话转换为可视化工作流"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <GitBranch size={12} />
              保存为工作流
            </button>
          )}
        </>
      )}
    </div>
  )
}
