import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, X, UserPlus, Trash2, Cpu, Loader2, BadgeCheck, Sparkles,
  Users, UserCheck, CheckCircle2, Coins, Wallet, Gauge, Flame,
  Building2, Workflow, Armchair, Store,
  Code2, Palette, ClipboardList, Megaphone, ShieldCheck, Brain, Gamepad2, Puzzle,
  type LucideIcon
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Select } from '../../components/ui/Select'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useUIStore } from '../../stores/ui'
import { formatTokens, formatCostUsd } from '../../lib/format-cost'
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

// 部门 → lucide 线性图标（办公室工位头像用，风格与全局统一，替代 emoji）
const DEPT_ICON: Record<string, LucideIcon> = {
  engineering: Code2, design: Palette, product: ClipboardList,
  marketing: Megaphone, qa: ShieldCheck, data: Brain, game: Gamepad2
}
const deptIcon = (k: string): LucideIcon => DEPT_ICON[k] || Puzzle

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
                  <div className="flex gap-3.5 text-[11px] text-muted-foreground mb-2">
                    <div><b className="text-foreground text-[13px] block">{e.stats.assigned}</b>承接</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.done}</b>完成</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.out}</b>产出</div>
                    <div><b className="text-foreground text-[13px] block">{e.stats.rate}%</b>成功率</div>
                  </div>
                  <div
                    className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2.5 tabular-nums"
                    title={`输入 ${(e.stats.tokensIn ?? 0).toLocaleString()} · 输出 ${(e.stats.tokensOut ?? 0).toLocaleString()} tokens`}
                  >
                    <span>🪙 {formatTokens((e.stats.tokensIn ?? 0) + (e.stats.tokensOut ?? 0))} tok</span>
                    <span className="text-amber-600 dark:text-amber-400 font-medium">💰 {formatCostUsd(e.stats.cost ?? 0)}</span>
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
  const done = employees.reduce((s, e) => s + e.stats.done, 0)
  const cost = employees.reduce((s, e) => s + (e.stats.cost ?? 0), 0)
  const tokens = employees.reduce((s, e) => s + (e.stats.tokensIn ?? 0) + (e.stats.tokensOut ?? 0), 0)
  const kpis: { Icon: LucideIcon; value: string; label: string; color: string; bg: string }[] = [
    { Icon: Users,        value: String(employees.length),        label: '员工',      color: 'text-indigo-500',  bg: 'bg-indigo-500/12' },
    { Icon: UserCheck,    value: String(employees.length - busy), label: '在岗空闲',  color: 'text-emerald-500', bg: 'bg-emerald-500/12' },
    { Icon: CheckCircle2, value: String(done),                    label: '完成需求',  color: 'text-sky-500',     bg: 'bg-sky-500/12' },
    { Icon: Coins,        value: formatTokens(tokens),            label: '累计 token', color: 'text-amber-500',   bg: 'bg-amber-500/12' },
    { Icon: Wallet,       value: formatCostUsd(cost),             label: '累计成本',  color: 'text-rose-500',    bg: 'bg-rose-500/12' }
  ]
  const byDept: Record<string, EmployeeInfo[]> = {}
  for (const e of employees) (byDept[e.dept] = byDept[e.dept] || []).push(e)
  const maxN = Math.max(1, ...Object.values(byDept).map(a => a.length))
  // 成本榜：按累计花费降序（其次产出），让用户一眼看清「谁烧钱最多」。
  const spenders = [...employees]
    .sort((a, b) => (b.stats.cost ?? 0) - (a.stats.cost ?? 0) || b.stats.out - a.stats.out)
    .slice(0, 6)
  // 名次徽章配色：前三金/银/铜，其余中性。
  const rankTint = ['bg-amber-400/20 text-amber-600 dark:text-amber-400', 'bg-slate-300/30 text-slate-500 dark:text-slate-300', 'bg-orange-500/15 text-orange-600 dark:text-orange-400']

  if (!employees.length) return <div className="grid place-items-center text-muted-foreground text-sm" style={{ height: '50vh' }}><div className="text-center"><Sparkles className="mx-auto mb-2 opacity-60" /> 招募员工并完成需求后，这里会显示团队经营数据</div></div>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-3">
        {kpis.map(k => (
          <div key={k.label} className="rounded-xl border border-border bg-card p-3.5">
            <div className="flex items-center gap-2.5">
              <span className={cn('w-9 h-9 rounded-lg grid place-items-center shrink-0', k.bg)}><k.Icon size={17} className={k.color} /></span>
              <div className="min-w-0">
                <div className="text-xl font-bold leading-none tabular-nums truncate">{k.value}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{k.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <div className="rounded-xl border border-border bg-card p-3.5">
          <h4 className="flex items-center gap-1.5 text-[12.5px] font-semibold mb-3"><Gauge size={14} className="text-muted-foreground" /> 各部门负载</h4>
          {Object.keys(DEPT).filter(d => byDept[d]).map(d => {
            const a = byDept[d], b = a.filter(e => e.status === 'busy').length
            return <div key={d} className="flex items-center gap-2.5 mb-2 text-xs">
              <span className="w-20 flex items-center gap-1.5 text-muted-foreground"><span className="w-2 h-2 rounded-sm shrink-0" style={{ background: dept(d).color }} />{dept(d).label}</span>
              <span className="flex-1 h-2 bg-muted rounded overflow-hidden"><span className="block h-full" style={{ width: a.length / maxN * 100 + '%', background: dept(d).color }} /></span>
              <span className="w-16 text-right text-muted-foreground text-[11px]">{a.length}人·忙{b}</span></div>
          })}
        </div>
        <div className="rounded-xl border border-border bg-card p-3.5">
          <h4 className="flex items-center gap-1.5 text-[12.5px] font-semibold mb-3"><Flame size={14} className="text-rose-500" /> 成本 / 消耗榜</h4>
          {spenders.map((e, i) => {
            const tok = (e.stats.tokensIn ?? 0) + (e.stats.tokensOut ?? 0)
            return (
              <div key={e.id} className="flex items-center gap-2.5 py-2 border-b border-border last:border-0">
                <span className={cn('w-5 h-5 shrink-0 rounded-full grid place-items-center text-[10px] font-bold tabular-nums', rankTint[i] ?? 'bg-muted text-muted-foreground')}>{i + 1}</span>
                <span className="flex items-center gap-1.5 flex-1 min-w-0 text-[12.5px] font-medium">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: dept(e.dept).color }} title={dept(e.dept).label} />
                  <span className="truncate">{e.name}</span>
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0" title={`输入 ${(e.stats.tokensIn ?? 0).toLocaleString()} · 输出 ${(e.stats.tokensOut ?? 0).toLocaleString()} tokens · ${e.stats.done} 完成`}>
                  {formatTokens(tok)} tok · <span className="text-amber-600 dark:text-amber-400 font-medium">{formatCostUsd(e.stats.cost ?? 0)}</span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── 需求看板（派活 / 开工 的可见入口）──────────────────────────────────────────
// 上下分栏：顶部聚焦「正在运行」的需求（子任务横向流程图体现进度），
// 下方折叠区放「待应用 / 已完成」，点开任一也用同样的流程图看迭代。
const STATUS_META: Record<string, { name: string; color: string }> = {
  proposed: { name: '待应用', color: '#f0b429' },
  applying: { name: '实现中', color: '#5b9bff' },
  done:     { name: '已完成', color: '#3ecf8e' }
}
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

/** Derive a rollup from the live sub-task list (preferred over the backend
 *  snapshot since it updates the instant tasksByReq is re-fetched). */
function rollupFromTasks(tasks: VibeTaskInfo[]): { total: number; done: number; running: number; error: number } {
  const r = { total: tasks.length, done: 0, running: 0, error: 0 }
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'skipped') r.done++
    else if (t.status === 'running') r.running++
    else if (t.status === 'error') r.error++
  }
  return r
}

// 流程图单节点：一个子任务 = 一个节点（状态色 + 序号 + 标题 + 承接员工）
function FlowNode({ task, emp }: { task: VibeTaskInfo; emp?: EmployeeInfo }) {
  const st = task.status
  const done = st === 'done' || st === 'skipped'
  return (
    <div className="flex flex-col items-center gap-1 w-[92px] shrink-0">
      <div className={cn(
        'w-full px-2 py-1.5 rounded-lg border text-center',
        done ? 'bg-emerald-500/10 border-emerald-500/40' :
        st === 'running' ? 'bg-blue-500/10 border-blue-500/50 animate-pulse' :
        st === 'error' ? 'bg-rose-500/10 border-rose-500/50' :
        'bg-muted/40 border-border'
      )}>
        <div className="flex items-center justify-center gap-1">
          <span className={cn('text-[11px]', TASK_COLOR[st] || '')}>{TASK_ICON[st] || '○'}</span>
          <span className="text-[9.5px] text-muted-foreground/70">#{task.ord}</span>
        </div>
        <div className={cn('text-[10.5px] leading-tight mt-0.5 line-clamp-2', done ? 'text-muted-foreground/70' : 'text-foreground/90')} title={task.title}>{task.title}</div>
      </div>
      {emp
        ? <span className="text-[9.5px] truncate max-w-[92px]" style={{ color: dept(emp.dept).color }} title={`${emp.name} · ${dept(emp.dept).label}`}>{dept(emp.dept).emoji} {emp.name}</span>
        : <span className="text-[9.5px] text-muted-foreground/50">待指派</span>}
    </div>
  )
}

// 横向流程图：子任务按 ord 顺序用 → 连接，溢出自动换行
function RequestFlow({ tasks, employees }: { tasks?: VibeTaskInfo[]; employees: EmployeeInfo[] }) {
  if (!tasks) return <div className="text-[11px] text-muted-foreground/50 py-2">加载子任务…</div>
  if (!tasks.length) return <div className="text-[11px] text-muted-foreground/50 py-2">尚未拆解子任务</div>
  return (
    <div className="flex flex-wrap items-start gap-y-3">
      {tasks.map((t, i) => (
        <div key={t.id} className="flex items-start">
          <FlowNode task={t} emp={employees.find(e => e.id === t.assigneeEmployeeId)} />
          {i < tasks.length - 1 && <span className="mx-1 text-muted-foreground/40 text-sm mt-2.5">→</span>}
        </div>
      ))}
    </div>
  )
}

// 摸鱼活动池：空闲员工不上班，按 id 稳定地随机做点不务正业的小动作，增加趣味。
const SLACK = [
  { emoji: '🎮', label: '打游戏' },
  { emoji: '☕', label: '喝咖啡' },
  { emoji: '📱', label: '刷手机' },
  { emoji: '😴', label: '打盹' },
  { emoji: '🐟', label: '摸鱼' },
  { emoji: '🍜', label: '干饭' },
  { emoji: '🎧', label: '听歌' }
] as const
function slackOf(id: string): { emoji: string; label: string } {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return SLACK[h % SLACK.length]
}

// 单个像素工位：显示器 + 坐着的小人（头+肩）+ 桌面 + 铭牌。忙碌时亮屏辉光 + 头顶任务
// 气泡 + 脑袋专注地上下点动；空闲时屏幕变成在打游戏/刷手机，脑袋慵懒地左右晃（摸鱼）。
type DeskTask = { taskTitle: string; reqTitle: string; pct: number; count: number }
function Desk({ employee: e, task }: { employee: EmployeeInfo; task?: DeskTask }) {
  const d = dept(e.dept)
  const DeptIcon = deptIcon(e.dept)
  const lv = levelOf(e.stats.done)
  const busy = e.status === 'busy' || !!task
  const slack = slackOf(e.id)
  const tok = (e.stats.tokensIn ?? 0) + (e.stats.tokensOut ?? 0)
  const screenStyle = (busy
    ? { borderColor: d.color, background: d.color + '22', '--glow': d.color }
    : { borderColor: 'hsl(var(--border))', background: 'hsl(var(--muted))' }) as React.CSSProperties
  return (
    <div
      className="relative flex flex-col items-center w-[120px] pt-8"
      title={`${e.name} · ${d.label}\n🧠 ${e.modelId || '默认模型'}\n完成 ${e.stats.done} · 产出 ${e.stats.out} · 🪙 ${formatTokens(tok)} · 💰 ${formatCostUsd(e.stats.cost ?? 0)}`}
    >
      {/* 头顶任务气泡（仅忙碌） */}
      {busy && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 w-[128px]">
          <div className="rounded-md border bg-card px-1.5 py-1 shadow-[2px_2px_0_rgba(0,0,0,0.12)]" style={{ borderColor: d.color }}>
            <div className="flex items-center gap-1 text-[9.5px] leading-tight">
              <span className="office-type shrink-0" style={{ color: d.color }}>▍</span>
              <span className="truncate text-foreground/90">{task ? task.taskTitle : '工作中…'}</span>
            </div>
            {task && task.count > 1 && <div className="text-[8.5px] text-muted-foreground mt-0.5">+{task.count - 1} 个任务并行</div>}
          </div>
          <div className="mx-auto w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent" style={{ borderTopColor: d.color }} />
        </div>
      )}
      {/* 显示器：忙碌显示进度%，空闲变成在打游戏/刷手机（摸鱼）的小活动 */}
      <div className={cn('w-[58px] h-[40px] rounded-[4px] border-2 grid place-items-center', busy && 'office-glow')} style={screenStyle}>
        {busy
          ? <span className="text-[11px] font-bold tabular-nums" style={{ color: d.color }}>{task ? task.pct + '%' : '···'}</span>
          : <span className="text-[16px] office-wiggle leading-none">{slack.emoji}</span>}
      </div>
      {/* 支架 */}
      <div className="w-2 h-1.5 bg-muted-foreground/30" />
      <div className="w-7 h-1 bg-muted-foreground/30 rounded-sm" />
      {/* 小人：头 + 肩，坐在桌后（桌面盖住肩部下缘）。忙碌点头、空闲慵懒摇头 */}
      <div className={cn('relative z-[1] -mb-3 flex flex-col items-center', busy ? 'office-bob' : 'office-sway')}>
        <div className="w-9 h-9 rounded-full grid place-items-center border-2" style={{ borderColor: d.color, background: d.color + '1f' }}>
          <DeptIcon size={16} style={{ color: d.color }} />
        </div>
        <div className="w-8 h-3.5 -mt-1 rounded-t-[12px] border-2 border-b-0" style={{ background: d.color + '2a', borderColor: d.color + '66' }} />
      </div>
      {/* 桌面 */}
      <div className="w-full h-[16px] rounded-[3px] border shadow-[2px_2px_0_rgba(0,0,0,0.1)]" style={{ background: d.color + '14', borderColor: d.color + '55' }} />
      {/* 铭牌 */}
      <div className="mt-1.5 text-center leading-tight">
        <div className="text-[11px] font-medium truncate max-w-[116px]">{e.name}</div>
        <div className="flex items-center justify-center gap-1 text-[9.5px] mt-0.5">
          <span title={lv.name}>{lv.icon}</span>
          {busy
            ? <span style={{ color: d.color }}>● 忙碌</span>
            : <span className="text-muted-foreground/60">{slack.emoji} {slack.label}</span>}
        </div>
      </div>
    </div>
  )
}

// 像素办公室平面图：一间“房间”里平铺所有员工的工位，实时反映谁在忙、在干什么。
function OfficeFloor({ employees, currentTaskByEmp, onGoMarket }: {
  employees: EmployeeInfo[]
  currentTaskByEmp: Map<string, DeskTask>
  onGoMarket: () => void
}) {
  if (!employees.length) {
    return (
      <div className="grid place-items-center text-center text-muted-foreground rounded-xl border-2 border-dashed border-border" style={{ height: '46vh' }}>
        <div>
          <Armchair size={44} className="mx-auto mb-3 opacity-50" />
          <h2 className="text-foreground font-semibold mb-1.5">办公室空空如也</h2>
          <p className="text-[12.5px] mb-4 max-w-sm">还没有员工入职 —— 去人才市场招募你的第一位 AI 员工，TA 就会出现在这里的工位上。</p>
          <button onClick={onGoMarket} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm"><Store size={14} /> 去人才市场招募</button>
        </div>
      </div>
    )
  }
  const busy = employees.filter(e => e.status === 'busy' || currentTaskByEmp.has(e.id)).length
  return (
    <div className="rounded-xl border-2 border-border overflow-hidden">
      {/* 门牌 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b-2 border-border bg-card/60">
        <Building2 size={14} className="text-primary" />
        <span className="font-semibold text-[12.5px]">办公室</span>
        <span className="text-[10.5px] text-muted-foreground">· 忙碌 <b className="text-foreground">{busy}</b> / 共 {employees.length} 人</span>
        {busy === 0 && <span className="text-[10.5px] text-muted-foreground/60">· 全员空闲，去看板派活让大家动起来</span>}
      </div>
      {/* 工位区（地板纹理） */}
      <div
        className="p-4 flex flex-wrap gap-x-3 gap-y-6 justify-center"
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, hsl(var(--muted) / 0.18) 0 12px, transparent 12px 24px)' }}
      >
        {employees.map(e => <Desk key={e.id} employee={e} task={currentTaskByEmp.get(e.id)} />)}
      </div>
    </div>
  )
}

export function Board({ employees, onChange, goMarket, goWorkbench }: { employees: EmployeeInfo[]; onChange: () => void; goMarket: () => void; goWorkbench?: () => void }) {
  const dlg = useConfirmDialog()
  const [requests, setRequests] = useState<VibeRequestInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // 底部「待应用 / 已完成」分组里，哪些需求行展开了流程图（默认收起，列表才不冗长）。
  const [expandedReqs, setExpandedReqs] = useState<Set<string>>(new Set())
  // 折叠的分组（默认两组都展开）。
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set())
  const [tasksByReq, setTasksByReq] = useState<Record<string, VibeTaskInfo[]>>({})
  // 看板两种视图：办公室（像素工位，默认）/ 流程图（需求执行进度）。
  const [view, setView] = useState<'office' | 'flow'>('office')
  const debTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadTasks = useCallback((reqId: string) => {
    window.api.vibeTaskList(reqId).then((t: VibeTaskInfo[]) => setTasksByReq(prev => ({ ...prev, [reqId]: t }))).catch(() => {})
  }, [])

  const refresh = useCallback(() => {
    window.api.vibeRequestListAll()
      .then((r: VibeRequestInfo[]) => {
        const list = r.filter(x => x.kind === 'change' || x.kind === 'bugfix')
        setRequests(list)
        // 默认加载每个需求的子任务，进度条从子任务实时派生（不只依赖后端 rollup 快照）。
        for (const req of list) loadTasks(req.id)
      })
      .catch(() => {}).finally(() => setLoading(false))
  }, [loadTasks])

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (key: string) =>
    setter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  const toggleReq = toggleIn(setExpandedReqs)
  const toggleGroup = toggleIn(setClosedGroups)

  useEffect(() => {
    refresh()
    // 实时：执行进度/完成时刷新看板与子任务（progress 高频，防抖 250ms）
    const debounced = () => {
      if (debTimer.current) clearTimeout(debTimer.current)
      debTimer.current = setTimeout(() => { refresh(); onChange() }, 250)
    }
    const u1 = window.api.onVibeDone(() => { debounced() })
    const u2 = window.api.onVibeProgress(() => { debounced() })
    return () => { u1?.(); u2?.(); if (debTimer.current) clearTimeout(debTimer.current) }
  }, [refresh, onChange])

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
  async function remove(req: VibeRequestInfo) {
    if (!(await dlg.confirm({ message: `确定删除需求「${req.title}」？子任务与执行记录一并删除，不可恢复。`, tone: 'danger', confirmLabel: '删除' }))) return
    setDeleting(req.id)
    try { await window.api.vibeRequestDelete(req.id); toast.success('已删除'); refresh() }
    catch (e) { toast.error('删除失败：' + (e as Error).message) }
    finally { setDeleting(null) }
  }

  const empById = (id?: string | null) => employees.find(e => e.id === id)
  const subsOf = (id: string) => tasksByReq[id]
  const rollOf = (r: VibeRequestInfo) => { const s = tasksByReq[r.id]; return s ? rollupFromTasks(s) : r.taskRollup }
  // 「运行中」= 状态为 applying，或任一子任务正在跑（更实时）。
  const isRunning = (r: VibeRequestInfo) => r.status === 'applying' || (subsOf(r.id)?.some(t => t.status === 'running') ?? false)
  const running = requests.filter(isRunning)
  const proposed = requests.filter(r => r.status === 'proposed' && !isRunning(r))
  const doneList = requests.filter(r => r.status === 'done' && !isRunning(r))

  // 反推「员工此刻在跑哪个子任务」：遍历所有 running 子任务，按子任务承接人
  // （无则其需求的默认承接人）归属。一员工多任务并行时取首个 + 计数。给办公室视图用。
  const currentTaskByEmp = new Map<string, { taskTitle: string; reqTitle: string; pct: number; count: number }>()
  for (const r of requests) {
    const subs = tasksByReq[r.id]
    if (!subs) continue
    const roll = rollupFromTasks(subs)
    const pct = roll.total ? Math.round(roll.done / roll.total * 100) : 0
    for (const t of subs) {
      if (t.status !== 'running') continue
      const eid = t.assigneeEmployeeId || r.assigneeEmployeeId
      if (!eid) continue
      const ex = currentTaskByEmp.get(eid)
      if (ex) ex.count++
      else currentTaskByEmp.set(eid, { taskTitle: t.title, reqTitle: r.title, pct, count: 1 })
    }
  }

  // 承接人下拉（顶/底通用）
  const assigneeSelect = (r: VibeRequestInfo) => (
    <div className="flex items-center gap-1.5" title="默认承接人：未单独指派的子任务用 TA">
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
  )
  const delBtn = (r: VibeRequestInfo) => (
    <button onClick={() => remove(r)} disabled={deleting === r.id}
      className="shrink-0 text-muted-foreground/40 hover:text-rose-400 disabled:opacity-40" title="删除该需求">
      {deleting === r.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
    </button>
  )

  const BOTTOM: { key: string; items: VibeRequestInfo[] }[] = [
    { key: 'proposed', items: proposed },
    { key: 'done', items: doneList }
  ]

  const VIEWS: { key: 'office' | 'flow'; label: string; Icon: LucideIcon }[] = [
    { key: 'office', label: '办公室', Icon: Building2 },
    { key: 'flow', label: '流程图', Icon: Workflow }
  ]

  return (
    <div>
      {dlg.element}
      {/* 视图切换：办公室（工位）/ 流程图（需求进度），共用同一份数据与实时刷新 */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex gap-0.5 rounded-lg bg-muted/40 border border-border p-0.5">
          {VIEWS.map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-colors', view === v.key ? 'bg-background text-foreground font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <v.Icon size={12} /> {v.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground truncate hidden sm:block">
          {view === 'office' ? '团队工位实时状态：忙碌的员工亮屏、头顶显示当前子任务' : '指派员工 →「开工」，下方流程图实时体现各子任务进度'}
        </div>
        <div className="flex-1" />
        <button onClick={refresh} className="text-[11px] px-2.5 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground">刷新</button>
      </div>

      {view === 'office' && (
        <OfficeFloor employees={employees} currentTaskByEmp={currentTaskByEmp} onGoMarket={goMarket} />
      )}

      {view === 'flow' && loading && (
        <div className="text-center text-muted-foreground text-sm py-10"><Loader2 size={16} className="animate-spin inline" /> 加载需求…</div>
      )}

      {view === 'flow' && !loading && !requests.length && (
        <div className="grid place-items-center text-center text-muted-foreground" style={{ height: '48vh' }}>
          <div>
            <div className="text-5xl mb-3 opacity-80">🗂</div>
            <h2 className="text-foreground font-semibold mb-1.5">还没有需求可派活</h2>
            <p className="text-[12.5px] mb-1">需求来自「公司」页：打开一个项目 → 用「新需求」描述任务，PM 会拆解成可执行任务。</p>
            <p className="text-[12.5px] mb-4">需求出现在这里后，给它<strong>指派一位员工</strong>并点<strong>开工</strong>，员工就会用自己的模型与岗位人格去执行。</p>
            <div className="flex gap-2 justify-center">
              <button onClick={goMarket} className="px-4 py-2 rounded-lg border border-border text-sm">先去招募员工</button>
              <button onClick={() => goWorkbench ? goWorkbench() : useUIStore.getState().setPage('vibe')} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm">去工作台提需求 →</button>
            </div>
          </div>
        </div>
      )}

      {view === 'flow' && !loading && requests.length > 0 && (
      <>
      {/* ── 顶部：正在运行（大图 + 横向流程图）────────────────────────────── */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="relative flex h-2.5 w-2.5">
            {running.length > 0 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60" />}
            <span className={cn('relative inline-flex rounded-full h-2.5 w-2.5', running.length ? 'bg-blue-500' : 'bg-muted-foreground/30')} />
          </span>
          <span className="font-semibold text-[13px]">正在运行</span>
          <span className="text-[11px] text-muted-foreground bg-muted/60 border border-border rounded-full px-2">{running.length}</span>
        </div>
        {running.length === 0 ? (
          <div className="text-[12px] text-muted-foreground/60 text-center py-6 border border-dashed border-border rounded-xl">
            当前没有正在执行的需求 —— 在下方「待应用」里给需求指派员工并点「开工」。
          </div>
        ) : (
          <div className="space-y-3">
            {running.map(r => {
              const emp = empById(r.assigneeEmployeeId)
              const roll = rollOf(r)
              const pct = roll && roll.total ? Math.round(roll.done / roll.total * 100) : 0
              return (
                <div key={r.id} className="rounded-xl border border-blue-500/40 bg-blue-500/[0.04] p-4">
                  <div className="flex items-start gap-2 mb-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold leading-snug truncate">{r.title}</span>
                        <span className="shrink-0 text-[10px] px-1.5 py-px rounded bg-blue-500/15 text-blue-500 font-medium">执行中</span>
                      </div>
                      <div className="text-[10.5px] text-muted-foreground mt-0.5">📁 {projName(r.projectPath)} · {r.kind === 'bugfix' ? '缺陷' : '需求'}{emp ? ` · 🧠 ${emp.modelId || '默认模型'}` : ''}</div>
                    </div>
                    <span className="shrink-0 text-[13px] font-semibold tabular-nums text-blue-500">{pct}%</span>
                    {delBtn(r)}
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <RequestFlow tasks={subsOf(r.id)} employees={employees} />
                  </div>
                  {roll && roll.error > 0 && <div className="text-[10.5px] text-rose-400 mt-2">⚠ {roll.error} 个子任务失败 —— 可在「待应用」重派后重跑</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 底部：待应用 / 已完成（折叠分组，点开看流程图迭代）──────────────── */}
      <div className="space-y-3">
        {BOTTOM.map(g => {
          const meta = STATUS_META[g.key]
          const open = !closedGroups.has(g.key)
          return (
            <div key={g.key} className="rounded-xl border border-border bg-card/40">
              <button onClick={() => toggleGroup(g.key)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
                <span className="text-muted-foreground/60 text-[11px] w-3">{open ? '▾' : '▸'}</span>
                <span className="w-2 h-2 rounded-sm" style={{ background: meta.color }} />
                <span className="font-semibold text-[12.5px]">{meta.name}</span>
                <span className="ml-auto text-[11px] text-muted-foreground bg-muted/60 border border-border rounded-full px-2">{g.items.length}</span>
              </button>
              {open && (
                <div className="px-2.5 pb-3 space-y-2">
                  {g.items.length === 0 && <div className="text-[11px] text-muted-foreground/50 text-center py-3 border border-dashed border-border rounded-lg">空</div>}
                  {g.items.map(r => {
                    const emp = empById(r.assigneeEmployeeId)
                    const flowOpen = expandedReqs.has(r.id)
                    return (
                      <div key={r.id} className="rounded-lg border border-border bg-card p-2.5">
                        <div className="flex items-start gap-1.5">
                          <button onClick={() => toggleReq(r.id)} className="text-muted-foreground/60 hover:text-foreground mt-0.5 text-[11px] w-3 shrink-0" title={flowOpen ? '收起流程图' : '展开流程图'}>{flowOpen ? '▾' : '▸'}</button>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium leading-snug">{r.title}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">📁 {projName(r.projectPath)} · {r.kind === 'bugfix' ? '缺陷' : '需求'}</div>
                          </div>
                          {delBtn(r)}
                        </div>

                        <TaskProgressBar roll={rollOf(r)} />

                        {flowOpen && (
                          <div className="mt-2.5 overflow-x-auto pb-1">
                            <RequestFlow tasks={subsOf(r.id)} employees={employees} />
                          </div>
                        )}

                        <div className="mt-2">{assigneeSelect(r)}</div>
                        {emp && <div className="text-[10px] text-muted-foreground mt-1">🧠 {emp.modelId || '默认模型'}</div>}
                        {g.key === 'proposed' && (
                          <button onClick={() => apply(r)} disabled={applying === r.id}
                            className="w-full mt-2 text-[11px] py-1.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50">
                            {applying === r.id ? <Loader2 size={11} className="animate-spin inline" /> : '▶'} 开工
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}
