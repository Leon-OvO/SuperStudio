import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Download, Trash2, ToggleLeft, ToggleRight, RefreshCw, Plus, Link2,
  MessageSquare, Code2, Video, Loader2, ExternalLink, X, AlertCircle, Globe, Package,
  Search, ChevronLeft, ChevronRight, ChevronDown, Shield, FileText, FolderOpen,
  Wand2, CheckCircle2, Ban, RotateCcw, TrendingUp, CheckSquare, Square, ArrowDownUp
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useT } from '../../lib/i18n'
import { toast } from '../../components/ui/Toast'
import { Select } from '../../components/ui/Select'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { useInputDialog } from '../../components/ui/InputDialog'
import type {
  InstalledSkillInfo, SkillSourceInfo, SkillRegistryEntryInfo,
  FetchedRegistryInfo, SkillScenario, DiscoveredSkillInfo
} from '../../../../shared/ipc-types'
import { useVibeStore } from '../Vibe/store'
import { DiscoverDialog } from './DiscoverDialog'

type Tab = 'installed' | 'browse' | 'sources' | 'auto'

const SCENARIO_META: Record<SkillScenario, { label: string; Icon: typeof MessageSquare; color: string }> = {
  chat:  { label: '对话', Icon: MessageSquare, color: 'text-slate-600 dark:text-slate-300' },
  vibe:  { label: '公司', Icon: Code2,         color: 'text-primary' },
  video: { label: '视频', Icon: Video,         color: 'text-purple-500' }
}

/**
 * Render a skill icon. The `icon` field may be either a short emoji/text
 * token (legacy + bundled skills) OR a full URL (SkillHub). Detect URLs
 * and render an <img>; otherwise render the text inside the same chip.
 */
function SkillIcon({ icon, size = 'md' }: { icon?: string; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-8 h-8 text-base' : 'w-10 h-10 text-xl'
  const isUrl = !!icon && /^https?:\/\//i.test(icon)
  return (
    <div className={cn('rounded-lg bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden', dim)}>
      {isUrl ? (
        <img
          src={icon!}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => {
            // Fall back to the default emoji if the URL fails to load.
            const el = e.currentTarget
            el.style.display = 'none'
            const parent = el.parentElement
            if (parent && !parent.querySelector('[data-fallback]')) {
              const span = document.createElement('span')
              span.setAttribute('data-fallback', '1')
              span.textContent = '🧩'
              parent.appendChild(span)
            }
          }}
        />
      ) : (
        <span>{icon || '🧩'}</span>
      )}
    </div>
  )
}

const BROWSE_PAGE_SIZE = 24
const INSTALLED_PAGE_SIZE = 12
const INSTALLED_KEYWORD_DEBOUNCE_MS = 200
const KEYWORD_DEBOUNCE_MS = 300

