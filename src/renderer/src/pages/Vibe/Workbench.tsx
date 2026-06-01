import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { VibeWorkbench } from './index'
import { Board, Market, Roster, Dashboard } from '../Company'
import { useEmployeesStore } from '../../stores/employees'
import type { ProviderConfig } from '../../../../shared/ipc-types'

/**
 * 「公司」页（侧边栏入口，原名「构建」）：把 Vibe IDE 与公司经营（人才/看板/团队/
 * 经营台）合并到一个页面，顶部一行 tab 切换。消除两者割裂，也让侧边栏少一个顶级入口。
 *   🛠 工作台 = 原 Vibe IDE（默认）
 *   🗂 看板 / 🛒 人才市场 / 👥 团队 / 📊 经营台 = 复用 Company 子视图
 */
type Tab = 'ide' | 'board' | 'market' | 'team' | 'dash'

export function WorkbenchPage() {
  const [tab, setTab] = useState<Tab>('ide')
  const employees = useEmployeesStore(s => s.employees)
  const refreshEmployees = useEmployeesStore(s => s.refresh)
  const [providers, setProviders] = useState<ProviderConfig[]>([])

  useEffect(() => {
    refreshEmployees()
    window.api.listProviders().then((p: ProviderConfig[]) => setProviders(p)).catch(() => {})
  }, [refreshEmployees])
  // 切到公司类 tab 时刷新一次员工，保证统计/在岗最新
  useEffect(() => { if (tab !== 'ide') refreshEmployees() }, [tab, refreshEmployees])

  const hiredSoulIds = new Set(employees.map(e => e.soulId))
  const busy = employees.filter(e => e.status === 'busy').length

  const TABS: [Tab, string][] = [
    ['ide', '🛠 工作台'],
    ['board', '🗂 看板'],
    ['market', '🛒 人才市场'],
    ['team', `👥 团队 ${employees.length}`],
    ['dash', '📊 经营台']
  ]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* workbench-level tab bar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-card/60 shrink-0">
        <Building2 size={14} className="text-primary shrink-0" />
        <div className="flex gap-0.5">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn('px-3 py-1 rounded-md text-xs', tab === k ? 'bg-primary/15 text-primary font-semibold' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        {tab !== 'ide' && (
          <div className="ml-auto text-[11px] text-muted-foreground">在岗 <b className="text-foreground">{employees.length - busy}</b>/{employees.length}</div>
        )}
      </div>

      {/* IDE stays mounted (preserves terminal/editor state); company views overlay it. */}
      <div className={cn('flex-1 min-h-0', tab === 'ide' ? 'flex flex-col' : 'hidden')}>
        <VibeWorkbench />
      </div>
      {tab !== 'ide' && (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {tab === 'board' && <Board employees={employees} onChange={refreshEmployees} goMarket={() => setTab('market')} goWorkbench={() => setTab('ide')} />}
          {tab === 'market' && <Market hiredSoulIds={hiredSoulIds} onHire={refreshEmployees} />}
          {tab === 'team' && <Roster employees={employees} providers={providers} onChange={refreshEmployees} goMarket={() => setTab('market')} />}
          {tab === 'dash' && <Dashboard employees={employees} />}
        </div>
      )}
    </div>
  )
}
