import { cn } from '../../lib/utils'

/**
 * macOS "System Settings" style grouped list. A SettingsGroup is a single rounded
 * card with hairline separators between rows; each SettingsRow is label-left /
 * control-right. Replaces the app's older pattern of N separate bordered cards
 * stacked with gaps.
 */
export function SettingsGroup({
  title,
  footnote,
  children,
  className
}: {
  title?: React.ReactNode
  footnote?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {title && (
        <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">{title}</div>
      )}
      <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border/60">
        {children}
      </div>
      {footnote && <p className="px-1 text-[11px] text-muted-foreground/80 leading-relaxed">{footnote}</p>}
    </div>
  )
}

export function SettingsRow({
  icon,
  title,
  description,
  control,
  /** stack the control below the text instead of right-aligning (wide controls) */
  stacked,
  /** vertical alignment of the control against the text block */
  align = 'center',
  children,
  className
}: {
  icon?: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  stacked?: boolean
  align?: 'center' | 'start'
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('px-4 py-3', className)}>
      <div className={cn('flex gap-3', align === 'center' ? 'items-center' : 'items-start')}>
        {icon && <div className={cn('shrink-0', align === 'start' && 'mt-0.5')}>{icon}</div>}
        {(title || description) && (
          <div className="flex-1 min-w-0">
            {title && <div className="text-sm font-medium flex items-center gap-2 flex-wrap">{title}</div>}
            {description && (
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
            )}
          </div>
        )}
        {control && !stacked && <div className="shrink-0 ml-2">{control}</div>}
      </div>
      {control && stacked && <div className="mt-2.5">{control}</div>}
      {children}
    </div>
  )
}
