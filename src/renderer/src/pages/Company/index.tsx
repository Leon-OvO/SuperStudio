import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, UserPlus, Trash2, Cpu, Loader2, BadgeCheck, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Select } from '../../components/ui/Select'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useUIStore } from '../../stores/ui'
import type { TalentEntry, TalentBrowseResult, EmployeeInfo, ProviderConfig, VibeRequestInfo, VibeTaskInfo } from '../../../../shared/ipc-types'
import { levelOf, nextLevel } from '../../../../shared/company-levels'

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

const PAGE_SIZE = 24

// NOTE: The standalone CompanyPage was merged into the unified Workbench
// (Vibe/Workbench.tsx). The sub-views below (Market / Roster / Board / Dashboard)
// are exported and consumed there.

// ── 人才市场 ─────────────────────────────────────────────────────────────────
export function Market({ hiredSoulIds, onHire }: { hiredSoulIds: Set<string>; onHire: () => void }) {
  const [data, setData] = useState<TalentBrowseResult>({ entries: [], total: 0, deptCounts: {} })
  const [deptFilter, setDeptFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hiring, setHiring] = useState<string | null>(null)
  const [preview, setPreview] = useState<TalentEntry | null>(null)
  // 面试试聊（不落库）
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [chatInput, setChatInput] = useState('')
  const [trying, setTrying] = useState(false)

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
    setChat([]); setChatInput('')
    try { const full = await window.api.getTalentSoul(e.id) as TalentEntry | null; setPreview(full || e) } catch { setPreview(e) }
  }
  async function sendTry() {
    if (!preview || !chatInput.trim() || trying) return
    const next = [...chat, { role: 'user' as const, content: chatInput.trim() }]
    setChat(next); setChatInput(''); setTrying(true)
    try {
      const res = await window.api.tryTalent(preview.id, next) as { text?: string; error?: string }
      setChat([...next, { role: 'assistant', content: res.error ? `⚠️ ${res.error}` : (res.text || '（无回复）') }])
    } catch (err) {
      setChat([...next, { role: 'assistant', content: '⚠️ ' + (err as Error).message }])
    } finally { setTrying(false) }
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
              <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground bg-muted/40 border border-border rounded-lg p-3 max-h-[140px] overflow-auto">{preview.systemPrompt}</pre>

              {/* 试聊：录用前临时功能测试（用该人格 + 推荐模型，不落库） */}
              <div className="mt-3">
                <div className="text-[11px] text-muted-foreground mb-1.5">💬 面试试聊 <span className="text-muted-foreground/60">· 录用前临时测试 TA 的回答（不保存）</span></div>
                <div className="bg-muted/30 border border-border rounded-lg p-2.5 max-h-[200px] overflow-auto space-y-2 mb-2">
                  {chat.length === 0 && <div className="text-[11px] text-muted-foreground/60 text-center py-3">给 TA 出个题，试试这个角色的回答 →</div>}
                  {chat.map((m, i) => (
                    <div key={i} className={cn('text-[12px] leading-relaxed', m.role === 'user' ? 'text-right' : '')}>
                      <span className={cn('inline-block px-2.5 py-1.5 rounded-lg max-w-[85%] text-left whitespace-pre-wrap',
                        m.role === 'user' ? 'bg-primary/15 text-foreground' : 'bg-card border border-border text-muted-foreground')}>
                        {m.content}
                      </span>
                    </div>
                  ))}
                  {trying && <div className="text-[12px]"><span className="inline-block px-2.5 py-1.5 rounded-lg bg-card border border-border text-muted-foreground"><Loader2 size={11} className="inline animate-spin" /> 思考中…</span></div>}
                </div>
                <div className="flex gap-2">
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTry() } }}
                    placeholder="输入一句话面试 TA…" disabled={trying}
                    className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-60" />
                  <button onClick={sendTry} disabled={trying || !chatInput.trim()}
                    className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium disabled:opacity-50">发送</button>
                </div>
              </div>

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
export function Roster({ employees, providers, onChange, goMarket }: { employees: EmployeeInfo[]; providers: ProviderConfig[]; onChange: () => void; goMarket: () => void }) {
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
                    <Select
                      value={`${e.providerId}::${e.modelId}`}
                      onChange={v => changeModel(e, v)}
                      className="flex-1"
                      popoverWidth={240}
                      options={[
                        ...(!allModels.some(m => m.providerId === e.providerId && m.modelId === e.modelId) && e.modelId
                          ? [{ value: `${e.providerId}::${e.modelId}`, label: `${e.modelId}（当前）` }] : []),
                        ...allModels.map(m => ({ value: `${m.providerId}::${m.modelId}`, label: m.label })),
                        ...(allModels.length === 0 ? [{ value: '::', label: '（未配置供应商）', disabled: true }] : [])
                      ]}
                    />
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
export function Dashboard({ employees }: { employees: EmployeeInfo[] }) {
  const busy = employees.filter(e => e.status === 'busy').length
  const out = employees.reduce((s, e) => s + e.stats.out, 0)
  const done = employees.reduce((s, e) => s + e.stats.done, 0)
  const cost = employees.reduce((s, e) => s + (e.stats.cost ?? 0), 0)
  const kpis: [string, string, string][] = [
    ['👥', String(employees.length), '员工'],
    ['🟢', String(employees.length - busy), '在岗空闲'],
    ['✅', String(done), '完成需求'],
    ['📦', String(out), '累计产出'],
    ['💰', '$' + cost.toFixed(2), '累计成本']
  ]
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

// ── 需求看板（派活 / 开工 的可见入口）──────────────────────────────────────────
const BOARD_COLS: { key: string; name: string; color: string }[] = [
  { key: 'proposed', name: '待应用', color: '#f0b429' },
  { key: 'applying', name: '实现中', color: '#5b9bff' },
  { key: 'done', name: '已完成', color: '#3ecf8e' }
]
function projName(p: string): string { return (p || '').split(/[\/]/).filter(Boolean).pop() || p }

// 子任务进度条（分段：done 绿 / running 蓝 / error 红 / pending 灰）
function TaskProgressBar({ roll }: { roll?: { total: number; done: number; running: number; error: number } }) {
  if (!roll || !roll.total) return <div className="text-[10px] text-muted-foreground/60 mt-1.5">尚未拆解子任务</div>
  const w = (n: number) => (n / roll.total * 100).toFixed(1) + '%'
  const pendingW = ((roll.total - roll.done - roll.running - roll.error) / roll.total * 100).toFixed(1) + '%'
  const pct = Math.round(roll.done / roll.total * 100)
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-muted">
        <span className="bg-emerald-500" style={{ width: w(roll.done) }} />
        <span className="bg-blue-500" style={{ width: w(roll.running) }} />
        <span className="bg-rose-500" style={{ width: w(roll.error) }} />
        <span style={{ width: pendingW }} />
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
        <span className="text-foreground font-semibold">{pct}%</span>
        <span>{roll.done}/{roll.total} 子任务</span>
        {roll.error > 0 && <span className="text-rose-400">⚠ {roll.error} 失败</span>}
      </div>
    </div>
  )
}
const TASK_ICON: Record<string, string> = { done: '✓', running: '◌', error: '✕', skipped: '⊘', pending: '○' }
const TASK_COLOR: Record<string, string> = { done: 'text-emerald-500', running: 'text-blue-400', error: 'text-rose-400', skipped: 'text-muted-foreground/50', pending: 'text-muted-foreground/60' }

export function Board({ employees, onChange, goMarket, goWorkbench }: { employees: EmployeeInfo[]; onChange: () => void; goMarket: () => void; goWorkbench?: () => void }) {
  const [requests, setRequests] = useState<VibeRequestInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState<string | null>(null)
  // 展开看子任务：requestId → 子任务列表
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tasksByReq, setTasksByReq] = useState<Record<string, VibeTaskInfo[]>>({})
  const debTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.api.vibeRequestListAll()
      .then((r: VibeRequestInfo[]) => setRequests(r.filter(x => x.kind === 'change' || x.kind === 'bugfix')))
      .catch(() => {}).finally(() => setLoading(false))
  }, [])

  const loadTasks = useCallback((reqId: string) => {
    window.api.vibeTaskList(reqId).then((t: VibeTaskInfo[]) => setTasksByReq(prev => ({ ...prev, [reqId]: t }))).catch(() => {})
  }, [])

  function toggleExpand(reqId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(reqId)) next.delete(reqId)
      else { next.add(reqId); loadTasks(reqId) }
      return next
    })
  }

  useEffect(() => {
    refresh()
    // 实时：执行进度/完成时刷新看板与员工统计（progress 高频，防抖 400ms）
    const debounced = () => {
      if (debTimer.current) clearTimeout(debTimer.current)
      debTimer.current = setTimeout(() => {
        refresh()
        // 展开中的卡片同步重拉子任务，进度条/子任务状态实时推进
        setExpanded(cur => { cur.forEach(id => loadTasks(id)); return cur })
      }, 400)
    }
    const u1 = window.api.onVibeDone(() => { debounced(); onChange() })
    const u2 = window.api.onVibeProgress(() => { debounced() })
    return () => { u1?.(); u2?.(); if (debTimer.current) clearTimeout(debTimer.current) }
  }, [refresh, onChange, loadTasks])

  async function assign(req: VibeRequestInfo, employeeId: string | null) {
    await window.api.vibeRequestSetAssignee(req.id, employeeId)
    refresh(); onChange()
  }
  async function apply(req: VibeRequestInfo) {
    if (!req.assigneeEmployeeId) { toast.error('请先给该需求指派一位员工'); return }
    setApplying(req.id)
    try {
      const res = await window.api.vibeApply({ requestId: req.id }) as { started?: boolean; error?: string }
      if (res?.error) toast.error('开工失败：' + res.error + '（该项目可能需先在 Vibe 中打开）')
      else toast.success('已派活，员工开工中…')
      refresh()
    } catch (e) { toast.error('开工失败：' + (e as Error).message) }
    finally { setApplying(null) }
  }

  if (loading) return <div className="text-center text-muted-foreground text-sm py-10"><Loader2 size={16} className="animate-spin inline" /> 加载需求…</div>

  if (!requests.length) {
    return (
      <div className="grid place-items-center text-center text-muted-foreground" style={{ height: '56vh' }}>
        <div>
          <div className="text-5xl mb-3 opacity-80">🗂</div>
          <h2 className="text-foreground font-semibold mb-1.5">还没有需求可派活</h2>
          <p className="text-[12.5px] mb-1">需求来自 Vibe「构建」页：打开一个项目 → 用「新需求」描述任务，PM 会拆解成可执行任务。</p>
          <p className="text-[12.5px] mb-4">需求出现在这里后，给它<strong>指派一位员工</strong>并点<strong>开工</strong>，员工就会用自己的模型与岗位人格去执行。</p>
          <div className="flex gap-2 justify-center">
            <button onClick={goMarket} className="px-4 py-2 rounded-lg border border-border text-sm">先去招募员工</button>
            <button onClick={() => goWorkbench ? goWorkbench() : useUIStore.getState().setPage('vibe')} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm">去工作台提需求 →</button>
          </div>
        </div>
      </div>
    )
  }

  const empById = (id?: string | null) => employees.find(e => e.id === id)
  return (
    <div>
      <div className="flex items-center mb-3">
        <div className="text-xs text-muted-foreground">把需求指派给员工并「开工」，员工以其底层模型 + 岗位人格执行。</div>
        <div className="flex-1" />
        <button onClick={refresh} className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground">刷新</button>
      </div>
      <div className="flex gap-3 items-start overflow-x-auto">
        {BOARD_COLS.map(col => {
          const items = requests.filter(r => r.status === col.key)
          return (
            <div key={col.key} className="flex-shrink-0 w-[300px] rounded-xl border border-border bg-card/40">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="w-2 h-2 rounded-sm" style={{ background: col.color }} />
                <span className="font-semibold text-[12.5px]">{col.name}</span>
                <span className="ml-auto text-[11px] text-muted-foreground bg-muted/60 border border-border rounded-full px-2">{items.length}</span>
              </div>
              <div className="px-2.5 pb-3 space-y-2.5">
                {items.length === 0 && <div className="text-[11px] text-muted-foreground/50 text-center py-4 border border-dashed border-border rounded-lg">空</div>}
                {items.map(r => {
                  const emp = empById(r.assigneeEmployeeId)
                  const isOpen = expanded.has(r.id)
                  const subs = tasksByReq[r.id]
                  return (
                    <div key={r.id} className="rounded-lg border border-border bg-card p-2.5">
                      <div className="flex items-start gap-1.5">
                        <button onClick={() => toggleExpand(r.id)} className="text-muted-foreground/60 hover:text-foreground mt-0.5 text-[11px] w-3 shrink-0" title="展开子任务">{isOpen ? '▾' : '▸'}</button>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium leading-snug">{r.title}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">📁 {projName(r.projectPath)} · {r.kind === 'bugfix' ? '缺陷' : '需求'}</div>
                        </div>
                      </div>

                      <TaskProgressBar roll={r.taskRollup} />

                      {isOpen && (
                        <div className="mt-2 pl-3 border-l border-border space-y-1">
                          {!subs ? <div className="text-[10px] text-muted-foreground/50">加载子任务…</div>
                            : subs.length === 0 ? <div className="text-[10px] text-muted-foreground/50">无子任务</div>
                            : subs.map(t => {
                              const te = employees.find(e => e.id === t.assigneeEmployeeId)
                              return (
                              <div key={t.id} className="flex items-start gap-1.5 text-[11px]">
                                <span className={cn('shrink-0 w-3 text-center', TASK_COLOR[t.status] || '')}>{TASK_ICON[t.status] || '○'}</span>
                                <span className={cn('leading-snug flex-1 min-w-0', t.status === 'done' || t.status === 'skipped' ? 'text-muted-foreground/60 line-through' : 'text-foreground/90')}>{t.title}</span>
                                {te && <span className="shrink-0 text-[9.5px]" style={{ color: dept(te.dept).color }} title={`${te.name} · ${dept(te.dept).label}`}>{dept(te.dept).emoji} {te.name}</span>}
                              </div>
                              )
                            })}
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 mt-2" title="默认承接人：未单独指派的子任务用 TA">
                        <span className="text-[11px]">👤</span>
                        <Select
                          value={r.assigneeEmployeeId ?? ''}
                          onChange={v => assign(r, v || null)}
                          className="flex-1"
                          options={[
                            { value: '', label: '默认承接人（未指派）' },
                            ...employees.map(emp2 => ({ value: emp2.id, label: emp2.name })),
                            ...(r.assigneeEmployeeId && !employees.some(e => e.id === r.assigneeEmployeeId) ? [{ value: r.assigneeEmployeeId, label: '（已离职）' }] : [])
                          ]}
                        />
                      </div>
                      {emp && <div className="text-[10px] text-muted-foreground mt-1">🧠 {emp.modelId || '默认模型'}{r.status === 'applying' ? ' · 执行中…' : ''}</div>}
                      {col.key === 'proposed' && (
                        <button onClick={() => apply(r)} disabled={applying === r.id}
                          className="w-full mt-2 text-[11px] py-1.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50">
                          {applying === r.id ? <Loader2 size={11} className="animate-spin inline" /> : '▶'} 开工
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