export function SkillsPage() {
  const [tab, setTab] = useState<Tab>('installed')
  const [installed, setInstalled] = useState<InstalledSkillInfo[]>([])
  const [sources, setSources] = useState<SkillSourceInfo[]>([])
  const [registries, setRegistries] = useState<FetchedRegistryInfo[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  // Browse pagination + search state. `keyword` is the live input;
  // `appliedKeyword` is the debounced value actually sent to the backend.
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [appliedKeyword, setAppliedKeyword] = useState('')

  // Local skill auto-discovery (~/.claude/skills, project .claude/skills, custom).
  const projectPath = useVibeStore(s => s.projectPath)
  const [discovered, setDiscovered] = useState<DiscoveredSkillInfo[]>([])
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [discoverDismissed, setDiscoverDismissed] = useState(
    () => sessionStorage.getItem('skills-discover-dismissed') === '1'
  )

  const t = useT()
  const dlg = useConfirmDialog()
  const inputDlg = useInputDialog()

  async function runDiscover() {
    try {
      const d = await window.api.discoverLocalSkills?.(projectPath ?? undefined) as DiscoveredSkillInfo[] | undefined
      setDiscovered(d ?? [])
    } catch { setDiscovered([]) }
  }
  const pendingDiscover = discovered.filter(d => !d.alreadyImported)
  function dismissDiscover() {
    setDiscoverDismissed(true)
    sessionStorage.setItem('skills-discover-dismissed', '1')
  }

  async function refreshInstalled() {
    const list = await window.api.listSkills()
    setInstalled(list as InstalledSkillInfo[])
  }
  async function refreshSources() {
    const list = await window.api.listSkillSources()
    setSources(list as SkillSourceInfo[])
  }
  // Cancel-aware refetch: only the latest call updates state.
  const reqIdRef = useRef(0)
  const refreshRegistry = useCallback(async (p: number, kw: string) => {
    const myReq = ++reqIdRef.current
    setBrowsing(true)
    try {
      const res = await window.api.browseSkillRegistry({
        page: p,
        pageSize: BROWSE_PAGE_SIZE,
        keyword: kw
      }) as { registries: FetchedRegistryInfo[] }
      if (myReq !== reqIdRef.current) return  // stale; a newer request is in flight
      setRegistries(res.registries)
    } finally {
      if (myReq === reqIdRef.current) setBrowsing(false)
    }
  }, [])

  // Debounce the keyword: reset to page 1 once it settles.
  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedKeyword(keyword.trim())
      setPage(1)
    }, KEYWORD_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [keyword])

  // Fetch browse page whenever the relevant inputs change (and the tab is visible).
  useEffect(() => {
    if (tab !== 'browse') return
    refreshRegistry(page, appliedKeyword)
  }, [tab, page, appliedKeyword, refreshRegistry])

  useEffect(() => {
    refreshInstalled()
    refreshSources()
  }, [])

  // ---- 对话自动学习 (auto-induced skills) ----
  const [induction, setInduction] = useState<{ enabled: boolean; autoEnable: boolean }>({ enabled: true, autoEnable: true })
  useEffect(() => {
    window.api.getSettings().then((s: { skillInductionEnabled?: boolean; skillAutoEnable?: boolean }) =>
      setInduction({ enabled: s.skillInductionEnabled !== false, autoEnable: s.skillAutoEnable !== false })
    ).catch(() => {/* defaults */})
  }, [])
  // Toast + refresh when a skill is auto-learned in the background.
  useEffect(() => {
    const off = window.api.onSkillInduced?.((d) => {
      toast.success(`学会了新技能：${d.name}${d.status === 'pending' ? '（待审核）' : ''}`)
      refreshInstalled()
    })
    return off
  }, [])
  async function toggleInduction(patch: { skillInductionEnabled?: boolean; skillAutoEnable?: boolean }) {
    const s = await window.api.getSettings()
    const next = { ...s, ...patch }
    await window.api.setSettings(next)
    setInduction({ enabled: next.skillInductionEnabled !== false, autoEnable: next.skillAutoEnable !== false })
  }
  async function setSkillStatus(s: InstalledSkillInfo, status: 'active' | 'pending' | 'deprecated') {
    await window.api.setSkillStatus({ id: s.id, status })
    refreshInstalled()
  }
  // Batch lifecycle ops for the 自动学习 list (one refresh after the whole batch).
  async function batchSkillStatus(ids: string[], status: 'active' | 'pending' | 'deprecated') {
    for (const id of ids) await window.api.setSkillStatus({ id, status })
    await refreshInstalled()
  }
  async function batchUninstallSkills(ids: string[]): Promise<boolean> {
    if (!ids.length) return false
    const ok = await dlg.confirm({
      message: `删除选中的 ${ids.length} 个自动学习技能？\n此操作不可撤销（可先导出备份）。`,
      tone: 'danger',
      confirmLabel: '删除'
    })
    if (!ok) return false
    for (const id of ids) await window.api.uninstallSkill(id)
    toast.success(`已删除 ${ids.length} 个技能`)
    await refreshInstalled()
    return true
  }

  const autoSkills = useMemo(() => installed.filter(s => s.origin === 'auto'), [installed])
  const manualSkills = useMemo(() => installed.filter(s => s.origin !== 'auto'), [installed])

  // Re-scan for importable local skills whenever the page mounts or the open
  // project changes (project .claude/skills may differ).
  useEffect(() => {
    runDiscover()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  // ---- installed actions ----

  async function toggleEnabled(s: InstalledSkillInfo) {
    await window.api.setSkillEnabled({ id: s.id, enabled: !s.enabled })
    refreshInstalled()
  }

  async function toggleScenario(s: InstalledSkillInfo, scn: SkillScenario) {
    const next = s.enabledScenarios.includes(scn)
      ? s.enabledScenarios.filter(x => x !== scn)
      : [...s.enabledScenarios, scn]
    await window.api.setSkillScenarios({ id: s.id, scenarios: next })
    refreshInstalled()
  }

  async function uninstall(s: InstalledSkillInfo) {
    const ok = await dlg.confirm({
      message: `卸载技能「${s.name}」？\n你之后还可以从仓库重新安装。`,
      tone: 'danger',
      confirmLabel: '卸载'
    })
    if (!ok) return
    await window.api.uninstallSkill(s.id)
    toast.success('已卸载')
    refreshInstalled()
  }

  // ---- browse actions ----

  async function install(entry: SkillRegistryEntryInfo, sourceUrl: string) {
    setInstalling(entry.id)
    try {
      await window.api.installSkill({ sourceUrl, entry })
      toast.success(`已安装「${entry.name}」`)
      refreshInstalled()
    } catch (e) {
      toast.error('安装失败：' + (e as Error).message)
    } finally {
      setInstalling(null)
    }
  }

  // Re-install a hollow legacy SkillHub skill as a real runtime skill.
  // SkillHub uses the slug as the id, so the slug is recoverable from the id —
  // passing `slug` routes SKILLS_INSTALL down the bundle-download path.
  async function upgradeToRuntime(s: InstalledSkillInfo) {
    if (!s.sourceUrl) {
      toast.error('无法升级：缺少来源信息')
      return
    }
    setInstalling(s.id)
    try {
      await window.api.installSkill({
        sourceUrl: s.sourceUrl,
        entry: {
          id: s.id,
          slug: s.id,
          name: s.name,
          description: s.description,
          icon: s.icon,
          version: s.version,
          author: s.author,
          homepage: s.homepage,
          suggestedScenarios: s.suggestedScenarios
        }
      })
      toast.success(`已升级「${s.name}」为运行时技能`)
      refreshInstalled()
    } catch (e) {
      toast.error('升级失败：' + (e as Error).message)
    } finally {
      setInstalling(null)
    }
  }

  // Import skill bundle(s) from local folders (offline / self-authored) — used by
  // both the "导入本地技能" button and drag-and-drop.
  async function importLocalFromPaths(rawPaths: string[]) {
    // Dedupe — a multi-file drop from one folder would otherwise re-import it.
    const paths = [...new Set(rawPaths)]
    if (!paths.length) return
    setInstalling('__local__')
    let ok = 0
    try {
      for (const p of paths) {
        try {
          const skill = await window.api.importLocalSkill(p) as InstalledSkillInfo
          toast.success(`已导入「${skill.name}」`)
          ok++
        } catch (e) {
          toast.error('导入失败：' + (e as Error).message)
        }
      }
      if (ok) await refreshInstalled()
    } finally {
      setInstalling(null)
    }
  }

  async function importLocal() {
    // Allow picking a folder (bundle) OR a single SKILL.md file. On Windows a
    // dialog can't mix openFile+openDirectory (directory wins) — single files
    // there go through drag-and-drop, which the importer now handles correctly.
    const paths = await window.api.openFileDialog({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Skill', extensions: ['md', 'zip'] }]
    })
    if (paths?.length) await importLocalFromPaths(paths)
  }

  // Import the user-selected discovered skills, then refresh both lists.
  async function importDiscovered(paths: string[]) {
    await importLocalFromPaths(paths)
    await runDiscover()
  }

  // "+ 添加扫描目录": pick a folder, persist it as the custom discover dir, re-scan.
  async function addScanDir() {
    const picked = await window.api.openFileDialog({ properties: ['openDirectory'] })
    const dir = picked?.[0]
    if (!dir) return
    try {
      const s = await window.api.getSettings()
      await window.api.setSettings({ ...s, skillDiscoverDir: dir })
      await runDiscover()
      toast.success('已添加扫描目录')
    } catch (e) {
      toast.error('添加失败：' + (e as Error).message)
    }
  }

  // ---- sources actions ----

  async function addSource() {
    const url = await inputDlg.ask({
      title: '添加自定义技能源',
      description: '输入指向 registry.json 的完整 URL',
      placeholder: 'https://example.com/skills/registry.json',
      confirmLabel: '添加',
      validate: (v) => /^https?:\/\//.test(v) ? null : 'URL 必须以 http:// 或 https:// 开头'
    })
    if (!url) return
    let hostname = url
    try { hostname = new URL(url).hostname } catch { /* keep raw input */ }
    const name = await inputDlg.ask({
      title: '取个名字',
      description: '给这个源起个好认的名字（仅本地显示）',
      placeholder: '我的私有技能仓库',
      defaultValue: hostname,
      confirmLabel: '保存'
    })
    if (name === null) return
    try {
      await window.api.addSkillSource({ url, name: name || hostname })
      toast.success('源已添加')
      refreshSources()
      refreshRegistry(page, appliedKeyword)
    } catch (e) {
      toast.error('添加失败：' + (e as Error).message)
    }
  }

  async function deleteSource(s: SkillSourceInfo) {
    if (s.builtin) {
      toast.info('内置源不可删除，但可以禁用')
      return
    }
    const ok = await dlg.confirm({
      message: `删除技能源「${s.name}」？\n已安装的技能不会被卸载。`,
      tone: 'danger',
      confirmLabel: '删除'
    })
    if (!ok) return
    await window.api.deleteSkillSource(s.url)
    refreshSources()
    refreshRegistry(page, appliedKeyword)
  }

  async function toggleSource(s: SkillSourceInfo) {
    await window.api.setSkillSourceEnabled({ url: s.url, enabled: !s.enabled })
    refreshSources()
    refreshRegistry(page, appliedKeyword)
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <header className="px-6 py-3 border-b border-border flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
          <Sparkles size={16} className="text-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-base font-semibold leading-tight">{t('skills.title')}</h1>
          <p className="text-[11px] text-muted-foreground/70 leading-tight">
            收纳常用 prompt + 工具白名单的技能包，按场景启用
          </p>
        </div>
        <nav className="flex items-center gap-0.5 bg-muted/40 p-0.5 rounded-lg">
          {[
            { id: 'installed' as Tab, label: `${t('skills.tabInstalled')} (${manualSkills.length})`, Icon: Package },
            { id: 'auto' as Tab, label: `自动学习 (${autoSkills.length})`, Icon: Wand2 },
            { id: 'browse' as Tab, label: t('skills.tabBrowse'), Icon: Globe },
            { id: 'sources' as Tab, label: t('skills.tabSources'), Icon: Link2 }
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'flex items-center gap-1.5 h-7 px-3 rounded-md text-xs transition-colors',
                tab === id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-prominent">
        {tab === 'installed' && pendingDiscover.length > 0 && !discoverDismissed && (
          <div className="max-w-4xl mx-auto px-6 pt-4">
            <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2 text-xs">
              <Search size={14} className="text-primary shrink-0" />
              <span className="flex-1 text-foreground/90">
                在本机发现 <b className="text-primary">{pendingDiscover.length}</b> 个可导入的本地技能（来自 Claude Code / 项目）。
              </span>
              <button
                onClick={() => setDiscoverOpen(true)}
                className="shrink-0 px-2.5 py-1 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90"
              >
                查看并导入
              </button>
              <button onClick={dismissDiscover} className="shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-foreground" title="本次会话不再提示">
                <X size={13} />
              </button>
            </div>
          </div>
        )}
        {tab === 'auto' && (
          <AutoLearnTab
            list={autoSkills}
            induction={induction}
            onToggleInduction={toggleInduction}
            onSetStatus={setSkillStatus}
            onUninstall={uninstall}
            onBatchStatus={batchSkillStatus}
            onBatchUninstall={batchUninstallSkills}
          />
        )}
        {tab === 'installed' && (
          <InstalledTab
            list={manualSkills}
            installing={installing}
            onToggle={toggleEnabled}
            onToggleScenario={toggleScenario}
            onUninstall={uninstall}
            onUpgrade={upgradeToRuntime}
            onRefresh={refreshInstalled}
            onImportLocal={importLocal}
            onImportPaths={importLocalFromPaths}
          />
        )}
        {tab === 'browse' && (
          <BrowseTab
            registries={registries}
            installedIds={new Set(installed.map(s => s.id))}
            installing={installing}
            browsing={browsing}
            page={page}
            pageSize={BROWSE_PAGE_SIZE}
            keyword={keyword}
            onPageChange={setPage}
            onKeywordChange={setKeyword}
            onRefresh={() => refreshRegistry(page, appliedKeyword)}
            onInstall={install}
          />
        )}
        {tab === 'sources' && (
          <SourcesTab
            sources={sources}
            onAdd={addSource}
            onDelete={deleteSource}
            onToggle={toggleSource}
          />
        )}
      </div>

      {dlg.element}
      {inputDlg.element}
      {discoverOpen && (
        <DiscoverDialog
          discovered={discovered}
          onClose={() => setDiscoverOpen(false)}
          onImport={async (paths) => { setDiscoverOpen(false); await importDiscovered(paths) }}
          onAddScanDir={addScanDir}
        />
      )}
    </div>
  )
}

// ============================================================================
// Installed tab
// ============================================================================

function InstalledTab({
  list, installing, onToggle, onToggleScenario, onUninstall, onUpgrade, onRefresh, onImportLocal, onImportPaths
}: {
  list: InstalledSkillInfo[]
  installing: string | null
  onToggle: (s: InstalledSkillInfo) => void
  onToggleScenario: (s: InstalledSkillInfo, scn: SkillScenario) => void
  onUninstall: (s: InstalledSkillInfo) => void
  onUpgrade: (s: InstalledSkillInfo) => void
  onRefresh: () => void
  onImportLocal: () => void
  onImportPaths: (paths: string[]) => void
}) {
  const t = useT()
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [appliedKeyword, setAppliedKeyword] = useState('')
  const [dragOver, setDragOver] = useState(false)

  // Drag-and-drop import: a dropped folder resolves to its disk path via
  // webUtils (window.api.getPathForFile), then goes through the same importer.
  const handleDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map(f => window.api.getPathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length) onImportPaths(paths)
  }

  // Debounce the keyword like BrowseTab so typing doesn't thrash the slice.
  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedKeyword(keyword.trim().toLowerCase())
      setPage(1)
    }, INSTALLED_KEYWORD_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [keyword])

  // Built-ins first, then user installs — gives the core skills a stable home
  // at the top so they're easy to find.
  const sorted = useMemo(() => {
    return [...list].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [list])

  const filtered = useMemo(() => {
    if (!appliedKeyword) return sorted
    return sorted.filter(s =>
      s.name.toLowerCase().includes(appliedKeyword) ||
      s.description.toLowerCase().includes(appliedKeyword) ||
      s.author.toLowerCase().includes(appliedKeyword)
    )
  }, [sorted, appliedKeyword])

  const totalPages = Math.max(1, Math.ceil(filtered.length / INSTALLED_PAGE_SIZE))
  // Clamp page when filter shrinks the list out from under us.
  const safePage = Math.min(page, totalPages)
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * INSTALLED_PAGE_SIZE, safePage * INSTALLED_PAGE_SIZE),
    [filtered, safePage]
  )

  // Stat counts for the header — total + enabled (so user sees at a glance
  // how many of their installed skills are actually active right now).
  const enabledCount = list.filter(s => s.enabled).length
  const builtinCount = list.filter(s => s.builtin).length

  if (list.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title={t('skills.emptyInstalledTitle')}
        message={t('skills.emptyInstalledMessage')}
      />
    )
  }

  return (
    <div
      className="relative max-w-4xl mx-auto px-6 py-6 space-y-4"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-2 z-20 flex items-center justify-center rounded-xl bg-primary/[0.06] border-2 border-dashed border-primary/50 pointer-events-none">
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <FolderOpen size={16} /> 松手导入技能（文件夹需含 SKILL.md，也可拖入单个 SKILL.md 文件）
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold whitespace-nowrap">{t('skills.mySkills')}</h2>
        <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap">
          {filtered.length === list.length
            ? `${list.length} 个 · 已启用 ${enabledCount} · 内置 ${builtinCount}`
            : `${filtered.length}/${list.length} 个 · 已启用 ${enabledCount}`
          }
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t('skills.searchInstalledPlaceholder')}
            className="h-7 pl-6 pr-7 w-52 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          {keyword && (
            <button
              onClick={() => setKeyword('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent"
              title="清除"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          onClick={onImportLocal}
          disabled={installing === '__local__'}
          title="从本地文件夹导入技能（文件夹内需包含 SKILL.md）；也可直接把技能文件夹拖到此页面"
          className="flex items-center gap-1 h-7 px-2.5 text-xs rounded-md border border-border bg-card hover:bg-accent text-foreground transition-colors disabled:opacity-50 shrink-0"
        >
          {installing === '__local__' ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
          {t('skills.importLocal')}
        </button>
      </div>

      {pageItems.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`没有匹配「${keyword}」的技能`}
          message="换个关键词试试，或清空搜索框查看全部。"
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            {pageItems.map(s => (
              <SkillCard
                key={s.id}
                skill={s}
                installing={installing === s.id}
                onToggle={() => onToggle(s)}
                onToggleScenario={(scn) => onToggleScenario(s, scn)}
                onUninstall={() => onUninstall(s)}
                onUpgrade={() => onUpgrade(s)}
                onRefresh={onRefresh}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              page={safePage}
              totalPages={totalPages}
              disabled={false}
              onChange={setPage}
            />
          )}
        </>
      )}
    </div>
  )
}

