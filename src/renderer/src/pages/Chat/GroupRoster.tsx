import { useEffect, useRef, useState } from 'react'
import { Users, Check, ChevronDown, UserPlus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { dept } from '../../lib/departments'
import { useUIStore } from '../../stores/ui'
import type { EmployeeInfo } from '../../../../shared/ipc-types'

interface Props {
  /** All hired employees (the add-pool). */
  employees: EmployeeInfo[]
  /** Current group member ids (in order). */
  memberIds: string[]
  onAdd: (employeeId: string) => void
  onRemove: (employeeId: string) => void
}

/**
 * 群聊成员管理胶囊：显示当前成员名单，点开后可【拉人进群】或【移出】。勾选=在群里，
 * 点一下切换加入/移出。保证至少留 2 人（群聊的意义）。
 */
export function GroupRoster({ employees, memberIds, onAdd, onRemove }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const memberSet = new Set(memberIds)
  const members = memberIds.map(id => employees.find(e => e.id === id)).filter(Boolean) as EmployeeInfo[]
  const label = members.length ? members.map(e => e.name).join('、') : '群聊'

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        title="群聊成员（点击管理：拉人进群 / 移出）"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/12 text-primary text-xs ring-1 ring-primary/20 hover:bg-primary/20 transition-colors"
      >
        <Users size={12} />
        <span className="max-w-[200px] truncate font-medium">{label}</span>
        <span className="text-[10px] opacity-70 tabular-nums">{memberIds.length}</span>
        <ChevronDown size={10} className={cn('transition-transform opacity-70', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 max-h-80 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 select-none flex items-center gap-1">
            <UserPlus size={11} /> 管理群聊成员
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
            </div>
          )}
          {employees.map(e => {
            const d = dept(e.dept)
            const inGroup = memberSet.has(e.id)
            // Keep at least 2 members — block removing when that would drop below 2.
            const blockRemove = inGroup && memberIds.length <= 2
            return (
              <button
                key={e.id}
                onClick={() => { if (inGroup) { if (!blockRemove) onRemove(e.id) } else onAdd(e.id) }}
                disabled={blockRemove}
                title={blockRemove ? '群聊至少保留 2 人' : inGroup ? '点击移出群聊' : '点击拉进群聊'}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  inGroup ? 'bg-accent/40 hover:bg-accent/60' : 'hover:bg-accent/60'
                )}
              >
                <span className={cn(
                  'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                  inGroup ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                )}>
                  {inGroup && <Check size={11} />}
                </span>
                <span className="w-6 h-6 rounded-md grid place-items-center text-[13px] shrink-0 border border-border" style={{ background: d.color + '22' }}>{d.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium truncate">{e.name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{d.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
