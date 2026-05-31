import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, Search, X, UserPlus, Trash2, Cpu, Loader2, BadgeCheck, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import type { TalentEntry, TalentBrowseResult, EmployeeInfo, ProviderConfig } from '../../../../shared/ipc-types'

// ── dept metadata ───────────────────────────────────────────────────────────
const DEPT: Record<string, { label: string; color: string; emoji: string }> = {
  engineering: { label: '工程研发', color: '#7c6cff', emoji: '⚙️' },
  design:      { label: '设计',     color: '#f06bd0', emoji: '🎨' },
  product:     { label: '产品',     color: '#5b9bff', emoji: '📋' },
  marketing:   { label: '营销增长', color: '#f0b429', emoji: '📣' },
  qa:          { label: '测试质量', color: '#3ecf8e', emoji: '🔎' },
  data:        { label: '数据/AI',  color: '#46d3d3', emoji: '🧠' },
  game:        { label: '游戏',     color: '#ff8a5b', emoji: '🎮' }
}
const dept = (k: string) => DEPT[k] || { label: k, color: '#8b91a0', emoji: '🧩' }

const LEVELS = [{ min: 0, name: '实习', icon: '🌱' }, { min: 1, name: '初级', icon: '⭐' }, { min: 3, name: '资深', icon: '💪' }, { min: 6, name: '专家', icon: '👑' }]
const levelOf = (done: number) => LEVELS.reduce((acc, l) => (done >= l.min ? l : acc), LEVELS[0])
const nextLevel = (done: number) => LEVELS.find(l => l.min > done)

const PAGE_SIZE = 24

type Tab = 'market' | 'team' | 'dash'

