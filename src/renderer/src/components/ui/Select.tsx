import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SelectOption<T = string> {
  value: T
  label: string
  hint?: string
  icon?: React.ReactNode
  disabled?: boolean
  /** Group header — items below this until next group form a section. */
  groupLabel?: string
}

interface Props<T extends string = string> {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  placeholder?: string
  disabled?: boolean
  /** Size variant — sm is the default chip-like size used in toolbars. */
  size?: 'sm' | 'md'
  /** Render a custom trigger (overrides the default chevron button). */
  trigger?: (props: { open: boolean; selected: SelectOption<T> | undefined }) => React.ReactNode
  className?: string
  /** Open the popover above the trigger instead of below. */
  placement?: 'top' | 'bottom' | 'auto'
  /** ARIA label for the trigger (used as title). */
  title?: string
  /** Width override for the popover (default: same as trigger). */
  popoverWidth?: number | 'trigger'
  /** Show a type-to-filter search box. Defaults to true once there are enough
   *  options to be worth filtering (>8); pass explicitly to force on/off. */
  searchable?: boolean
  /** Placeholder for the search box. */
  searchPlaceholder?: string
}

// Auto-show the search box only once a list is long enough that scanning it is
// painful. Kept high enough that short chip lists (image ratios, search engines,
// enums) don't grow an unexpected search box; long model/employee lists do.
const SEARCH_AUTO_THRESHOLD = 12
const POPOVER_MAX_H = 384

/**
 * Themed replacement for <select>. Uses a fixed popover with keyboard navigation
 * (ArrowUp/ArrowDown/Enter/Esc), grouped option support, per-option icons, and an
 * optional type-to-filter search box.
 *
 * The popover height adapts to the available viewport space (always fits + scrolls)
 * and its width grows to the longest option (clamped to the viewport), so long
 * model names and long lists both display completely.
 */
