import { useEffect, useState } from 'react'
import { Loader2, Power, MousePointerClick, AlertTriangle, Home, Check, Globe, PanelLeft, Network } from 'lucide-react'
import type { AppSettings, ProviderConfig, ProxyMode } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { Select } from '../../components/ui/Select'
import { useUIStore, type Skin } from '../../stores/ui'
import { GlobalSettings } from './GlobalSettings'
import { AutoModelTab } from './AutoModelTab'

interface SystemState {
  autoLaunch: boolean
  shellIntegration: boolean
  shellIntegrationSupported: boolean
  storedAutoLaunch: boolean
  storedShellIntegration: boolean
}

type SubTab = 'system' | 'defaults' | 'auto-model' | 'build' | 'skin' | 'browser'

interface Props {
  settings: AppSettings | null
  providers: ProviderConfig[]
  onSave: (s: AppSettings) => void | Promise<void>
  onProvidersRefresh?: () => Promise<void> | void
}

/**
 * 全局 — combined "global configuration" tab. Acts as a parent for four
 * related sub-sections that all affect app-wide behavior:
 *
 *   - 系统         OS-level toggles (auto-launch, Explorer right-click menu)
 *   - 模型         Default provider/model per task type
 *   - 自动切换模型  Intent-routed model overrides
 *   - 构建         Vibe (build) page defaults
 *
 * The four were separate top-level Settings tabs in v0.2.7 and earlier; we
 * folded them under one umbrella to shrink the left rail and group "things
 * that change app behavior globally" together.
 */
export function SystemTab({ settings, providers, onSave, onProvidersRefresh }: Props): JSX.Element {
  const [subTab, setSubTab] = useState<SubTab>('system')

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b border-border pb-2 -mx-2 px-2 overflow-x-auto">
        <SubTabPill active={subTab === 'system'} onClick={() => setSubTab('system')}>系统</SubTabPill>
        <SubTabPill active={subTab === 'defaults'} onClick={() => setSubTab('defaults')}>模型</SubTabPill>
        <SubTabPill active={subTab === 'auto-model'} onClick={() => setSubTab('auto-model')}>自动切换模型</SubTabPill>
        <SubTabPill active={subTab === 'build'} onClick={() => setSubTab('build')}>构建</SubTabPill>
        <SubTabPill active={subTab === 'browser'} onClick={() => setSubTab('browser')}>浏览器</SubTabPill>
        <SubTabPill active={subTab === 'skin'} onClick={() => setSubTab('skin')}>皮肤</SubTabPill>
      </div>

      {subTab === 'system' && <SystemSection settings={settings} onSave={onSave} />}
      {subTab === 'browser' && <BrowserSection settings={settings} onSave={onSave} />}
      {subTab === 'skin' && <SkinSection />}
      {subTab === 'defaults' && settings && (
        <GlobalSettings
          tab="defaults"
          settings={settings}
          providers={providers}
          onSave={onSave}
          onProvidersRefresh={onProvidersRefresh}
        />
      )}
      {subTab === 'auto-model' && settings && (
        <AutoModelTab settings={settings} providers={providers} onSave={onSave} />
      )}
      {subTab === 'build' && settings && (
        <GlobalSettings
          tab="build"
          settings={settings}
          providers={providers}
          onSave={onSave}
          onProvidersRefresh={onProvidersRefresh}
        />
      )}
    </div>
  )
}

function SubTabPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap',
        active ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function SystemSection({
  settings, onSave
}: {
  settings: AppSettings | null
  onSave: (s: AppSettings) => void | Promise<void>
}): JSX.Element {
  const [state, setState] = useState<SystemState | null>(null)
  const [pending, setPending] = useState<'autoLaunch' | 'shell' | null>(null)
  // Sidebar expand/collapse is a pure client-side preference (zustand +
  // localStorage), so it updates the live sidebar instantly with no IPC.
  const sidebarExpanded = useUIStore(s => s.sidebarExpanded)
  const setSidebarExpanded = useUIStore(s => s.setSidebarExpanded)

  async function updateStartupPage(next: 'chat' | 'vibe') {
    if (!settings) return
    try {
      await onSave({ ...settings, startupPage: next })
      toast.success(next === 'chat' ? '下次启动将进入对话页' : '下次启动将进入构建页')
    } catch (e) {
      toast.error('保存失败：' + ((e as Error)?.message ?? '未知错误'))
    }
  }

  useEffect(() => { reload() }, [])

  async function reload() {
    try {
      const s = await window.api.getSystemState?.()
      if (s) setState(s as SystemState)
    } catch (e) {
      console.warn('[SystemTab] getSystemState failed:', (e as Error).message)
    }
  }

  async function toggleAutoLaunch(next: boolean) {
    setPending('autoLaunch')
    try {
      const result = await window.api.setAutoLaunch?.(next)
      if (result?.ok) {
        toast.success(next ? '已开启开机自启' : '已关闭开机自启')
        await reload()
      } else {
        toast.error('设置失败：' + (result?.error ?? '未知错误'))
      }
    } finally {
      setPending(null)
    }
  }

  async function toggleShellIntegration(next: boolean) {
    setPending('shell')
    try {
      const result = await window.api.setShellIntegration?.(next)
      if (result?.ok) {
        toast.success(next ? '已开启右键菜单' : '已关闭右键菜单')
        await reload()
      } else {
        toast.error('设置失败：' + (result?.error ?? '未知错误'))
      }
    } finally {
      setPending(null)
    }
  }

  if (!state) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> 正在读取系统状态…
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">全局配置</h2>
        <p className="text-xs text-muted-foreground mt-1">
          这里的开关会直接修改操作系统层面的设置（启动项 / 资源管理器右键菜单），不会同步到云端。
        </p>
      </div>

      {/* 首页 -------------------------------------------------------------- */}
      <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card">
        <div className="shrink-0 mt-0.5">
          <Home size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">首页</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            选择 SuperStudio 启动后默认进入的页面。通过右键「用 SuperStudio 打开」启动时不受此设置影响。
          </p>
        </div>
        <div className="shrink-0">
          <Select<'chat' | 'vibe'>
            value={settings?.startupPage ?? 'chat'}
            onChange={updateStartupPage}
            options={[
              { value: 'chat', label: '对话' },
              { value: 'vibe', label: '构建' }
            ]}
            size="md"
            disabled={!settings}
          />
        </div>
      </div>

      {/* 左侧菜单 ---------------------------------------------------------- */}
      <SimpleToggleRow
        icon={<PanelLeft size={16} className="text-primary" />}
        title="展开左侧菜单"
        description="开启后左侧导航栏显示文字标签；关闭则只显示图标，更紧凑。也可随时点击侧栏顶部按钮切换。默认展开。"
        checked={sidebarExpanded}
        pending={false}
        onChange={setSidebarExpanded}
      />

      {/* 开机自启 ---------------------------------------------------------- */}
      <ToggleRow
        icon={<Power size={16} className="text-primary" />}
        title="开机自启"
        description="在操作系统启动时自动打开 SuperStudio。如果你后续把 .exe 移到了别的位置，请重新切换此开关让路径生效。"
        checked={state.storedAutoLaunch}
        actualState={state.autoLaunch}
        pending={pending === 'autoLaunch'}
        onChange={toggleAutoLaunch}
      />

      {/* 右键菜单 ---------------------------------------------------------- */}
      <ToggleRow
        icon={<MousePointerClick size={16} className="text-primary" />}
        title="菜单右键打开文件、文件夹"
        description={
          state.shellIntegrationSupported
            ? '在 Windows 资源管理器中右键点击文件或文件夹时显示「用 SuperStudio 打开」。文件会作为编辑器标签页打开；文件夹会作为构建项目打开。'
            : '当前操作系统暂不支持此功能（仅 Windows 可用）。'
        }
        checked={state.storedShellIntegration}
        actualState={state.shellIntegration}
        pending={pending === 'shell'}
        disabled={!state.shellIntegrationSupported}
        onChange={toggleShellIntegration}
      />

      {/* 网络代理 ---------------------------------------------------------- */}
      <ProxySection settings={settings} onSave={onSave} />

      {/* Out-of-sync warning — only shows when stored intent ≠ actual OS state */}
      {(state.storedAutoLaunch !== state.autoLaunch ||
        (state.shellIntegrationSupported && state.storedShellIntegration !== state.shellIntegration)) && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs">
          <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 leading-relaxed">
            检测到记录的偏好与系统实际状态不一致。这通常发生在你卸载/重装、或把程序移到其他目录之后。
            点击对应开关重新应用即可恢复同步。
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 网络代理 —— global proxy switch. Affects EVERY outbound request from the
   main process (LLM streaming, image/video generation, web_search, web_open
   BrowserWindow, updater, skills registry, MCP downloads). Wired to
   electron/main/services/proxy.ts which sets both session.setProxy AND
   undici.setGlobalDispatcher. */

function ProxySection({
  settings, onSave
}: {
  settings: AppSettings | null
  onSave: (s: AppSettings) => void | Promise<void>
}): JSX.Element {
  const mode: ProxyMode = settings?.proxyMode ?? 'off'
  // Local input state so typing doesn't fire a setProxy per keystroke; we
  // commit on blur. Re-sync if settings reload externally (e.g. config import).
  const [host, setHost] = useState(settings?.proxyHost ?? '')
  const [port, setPort] = useState(settings?.proxyPort ? String(settings.proxyPort) : '')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setHost(settings?.proxyHost ?? '')
    setPort(settings?.proxyPort ? String(settings.proxyPort) : '')
  }, [settings?.proxyHost, settings?.proxyPort])

  async function patch(partial: Partial<AppSettings>, okMsg: string) {
    if (!settings) return
    setPending(true)
    try {
      await onSave({ ...settings, ...partial })
      toast.success(okMsg)
    } catch (e) {
      toast.error('保存失败：' + ((e as Error)?.message ?? '未知错误'))
    } finally {
      setPending(false)
    }
  }

  async function changeMode(next: ProxyMode) {
    if (next === mode) return
    const msg = next === 'off' ? '已关闭代理' : next === 'system' ? '已切换为跟随系统代理' : '已切换为自定义代理'
    await patch({ proxyMode: next }, msg)
  }

  async function commitCustom() {
    if (mode !== 'custom') return
    const portNum = Number(port)
    if (host.trim() && port && (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535)) {
      toast.error('端口必须在 1-65535 之间')
      return
    }
    const nextHost = host.trim()
    const nextPort = portNum > 0 ? portNum : 0
    // Skip save if nothing actually changed — avoids redundant proxy re-apply.
    if (nextHost === (settings?.proxyHost ?? '') && nextPort === (settings?.proxyPort ?? 0)) return
    await patch({ proxyHost: nextHost, proxyPort: nextPort }, '代理地址已保存')
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-card space-y-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <Network size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">网络代理</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            统一控制所有出站请求（LLM 对话、图片/视频生成、网络搜索、网页浏览、检查更新等）走何种代理。修改即时生效，无需重启。
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-0.5 rounded-md bg-muted/40 border border-border p-0.5">
          <ModePill active={mode === 'off'} onClick={() => changeMode('off')} disabled={pending}>关闭</ModePill>
          <ModePill active={mode === 'system'} onClick={() => changeMode('system')} disabled={pending}>跟随系统</ModePill>
          <ModePill active={mode === 'custom'} onClick={() => changeMode('custom')} disabled={pending}>自定义</ModePill>
        </div>
      </div>

      {mode === 'custom' && (
        <div className="space-y-2 pt-3 border-t border-border/50">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground w-10 shrink-0">主机</label>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              onBlur={commitCustom}
              placeholder="127.0.0.1"
              disabled={pending}
              className="flex-1 h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <label className="text-xs text-muted-foreground w-8 shrink-0 ml-2">端口</label>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              onBlur={commitCustom}
              placeholder="7890"
              min={1}
              max={65535}
              disabled={pending}
              className="w-24 h-8 px-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            仅支持裸 HTTP 代理（http://host:port），不支持账号密码鉴权和 SOCKS5。如需鉴权或 SOCKS，请切到「跟随系统」由操作系统的代理工具承担。
          </p>
        </div>
      )}

      {mode === 'system' && (
        <div className="pt-3 border-t border-border/50">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            浏览器窗口与抓取请求跟随操作系统的代理设置；LLM/图片等通过 Node 原生 fetch 的请求按 <code className="font-mono text-[10px] px-1 rounded bg-muted">HTTPS_PROXY</code> / <code className="font-mono text-[10px] px-1 rounded bg-muted">HTTP_PROXY</code> 环境变量走代理。Windows 上若系统已设置代理但未配置环境变量，请改用「自定义」模式填写代理地址。
          </p>
        </div>
      )}
    </div>
  )
}

