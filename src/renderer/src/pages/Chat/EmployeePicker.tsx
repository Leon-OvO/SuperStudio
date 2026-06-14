import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, UserRound, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { dept } from '../../lib/departments'
import { useUIStore } from '../../stores/ui'
import type { EmployeeInfo } from '../../../../shared/ipc-types'

interface Props {
  employees: EmployeeInfo[]
  /** Currently-bound employee id, or null for an unbound conversation. */
  value: string | null
  onChange: (employeeId: string | null) => void
  disabled?: boolean
}

/**
 * Compact "正在与 …对话" chip + dropdown that binds a hired employee to the
 * current conversation. Binding injects that employee's soul persona and
 * defaults the session to their model (engine reads the binding live). The chip
 * is muted when unbound and shows the employee's dept emoji + name when bound.
 */
export function EmployeePicker({ employees, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const bound = value ? employees.find(e => e.id === value) : undefined
  // Bound-but-missing = the employee was fired while this session kept the link.
  const firedRef = !!value && !bound

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const d = bound ? dept(bound.dept) : null

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={bound ? `正在与员工「${bound.name}」对话（点击更换 / 取消绑定）` : '绑定一名已入职员工，用其岗位人格与模型单独对话'}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors disabled:opacity-50',
          bound
            ? 'bg-primary/12 text-primary ring-1 ring-primary/20 hover:bg-primary/20'
            : firedRef
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
        )}
      >
        {bound && d ? (
          <>
            <span className="text-[13px] leading-none">{d.emoji}</span>
            <span className="max-w-[120px] truncate font-medium">{bound.name}</span>
          </>
        ) : firedRef ? (
          <><UserRound size={12} /> 员工已离职</>
        ) : (
          <><UserRound size={12} /> 指定员工</>
        )}
        <ChevronDown size={10} className={cn('transition-transform opacity-70', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-60 max-h-80 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 select-none">
            与员工单独对话
          </div>
          {employees.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-muted-foreground/80 leading-relaxed">
              还没有已入职员工。
              <button
                onClick={() => {
                  useUIStore.getState().setPendingCompanyTab('market')
                  useUIStore.getState().setPage('vibe')
                  setOpen(false)
                }}
                className="text-primary hover:underline font-medium"
              >
                去人才市场招募 →
              </button>
              <span className="block mt-0.5 text-muted-foreground/60">招募后即可在这里单独对话。</span>
            </div>
          )}
          {employees.map(e => {
            const ed = dept(e.dept)
            const active = e.id === value
            return (
              <button
                key={e.id}
                onClick={() => { onChange(active ? null : e.id); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                  active ? 'bg-accent' : 'hover:bg-accent/60'
                )}
              >
                <span className="w-6 h-6 rounded-md grid place-items-center text-[13px] shrink-0 border border-border" style={{ background: ed.color + '22' }}>{ed.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium truncate">{e.name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{ed.label} · {e.modelId || '默认模型'}</span>
                </span>
                {active && <Check size={13} className="text-primary shrink-0" />}
              </button>
            )
          })}
          {value && (
            <>
              <div className="my-1 border-t border-border/60" />
              <button
                onClick={() => { onChange(null); setOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
              >
                <X size={13} className="shrink-0" /> 取消绑定（恢复普通对话）
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
