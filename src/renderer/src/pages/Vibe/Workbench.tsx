import { useEffect, useRef, useState } from 'react'
import { Building2, X, ArrowRight, Store, Users, Hammer, LayoutGrid, BarChart3, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { VibeWorkbench } from './index'
import { Board, Market, Roster, Dashboard } from '../Company'
import { useEmployeesStore } from '../../stores/employees'
import type { ProviderConfig, VibeRequestInfo } from '../../../../shared/ipc-types'

/**
 * 「公司」页（侧边栏入口，原名「构建」）：把 Vibe IDE 与公司经营（人才/团队/看板/
 * 经营台）合并到一个页面，顶部一行 tab 切换。消除两者割裂，也让侧边栏少一个顶级入口。
 *
 * 标签顺序按「经营一家公司」的真实路径：
 *   🛒 人才市场 → 👥 团队 → 🛠 工作台 → 🏢 看板 → 📊 经营台
 * 招人 → 配模型 → 提需求 → 派活开工/看工位 → 复盘成本。首次进入按状态智能落点，
 * 并用一条步骤引导条把新用户从空公司一步步带上路。
 */
type Tab = 'market' | 'team' | 'ide' | 'board' | 'dash'

export function WorkbenchPage() {
  const [tab, setTab] = useState<Tab>('ide')
  const employees = useEmployeesStore(s => s.employees)
  const loaded = useEmployeesStore(s => s.loaded)
  const refreshEmployees = useEmployeesStore(s => s.refresh)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [requestCount, setRequestCount] = useState<number | null>(null)
  // 有 applying/done 需求 ⇒ 已经派过活，引导第③步算完成。
  const [hasDispatched, setHasDispatched] = useState(false)
  const [guideDismissed, setGuideDismissed] = useState(() => sessionStorage.getItem('company-guide-dismissed') === '1')
  // 智能默认落点只在首次员工列表就绪时设一次，之后不再覆盖用户的手动切换。
  const defaultApplied = useRef(false)

  const loadRequestStats = () => {
    window.api.vibeRequestListAll?.()
      .then((r: VibeRequestInfo[]) => {
        const list = r.filter(x => x.kind === 'change' || x.kind === 'bugfix')
        setRequestCount(list.length)
        setHasDispatched(list.some(x => x.status === 'applying' || x.status === 'done'))
      })
      .catch(() => {})
  }

  useEffect(() => {
    refreshEmployees()
    loadRequestStats()
    window.api.listProviders().then((p: ProviderConfig[]) => setProviders(p)).catch(() => {})
  }, [refreshEmployees])

  // 切到公司类 tab 时刷新一次员工与需求统计，保证在岗/引导最新
  useEffect(() => { if (tab !== 'ide') { refreshEmployees(); loadRequestStats() } }, [tab, refreshEmployees])

  // 智能默认：员工列表就绪后，没有员工 → 落「人才市场」开始招人；否则保持「工作台」。
  useEffect(() => {
    if (!loaded || defaultApplied.current) return
    defaultApplied.current = true
    if (employees.length === 0) setTab('market')
  }, [loaded, employees.length])

  const hiredSoulIds = new Set(employees.map(e => e.soulId))
  const busy = employees.filter(e => e.status === 'busy').length

  const TABS: { key: Tab; label: string; Icon: LucideIcon; badge?: string }[] = [
    { key: 'market', label: '人才市场', Icon: Store },
    { key: 'team', label: '团队', Icon: Users, badge: employees.length ? String(employees.length) : undefined },
    { key: 'ide', label: '工作台', Icon: Hammer },
    { key: 'board', label: '看板', Icon: LayoutGrid },
    { key: 'dash', label: '经营台', Icon: BarChart3 }
  ]

  // ── 步骤引导：根据流程进度算出「下一步」──────────────────────────────────
  // 一旦有员工且提过需求即视为已上路，引导条不再出现（用户也可手动 ✕ 关）。
  const flowUnderway = employees.length > 0 && (requestCount ?? 0) > 0
  const guide: { step: number; text: string; cta: string; go: Tab } | null =
    guideDismissed || flowUnderway ? null :
    employees.length === 0
      ? { step: 1, text: '先去人才市场招募你的第一位 AI 员工', cta: '去招募', go: 'market' }
      : (requestCount ?? 0) === 0
        ? { step: 2, text: '打开一个项目，在工作台描述你的第一个需求', cta: '去提需求', go: 'ide' }
        : !hasDispatched
          ? { step: 3, text: '在看板给需求指派员工并「开工」', cta: '去派活', go: 'board' }
          : null

  function dismissGuide() {
    setGuideDismissed(true)
    sessionStorage.setItem('company-guide-dismissed', '1')
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* workbench-level tab bar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-card/60 shrink-0">
        <Building2 size={14} className="text-primary shrink-0" />
        <div className="flex gap-0.5">
          {TABS.map(({ key, label, Icon, badge }) => (
            <button key={key} onClick={() => setTab(key)}
              className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs', tab === key ? 'bg-primary/15 text-primary font-semibold' : 'text-muted-foreground hover:text-foreground')}>
              <Icon size={13} className="shrink-0" />
              {label}
              {badge && <span className="text-[10px] px-1 rounded bg-muted-foreground/15 tabular-nums">{badge}</span>}
            </button>
          ))}
        </div>
        {tab !== 'ide' && (
          <div className="ml-auto text-[11px] text-muted-foreground">在岗 <b className="text-foreground">{employees.length - busy}</b>/{employees.length}</div>
        )}
      </div>

      {/* 步骤引导条 —— 仅在流程未跑通时出现 */}
      {guide && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-primary/20 bg-primary/5 shrink-0 text-[11.5px]">
          <span className="shrink-0 w-4 h-4 rounded-full bg-primary text-primary-foreground grid place-items-center text-[10px] font-bold">{guide.step}</span>
          <span className="text-foreground/90">{guide.text}</span>
          <button onClick={() => setTab(guide.go)} className="shrink-0 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90">
            {guide.cta} <ArrowRight size={11} />
          </button>
          <div className="flex-1" />
          <button onClick={dismissGuide} className="shrink-0 text-muted-foreground/60 hover:text-foreground" title="不再提示（本次会话）"><X size={12} /></button>
        </div>
      )}

      {/* IDE stays mounted (preserves terminal/editor state); company views overlay it. */}
      <div className={cn('flex-1 min-h-0', tab === 'ide' ? 'flex flex-col' : 'hidden')}>
        <VibeWorkbench />
      </div>
      {tab !== 'ide' && (
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {tab === 'market' && <Market hiredSoulIds={hiredSoulIds} onHire={refreshEmployees} />}
          {tab === 'team' && <Roster employees={employees} providers={providers} onChange={refreshEmployees} goMarket={() => setTab('market')} />}
          {tab === 'board' && <Board employees={employees} onChange={refreshEmployees} goMarket={() => setTab('market')} goWorkbench={() => setTab('ide')} />}
          {tab === 'dash' && <Dashboard employees={employees} />}
        </div>
      )}
    </div>
  )
}
