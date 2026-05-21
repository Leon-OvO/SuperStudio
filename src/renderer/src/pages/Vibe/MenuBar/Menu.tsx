import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/utils'

/** One dropdown menu in the top menu bar. Title is always rendered; the
 *  panel only mounts while `open` is true. A single MenuBar is the
 *  controller — it tracks which menu is open and listens for outside
 *  clicks / Escape to close. */
export function Menu({
  title, open, onToggle, onClose, children
}: {
  title: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on Escape. Outside-click is handled by the MenuBar parent so
  // clicking another menu title transfers focus instead of double-toggling.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        // Hover-to-switch: when ANY menu is already open and the cursor
        // crosses another title, switch to it without requiring a click —
        // matches the OS menu-bar idiom (and VS Code's).
        onMouseEnter={() => { if (!open && document.querySelector('[data-menu-open="true"]')) onToggle() }}
        data-menu-open={open ? 'true' : 'false'}
        className={cn(
          'h-7 px-2.5 text-xs rounded transition-colors',
          open ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground'
        )}
      >
        {title}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute top-full left-0 mt-0.5 z-50 min-w-[240px] py-1 rounded-md border border-border bg-popover shadow-2xl text-foreground"
          onClick={onClose}  // Any item click bubbles → close menu
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** A clickable item inside a Menu's dropdown panel. */
export function MenuItem({
  label, shortcut, icon, disabled, danger, onClick
}: {
  label: string
  shortcut?: string
  icon?: React.ReactNode
  disabled?: boolean
  danger?: boolean
  onClick?: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : danger
            ? 'hover:bg-destructive/10 hover:text-destructive'
            : 'hover:bg-accent'
      )}
    >
      <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-muted-foreground/70 font-mono shrink-0 ml-4">
          {shortcut}
        </span>
      )}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-border" />
}

export function MenuLabel({ label }: { label: string }) {
  return <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</div>
}