export function CompanyPage() {
  const [tab, setTab] = useState<Tab>('market')
  const [employees, setEmployees] = useState<EmployeeInfo[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])

  const refreshEmployees = useCallback(() => { window.api.listEmployees().then((e: EmployeeInfo[]) => setEmployees(e)).catch(() => {}) }, [])
  useEffect(() => {
    refreshEmployees()
    window.api.listProviders().then((p: ProviderConfig[]) => setProviders(p)).catch(() => {})
  }, [refreshEmployees])

  const hiredSoulIds = useMemo(() => new Set(employees.map(e => e.soulId)), [employees])
  const busy = employees.filter(e => e.status === 'busy').length

  return (
    <div className="flex flex-col h-full">
      {/* company header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <div className="w-8 h-8 rounded-lg grid place-items-center text-white" style={{ background: 'linear-gradient(135deg,#7c6cff,#b06cff)' }}>
          <Building2 size={16} />
        </div>
        <div className="leading-tight">
          <div className="font-semibold text-sm">我的工作室</div>
          <div className="text-[11px] text-muted-foreground">AI 公司 · 招募 AI 员工承接需求</div>
        </div>
        <div className="flex-1" />
        <div className="flex bg-muted/40 rounded-lg p-0.5">
          {([['market', '🛒 人才市场'], ['team', `👥 员工 ${employees.length}`], ['dash', '📊 经营台']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn('px-3.5 py-1.5 rounded-md text-xs', tab === k ? 'bg-primary/15 text-primary font-semibold' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground ml-2">在岗 <b className="text-foreground">{employees.length - busy}</b>/{employees.length}</div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'market' && <Market hiredSoulIds={hiredSoulIds} onHire={refreshEmployees} />}
        {tab === 'team' && <Roster employees={employees} providers={providers} onChange={refreshEmployees} goMarket={() => setTab('market')} />}
        {tab === 'dash' && <Dashboard employees={employees} />}
      </div>
    </div>
  )
}

// ── 人才市场 ─────────────────────────────────────────────────────────────────
function Market({ hiredSoulIds, onHire }: { hiredSoulIds: Set<string>; onHire: () => void }) {
  const [data, setData] = useState<TalentBrowseResult>({ entries: [], total: 0, deptCounts: {} })
  const [deptFilter, setDeptFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hiring, setHiring] = useState<string | null>(null)
  const [preview, setPreview] = useState<TalentEntry | null>(null)

  useEffect(() => { const t = setTimeout(() => { setApplied(keyword.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [keyword])
  useEffect(() => {
    setLoading(true)
    window.api.browseTalent({ dept: deptFilter, keyword: applied, page, pageSize: PAGE_SIZE })
      .then((r: TalentBrowseResult) => setData(r)).catch(() => {}).finally(() => setLoading(false))
  }, [deptFilter, applied, page])

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const chips = ['all', ...Object.keys(DEPT)]

  async function hire(e: TalentEntry) {
    setHiring(e.id)
    try { await window.api.hireEmployee(e.id); toast.success(`🎉 ${e.name} 已入职`); onHire() }
    catch (err) { toast.error('录用失败：' + (err as Error).message) }
    finally { setHiring(null) }
  }
  async function interview(e: TalentEntry) {
    try { const full = await window.api.getTalentSoul(e.id) as TalentEntry | null; setPreview(full || e) } catch { setPreview(e) }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {chips.map(d => (
            <button key={d} onClick={() => { setDeptFilter(d); setPage(1) }}
              className={cn('text-[11px] px-2.5 py-1 rounded-full border', deptFilter === d ? 'bg-primary/15 text-primary border-transparent' : 'border-border text-muted-foreground hover:text-foreground')}>
              {d === 'all' ? `全部 ${data.total && deptFilter === 'all' ? '' : ''}` : `${dept(d).label} ${data.deptCounts[d] ?? 0}`}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索人才…"
            className="h-7 pl-6 pr-7 w-52 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40" />
          {keyword && <button onClick={() => setKeyword('')} className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"><X size={11} /></button>}
        </div>
      </div>

      {loading ? <div className="text-center text-muted-foreground text-sm py-10"><Loader2 size={16} className="animate-spin inline" /> 加载人才中…</div>
        : data.entries.length === 0 ? <div className="text-center text-muted-foreground text-sm py-10">没有匹配的人才</div>
        : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.entries.map(e => {
            const d = dept(e.dept)
            const hired = hiredSoulIds.has(e.id)
            return (
              <div key={e.id} className="rounded-xl border border-border bg-card p-3.5 hover:border-border/60 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl grid place-items-center text-xl border border-border" style={{ background: d.color + '22' }}>{d.emoji}</div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{e.name}</div>
                    <div className="text-[11px]" style={{ color: d.color }}>● {d.label}</div>
                  </div>
                </div>
                <div className="text-[11.5px] text-muted-foreground mt-2.5 line-clamp-3 min-h-[48px]">{e.description || '（无简介）'}</div>
                <div className="flex gap-1.5 flex-wrap mt-2.5 mb-3">
                  {e.recModel && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">🧠 {e.recModel}</span>}
                  {e.tools.slice(0, 4).map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">{t}</span>)}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => interview(e)} className="text-[11px] px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground">面试</button>
                  {hired
                    ? <span className="flex-1 text-[11px] px-2.5 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-500 text-center font-medium"><BadgeCheck size={11} className="inline -mt-0.5" /> 已入职</span>
                    : <button disabled={hiring === e.id} onClick={() => hire(e)} className="flex-1 text-[11px] px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 font-medium">
                        {hiring === e.id ? <Loader2 size={11} className="animate-spin inline" /> : <UserPlus size={11} className="inline -mt-0.5" />} 录用
                      </button>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 text-xs">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40">上一页</button>
          <span className="text-muted-foreground">{page} / {totalPages} · 共 {data.total} 人</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40">下一页</button>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 bg-black/55 grid place-items-center z-50" onClick={() => setPreview(null)}>
          <div className="w-[520px] max-w-[92vw] max-h-[80vh] overflow-auto bg-card border border-border rounded-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 p-4 border-b border-border">
              <div className="w-10 h-10 rounded-xl grid place-items-center text-xl border border-border" style={{ background: dept(preview.dept).color + '22' }}>{dept(preview.dept).emoji}</div>
              <div><div className="font-semibold">{preview.name}</div><div className="text-[11px]" style={{ color: dept(preview.dept).color }}>● {dept(preview.dept).label} · 推荐 🧠 {preview.recModel || '默认'}</div></div>
            </div>
            <div className="p-4">
              <div className="text-[11px] text-muted-foreground mb-1.5">岗位提示词（soul 人格）</div>
              <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground bg-muted/40 border border-border rounded-lg p-3 max-h-[300px] overflow-auto">{preview.systemPrompt}</pre>
              <div className="flex gap-2 mt-3">
                {hiredSoulIds.has(preview.id)
                  ? <span className="flex-1 text-sm px-3 py-2 rounded-lg bg-emerald-500/15 text-emerald-500 text-center font-medium">✓ 已入职</span>
                  : <button onClick={() => { hire(preview); setPreview(null) }} className="flex-1 text-sm px-3 py-2 rounded-lg bg-primary text-primary-foreground font-medium">＋ 录用 TA</button>}
                <button onClick={() => setPreview(null)} className="text-sm px-3 py-2 rounded-lg border border-border text-muted-foreground">关闭</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 员工花名册 ───────────────────────────────────────────────────────────────
function Roster({ employees, providers, onChange, goMarket }: { employees: EmployeeInfo[]; providers: ProviderConfig[]; onChange: () => void; goMarket: () => void }) {
  const dlg = useConfirmDialog()
  const allModels = useMemo(() => providers.flatMap(p => p.models.map(m => ({ providerId: p.id, modelId: m, label: `${m} · ${p.name}` }))), [providers])

  if (!employees.length) {
    return (
      <div className="grid place-items-center text-center text-muted-foreground" style={{ height: '58vh' }}>
        <div>
          <div className="text-5xl mb-3 opacity-80">🪑</div>
          <h2 className="text-foreground font-semibold mb-1.5">公司还没有员工</h2>
          <p className="text-[12.5px] mb-4">去人才市场招募你的第一位 AI 员工 —— 录用后可设其底层模型，并在 Vibe 给需求派活。</p>
          <button onClick={goMarket} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm">🛒 去人才市场招募</button>
        </div>
      </div>
    )
  }

  const byDept: Record<string, EmployeeInfo[]> = {}
  for (const e of employees) (byDept[e.dept] = byDept[e.dept] || []).push(e)

  async function fire(e: EmployeeInfo) {
    if (!(await dlg.confirm({ message: `确定解雇「${e.name}」？`, tone: 'danger', confirmLabel: '解雇' }))) return
    await window.api.fireEmployee(e.id); onChange()
  }
  async function changeModel(e: EmployeeInfo, value: string) {
    const [providerId, modelId] = value.split('::')
    await window.api.setEmployeeModel({ id: e.id, providerId, modelId }); toast.success(`🧠 ${e.name} 改用 ${modelId}`); onChange()
  }

  return (
    <div className="space-y-5">
      {dlg.element}
      {Object.entries(byDept).map(([d, emps]) => (
        <div key={d}>
          <div className="flex items-center gap-2 font-semibold text-[12.5px] mb-2.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: dept(d).color }} />{dept(d).label}
            <span className="text-[11px] text-muted-foreground font-normal">· {emps.length} 人</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {emps.map(e => {
              const lv = levelOf(e.stats.done), nx = nextLevel(e.stats.done)
              const prog = nx ? Math.round((e.stats.done - lv.min) / (nx.min - lv.min) * 100) : 100
              const busy = e.status === 'busy'
              return (
                <div key={e.id} className={cn('rounded-xl border bg-card p-3.5', busy ? 'border-blue-500/50' : 'border-border')}>
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-xl grid place-items-center text-xl border border-border" style={{ background: dept(e.dept).color + '22' }}>{dept(e.dept).emoji}</div>
                    <div className="min-w-0"><div className="font-medium text-sm truncate">{e.name}</div><div className="text-[11px]" style={{ color: dept(e.dept).color }}>● {dept(e.dept).label}</div></div>
                    <span className={cn('ml-auto text-[10.5px] px-2 py-0.5 rounded-full', busy ? 'bg-blue-500/15 text-blue-400' : 'bg-muted/60 text-muted-foreground')}>{busy ? '忙碌中' : '空闲'}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2.5">
                    <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500">{lv.icon} {lv.name}</span>
                    <span className="text-[10px] text-muted-foreground">{nx ? `距${nx.name}还差 ${nx.min - e.stats.done} 单` : '已满级'}</span>
                  </div>
                  <div className="h-1 bg-muted rounded mt-1.5 mb-2.5 overflow-hidden"><div className="h-full bg-amber-400" style={{ width: prog + '%' }} /></div>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-2.5">
                    <Cpu size={12} /> 底层模型
                    <select value={`${e.providerId}::${e.modelId}`} onChange={ev => changeModel(e, ev.target.value)}
                      className="flex-1 bg-muted/40 border border-border rounded-md px-2 py-1 text-[11.5px] text-foreground focus:outline-none">
                      {!allModels.some(m => m.providerId === e.providerId && m.modelId === e.modelId) && e.modelId &&
                        <option value={`${e.providerId}::${e.modelId}`}>{e.modelId}（当前）</option>}
                      {allModels.map(m => <option key={m.providerId + m.modelId} value={`${m.providerId}::${m.modelId}`}>{m.label}</option>)}
                      {allModels.length === 0 && <option value="::">（未配置供应商）</option>}
                    </select>
                  </div>
                  <div className="flex gap-3.5 text-[11px] text-muted-foreground mb-2.5">
                    <div><b className="text-foreground text-[13px] block">{e.stats.assigned}</b>承接</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.done}</b>完成</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.out}</b>产出</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.rate}%</b>成功率</div>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={() => fire(e)} className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-rose-400 hover:bg-rose-500/10"><Trash2 size={11} className="inline -mt-0.5" /> 解雇</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 经营台 ───────────────────────────────────────────────────────────────────
function Dashboard({ employees }: { employees: EmployeeInfo[] }) {
  const busy = employees.filter(e => e.status === 'busy').length
  const out = employees.reduce((s, e) => s + e.stats.out, 0)
  const done = employees.reduce((s, e) => s + e.stats.done, 0)
  const kpis: [string, number, string][] = [['👥', employees.length, '员工'], ['🟢', employees.length - busy, '在岗空闲'], ['⚙️', busy, '忙碌中'], ['✅', done, '完成需求'], ['📦', out, '累计产出']]
  const byDept: Record<string, EmployeeInfo[]> = {}
  for (const e of employees) (byDept[e.dept] = byDept[e.dept] || []).push(e)
  const maxN = Math.max(1, ...Object.values(byDept).map(a => a.length))
  const stars = [...employees].sort((a, b) => b.stats.out - a.stats.out).slice(0, 5)
  const medals = ['🥇', '🥈', '🥉', '4', '5']

  if (!employees.length) return <div className="grid place-items-center text-muted-foreground text-sm" style={{ height: '50vh' }}><div className="text-center"><Sparkles className="mx-auto mb-2 opacity-60" /> 招募员工并完成需求后，这里会显示团队经营数据</div></div>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-3">
        {kpis.map(k => <div key={k[2]} className="rounded-xl border border-border bg-card p-3.5"><div className="text-2xl font-bold">{k[0]} {k[1]}</div><div className="text-[11px] text-muted-foreground mt-0.5">{k[2]}</div></div>)}
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <div className="rounded-xl border border-border bg-card p-3.5">
          <h4 className="text-[12.5px] font-semibold mb-3">各部门负载</h4>
          {Object.keys(DEPT).filter(d => byDept[d]).map(d => {
            const a = byDept[d], b = a.filter(e => e.status === 'busy').length
            return <div key={d} className="flex items-center gap-2.5 mb-2 text-xs"><span className="w-20 text-muted-foreground">{dept(d).label}</span>
              <span className="flex-1 h-2 bg-muted rounded overflow-hidden"><span className="block h-full" style={{ width: a.length / maxN * 100 + '%', background: dept(d).color }} /></span>
              <span className="w-16 text-right text-muted-foreground text-[11px]">{a.length}人·忙{b}</span></div>
          })}
        </div>
        <div className="rounded-xl border border-border bg-card p-3.5">
          <h4 className="text-[12.5px] font-semibold mb-3">⭐ 明星员工榜</h4>
          {stars.map((e, i) => <div key={e.id} className="flex items-center gap-2.5 py-2 border-b border-border last:border-0">
            <span className="w-6 text-center">{medals[i]}</span><span className="flex-1 text-[12.5px] font-medium">{dept(e.dept).emoji} {e.name}</span>
            <span className="text-[11px] text-muted-foreground">{levelOf(e.stats.done).icon} {e.stats.out} 产出 · {e.stats.done} 完成</span></div>)}
        </div>
      </div>
    </div>
  )
}