function ModePill({
  active, onClick, disabled, children
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2.5 h-6 rounded text-xs transition-colors whitespace-nowrap',
        active ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
        disabled && 'opacity-60 cursor-not-allowed'
      )}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 浏览器 —— config for the headless Chromium window that scrapes search
   engines (Bing/Baidu/Sogou/DDG) for the builtin web_search tool. Right now
   it only exposes a visibility toggle; future browser-open features will
   land here too. */

function BrowserSection({
  settings, onSave
}: {
  settings: AppSettings | null
  onSave: (s: AppSettings) => void | Promise<void>
}): JSX.Element {
  const [pending, setPending] = useState(false)

  async function patch(partial: Partial<AppSettings>, okMsg: string) {
    if (!settings) return
    setPending(true)
    try {
      await onSave({ ...settings, ...partial })
      toast.success(okMsg)
    } catch (e) {
      toast.error('保存失败：' + ((e as Error)?.message ?? '未知错误'))
    } finally {
      setPending(false)
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> 加载中…
      </div>
    )
  }

  const visible = settings.searchBrowserVisible ?? false
  // The picker offers the three browser-scraped engines the user asked for.
  // If searchProvider is currently a hosted API (set in 网络搜索), fall back to
  // 'bing' for display so the control always shows a valid selection.
  const engineValue = (['bing', 'baidu', 'google'] as const).includes(
    settings.searchProvider as 'bing' | 'baidu' | 'google'
  ) ? (settings.searchProvider as 'bing' | 'baidu' | 'google') : 'bing'

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">浏览器</h2>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          内置「网络搜索」会启动一个 Chromium 窗口去搜索引擎抓取结果（无需 API Key）。
          默认隐藏，仅在后台运行；如果搜索老是返回空，可以打开它观察是否被引擎拦截或弹了验证码。
        </p>
      </div>

      {/* 搜索引擎 ---------------------------------------------------------- */}
      <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card">
        <div className="shrink-0 mt-0.5">
          <Globe size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">搜索引擎</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            选择抓取用的搜索引擎。谷歌可能弹验证码——若搜索返回空，打开下方开关观察并手动通过验证。所选引擎失败时会自动按内置顺序兜底其他引擎。
          </p>
        </div>
        <div className="shrink-0">
          <Select<'bing' | 'baidu' | 'google'>
            value={engineValue}
            onChange={v => patch({ searchProvider: v }, `搜索引擎已切换到 ${v === 'google' ? '谷歌' : v === 'baidu' ? '百度' : 'Bing'}`)}
            options={[
              { value: 'bing', label: 'Bing' },
              { value: 'baidu', label: '百度' },
              { value: 'google', label: '谷歌' }
            ]}
            size="md"
            disabled={pending}
          />
        </div>
      </div>

      <SimpleToggleRow
        icon={<Globe size={16} className="text-primary" />}
        title="显示搜索抓取窗口"
        description="开启后，每次搜索会弹出抓取用的浏览器窗口，便于调试或手动通过验证码。默认隐藏在后台。修改即时生效。"
        checked={visible}
        pending={pending}
        onChange={next => patch({ searchBrowserVisible: next }, next ? '搜索时将显示抓取窗口' : '抓取窗口已隐藏')}
      />
    </div>
  )
}

