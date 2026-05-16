import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'
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
}

/**
 * Themed replacement for <select>. Uses a popover with keyboard navigation
 * (ArrowUp/ArrowDown/Enter/Esc), grouped option support, and per-option icons.
 *
 * The native <select> uses OS-level styling that can't be customized; this
 * component renders a portal-less fixed popover that picks up the app theme.
 */
export function Select<T extends string = string>({
  value, onChange, options, placeholder, disabled, size = 'sm', trigger,
  className, placement = 'auto', title, popoverWidth = 'trigger'
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState<number>(() => Math.max(0, options.findIndex(o => o.value === value)))
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number; width: number; flip: boolean }>({
    top: 0, left: 0, width: 0, flip: false
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const selected = options.find(o => o.value === value)

  // Position popover relative to trigger
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const width = popoverWidth === 'trigger' ? rect.width : popoverWidth
    const spaceBelow = window.innerHeight - rect.bottom
    const flip = placement === 'top' || (placement === 'auto' && spaceBelow < 240)
    const top = flip ? rect.top : rect.bottom + 4
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setPopoverPos({ top, left, width, flip })
  }, [open, placement, popoverWidth])

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (popoverRef.current?.contains(e.target as Node)) return
      if (triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx(i => {
          let n = i
          do { n = (n + 1) % options.length } while (options[n]?.disabled && n !== i)
          return n
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx(i => {
          let n = i
          do { n = (n - 1 + options.length) % options.length } while (options[n]?.disabled && n !== i)
          return n
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const opt = options[activeIdx]
        if (opt && !opt.disabled) {
          onChange(opt.value)
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, activeIdx, options, onChange])

  // Sync activeIdx when value changes externally or popover opens
  useEffect(() => {
    if (open) {
      const i = options.findIndex(o => o.value === value)
      if (i >= 0) setActiveIdx(i)
    }
  }, [open, value, options])

  // Scroll active option into view
  useEffect(() => {
    if (!open) return
    popoverRef.current?.querySelector<HTMLButtonElement>(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  // Build grouped option layout (preserve original order; groupLabel changes start a new section)
  const sections: Array<{ label: string | null; items: Array<{ opt: SelectOption<T>; idx: number }> }> = []
  let currentLabel: string | null = null
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const label = opt.groupLabel ?? null
    if (sections.length === 0 || label !== currentLabel) {
      sections.push({ label, items: [] })
      currentLabel = label
    }
    sections[sections.length - 1].items.push({ opt, idx: i })
  }

  const triggerEl = trigger ? trigger({ open, selected }) : (
    <DefaultTrigger
      size={size}
      open={open}
      selected={selected}
      placeholder={placeholder}
      disabled={disabled}
    />
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className={cn('group inline-flex', disabled && 'opacity-50 cursor-not-allowed', className)}
      >
        {triggerEl}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          className="fixed z-[150] bg-popover border border-border rounded-lg shadow-xl py-1 max-h-72 overflow-y-auto"
          style={{
            top: popoverPos.flip ? undefined : popoverPos.top,
            bottom: popoverPos.flip ? window.innerHeight - popoverPos.top + 4 : undefined,
            left: popoverPos.left,
            minWidth: popoverPos.width
          }}
        >
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
                  onClick={() => {
                    if (opt.disabled) return
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                    idx === activeIdx ? 'bg-accent' : 'hover:bg-accent/50',
                    opt.value === value ? 'text-foreground' : 'text-foreground/80',
                    opt.disabled && 'opacity-40 cursor-not-allowed'
                  )}
                >
                  {opt.icon && <span className="shrink-0 text-muted-foreground">{opt.icon}</span>}
                  <span className="flex-1 truncate">{opt.label}</span>
                  {opt.hint && <span className="text-[10px] text-muted-foreground/60 ml-2">{opt.hint}</span>}
                  {opt.value === value && <Check size={12} className="text-primary shrink-0" />}
                </button>
              ))}
            </div>
          ))}
          {options.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground/60">无可选项</p>
          )}
        </div>
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
        open
          ? 'border-ring ring-1 ring-ring/40'
          : 'border-border hover:border-border/80',
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