function SkillCard({
  skill, installing, onToggle, onToggleScenario, onUninstall, onUpgrade, onRefresh
}: {
  skill: InstalledSkillInfo
  installing: boolean
  onToggle: () => void
  onToggleScenario: (scn: SkillScenario) => void
  onUninstall: () => void
  onUpgrade: () => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  // Built-in skills are mandatory: the app relies on them (e.g. opsx workflow).
  // We hide the disable toggle for them entirely and show a 始终启用 badge so
  // it's clear they're always active.
  const canDisable = !skill.builtin
  // A hollow legacy SkillHub skill — installed before the runtime rewrite, so
  // its body is just the seeded description. Offer a one-click re-download
  // into a real runtime bundle (SkillHub uses slug as id → slug recoverable).
  const canUpgrade = !skill.runtime && !skill.builtin && !!skill.sourceUrl && /skillhub/i.test(skill.sourceUrl)
  return (
    <div
      className={cn(
        'group rounded-xl border bg-card p-4 transition-all hover:shadow-sm hover:border-border',
        // Slightly tinted background for builtins so they stand out as protected
        skill.builtin && 'bg-gradient-to-br from-primary/[0.03] to-transparent border-primary/20',
        !skill.enabled && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <SkillIcon icon={skill.icon} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">{skill.name}</h3>
            {skill.builtin && (
              <span className="inline-flex items-center gap-1 text-[9px] uppercase font-semibold px-1.5 py-px rounded bg-primary/15 text-primary"
                title="内置技能，App 的部分功能依赖它，因此不可禁用"
              >
                <Shield size={9} /> 内置
              </span>
            )}
            {skill.runtime && (
              <span
                className="text-[9px] uppercase font-semibold px-1.5 py-px rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                title="运行时技能：完整 SKILL.md 与资源文件已下载到本地，由模型按需加载"
              >
                运行时
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/60 font-mono">v{skill.version}</span>
            {skill.author && <span className="text-[10px] text-muted-foreground/60">· {skill.author}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{skill.description}</p>
        </div>
        {canDisable ? (
          <button
            onClick={onToggle}
            className={cn(
              'p-1 rounded-md transition-colors shrink-0',
              skill.enabled ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:bg-accent'
            )}
            title={skill.enabled ? '点击禁用' : '点击启用'}
          >
            {skill.enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
          </button>
        ) : (
          <div
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-primary bg-primary/10 cursor-default"
            title="内置技能 App 依赖此功能，不可禁用"
          >
            <Shield size={11} /> 始终启用
          </div>
        )}
      </div>

      {/* Scenario chips — independent of global enabled. Built-ins are always
          enabled so chips are clickable regardless of the (hidden) toggle. */}
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        <span className="text-[10px] uppercase text-muted-foreground/60 font-semibold mr-1">作用场景</span>
        {(['chat', 'vibe', 'video'] as SkillScenario[]).map(scn => {
          const meta = SCENARIO_META[scn]
          const Icon = meta.Icon
          const active = skill.enabledScenarios.includes(scn)
          const interactive = skill.enabled  // builtins always have enabled=true
          return (
            <button
              key={scn}
              onClick={() => onToggleScenario(scn)}
              disabled={!interactive}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] transition-colors',
                active
                  ? cn('bg-primary/10 border-primary/40', meta.color, 'font-medium')
                  : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent',
                !interactive && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Icon size={10} /> {meta.label}
            </button>
          )
        })}
      </div>

      {/* Collapsible details */}
      <div className="mt-3 flex items-center gap-2 text-[11px]">
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? '收起详情' : '查看详情'}
        </button>
        {skill.homepage && (
          <a
            href={skill.homepage}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
          >
            主页 <ExternalLink size={9} />
          </a>
        )}
        <div className="flex-1" />
        <button
          onClick={async () => {
            try {
              const r = await window.api.exportSkill(skill.id)
              if (r?.canceled) { if (r.error) toast.error('导出失败：' + r.error); return }
              toast.success('已导出技能到 ' + r.filePath)
            } catch (e) {
              toast.error('导出失败：' + (e as Error).message)
            }
          }}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
          title="导出为 .zip 技能包（可再导入）"
        >
          <Download size={10} /> 导出
        </button>
        {canUpgrade && (
          <button
            onClick={onUpgrade}
            disabled={installing}
            className="text-primary hover:opacity-80 inline-flex items-center gap-1 transition-colors disabled:opacity-50"
            title="重新从 SkillHub 下载完整 SKILL.md 与资源文件"
          >
            {installing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            升级为运行时
          </button>
        )}
        {!skill.builtin && (
          <button
            onClick={onUninstall}
            className="text-destructive/80 hover:text-destructive inline-flex items-center gap-1 transition-colors"
          >
            <Trash2 size={10} /> 卸载
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border/60 space-y-3 text-xs">
          {skill.runtime
            ? <RuntimeSkillDetails skill={skill} onRefresh={onRefresh} />
            : <LegacySkillDetails skill={skill} />}
        </div>
      )}
    </div>
  )
}

/** Expanded-card body for legacy (runtime=0) prompt-only skills — unchanged. */
function LegacySkillDetails({ skill }: { skill: InstalledSkillInfo }) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase text-muted-foreground/60 font-semibold mb-1">系统提示词</div>
        <pre className="whitespace-pre-wrap font-mono text-[11px] bg-muted/30 rounded-md p-2 max-h-40 overflow-y-auto scrollbar-prominent">
          {skill.systemPrompt || '(空)'}
        </pre>
      </div>
      <div>
        <div className="text-[10px] uppercase text-muted-foreground/60 font-semibold mb-1">
          工具白名单 {skill.toolWhitelist === null && <span className="font-normal normal-case text-muted-foreground/50">(不限制)</span>}
        </div>
        {skill.toolWhitelist === null ? (
          <div className="text-muted-foreground/70 italic">允许使用全部工具</div>
        ) : skill.toolWhitelist.length === 0 ? (
          <div className="text-muted-foreground/70 italic">禁用所有工具（纯对话）</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {skill.toolWhitelist.map(t => (
              <span key={t} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted/50">{t}</span>
            ))}
          </div>
        )}
      </div>
      {skill.starterPrompts.length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-muted-foreground/60 font-semibold mb-1">起始模板</div>
          <div className="space-y-1.5">
            {skill.starterPrompts.map((p, i) => (
              <div key={i} className="rounded-md bg-muted/30 p-2">
                <div className="font-medium text-[11px] mb-0.5">{p.label}</div>
                <div className="text-[10px] text-muted-foreground whitespace-pre-wrap line-clamp-3">{p.prompt}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Expanded-card body for runtime (runtime=1) skills: the downloaded SKILL.md
 * body, a per-skill allow-scripts toggle, and a browsable list of bundled
 * resource files (clicking one previews it via readSkillFile).
 */
function RuntimeSkillDetails({ skill, onRefresh }: { skill: InstalledSkillInfo; onRefresh: () => void }) {
  const [resourcesOpen, setResourcesOpen] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  async function openFile(p: string) {
    // Toggle off if the same file is clicked again.
    if (previewPath === p) {
      setPreviewPath(null)
      setPreviewContent('')
      return
    }
    setPreviewPath(p)
    setPreviewContent('')
    setPreviewLoading(true)
    try {
      const res = await window.api.readSkillFile({ id: skill.id, path: p }) as { content?: string; error?: string }
      setPreviewContent(res.error ? `读取失败：${res.error}` : (res.content ?? ''))
    } catch (e) {
      setPreviewContent('读取失败：' + (e as Error).message)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function toggleScripts() {
    await window.api.setSkillAllowScripts({ id: skill.id, allow: !skill.allowScripts })
    onRefresh()
  }

  return (
    <>
      <div>
        <div className="text-[10px] uppercase text-muted-foreground/60 font-semibold mb-1">SKILL.md</div>
        <pre className="whitespace-pre-wrap font-mono text-[11px] bg-muted/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-prominent">
          {skill.skillBody || '(空)'}
        </pre>
      </div>

      <div className="flex items-start gap-2 rounded-md bg-muted/30 p-2">
        <button
          onClick={toggleScripts}
          className={cn(
            'p-0.5 rounded shrink-0 transition-colors',
            skill.allowScripts ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:bg-accent'
          )}
          title={skill.allowScripts ? '点击禁止脚本' : '点击允许脚本'}
        >
          {skill.allowScripts ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[11px]">允许运行脚本</div>
          <div className="text-[10px] text-muted-foreground/70 leading-relaxed">
            允许此技能运行其自带脚本（通过 bash 执行命令）。关闭后模型仍可加载技能说明，但不会执行其脚本。
          </div>
        </div>
      </div>

      {skill.resourceFiles.length > 0 && (
        <div>
          <button
            onClick={() => setResourcesOpen(o => !o)}
            className="inline-flex items-center gap-1 text-[10px] uppercase text-muted-foreground/60 font-semibold mb-1 hover:text-foreground transition-colors"
          >
            {resourcesOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            资源文件 ({skill.resourceFiles.length})
          </button>
          {resourcesOpen && (
            <div className="space-y-1">
              {skill.resourceFiles.map(f => (
                <div key={f}>
                  <button
                    onClick={() => openFile(f)}
                    className={cn(
                      'w-full text-left font-mono text-[10px] px-1.5 py-1 rounded flex items-center gap-1.5 transition-colors',
                      previewPath === f ? 'bg-accent' : 'hover:bg-accent'
                    )}
                  >
                    <FileText size={10} className="shrink-0 text-muted-foreground/60" />
                    <span className="truncate">{f}</span>
                  </button>
                  {previewPath === f && (
                    <pre className="whitespace-pre-wrap font-mono text-[10px] bg-muted/30 rounded-md p-2 mt-1 max-h-48 overflow-y-auto scrollbar-prominent">
                      {previewLoading ? '加载中…' : previewContent}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {skill.installPath && (
        <div className="text-[10px] text-muted-foreground/50 font-mono truncate" title={skill.installPath}>
          安装位置：{skill.installPath}
        </div>
      )}
    </>
  )
}

// ============================================================================
// Browse tab
// ============================================================================

function BrowseTab({
  registries, installedIds, installing, browsing,
  page, pageSize, keyword,
  onPageChange, onKeywordChange, onRefresh, onInstall
}: {
  registries: FetchedRegistryInfo[]
  installedIds: Set<string>
  installing: string | null
  browsing: boolean
  page: number
  pageSize: number
  keyword: string
  onPageChange: (p: number) => void
  onKeywordChange: (kw: string) => void
  onRefresh: () => void
  onInstall: (entry: SkillRegistryEntryInfo, sourceUrl: string) => void
}) {
  const t = useT()
  // Dedupe across registries (same id only shown once, first source wins).
  // Bundled skills no longer appear here — they auto-install as built-ins.
  const merged = useMemo(() => {
    const seen = new Set<string>()
    const out: { entry: SkillRegistryEntryInfo; sourceUrl: string; sourceLabel: string }[] = []
    for (const reg of registries) {
      for (const entry of reg.entries) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        let label = reg.sourceUrl
        try { label = new URL(reg.sourceUrl).hostname } catch { /* keep raw */ }
        out.push({ entry, sourceUrl: reg.sourceUrl, sourceLabel: label })
      }
    }
    return out
  }, [registries])

  // Pagination is driven by the largest reported `total` across paginated
  // sources, plus any flat-source `total`s summed in. For the typical case
  // (one SkillHub source) this just equals SkillHub's reported total.
  const grandTotal = useMemo(() => {
    let t = 0
    for (const r of registries) if (typeof r.total === 'number') t += r.total
    return t
  }, [registries])

  const totalPages = grandTotal > 0 ? Math.max(1, Math.ceil(grandTotal / pageSize)) : 1
  const failedSources = registries.filter(r => r.error)

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold whitespace-nowrap">{t('skills.recommended')}</h2>
        <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap">
          共 {grandTotal.toLocaleString()} 个 · 第 {page} / {totalPages.toLocaleString()} 页
        </span>
        <div className="flex-1" />
        {/* Search input */}
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder={t('skills.searchPlaceholder')}
            className="h-7 pl-6 pr-7 w-52 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          {keyword && (
            <button
              onClick={() => onKeywordChange('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent"
              title="清除"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={browsing}
          className="flex items-center gap-1 h-7 px-2.5 text-xs rounded-md border border-border bg-card hover:bg-accent disabled:opacity-50"
        >
          {browsing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {t('skills.refresh')}
        </button>
      </div>

      {failedSources.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <div>
            {failedSources.length} 个源拉取失败：
            <ul className="mt-1 space-y-0.5">
              {failedSources.map(s => (
                <li key={s.sourceUrl} className="font-mono opacity-80">{s.sourceUrl} — {s.error}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {browsing && merged.length === 0 ? (
        <div className="text-center py-12 text-xs text-muted-foreground">
          <Loader2 size={20} className="animate-spin mx-auto mb-2" />
          正在拉取技能列表…
        </div>
      ) : merged.length === 0 ? (
        <EmptyState
          icon={Globe}
          title={keyword ? `没有找到匹配「${keyword}」的技能` : t('skills.browseEmptyTitle')}
          message={keyword ? '换个关键词试试，或清空搜索框查看全部。' : t('skills.browseEmptyMessage')}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {merged.map(({ entry, sourceUrl, sourceLabel }) => (
              <RegistryCard
                key={entry.id}
                entry={entry}
                sourceLabel={sourceLabel}
                installed={installedIds.has(entry.id)}
                installing={installing === entry.id}
                onInstall={() => onInstall(entry, sourceUrl)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              disabled={browsing}
              onChange={onPageChange}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * Compact pagination control: ‹ 1 … N-1 [N] N+1 … M › plus a jump-to-page
 * input. Window of pages around the current page so it scales to 3000+.
 */
function Pagination({
  page, totalPages, disabled, onChange
}: {
  page: number
  totalPages: number
  disabled: boolean
  onChange: (p: number) => void
}) {
  const [jump, setJump] = useState('')
  const pages = useMemo(() => buildPageWindow(page, totalPages), [page, totalPages])

  function go(p: number) {
    const clamped = Math.min(totalPages, Math.max(1, Math.floor(p)))
    if (clamped !== page) onChange(clamped)
  }

  function submitJump(e: React.FormEvent) {
    e.preventDefault()
    const n = parseInt(jump, 10)
    if (Number.isFinite(n)) go(n)
    setJump('')
  }

  return (
    <div className="flex items-center justify-center gap-1 pt-2 flex-wrap">
      <button
        onClick={() => go(page - 1)}
        disabled={disabled || page <= 1}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-border bg-card hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        title="上一页"
      >
        <ChevronLeft size={13} />
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground/60">…</span>
        ) : (
          <button
            key={p}
            onClick={() => go(p)}
            disabled={disabled || p === page}
            className={cn(
              'h-7 min-w-7 px-2 flex items-center justify-center rounded-md text-xs border',
              p === page
                ? 'bg-primary text-primary-foreground border-primary font-medium cursor-default'
                : 'border-border bg-card hover:bg-accent'
            )}
          >
            {p}
          </button>
        )
      )}
      <button
        onClick={() => go(page + 1)}
        disabled={disabled || page >= totalPages}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-border bg-card hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        title="下一页"
      >
        <ChevronRight size={13} />
      </button>
      <form onSubmit={submitJump} className="flex items-center gap-1 ml-2">
        <span className="text-[11px] text-muted-foreground/70">跳转</span>
        <input
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ''))}
          placeholder={String(page)}
          className="h-7 w-14 px-2 text-xs text-center rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </form>
    </div>
  )
}

/** Build a windowed page list with ellipses. Always shows first + last. */
function buildPageWindow(page: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const result: (number | '...')[] = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(total - 1, page + 1)
  if (start > 2) result.push('...')
  for (let p = start; p <= end; p++) result.push(p)
  if (end < total - 1) result.push('...')
  result.push(total)
  return result
}

function RegistryCard({
  entry, sourceLabel, installed, installing, onInstall
}: {
  entry: SkillRegistryEntryInfo
  sourceLabel: string
  installed: boolean
  installing: boolean
  onInstall: () => void
}) {
  const t = useT()
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col">
      <div className="flex items-start gap-3">
        <SkillIcon icon={entry.icon} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold truncate">{entry.name}</h3>
            {entry.version && <span className="text-[10px] text-muted-foreground/60 font-mono">v{entry.version}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{entry.description}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
        {(entry.suggestedScenarios ?? []).map(scn => {
          const meta = SCENARIO_META[scn]
          const Icon = meta.Icon
          return (
            <span key={scn} className={cn('inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] border border-border/60', meta.color)}>
              <Icon size={9} /> {meta.label}
            </span>
          )
        })}
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground/60 truncate">来自 {sourceLabel}</span>
        {installed ? (
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('skills.installed')}</span>
        ) : (
          <button
            onClick={onInstall}
            disabled={installing}
            className="flex items-center gap-1 h-6 px-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 font-medium"
          >
            {installing ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            {t('skills.install')}
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Sources tab
// ============================================================================

function SourcesTab({
  sources, onAdd, onDelete, onToggle
}: {
  sources: SkillSourceInfo[]
  onAdd: () => void
  onDelete: (s: SkillSourceInfo) => void
  onToggle: (s: SkillSourceInfo) => void
}) {
  const t = useT()
  return (
    <div className="max-w-2xl mx-auto px-6 py-6 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('skills.sourcesTitle')}</h2>
        <span className="text-[11px] text-muted-foreground/60">{sources.length} 个</span>
        <div className="flex-1" />
        <button
          onClick={onAdd}
          className="flex items-center gap-1 h-7 px-2.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90"
        >
          <Plus size={11} /> {t('skills.addSource')}
        </button>
      </div>

      <div className="space-y-2">
        {sources.map(s => (
          <div
            key={s.url}
            className={cn(
              'rounded-lg border bg-card p-3 flex items-start gap-3',
              !s.enabled && 'opacity-60'
            )}
          >
            <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
              <Globe size={14} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{s.name}</span>
                {s.builtin && (
                  <span className="text-[9px] uppercase font-semibold px-1.5 py-px rounded bg-primary/15 text-primary">
                    内置
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">{s.url}</div>
            </div>
            <button
              onClick={() => onToggle(s)}
              className={cn(
                'p-1 rounded-md transition-colors shrink-0',
                s.enabled ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:bg-accent'
              )}
              title={s.enabled ? '禁用此源' : '启用此源'}
            >
              {s.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
            </button>
            {!s.builtin && (
              <button
                onClick={() => onDelete(s)}
                className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                title="删除"
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// 自动学习 tab — auto-induced skills (review / approve / evolve)
// ============================================================================

const AUTO_STATUS_META: Record<'pending' | 'active' | 'deprecated', { label: string; cls: string }> = {
  pending:    { label: '待审核', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  active:     { label: '已采纳', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  deprecated: { label: '已停用', cls: 'bg-muted text-muted-foreground' },
}

const AUTO_PAGE_SIZE = 10
type AutoStatusFilter = 'all' | 'pending' | 'active' | 'deprecated'
type AutoSort = 'recent' | 'loaded' | 'maturity'

const AUTO_FILTERS: { key: AutoStatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审核' },
  { key: 'active', label: '已采纳' },
  { key: 'deprecated', label: '已停用' },
]

function AutoLearnTab({
  list, induction, onToggleInduction, onSetStatus, onUninstall, onBatchStatus, onBatchUninstall
}: {
  list: InstalledSkillInfo[]
  induction: { enabled: boolean; autoEnable: boolean }
  onToggleInduction: (patch: { skillInductionEnabled?: boolean; skillAutoEnable?: boolean }) => void
  onSetStatus: (s: InstalledSkillInfo, status: 'active' | 'pending' | 'deprecated') => void
  onUninstall: (s: InstalledSkillInfo) => void
  onBatchStatus: (ids: string[], status: 'active' | 'pending' | 'deprecated') => Promise<void> | void
  onBatchUninstall: (ids: string[]) => Promise<boolean>
}) {
  const [statusFilter, setStatusFilter] = useState<AutoStatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [applied, setApplied] = useState('')
  const [sort, setSort] = useState<AutoSort>('recent')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)

  // Debounce search; reset to page 1 once it settles.
  useEffect(() => {
    const t = setTimeout(() => { setApplied(keyword.trim().toLowerCase()); setPage(1) }, 200)
    return () => clearTimeout(t)
  }, [keyword])
  useEffect(() => { setPage(1) }, [statusFilter, sort])

  // Per-status counts for the filter chips.
  const counts = useMemo(() => {
    const c: Record<AutoStatusFilter, number> = { all: list.length, pending: 0, active: 0, deprecated: 0 }
    for (const s of list) {
      if (s.status === 'pending' || s.status === 'active' || s.status === 'deprecated') c[s.status]++
    }
    return c
  }, [list])

  const filtered = useMemo(() => {
    let r = list
    if (statusFilter !== 'all') r = r.filter(s => s.status === statusFilter)
    if (applied) r = r.filter(s =>
      s.name.toLowerCase().includes(applied) ||
      s.description.toLowerCase().includes(applied) ||
      (s.skillBody ?? '').toLowerCase().includes(applied))
    return [...r].sort((a, b) => {
      if (sort === 'loaded') return (b.timesLoaded - a.timesLoaded) || (b.installedAt - a.installedAt)
      if (sort === 'maturity') return ((b.confidence ?? 0) - (a.confidence ?? 0)) || (b.installedAt - a.installedAt)
      return b.installedAt - a.installedAt
    })
  }, [list, statusFilter, applied, sort])

  const totalPages = Math.max(1, Math.ceil(filtered.length / AUTO_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * AUTO_PAGE_SIZE, safePage * AUTO_PAGE_SIZE),
    [filtered, safePage]
  )

  // Selection spans the whole filtered set (not just the current page), but is
  // always reconciled against skills that still exist.
  const filteredIds = useMemo(() => filtered.map(s => s.id), [filtered])
  const selectedExisting = useMemo(
    () => [...selected].filter(id => list.some(s => s.id === id)),
    [selected, list]
  )
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selected.has(id))

  function toggleSelect(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleSelectAll() {
    setSelected(prev => {
      const n = new Set(prev)
      if (allFilteredSelected) filteredIds.forEach(id => n.delete(id))
      else filteredIds.forEach(id => n.add(id))
      return n
    })
  }
  const clearSelection = () => setSelected(new Set())

  async function doExport(ids: string[]) {
    if (!ids.length || exporting) return
    setExporting(true)
    try {
      if (ids.length === 1) {
        const r = await window.api.exportSkill(ids[0])
        if (r?.canceled) { if (r.error) toast.error('导出失败：' + r.error); return }
        toast.success('已导出技能到 ' + r.filePath)
      } else {
        const r = await window.api.exportSkills(ids)
        if (r?.canceled) { if (r.error) toast.error('导出失败：' + r.error); return }
        toast.success(`已导出 ${r.count ?? ids.length} 个技能到 ${r.filePath}`)
      }
    } catch (e) {
      toast.error('导出失败：' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  async function batchDeprecate() {
    if (!selectedExisting.length) return
    await onBatchStatus(selectedExisting, 'deprecated')
    clearSelection()
  }
  async function batchDelete() {
    if (await onBatchUninstall(selectedExisting)) clearSelection()
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
      {/* Intro + global controls */}
      <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
            <Wand2 size={16} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">对话自动学习</h2>
            <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
              系统会在后台从你的对话里提炼可复用的做法，沉淀成可被模型按需加载的技能，并随使用不断进化（合并重复 / 停用没用的 / 失败时自我改进）。
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <ToggleRow
            on={induction.enabled}
            onClick={() => onToggleInduction({ skillInductionEnabled: !induction.enabled })}
            title="开启对话自动学习"
            desc="关闭后不再从对话提炼新技能（已有技能仍可用）。"
          />
          <ToggleRow
            on={induction.autoEnable}
            disabled={!induction.enabled}
            onClick={() => onToggleInduction({ skillAutoEnable: !induction.autoEnable })}
            title="激进模式：自动启用"
            desc="提炼出的技能通过校验即自动生效；关闭则进入「待审核」，需你手动采纳。"
          />
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Wand2}
          title="还没有自动学到的技能"
          message="多用对话；当出现可复用的多步做法时，系统会在这里沉淀成技能。也可以在任意对话里点「把这次对话变成技能」。"
        />
      ) : (
        <>
          {/* Toolbar: status chips · search · sort · export */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {AUTO_FILTERS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className={cn(
                    'h-7 px-2.5 rounded-md text-xs border transition-colors',
                    statusFilter === key
                      ? 'bg-primary text-primary-foreground border-primary font-medium'
                      : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  {label} <span className={cn('tabular-nums', statusFilter === key ? 'opacity-90' : 'opacity-60')}>{counts[key]}</span>
                </button>
              ))}
              <div className="flex-1" />
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索技能名 / 描述 / 内容"
                  className="h-7 pl-6 pr-7 w-52 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                {keyword && (
                  <button
                    onClick={() => setKeyword('')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent"
                    title="清除"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
              <Select
                size="sm"
                value={sort}
                onChange={(v) => setSort(v as AutoSort)}
                title="排序"
                options={[
                  { value: 'recent', label: '最近学到', icon: <ArrowDownUp size={12} /> },
                  { value: 'loaded', label: '最常加载', icon: <TrendingUp size={12} /> },
                  { value: 'maturity', label: '成熟度', icon: <CheckCircle2 size={12} /> },
                ]}
              />
              <button
                onClick={() => doExport(filteredIds)}
                disabled={exporting || filteredIds.length === 0}
                title="把当前筛选出的全部技能打包成一个合集 .zip（每个技能一个子目录，用于备份/分享；解压后可逐个导入）"
                className="flex items-center gap-1 h-7 px-2.5 text-xs rounded-md border border-border bg-card hover:bg-accent text-foreground transition-colors disabled:opacity-50 shrink-0"
              >
                {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                导出{statusFilter === 'all' && !applied ? '全部' : '筛选'}
              </button>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
              <button onClick={toggleSelectAll} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                {allFilteredSelected ? <CheckSquare size={13} className="text-primary" /> : <Square size={13} />}
                全选当前结果
              </button>
              <span>
                共 {filtered.length} 个{filtered.length !== list.length && ` · 全部 ${list.length}`}
              </span>
            </div>
          </div>

          {/* Batch action bar — appears when ≥1 selected */}
          {selectedExisting.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.08] backdrop-blur-sm px-3 py-2 text-xs">
              <span className="font-medium text-primary">已选 {selectedExisting.length} 个</span>
              <div className="flex-1" />
              <button
                onClick={() => doExport(selectedExisting)}
                disabled={exporting}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 font-medium"
              >
                {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} 导出所选
              </button>
              <button onClick={batchDeprecate} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                <Ban size={12} /> 停用
              </button>
              <button onClick={batchDelete} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-destructive/10 text-destructive/80 hover:text-destructive transition-colors">
                <Trash2 size={12} /> 删除
              </button>
              <button onClick={clearSelection} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-accent text-muted-foreground transition-colors">
                取消
              </button>
            </div>
          )}

          {pageItems.length === 0 ? (
            <EmptyState
              icon={Search}
              title="没有匹配的技能"
              message="换个关键词或筛选条件试试。"
            />
          ) : (
            <div className="space-y-3">
              {pageItems.map(s => (
                <AutoSkillCard
                  key={s.id}
                  skill={s}
                  selected={selected.has(s.id)}
                  onToggleSelect={() => toggleSelect(s.id)}
                  onExport={() => doExport([s.id])}
                  onSetStatus={(status) => onSetStatus(s, status)}
                  onUninstall={() => onUninstall(s)}
                />
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <Pagination page={safePage} totalPages={totalPages} disabled={false} onChange={setPage} />
          )}
        </>
      )}
    </div>
  )
}

function ToggleRow({ on, onClick, title, desc, disabled }: {
  on: boolean; onClick: () => void; title: string; desc: string; disabled?: boolean
}) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg bg-card/60 border border-border/60 p-2.5', disabled && 'opacity-50')}>
      <button onClick={onClick} disabled={disabled} className="p-0.5 rounded shrink-0 text-primary disabled:cursor-not-allowed">
        {on ? <ToggleRight size={22} className="text-primary" /> : <ToggleLeft size={22} className="text-muted-foreground" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[10px] text-muted-foreground/80 leading-relaxed">{desc}</div>
      </div>
    </div>
  )
}

function AutoSkillCard({ skill, selected, onToggleSelect, onExport, onSetStatus, onUninstall }: {
  skill: InstalledSkillInfo
  selected: boolean
  onToggleSelect: () => void
  onExport: () => void
  onSetStatus: (status: 'active' | 'pending' | 'deprecated') => void
  onUninstall: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const meta = AUTO_STATUS_META[skill.status] ?? AUTO_STATUS_META.active
  const total = skill.timesSucceeded + skill.timesFailed
  const conf = skill.confidence != null ? Math.round(skill.confidence * 100) : null
  return (
    <div className={cn(
      'rounded-xl border bg-card p-4 transition-all',
      skill.status === 'deprecated' && 'opacity-60',
      selected && 'border-primary/50 bg-primary/[0.03] ring-1 ring-primary/20'
    )}>
      <div className="flex items-start gap-3">
        <button
          onClick={onToggleSelect}
          className="mt-0.5 p-0.5 rounded shrink-0 text-muted-foreground/70 hover:text-primary transition-colors"
          title={selected ? '取消选择' : '选择'}
        >
          {selected ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} />}
        </button>
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-lg">✨</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">{skill.name}</h3>
            <span className={cn('text-[10px] px-1.5 py-px rounded font-medium', meta.cls)}>{meta.label}</span>
            <span className="text-[10px] text-muted-foreground/60 font-mono">v{skill.inducedVersion}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{skill.description}</p>
          {/* Trust stats */}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-1"><TrendingUp size={10} /> 加载 {skill.timesLoaded}</span>
            {total > 0 && <span>成功 {skill.timesSucceeded} / 失败 {skill.timesFailed}</span>}
            {conf != null && total > 0 && <span>成熟度 {conf}%</span>}
          </div>
        </div>
      </div>

      {/* Actions by status */}
      <div className="mt-3 flex items-center gap-2 text-[11px] flex-wrap">
        <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground hover:text-foreground transition-colors">
          {expanded ? '收起内容' : '查看内容'}
        </button>
        <div className="flex-1" />
        {skill.status === 'pending' && (
          <button onClick={() => onSetStatus('active')} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 font-medium">
            <CheckCircle2 size={12} /> 采纳启用
          </button>
        )}
        {skill.status === 'active' && (
          <button onClick={() => onSetStatus('deprecated')} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors">
            <Ban size={11} /> 停用
          </button>
        )}
        {skill.status === 'deprecated' && (
          <button onClick={() => onSetStatus('active')} className="inline-flex items-center gap-1 text-primary hover:opacity-80 transition-colors">
            <RotateCcw size={11} /> 恢复启用
          </button>
        )}
        <button onClick={onExport} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors" title="导出为 .zip 技能包（可再导入）">
          <Download size={11} /> 导出
        </button>
        <button onClick={onUninstall} className="inline-flex items-center gap-1 text-destructive/80 hover:text-destructive transition-colors">
          <Trash2 size={11} /> 删除
        </button>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border/60 space-y-2 text-xs">
          <pre className="whitespace-pre-wrap font-mono text-[11px] bg-muted/30 rounded-md p-2 max-h-60 overflow-y-auto scrollbar-prominent">
            {skill.skillBody || '(空)'}
          </pre>
          {skill.triggerReason && (
            <div className="text-[10px] text-muted-foreground/50 font-mono truncate" title={skill.triggerReason}>
              来源：{skill.inducedFrom || '—'} · 触发：{skill.triggerReason}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Empty state — shared
// ============================================================================

function EmptyState({ icon: Icon, title, message }: {
  icon: typeof Sparkles
  title: string
  message: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="w-14 h-14 rounded-2xl bg-muted/30 flex items-center justify-center mb-3">
        <Icon size={22} className="text-muted-foreground/60" />
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-xs">{message}</p>
    </div>
  )
}