/** A plain on/off switch row — no OS-drift detection, unlike ToggleRow. */
function SimpleToggleRow({
  icon, title, description, checked, pending, onChange
}: {
  icon: React.ReactNode
  title: string
  description: string
  checked: boolean
  pending: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card">
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={pending}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors mt-1',
          'focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
          pending && 'cursor-not-allowed opacity-60'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-4'
          )}
        />
        {pending && (
          <Loader2 size={10} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-white" />
        )}
      </button>
    </div>
  )
}

function ToggleRow({
  icon, title, description, checked, actualState, pending, disabled, onChange
}: {
  icon: React.ReactNode
  title: string
  description: string
  checked: boolean
  /** Actual OS-reported state — shown as a small label when it disagrees with stored intent. */
  actualState: boolean
  pending: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  const drifted = checked !== actualState
  return (
    <div className={cn(
      'flex items-start gap-3 p-4 rounded-lg border border-border bg-card',
      disabled && 'opacity-60'
    )}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {drifted && !disabled && (
            <span className="text-[10px] px-1.5 py-px rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
              系统实际: {actualState ? '已开启' : '已关闭'}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled || pending}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors mt-1',
          'focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
          (disabled || pending) && 'cursor-not-allowed opacity-60'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-4'
          )}
        />
        {pending && (
          <Loader2 size={10} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-white" />
        )}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 皮肤 —— 4 sets of CSS-variable palettes. Each card paints itself with
   the target skin's hard-coded swatch so the user sees what they're picking
   without applying it first. Selecting a card calls setSkin which mutates
   the <html> class via App.tsx's useLayoutEffect — fully client-side, no
   electron-store round-trip needed. */

interface SkinOption {
  id: Skin
  label: string
  description: string
  swatches: { bg: string; surface: string; primary: string; accent: string }
  base: 'light' | 'dark'
}

const SKIN_OPTIONS: SkinOption[] = [
  {
    id: 'classic',
    label: '经典',
    description: '默认浅色 — 靛蓝主调，柔和米白底，对长时间阅读友好。',
    swatches: { bg: 'hsl(220 20% 98%)', surface: 'hsl(220 16% 97%)', primary: 'hsl(243 75% 59%)', accent: 'hsl(220 14% 93%)' },
    base: 'light'
  },
  {
    id: 'warm',
    label: '米黄',
    description: '暖色系 — 米黄牛皮纸底，赤陶主调，像纸笔阅读的氛围。',
    swatches: { bg: 'hsl(40 40% 96%)', surface: 'hsl(40 45% 93%)', primary: 'hsl(22 75% 48%)', accent: 'hsl(38 35% 88%)' },
    base: 'light'
  },
  {
    id: 'cold',
    label: '极地蓝',
    description: '深色系 — 海军底色 + 冰蓝主调，冷静专注，夜间长时使用更轻松。',
    swatches: { bg: 'hsl(222 35% 8%)', surface: 'hsl(222 38% 6%)', primary: 'hsl(198 90% 60%)', accent: 'hsl(215 28% 21%)' },
    base: 'dark'
  },
  {
    id: 'twilight',
    label: '暮光紫',
    description: '深色系 — 梅紫底色 + 紫罗兰主调，柔和不刺眼，氛围感更强。',
    swatches: { bg: 'hsl(270 25% 10%)', surface: 'hsl(270 28% 8%)', primary: 'hsl(280 80% 68%)', accent: 'hsl(270 18% 22%)' },
    base: 'dark'
  },
  {
    id: 'terminal',
    label: '终端',
    description: '深色系 — 近黑炭底 + 磷光绿主调，仿 SSH 终端，专为深夜长时控制台操作而生。',
    swatches: { bg: 'hsl(150 10% 6%)', surface: 'hsl(150 12% 4%)', primary: 'hsl(142 70% 50%)', accent: 'hsl(152 9% 19%)' },
    base: 'dark'
  }
]

function SkinSection(): JSX.Element {
  const skin = useUIStore(u => u.skin)
  const setSkin = useUIStore(u => u.setSkin)

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">皮肤</h2>
        <p className="text-xs text-muted-foreground mt-1">
          切换整套配色（含侧栏、卡片、主色、边框等）。选择会即时生效，并自动同步亮/暗变体到代码编辑器与终端。
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SKIN_OPTIONS.map(opt => (
          <SkinCard
            key={opt.id}
            option={opt}
            active={skin === opt.id}
            onPick={() => {
              setSkin(opt.id)
              toast.success(`已切换到「${opt.label}」皮肤`)
            }}
          />
        ))}
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed">
        提示：侧栏的「切换主题」按钮在浅色与深色之间快速切换（默认 经典 ↔ 暮光紫）。
        想固定某一套配色，请直接在这里选。
      </p>
    </div>
  )
}

