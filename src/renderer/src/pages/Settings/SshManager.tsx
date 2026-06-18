import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Upload, Loader2, Search, X, Server, Activity, Edit2, Copy, Trash2,
  KeyRound, Lock, Zap, UserCog, CheckCircle2, XCircle, SlidersHorizontal, ChevronDown,
  Clipboard, CheckSquare
} from 'lucide-react'
import type { SshConnection } from '../../../../shared/ipc-types'
import { SshTree } from '../../components/ssh/SshTree'
import { SshForm } from './SshForm'
import { randomId } from '../../lib/id'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'
import { cn } from '../../lib/utils'

type TestState = 'testing' | 'ok' | 'fail'

/** Right-click menu target: a single connection, or a folder (all conns under it). */
type Menu =
  | { kind: 'conn'; x: number; y: number; conn: SshConnection }
  | { kind: 'folder'; x: number; y: number; path: string; conns: SshConnection[] }
  | null

/** Run an async task over items with a small concurrency cap. */
async function runPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => { while (i < items.length) { await fn(items[i++]) } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

/**
 * SSH connection管理 (设置 → SSH). MobaXterm-style nested folder tree (built from
 * each connection's `group` path) + multi-select bulk operations + right-click
 * context menus. Add / edit opens SshForm in a modal. Credentials are encrypted at
 * rest by the main process and never exposed to the LLM (referenced by name only).
 */
export function SshManager() {
  const [connections, setConnections] = useState<SshConnection[]>([])
  const [editing, setEditing] = useState<SshConnection | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Record<string, TestState>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkTesting, setBulkTesting] = useState(false)
  const [settingAuto, setSettingAuto] = useState(false)
  const [settingBecome, setSettingBecome] = useState(false)
  const [bulkUser, setBulkUser] = useState('root')
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [menu, setMenu] = useState<Menu>(null)
  const bulkMenuRef = useRef<HTMLDivElement>(null)
  const dlg = useConfirmDialog()

  const reload = useCallback(async () => {
    try { setConnections((await window.api.sshListConnections()) as SshConnection[]) }
    catch (e) { toast.error('加载 SSH 连接失败：' + (e as Error).message) }
  }, [])
  useEffect(() => { reload() }, [reload])

  // Close popovers on outside click / Esc.
  useEffect(() => {
    if (!bulkMenuOpen) return
    const onDoc = (e: MouseEvent) => { if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target as Node)) setBulkMenuOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [bulkMenuOpen])
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-ssh-ctx]')) setMenu(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menu])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q
      ? connections.filter(c => (c.name + ' ' + c.host + ' ' + c.username + ' ' + (c.group || '')).toLowerCase().includes(q))
      : connections
  }, [connections, query])

  const visibleIds = useMemo(() => filtered.map(c => c.id), [filtered])
  const selectedVisible = visibleIds.filter(id => selected.has(id))
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length

  function toggle(id: string) { setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n }) }
  function toggleGroup(ids: string[], on: boolean) { setSelected(prev => { const n = new Set(prev); ids.forEach(id => on ? n.add(id) : n.delete(id)); return n }) }
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(visibleIds)) }

  // --- CRUD ---------------------------------------------------------------
  async function handleSave(c: SshConnection) { await window.api.sshSaveConnection(c); setEditing(null); await reload(); toast.success('已保存') }
  async function handleDelete(id: string) {
    const ok = await dlg.confirm({ message: '删除该 SSH 连接？', tone: 'danger', confirmLabel: '删除' })
    if (!ok) return
    await window.api.sshDeleteConnection(id); await reload()
  }
  async function handleDuplicate(c: SshConnection) {
    const copy: SshConnection = { ...c, id: randomId(), name: `${c.name} 副本`, createdAt: undefined }
    await window.api.sshSaveConnection(copy); await reload(); toast.success(`已复制为「${copy.name}」`)
  }
  async function testOne(c: SshConnection) {
    setStatus(s => ({ ...s, [c.id]: 'testing' }))
    try {
      const r = await window.api.sshTestConnection(c)
      setStatus(s => ({ ...s, [c.id]: r.ok ? 'ok' : 'fail' }))
      if (!r.ok) toast.error(`「${c.name}」连接失败：${r.error || '未知错误'}`)
    } catch (e) { setStatus(s => ({ ...s, [c.id]: 'fail' })); toast.error(`「${c.name}」连接失败：${(e as Error).message}`) }
  }

  async function handleImport() {
    const paths = (await window.api.openFileDialog?.({
      properties: ['openFile'],
      filters: [{ name: 'MobaXterm Sessions', extensions: ['mxtsessions'] }, { name: 'All Files', extensions: ['*'] }],
    })) as string[] | undefined
    if (!paths?.[0]) return
    setImporting(true)
    try {
      const r = await window.api.sshImportConnections(paths[0])
      await reload()
      if (r.imported > 0) {
        const extras: string[] = []
        if (r.duplicates) extras.push(`跳过重复 ${r.duplicates}`)
        if (r.skipped) extras.push(`跳过非 SSH ${r.skipped}`)
        if (r.missingKey) extras.push(`${r.missingKey} 个引用了本机找不到的私钥，请在该连接里补全`)
        toast.success(`已导入 ${r.imported} 个 SSH 连接${extras.length ? '（' + extras.join('；') + '）' : ''}。MobaXterm 不导出密码，密码登录的连接请补填密码。`, { duration: 6000 })
      } else toast.error(`未导入任何连接（重复 ${r.duplicates}、非 SSH ${r.skipped}）。`)
    } catch (e) { toast.error('导入失败：' + (e as Error).message) } finally { setImporting(false) }
  }

  // --- Bulk / per-connection toggles --------------------------------------
  async function runTests(conns: SshConnection[]) {
    if (!conns.length) return
    setBulkTesting(true)
    try { await runPool(conns, 4, testOne) } finally { setBulkTesting(false) }
  }
  async function bulkDelete(ids: string[]) {
    if (!ids.length) return
    const ok = await dlg.confirm({ message: `确定删除选中的 ${ids.length} 个 SSH 连接？此操作不可撤销。`, tone: 'danger', confirmLabel: `删除 ${ids.length} 个` })
    if (!ok) return
    for (const id of ids) await window.api.sshDeleteConnection(id)
    setSelected(new Set()); await reload(); toast.success(`已删除 ${ids.length} 个连接`)
  }
  async function setAutoConfirm(ids: string[], value: boolean) {
    const targets = connections.filter(c => ids.includes(c.id) && !!c.autoConfirm !== value)
    if (!targets.length) return
    if (value) {
      const ok = await dlg.confirm({
        message: `确定对 ${targets.length} 个连接开启「免确认执行」？\n\n开启后 Agent 在这些连接上执行命令（含删除/重启/改配置等高危操作）不再逐次弹窗确认。仅在完全信任时使用。`,
        tone: 'danger', confirmLabel: `开启 ${targets.length} 个`,
      })
      if (!ok) return
    }
    setSettingAuto(true)
    try { for (const c of targets) await window.api.sshSaveConnection({ ...c, autoConfirm: value }) } finally { setSettingAuto(false) }
    await reload()
    toast.success(value ? `已对 ${targets.length} 个连接开启免确认执行` : `已关闭 ${targets.length} 个连接的免确认执行`)
  }
  async function setBecome(ids: string[], enabled: boolean, user: string) {
    const u = (user.trim().replace(/[^A-Za-z0-9._-]/g, '')) || 'root'
    const targets = connections.filter(c => {
      if (!ids.includes(c.id)) return false
      if (enabled) return !c.becomeRoot || (c.becomeUser || 'root') !== u
      return !!c.becomeRoot
    })
    if (!targets.length) return
    if (enabled) {
      const ok = await dlg.confirm({
        message: `确定对 ${targets.length} 个连接开启「sudo 切换到 ${u} 执行」？\n\n开启后每条命令都会自动以 ${u} 身份运行。请确保已填好可用的 sudo 密码（或登录密码即 sudo 密码）。`,
        tone: 'danger', confirmLabel: `开启 ${targets.length} 个`,
      })
      if (!ok) return
    }
    setSettingBecome(true)
    try { for (const c of targets) await window.api.sshSaveConnection({ ...c, becomeRoot: enabled || undefined, becomeUser: enabled ? u : undefined }) } finally { setSettingBecome(false) }
    await reload()
    toast.success(enabled ? `已对 ${targets.length} 个连接开启 sudo 切换到 ${u}` : `已关闭 ${targets.length} 个连接的 sudo 切换`)
  }

  const selectedAutoOn = selectedVisible.filter(id => connections.find(c => c.id === id)?.autoConfirm).length
  const selectedBecomeOn = selectedVisible.filter(id => connections.find(c => c.id === id)?.becomeRoot).length

  function copyText(text: string, label: string) { void navigator.clipboard.writeText(text).then(() => toast.success(`已复制${label}`)).catch(() => {}) }

  const StatusDot = ({ id }: { id: string }) => {
    const st = status[id]
    if (st === 'testing') return <Loader2 size={12} className="animate-spin text-muted-foreground shrink-0" />
    if (st === 'ok') return <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
    if (st === 'fail') return <XCircle size={12} className="text-destructive shrink-0" />
    return <span className="w-[6px] h-[6px] rounded-full bg-muted-foreground/30 shrink-0" />
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">SSH 连接</h2>
          <p className="text-sm text-muted-foreground">
            配置远程服务器，对话和公司工作台的 Agent 可在其上执行命令。凭据加密保存在本机，不会进入模型上下文。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleImport} disabled={importing}
            title="从 MobaXterm 导出的 .mxtsessions 文件批量导入（不含密码，导入后请补全凭据）"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50">
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            导入 MobaXterm
          </button>
          <button onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors">
            <Plus size={14} /> 添加连接
          </button>
        </div>
      </div>

      {connections.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
          尚未配置任何 SSH 连接，点击「添加连接」或「导入 MobaXterm」开始。
        </div>
      ) : (
        <>
          {/* toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 名称 / 主机 / 用户 / 分组…"
                className="h-8 w-full pl-8 pr-7 text-sm rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40" />
              {query && <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"><X size={12} /></button>}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer px-2 h-8 rounded-md border border-border hover:bg-accent">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-primary" /> 全选
            </label>
          </div>

          {/* bulk action bar */}
          {selectedVisible.length > 0 && (
            <div className="flex items-center gap-2 text-sm bg-accent/60 border border-border rounded-md px-3 py-2">
              <span className="text-foreground font-medium">已选 {selectedVisible.length} 项</span>
              <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:text-foreground">清除</button>
              <div className="flex-1" />
              <button onClick={() => runTests(connections.filter(c => selected.has(c.id)))} disabled={bulkTesting}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-50">
                {bulkTesting ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />} 测试
              </button>
              <div className="relative" ref={bulkMenuRef}>
                <button onClick={() => setBulkMenuOpen(o => !o)}
                  className={cn('flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs transition-colors',
                    bulkMenuOpen ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card hover:bg-accent')}>
                  <SlidersHorizontal size={12} /> 批量设置 <ChevronDown size={11} className={cn('transition-transform', bulkMenuOpen && 'rotate-180')} />
                </button>
                {bulkMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-50 w-72 rounded-lg border border-border bg-popover shadow-xl p-3.5 space-y-3.5 cursor-default">
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-medium"><Zap size={13} className="text-amber-500" /> 免确认执行</div>
                      <p className="text-[11px] text-muted-foreground/80 leading-snug">开启后 Agent 在这些连接上执行命令不再逐次弹窗（含删除/重启等高危操作）。</p>
                      <div className="flex gap-2">
                        <button onClick={() => { setBulkMenuOpen(false); setAutoConfirm(selectedVisible, true) }} disabled={selectedVisible.length - selectedAutoOn === 0 || settingAuto}
                          className="flex-1 px-2 py-1.5 rounded-md border border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 text-xs disabled:opacity-40">开启{selectedVisible.length - selectedAutoOn > 0 ? `（${selectedVisible.length - selectedAutoOn}）` : ''}</button>
                        <button onClick={() => { setBulkMenuOpen(false); setAutoConfirm(selectedVisible, false) }} disabled={selectedAutoOn === 0 || settingAuto}
                          className="flex-1 px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-40">关闭{selectedAutoOn > 0 ? `（${selectedAutoOn}）` : ''}</button>
                      </div>
                    </div>
                    <div className="border-t border-border" />
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-medium"><UserCog size={13} className="text-blue-500" /> 登录后 sudo 切换用户</div>
                      <p className="text-[11px] text-muted-foreground/80 leading-snug">每条命令自动以目标用户运行（需各连接已填 sudo 密码或登录密码即 sudo 密码）。</p>
                      <div className="flex items-center gap-2">
                        <input value={bulkUser} onChange={e => setBulkUser(e.target.value)} placeholder="root"
                          className="h-7 flex-1 min-w-0 px-2 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                        <button onClick={() => { setBulkMenuOpen(false); setBecome(selectedVisible, true, bulkUser) }} disabled={settingBecome}
                          className="px-3 py-1.5 rounded-md border border-blue-500/40 text-blue-700 dark:text-blue-400 hover:bg-blue-500/10 text-xs disabled:opacity-40 whitespace-nowrap">切到 {bulkUser.trim() || 'root'}</button>
                      </div>
                      <button onClick={() => { setBulkMenuOpen(false); setBecome(selectedVisible, false, bulkUser) }} disabled={selectedBecomeOn === 0 || settingBecome}
                        className="w-full px-2 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-40">关闭切换{selectedBecomeOn > 0 ? `（${selectedBecomeOn}）` : ''}</button>
                    </div>
                  </div>
                )}
              </div>
              <button onClick={() => bulkDelete(selectedVisible)} className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 text-xs">
                <Trash2 size={12} /> 删除
              </button>
            </div>
          )}

          {/* MobaXterm-style nested folder tree (右键有更多操作) */}
          <div className="border border-border rounded-lg bg-card/40 p-2">
            {filtered.length === 0 ? (
              <div className="text-center text-muted-foreground text-sm py-6">没有匹配的连接</div>
            ) : (
              <SshTree
                connections={filtered}
                forceExpand={!!query.trim()}
                onFolderContextMenu={(path, conns, e) => { e.preventDefault(); setMenu({ kind: 'folder', x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 240), path, conns }) }}
                renderFolderExtra={(_p, conns) => {
                  const ids = conns.map(c => c.id)
                  const groupAll = ids.length > 0 && ids.every(id => selected.has(id))
                  return <input type="checkbox" checked={groupAll} onChange={e => toggleGroup(ids, e.target.checked)} onClick={e => e.stopPropagation()} className="accent-primary shrink-0" title="选中此文件夹下全部连接" />
                }}
                renderItem={(c) => (
                  <div
                    onContextMenu={e => { e.preventDefault(); setMenu({ kind: 'conn', x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 320), conn: c }) }}
                    className={cn('group/row flex items-center gap-2 pl-1.5 pr-1 py-1 rounded-md transition-colors',
                      selected.has(c.id) ? 'bg-primary/[0.06]' : 'hover:bg-accent')}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} className="accent-primary shrink-0" />
                    <StatusDot id={c.id} />
                    <Server size={14} className="text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{c.name}</span>
                        <span className="text-[10px] px-1 py-px rounded bg-muted text-muted-foreground inline-flex items-center gap-0.5 shrink-0">
                          {c.authType === 'privateKey' ? <><KeyRound size={9} /> 私钥</> : <><Lock size={9} /> 密码</>}
                        </span>
                        {c.autoConfirm && <span title="免确认执行" className="text-amber-500 shrink-0"><Zap size={11} /></span>}
                        {c.becomeRoot && <span title={`登录后 sudo 切换到 ${c.becomeUser || 'root'}`} className="text-blue-500 shrink-0 inline-flex"><UserCog size={11} /></span>}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{c.username}@{c.host}:{c.port || 22}</div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity">
                      <button onClick={() => testOne(c)} title="测试连接" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"><Activity size={14} /></button>
                      <button onClick={() => setEditing(c)} title="编辑" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"><Edit2 size={14} /></button>
                      <button onClick={() => handleDelete(c.id)} title="删除" className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"><Trash2 size={14} /></button>
                    </div>
                  </div>
                )}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/70">提示：右键连接或文件夹可快捷 测试 / 编辑 / 复制 / 免确认·sudo 切换 / 删除等。</p>
        </>
      )}

      {/* context menu */}
      {menu && createPortal(
        <div data-ssh-ctx className="fixed z-[100] min-w-[200px] bg-popover border border-border rounded-lg shadow-xl py-1 text-sm select-none" style={{ left: menu.x, top: menu.y }}>
          {(() => {
            if (!menu) return null
            if (menu.kind === 'conn') {
              const c = menu.conn
              return (
                <>
                  <CtxItem icon={<Activity size={13} />} label="测试连接" onClick={() => { setMenu(null); testOne(c) }} />
                  <CtxItem icon={<Edit2 size={13} />} label="编辑" onClick={() => { setMenu(null); setEditing(c) }} />
                  <CtxItem icon={<Copy size={13} />} label="复制连接" onClick={() => { setMenu(null); handleDuplicate(c) }} />
                  <CtxItem icon={<Clipboard size={13} />} label="复制 user@host" onClick={() => { setMenu(null); copyText(`${c.username}@${c.host}`, ' user@host') }} />
                  <CtxItem icon={<Clipboard size={13} />} label="复制主机" onClick={() => { setMenu(null); copyText(c.host, '主机') }} />
                  <CtxDivider />
                  <CtxItem icon={<Zap size={13} className="text-amber-500" />} label={c.autoConfirm ? '关闭免确认执行' : '开启免确认执行'} onClick={() => { setMenu(null); setAutoConfirm([c.id], !c.autoConfirm) }} />
                  <CtxItem icon={<UserCog size={13} className="text-blue-500" />} label={c.becomeRoot ? `关闭 sudo 切换（当前 ${c.becomeUser || 'root'}）` : '开启 sudo 切换到 root'} onClick={() => { setMenu(null); setBecome([c.id], !c.becomeRoot, c.becomeUser || 'root') }} />
                  <CtxDivider />
                  <CtxItem icon={<Trash2 size={13} />} label="删除" danger onClick={() => { setMenu(null); handleDelete(c.id) }} />
                </>
              )
            }
            const { path, conns } = menu
            const ids = conns.map(c => c.id)
            return (
              <>
                <div className="px-3 py-1 text-[11px] text-muted-foreground truncate">📁 {path}（{conns.length}）</div>
                <CtxItem icon={<CheckSquare size={13} />} label="全选此分组" onClick={() => { setMenu(null); toggleGroup(ids, true) }} />
                <CtxItem icon={<Activity size={13} />} label={`测试此分组（${conns.length}）`} onClick={() => { setMenu(null); runTests(conns) }} />
                <CtxDivider />
                <CtxItem icon={<Zap size={13} className="text-amber-500" />} label="此分组开启免确认" onClick={() => { setMenu(null); setAutoConfirm(ids, true) }} />
                <CtxItem icon={<Zap size={13} className="text-muted-foreground" />} label="此分组关闭免确认" onClick={() => { setMenu(null); setAutoConfirm(ids, false) }} />
                <CtxItem icon={<UserCog size={13} className="text-blue-500" />} label="此分组 sudo 切到 root" onClick={() => { setMenu(null); setBecome(ids, true, 'root') }} />
                <CtxItem icon={<UserCog size={13} className="text-muted-foreground" />} label="此分组关闭 sudo 切换" onClick={() => { setMenu(null); setBecome(ids, false, 'root') }} />
                <CtxDivider />
                <CtxItem icon={<Trash2 size={13} />} label={`删除此分组（${conns.length}）`} danger onClick={() => { setMenu(null); bulkDelete(ids) }} />
              </>
            )
          })()}
        </div>,
        document.body
      )}

      {/* Add / edit connection — portaled to <body> so the overlay covers the full
          viewport (a transformed Settings ancestor would otherwise clip a `fixed`
          overlay rendered inline). */}
      {editing !== null && createPortal(
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[1px] flex items-center justify-center p-4" onMouseDown={() => setEditing(null)}>
          <div className="bg-card rounded-xl border border-border shadow-2xl w-full max-w-xl max-h-[88vh] overflow-y-auto p-5" onMouseDown={e => e.stopPropagation()}>
            <SshForm initial={editing === 'new' ? null : editing} onSave={handleSave} onCancel={() => setEditing(null)} />
          </div>
        </div>,
        document.body
      )}
      {dlg.element}
    </div>
  )
}

function CtxItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent',
        danger ? 'text-destructive hover:text-destructive' : 'text-foreground/90 hover:text-foreground')}>
      <span className={danger ? 'text-destructive' : 'text-muted-foreground'}>{icon}</span>
      <span className="text-xs">{label}</span>
    </button>
  )
}
function CtxDivider() { return <div className="my-1 border-t border-border" /> }