export function Select<T extends string = string>({
  value, onChange, options, placeholder, disabled, size = 'sm', trigger,
  className, placement = 'auto', title, popoverWidth = 'trigger', searchable,
  searchPlaceholder = '搜索…'
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxWidth: number; maxHeight: number; flip: boolean }>({
    top: 0, left: 0, width: 0, maxWidth: 0, maxHeight: POPOVER_MAX_H, flip: false
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = options.find(o => o.value === value)
  const showSearch = searchable ?? options.length > SEARCH_AUTO_THRESHOLD

  // Filter by query (label / value / hint), preserving order + group labels.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      o.label.toLowerCase().includes(q) ||
      String(o.value).toLowerCase().includes(q) ||
      (o.hint?.toLowerCase().includes(q) ?? false)
    )
  }, [options, query])

  const firstEnabled = (list: SelectOption<T>[]): number => {
    const i = list.findIndex(o => !o.disabled)
    return i >= 0 ? i : 0
  }

  // Position popover relative to trigger: pick the side with room, cap height to
  // the available space (so it never runs off-screen), let width grow to content.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const baseWidth = popoverWidth === 'trigger' ? rect.width : popoverWidth
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    const flip = placement === 'top' || (placement === 'auto' && spaceBelow < 240 && spaceAbove > spaceBelow)
    // Cap to the chosen side's available space so the popover ALWAYS fits the
    // viewport (it scrolls internally); no hard min that could push it off-screen.
    const maxHeight = Math.min(POPOVER_MAX_H, Math.max(0, flip ? spaceAbove : spaceBelow))
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - baseWidth - 8))
    const maxWidth = Math.max(baseWidth, window.innerWidth - left - 8)
    setPos({ top: flip ? rect.top : rect.bottom + 4, left, width: baseWidth, maxWidth, maxHeight, flip })
  }, [open, placement, popoverWidth])

  // Reset query on close; on open seed the active row to the current value and
  // focus the search box (when shown) for immediate typing.
  useEffect(() => {
    if (!open) { setQuery(''); return }
    const i = options.findIndex(o => o.value === value)
    setActiveIdx(i >= 0 ? i : firstEnabled(options))
    if (showSearch) requestAnimationFrame(() => searchRef.current?.focus())
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the filter changes, jump the active row to the first match.
  useEffect(() => {
    if (open) setActiveIdx(firstEnabled(filtered))
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click / keyboard navigation over the FILTERED list.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (popoverRef.current?.contains(e.target as Node)) return
      if (triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      const n = filtered.length
      if (e.key === 'Escape') {
        e.preventDefault(); setOpen(false); triggerRef.current?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!n) return
        setActiveIdx(i => { let k = i; do { k = (k + 1) % n } while (filtered[k]?.disabled && k !== i); return k })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!n) return
        setActiveIdx(i => { let k = i; do { k = (k - 1 + n) % n } while (filtered[k]?.disabled && k !== i); return k })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const opt = filtered[activeIdx]
        if (opt && !opt.disabled) { onChange(opt.value); setOpen(false); triggerRef.current?.focus() }
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open, activeIdx, filtered, onChange])

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return
    popoverRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  // Group the FILTERED options into sections (groupLabel changes start a section).
  const sections = useMemo(() => {
    const out: Array<{ label: string | null; items: Array<{ opt: SelectOption<T>; idx: number }> }> = []
    let cur: string | null = null
    for (let i = 0; i < filtered.length; i++) {
      const label = filtered[i].groupLabel ?? null
      if (out.length === 0 || label !== cur) { out.push({ label, items: [] }); cur = label }
      out[out.length - 1].items.push({ opt: filtered[i], idx: i })
    }
    return out
  }, [filtered])

  const triggerEl = trigger ? trigger({ open, selected }) : (
    <DefaultTrigger size={size} open={open} selected={selected} placeholder={placeholder} disabled={disabled} />
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); setOpen(true) }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className={cn('group inline-flex', disabled && 'opacity-50 cursor-not-allowed', className)}
      >
        {triggerEl}
      </button>

      {open && createPortal(
        // Portal to <body> so the popover escapes any ancestor that clips
        // (overflow) or creates a stacking context (backdrop-blur in the title
        // bar / sidebar) — otherwise it can be hidden behind page content.
        <div
          ref={popoverRef}
          role="listbox"
          className="fixed z-[150] w-max bg-popover border border-border rounded-lg shadow-xl flex flex-col overflow-hidden animate-popover-in"
          style={{
            top: pos.flip ? undefined : pos.top,
            bottom: pos.flip ? window.innerHeight - pos.top + 4 : undefined,
            left: pos.left,
            minWidth: pos.width,
            maxWidth: pos.maxWidth,
            maxHeight: pos.maxHeight,
            transformOrigin: pos.flip ? 'bottom center' : 'top center'
          }}
        >
          {showSearch && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border shrink-0">
              <Search size={12} className="text-muted-foreground/60 shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
              />
            </div>
          )}

          <div className="overflow-y-auto py-1 min-h-0">
            {sections.map((section, si) => (
              <div key={si}>
                {section.label && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 select-none">
                    {section.label}
                  </div>
                )}
                {section.items.map(({ opt, idx }) => (
                  <button
                    key={String(opt.value)}
                    data-idx={idx}
                    type="button"
                    disabled={opt.disabled}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => { if (opt.disabled) return; onChange(opt.value); setOpen(false) }}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                      idx === activeIdx ? 'bg-accent' : 'hover:bg-accent/50',
                      opt.value === value ? 'text-foreground' : 'text-foreground/80',
                      opt.disabled && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    {opt.icon && <span className="shrink-0 text-muted-foreground">{opt.icon}</span>}
                    <span className="flex-1 truncate">{opt.label}</span>
                    {opt.hint && <span className="text-[10px] text-muted-foreground/60 ml-2 shrink-0">{opt.hint}</span>}
                    {opt.value === value && <Check size={12} className="text-primary shrink-0" />}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground/60">{query ? '无匹配项' : '无可选项'}</p>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

function DefaultTrigger<T extends string>({
  size, open, selected, placeholder, disabled
}: {
  size: 'sm' | 'md'
  open: boolean
  selected: SelectOption<T> | undefined
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-md border bg-card transition-all',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        open ? 'border-ring ring-1 ring-ring/40' : 'border-border hover:border-border/80',
        disabled && 'cursor-not-allowed'
      )}
    >
      {selected?.icon && <span className="shrink-0 text-muted-foreground">{selected.icon}</span>}
      <span className={cn('flex-1 truncate text-left', !selected && 'text-muted-foreground/60')}>
        {selected?.label ?? placeholder ?? '请选择'}
      </span>
      <ChevronDown
        size={size === 'sm' ? 11 : 13}
        className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
      />
    </span>
  )
}