function SkinCard({ option, active, onPick }: { option: SkinOption; active: boolean; onPick: () => void }) {
  const { swatches, label, description, base } = option
  // Preview card paints itself with the target palette so the user gets a
  // truthful preview of the bg / surface / primary / accent triad regardless
  // of which skin is currently active.
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'group text-left rounded-xl border p-3 transition-all',
        'hover:shadow-md',
        active ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/40'
      )}
    >
      <div
        className="rounded-lg overflow-hidden border border-black/5 dark:border-white/5 mb-3"
        style={{ background: swatches.bg }}
      >
        <div className="flex">
          <div className="w-12 py-3 flex flex-col items-center gap-1.5" style={{ background: swatches.surface }}>
            <span className="w-5 h-5 rounded-md" style={{ background: swatches.primary }} />
            <span className="w-5 h-1 rounded-full" style={{ background: swatches.accent }} />
            <span className="w-5 h-1 rounded-full" style={{ background: swatches.accent }} />
          </div>
          <div className="flex-1 p-3 space-y-2">
            <div className="h-1.5 rounded-full w-2/3" style={{ background: swatches.primary, opacity: 0.85 }} />
            <div className="h-1.5 rounded-full w-full" style={{ background: swatches.accent }} />
            <div className="h-1.5 rounded-full w-5/6" style={{ background: swatches.accent }} />
          </div>
        </div>
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{label}</h3>
            <span className="text-[10px] px-1.5 py-px rounded bg-muted text-muted-foreground border border-border">
              {base === 'dark' ? '深色' : '浅色'}
            </span>
            {active && (
              <span className="text-[10px] px-1.5 py-px rounded bg-primary/15 text-primary border border-primary/30 flex items-center gap-1">
                <Check size={10} /> 当前
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  )
}
