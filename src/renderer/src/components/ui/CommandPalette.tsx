import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, MessageSquare, Plus, Zap, Image as ImageIcon, Brain, Settings, X, ArrowRight, Loader2 } from 'lucide-react'
import type { Session } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

type Action =
  | { kind: 'nav'; id: string; label: string; hint: string; icon: React.ReactNode; run: () => void }
  | { kind: 'session'; session: Session; run: () => void }

const navigateTo = (page: string): void => {
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page } }))
}

/**
 * Cmd/Ctrl+K palette — quick search across sessions plus the most common
 * navigation actions. Keyboard-only: arrow keys move selection, Enter runs,
 * Esc dismisses.
 */
export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null)
  const [searching, setSearching] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load sessions on open
  useEffect(() => {
    if (!open) return
    setQuery('')
    setMatchedIds(null)
    setCursor(0)
    window.api.listSessions().then(setSessions).catch(() => setSessions([]))
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  // FTS debounced
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (!trimmed) { setMatchedIds(null); return }
    setSearching(true)
    const handle = setTimeout(async () => {
      try {
        const r = await window.api.searchSessions?.(trimmed) as { matchedSessionIds: string[] } | undefined
        setMatchedIds(new Set(r?.matchedSessionIds ?? []))
      } finally {
        setSearching(false)
      }
    }, 180)
    return () => clearTimeout(handle)
  }, [query, open])

  const navActions: Action[] = useMemo(() => [
    { kind: 'nav', id: 'new-chat', label: '新建对话', hint: 'Ctrl+N', icon: <Plus size={14} />, run: () => {
        navigateTo('chat'); window.dispatchEvent(new CustomEvent('app:new-chat')); onClose()
    } },
    { kind: 'nav', id: 'chat',      label: '对话',      hint: 'Ctrl+1', icon: <MessageSquare size={14} />, run: () => { navigateTo('chat'); onClose() } },
    { kind: 'nav', id: 'workflow',  label: '工作流',    hint: 'Ctrl+2', icon: <Zap size={14} />,           run: () => { navigateTo('workflow'); onClose() } },
    { kind: 'nav', id: 'gallery',   label: '素材库',    hint: 'Ctrl+3', icon: <ImageIcon size={14} />,     run: () => { navigateTo('gallery'); onClose() } },
    { kind: 'nav', id: 'memory',    label: '记忆',      hint: 'Ctrl+4', icon: <Brain size={14} />,         run: () => { navigateTo('memory'); onClose() } },
    { kind: 'nav', id: 'settings',  label: '设置',      hint: 'Ctrl+,', icon: <Settings size={14} />,      run: () => { navigateTo('settings'); onClose() } }
  ], [onClose])

  const items = useMemo<Action[]>(() => {
    const q = query.trim().toLowerCase()
    const navFiltered = q
      ? navActions.filter(a => a.kind === 'nav' && a.label.toLowerCase().includes(q))
      : navActions

    const sessionItems: Action[] = sessions
      .filter(s => s.archived !== 1)
      .filter(s => {
        if (!q) return true
        if (matchedIds) return matchedIds.has(s.id)
        return s.title.toLowerCase().includes(q)
      })
      .slice(0, 20)
      .map(s => ({
        kind: 'session' as const,
        session: s,
        run: () => {
          window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'chat' } }))
          window.dispatchEvent(new CustomEvent('app:select-session', { detail: { sessionId: s.id } }))
          onClose()
        }
      }))

    return [...navFiltered, ...sessionItems]
  }, [navActions, sessions, query, matchedIds, onClose])

  // Clamp cursor when list shrinks
  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1))
  }, [items.length, cursor])

  // Scroll active row into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(items.length - 1, c + 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); return }
      if (e.key === 'Enter')     { e.preventDefault(); items[cursor]?.run(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[500] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl bg-popover border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Search size={14} className="text-muted-foreground/60 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0) }}
            placeholder="搜索对话或跳转到页面…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground/50"
          />
          {searching && <Loader2 size={13} className="animate-spin text-muted-foreground/60" />}
          <button
            onClick={onClose}
            className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground"
            title="关闭 (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground/50 py-8">无匹配项</p>
          ) : (
            items.map((item, idx) => {
              const active = idx === cursor
              if (item.kind === 'nav') {
                return (
                  <div
                    key={'n:' + item.id}
                    data-row={idx}
                    onMouseEnter={() => setCursor(idx)}
                    onMouseDown={(e) => { e.preventDefault(); item.run() }}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2 mx-1 rounded-md text-sm cursor-pointer transition-colors',
                      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                    )}
                  >
                    <span className="shrink-0 text-foreground/60">{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">{item.hint}</span>
                    {active && <ArrowRight size={12} className="text-muted-foreground/50 shrink-0" />}
                  </div>
                )
              }
              return (
                <div
                  key={'s:' + item.session.id}
                  data-row={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onMouseDown={(e) => { e.preventDefault(); item.run() }}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 mx-1 rounded-md text-sm cursor-pointer transition-colors',
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  <MessageSquare size={14} className="shrink-0 text-foreground/50" />
                  <span className="flex-1 truncate">{item.session.title}</span>
                  {active && <ArrowRight size={12} className="text-muted-foreground/50 shrink-0" />}
                </div>
              )
            })
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-border bg-muted/30 flex items-center gap-3 text-[10px] text-muted-foreground/60">
          <span><kbd className="px-1 rounded bg-background border border-border">↑↓</kbd> 选择</span>
          <span><kbd className="px-1 rounded bg-background border border-border">Enter</kbd> 执行</span>
          <span><kbd className="px-1 rounded bg-background border border-border">Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  )
}
