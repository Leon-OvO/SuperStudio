import { cn } from '../../lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** md = standard macOS pill (38×22); sm = compact (32×18) for dense lists */
  size?: 'sm' | 'md'
  title?: string
  className?: string
}

/**
 * macOS-style pill toggle: rounded track, white knob with a soft shadow, fills
 * with the primary color when on, knob springs across on toggle. Shared so every
 * on/off setting in the app reads identically.
 */
export function Switch({ checked, onChange, disabled, size = 'md', title, className }: SwitchProps) {
  const dims =
    size === 'sm'
      ? { track: 'h-[18px] w-8', knob: 'h-3.5 w-3.5', on: 'translate-x-[14px]', off: 'translate-x-0.5' }
      : { track: 'h-[22px] w-[38px]', knob: 'h-[18px] w-[18px]', on: 'translate-x-[17px]', off: 'translate-x-0.5' }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/30',
        dims.track,
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
          dims.knob,
          checked ? dims.on : dims.off
        )}
      />
    </button>
  )
}
