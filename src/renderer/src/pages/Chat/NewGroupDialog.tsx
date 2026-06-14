import { useState } from 'react'
import { Users, X, Check, Store } from 'lucide-react'
import { cn } from '../../lib/utils'
import { dept } from '../../lib/departments'
import { useUIStore } from '../../stores/ui'
import type { EmployeeInfo } from '../../../../shared/ipc-types'

interface Props {
  employees: EmployeeInfo[]
  onClose: () => void
  /** Create a group chat with the chosen employees (≥2). */
  onCreate: (employeeIds: string[]) => void
}

/**
 * 「新建群聊」对话框：多选已入职员工组成一个讨论组。建好后，用户每发一句话，
 * 选中的员工会轮流发言、彼此能看到对方的观点（多 Agent 互相沟通）。
 */
export function NewGroupDialog({ employees, onClose, onCreate }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const canCreate = selected.size >= 2

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-6 animate-overlay-in" onClick={onClose}>
      <div
        className="w-[460px] max-w-full max-h-[80vh] flex flex-col bg-popover border border-border rounded-2xl shadow-2xl overflow-hidden animate-dialog-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border">
          <Users size={16} className="text-primary" />
          <h3 className="text-sm font-semibold flex-1">新建群聊</h3>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60">
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-2 text-[11.5px] text-muted-foreground border-b border-border/50">
          选 2 名及以上员工组成讨论组。你每发一句话，TA 们会轮流发言、互相回应。
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {employees.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground/80 leading-relaxed">
              还没有已入职员工。<br />招募后再来组群。
              <button
                onClick={() => {
                  useUIStore.getState().setPendingCompanyTab('market')
                  useUIStore.getState().setPage('vibe')
                  onClose()
                }}
                className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
              >
                <Store size={13} /> 去人才市场招募
              </button>
            </div>
          ) : (
            employees.map(e => {
              const d = dept(e.dept)
              const on = selected.has(e.id)
              return (
                <button
                  key={e.id}
                  onClick={() => toggle(e.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                    on ? 'bg-primary/10' : 'hover:bg-accent/60'
                  )}
                >
                  <span className={cn(
                    'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                    on ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                  )}>
                    {on && <Check size={11} />}
                  </span>
                  <span className="w-8 h-8 rounded-lg grid place-items-center text-base shrink-0 border border-border" style={{ background: d.color + '22' }}>{d.emoji}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate">{e.name}</span>
                    <span className="block text-[10.5px] text-muted-foreground truncate">{d.label} · {e.modelId || '默认模型'}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border">
          <span className="text-[11px] text-muted-foreground">已选 {selected.size} 人{selected.size < 2 ? '（至少 2 人）' : ''}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60">取消</button>
            <button
              onClick={() => canCreate && onCreate([...selected])}
              disabled={!canCreate}
              className="px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              创建群聊
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
