import { cn } from '../../lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  icon?: React.ReactNode
  title?: string
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (next: T) => void
  options: SegmentedOption<T>[]
  size?: 'sm' | 'md'
  className?: string
}

/**
 * macOS-style segmented control: an inset rounded track holding equal-weight
 * segments; the selected one lifts to a card-colored pill with a soft shadow.
 * Shared so every "pick one of N" tab strip in the app reads identically.
 */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className }: SegmentedProps<T>) {
  const pad = size === 'sm' ? 'px-2.5 h-6 text-xs' : 'px-3 h-7 text-sm'
  return (
    <div className={cn('inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-muted/60', className)}>
      {options.map(opt => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150',
              pad,
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
