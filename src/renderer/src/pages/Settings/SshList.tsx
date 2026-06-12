import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Edit2, Trash2, Server, KeyRound, Lock, Upload, Loader2, Copy, Search, X,
  ChevronDown, ChevronRight, Activity, CheckCircle2, XCircle, FolderClosed, Zap, UserCog, SlidersHorizontal
} from 'lucide-react'
import type { SshConnection } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'
import { cn } from '../../lib/utils'

type SortKey = 'name' | 'host' | 'recent'
type TestState = 'testing' | 'ok' | 'fail'

interface Props {
  connections: SshConnection[]
  onEdit: (c: SshConnection) => void
  onDelete: (id: string) => void
  onBulkDelete: (ids: string[]) => Promise<void> | void
  onBulkSetAutoConfirm: (ids: string[], value: boolean) => Promise<void> | void
  onBulkSetBecome: (ids: string[], enabled: boolean, user: string) => Promise<void> | void
  onDuplicate: (c: SshConnection) => void
  onCreate: () => void
  onImport: () => void
  importing: boolean
}

const UNGROUPED = '未分组'

/** Run an async task over items with a small concurrency cap. */
async function runPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => { while (i < items.length) { const cur = items[i++]; await fn(cur) } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

export function SshList({ connections, onEdit, onDelete, onBulkDelete, onBulkSetAutoConfirm, onBulkSetBecome, onDuplicate, onCreate, onImport, importing }: Props) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Record<string, TestState>>({})
  const [bulkTesting, setBulkTesting] = useState(false)
  const [settingAuto, setSettingAuto] = useState(false)
  const [settingBecome, setSettingBecome] = useState(false)
  const [bulkUser, setBulkUser] = useState('root')
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const bulkMenuRef = useRef<HTMLDivElement>(null)

  // Close the 批量设置 popover on an outside click.
  useEffect(() => {
    if (!bulkMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target as Node)) setBulkMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [bulkMenuOpen])

  // Filter → group → sort.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? connections.filter(c => (c.name + ' ' + c.host + ' ' + c.username + ' ' + (c.group || '')).toLowerCase().includes(q))
      : connections
    const byGroup = new Map<string, SshConnection[]>()
    for (const c of filtered) {
      const g = c.group?.trim() || UNGROUPED
      ;(byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(c)
    }
    const cmp = (a: SshConnection, b: SshConnection): number => {
      if (sortKey === 'host') return a.host.localeCompare(b.host)
      if (sortKey === 'recent') return (b.createdAt ?? 0) - (a.createdAt ?? 0)
      return a.name.localeCompare(b.name)
    }
    const names = [...byGroup.keys()].sort((a, b) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b))
    return names.map(name => ({ name, items: byGroup.get(name)!.sort(cmp) }))
  }, [connections, query, sortKey])

  const visibleIds = useMemo(() => groups.flatMap(g => g.items.map(c => c.id)), [groups])
  const selectedVisible = visibleIds.filter(id => selected.has(id))
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length
  const multipleGroups = groups.length > 1 || (groups[0]?.name !== UNGROUPED)

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleGroup(ids: string[], on: boolean) {
    setSelected(prev => { const n = new Set(prev); ids.forEach(id => on ? n.add(id) : n.delete(id)); return n })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleIds))
  }
  function toggleCollapse(name: string) {
    setCollapsed(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  async function testOne(c: SshConnection) {
    setStatus(s => ({ ...s, [c.id]: 'testing' }))
    try {
      const r = await window.api.sshTestConnection(c)
      setStatus(s => ({ ...s, [c.id]: r.ok ? 'ok' : 'fail' }))
    } catch {
      setStatus(s => ({ ...s, [c.id]: 'fail' }))
    }
  }

  async function bulkTest() {
    const targets = connections.filter(c => selected.has(c.id))
    if (!targets.length) return
    setBulkTesting(true)
    try { await runPool(targets, 4, testOne) } finally { setBulkTesting(false) }
  }

  async function bulkDelete() {
    await onBulkDelete(selectedVisible)
    setSelected(new Set())
  }

  // Split the selection by current免确认 state so each button shows how many it will
  // actually change (mixed selections), and disables when nothing would change.
  const selectedAutoOn = selectedVisible.filter(id => connections.find(c => c.id === id)?.autoConfirm).length
  const toEnable = selectedVisible.length - selectedAutoOn // selected that are currently OFF
  const toDisable = selectedAutoOn                          // selected that are currently ON
  async function bulkSetAutoConfirm(value: boolean) {
    setSettingAuto(true)
    try { await onBulkSetAutoConfirm(selectedVisible, value) } finally { setSettingAuto(false) }
  }

  // Bulk sudo-switch: enable runs every command as <bulkUser> on the selected
  // connections; disable turns it off. Disable only counts those currently on.
  const selectedBecomeOn = selectedVisible.filter(id => connections.find(c => c.id === id)?.becomeRoot).length
  async function bulkSetBecome(enabled: boolean) {
    setSettingBecome(true)
    try { await onBulkSetBecome(selectedVisible, enabled, bulkUser) } finally { setSettingBecome(false) }
  }

  const StatusDot = ({ id }: { id: string }) => {
    const st = status[id]
    if (st === 'testing') return <Loader2 size={13} className="animate-spin text-muted-foreground shrink-0" />
    if (st === 'ok') return <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
    if (st === 'fail') return <XCircle size={13} className="text-destructive shrink-0" />
    return <span className="w-[7px] h-[7px] rounded-full bg-muted-foreground/30 shrink-0" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">SSH 连接</h2>
          <p className="text-sm text-muted-foreground">
            配置远程服务器,对话和公司工作台的 Agent 可在其上执行命令。凭据加密保存在本机,不会进入模型上下文。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onImport} disabled={importing}
            title="从 MobaXterm 导出的 .mxtsessions 文件批量导入(不含密码,导入后请补全凭据)"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50">
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            导入 MobaXterm
          </button>
          <button onClick={onCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors">
            <Plus size={14} /> 添加连接
          </button>
        </div>
      </div>

      {connections.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
          尚未配置任何 SSH 连接,点击「添加连接」或「导入 MobaXterm」开始。
        </div>
      ) : (
        <>
          {/* toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 名称 / 主机 / 用户 / 分组…"
                className="h-8 w-full pl-8 pr-7 text-sm rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40" />
              {query && <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"><X size={12} /></button>}
            </div>
            <Select<SortKey>
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: 'name', label: '按名称' },
                { value: 'host', label: '按主机' },
                { value: 'recent', label: '最近添加' },
              ]}
              size="sm"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer px-2 h-8 rounded-md border border-border hover:bg-accent">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-primary" />
              全选
            </label>
          </div>

          {/* selection action bar — compact: count + 测试 / 批量设置▾ / 删除.
              The toggle-style bulk settings live in a tidy grouped popover so the
              bar never crowds into an unreadable row. */}
          {selectedVisible.length > 0 && (
            <div className="flex items-center gap-2 text-sm bg-accent/60 border border-border rounded-md px-3 py-2">
              <span className="text-foreground font-medium">已选 {selectedVisible.length} 项</span>
              <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:text-foreground">清除</button>
              <div className="flex-1" />
              <button onClick={bulkTest} disabled={bulkTesting}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-50">
                {bulkTesting ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />} 测试
              </button>

              <div className="relative" ref={bulkMenuRef}>
                <button onClick={() => setBulkMenuOpen(o => !o)}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs transition-colors',
                    bulkMenuOpen ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card hover:bg-accent'
                  )}>
                  <SlidersHorizontal size={12} /> 批量设置
                  <ChevronDown size={11} className={cn('transition-transform', bulkMenuOpen && 'rotate-180')} />
                </button>
                {bulkMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-50 w-72 rounded-lg border border-border bg-popover shadow-xl p-3.5 space-y-3.5 cursor-default">
                    {/* 免确认执行 */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-medium"><Zap size={13} className="text-amber-500" /> 免确认执行</div>
                      <p className="text-[11px] text-muted-foreground/80 leading-snug">开启后 Agent 在这些连接上执行命令不再逐次弹窗（含删除/重启等高危操作）。</p>
                      <div className="flex gap-2">
                        <button onClick={() => { setBulkMenuOpen(false); bulkSetAutoConfirm(true) }} disabled={toEnable === 0 || settingAuto}
                          className="flex-1 px-2 py-1.5 rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 text-xs disabled:opacity-40 disabled:cursor-not-allowed">
                          开启{toEnable > 0 ? `（${toEnable}）` : ''}
                        </button>
                        <button onClick={() => { setBulkMenuOpen(false); bulkSetAutoConfirm(false) }} disabled={toDisable === 0 || settingAuto}
                          className="flex-1 px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-40 disabled:cursor-not-allowed">
                          关闭{toDisable > 0 ? `（${toDisable}）` : ''}
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-border" />

                    {/* sudo 切换用户 */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-medium"><UserCog size={13} className="text-blue-500" /> 登录后 sudo 切换用户</div>
                      <p className="text-[11px] text-muted-foreground/80 leading-snug">每条命令自动以目标用户运行（需各连接已填 sudo 密码或登录密码即 sudo 密码）。</p>
                      <div className="flex items-center gap-2">
                        <input value={bulkUser} onChange={e => setBulkUser(e.target.value)} placeholder="root"
                          className="h-7 flex-1 min-w-0 px-2 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
                          autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                        <button onClick={() => { setBulkMenuOpen(false); bulkSetBecome(true) }} disabled={settingBecome}
                          className="px-3 py-1.5 rounded-md border border-blue-500/40 text-blue-700 dark:text-blue-400 hover:bg-blue-500/10 text-xs disabled:opacity-40 whitespace-nowrap">
                          切到 {bulkUser.trim() || 'root'}
                        </button>
                      </div>
                      <button onClick={() => { setBulkMenuOpen(false); bulkSetBecome(false) }} disabled={selectedBecomeOn === 0 || settingBecome}
                        className="w-full px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-40 disabled:cursor-not-allowed">
                        关闭切换{selectedBecomeOn > 0 ? `（${selectedBecomeOn}）` : ''}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button onClick={bulkDelete}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 text-xs">
                <Trash2 size={12} /> 删除
              </button>
            </div>
          )}

          {/* grouped list */}
          <div className="space-y-3">
            {groups.map(group => {
              const ids = group.items.map(c => c.id)
              const groupAll = ids.length > 0 && ids.every(id => selected.has(id))
              const isCollapsed = collapsed.has(group.name)
              return (
                <div key={group.name}>
                  {multipleGroups && (
                    <div className="flex items-center gap-2 mb-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" checked={groupAll} onChange={e => toggleGroup(ids, e.target.checked)} className="accent-primary" />
                      <button onClick={() => toggleCollapse(group.name)} className="flex items-center gap-1 hover:text-foreground">
                        {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <FolderClosed size={12} />
                        <span className="font-medium">{group.name}</span>
                        <span className="text-muted-foreground/60">· {group.items.length}</span>
                      </button>
                    </div>
                  )}
                  {!isCollapsed && (
                    <div className="space-y-2">
                      {group.items.map(c => (
                        <div key={c.id} className={cn(
                          'border rounded-lg p-3 flex items-center gap-3 bg-card shadow-sm transition-colors',
                          selected.has(c.id) ? 'border-primary/50 bg-primary/[0.04]' : 'border-border'
                        )}>
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="accent-primary shrink-0" />
                          <StatusDot id={c.id} />
                          <Server size={14} className="text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{c.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground inline-flex items-center gap-1 shrink-0">
                                {c.authType === 'privateKey' ? <><KeyRound size={9} /> 私钥</> : <><Lock size={9} /> 密码</>}
                              </span>
                              {c.autoConfirm && (
                                <span title="免确认执行：Agent 在此连接上执行命令不弹窗确认"
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 inline-flex items-center gap-1 shrink-0">
                                  <Zap size={9} /> 免确认
                                </span>
                              )}
                              {c.becomeRoot && (
                                <span title={`登录后自动 sudo 切换到 ${c.becomeUser || 'root'} 执行`}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-400 inline-flex items-center gap-1 shrink-0">
                                  <UserCog size={9} /> →{c.becomeUser || 'root'}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5 truncate">{c.username}@{c.host}:{c.port || 22}</div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button onClick={() => testOne(c)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded" title="测试连接">
                              <Activity size={14} />
                            </button>
                            <button onClick={() => onDuplicate(c)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded" title="复制">
                              <Copy size={14} />
                            </button>
                            <button onClick={() => onEdit(c)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded" title="编辑">
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => onDelete(c.id)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-accent rounded" title="删除">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {groups.length === 0 && <div className="text-center text-muted-foreground text-sm py-6">没有匹配的连接</div>}
          </div>
        </>
      )}
    </div>
  )
}
