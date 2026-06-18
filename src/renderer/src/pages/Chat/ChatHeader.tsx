import { useEffect, useRef, useState } from 'react'
import { GitBranch, MessageSquare, Pencil, Check, X, Download, ChevronDown, Brain, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useT } from '../../lib/i18n'
import { toast } from '../../components/ui/Toast'
import { EmployeePicker } from './EmployeePicker'
import { GroupRoster } from './GroupRoster'
import type { EmployeeInfo } from '../../../../shared/ipc-types'

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
  /** Open the「对话长截图」dialog (export all / selected messages as one PNG). */
  onExportImage?: () => void
  /** Hired employees, for the "与员工单独对话" picker. */
  employees?: EmployeeInfo[]
  /** Currently-bound employee id for this session (null = unbound). */
  boundEmployeeId?: string | null
  /** Bind / unbind an employee to this session (null = unbind). */
  onBindEmployee?: (employeeId: string | null) => void
  /** Group-chat member ids (non-empty ⇒ show a roster chip instead of the picker). */
  groupEmployeeIds?: string[] | null
  /** Pull an employee into the group / remove one (group chat only). */
  onAddGroupMember?: (employeeId: string) => void
  onRemoveGroupMember?: (employeeId: string) => void
}

/**
 * Slim chat header — shows the current session title prominently and a few
 * top-right actions. Click the title (or the pencil) to rename inline.
 */
export function ChatHeader({ sessionId, sessionTitle, onSaveAsWorkflow, onRename, onExport, onExportImage, employees, boundEmployeeId, onBindEmployee, groupEmployeeIds, onAddGroupMember, onRemoveGroupMember }: Props) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(sessionTitle)
  const [exportOpen, setExportOpen] = useState(false)
  const [remembering, setRemembering] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function rememberConversation() {
    if (!sessionId || remembering) return
    setRemembering(true)
    try {
      const r = await window.api.captureSessionMemory(sessionId) as { count: number }
      toast.success(r.count > 0 ? `已记住 ${r.count} 条` : '这次对话暂无值得长期记住的内容')
    } catch (e) {
      toast.error('提炼记忆失败：' + (e as Error).message)
    } finally {
      setRemembering(false)
    }
  }
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
        <span className="text-xs text-muted-foreground/60">{t('chatHeader.noSession')}</span>
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
            title={t('chatHeader.saveTitle')}
            className="p-1 rounded text-green-600 hover:bg-green-500/10"
          >
            <Check size={14} />
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
            title={t('chatHeader.cancelTitle')}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => onRename && setEditing(true)}
            title={onRename ? t('chatHeader.renameTitle') : sessionTitle}
            disabled={!onRename}
            className="flex-1 min-w-0 group flex items-center gap-1.5 text-left disabled:cursor-default"
          >
            <h2 className="truncate text-base font-medium">
              {sessionTitle || t('chatHeader.untitled')}
            </h2>
            {onRename && (
              <Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0 text-muted-foreground" />
            )}
          </button>
          {onBindEmployee && (
            <EmployeePicker
              employees={employees ?? []}
              value={boundEmployeeId ?? null}
              onChange={onBindEmployee}
            />
          )}
          {(groupEmployeeIds?.length ?? 0) > 0 && onAddGroupMember && onRemoveGroupMember && (
            <GroupRoster
              employees={employees ?? []}
              memberIds={groupEmployeeIds ?? []}
              onAdd={onAddGroupMember}
              onRemove={onRemoveGroupMember}
            />
          )}
          <button
            onClick={rememberConversation}
            disabled={remembering}
            title="从这次对话提炼长期记忆（让助手越用越懂你）"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
          >
            {remembering ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
            记住对话
          </button>
          {onExport && (
            <div ref={exportWrapRef} className="relative">
              <button
                onClick={() => setExportOpen(o => !o)}
                title={t('chatHeader.exportTitle')}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors',
                  exportOpen && 'bg-muted/60 text-foreground'
                )}
              >
                <Download size={12} />
                {t('chatHeader.export')}
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
                  {onExportImage && (
                    <button
                      onClick={() => { onExportImage(); setExportOpen(false) }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors border-t border-border/60"
                    >
                      长截图 (.png)
                      <span className="block text-[10px] text-muted-foreground/70">整段或勾选部分，拼成一张图分享</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {onSaveAsWorkflow && (
            <button
              onClick={onSaveAsWorkflow}
              title={t('chatHeader.saveAsWorkflowTitle')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <GitBranch size={12} />
              {t('chatHeader.saveAsWorkflow')}
            </button>
          )}
        </>
      )}
    </div>
  )
}
