import { useEffect, useState } from 'react'
import { Loader2, Power, MousePointerClick, AlertTriangle } from 'lucide-react'
import type { AppSettings, ProviderConfig } from '../../../../shared/ipc-types'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { GlobalSettings } from './GlobalSettings'
import { AutoModelTab } from './AutoModelTab'

interface SystemState {
  autoLaunch: boolean
  shellIntegration: boolean
  shellIntegrationSupported: boolean
  storedAutoLaunch: boolean
  storedShellIntegration: boolean
}

type SubTab = 'system' | 'defaults' | 'auto-model' | 'build'

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
      </div>

      {subTab === 'system' && <SystemSection />}
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

function SystemSection(): JSX.Element {
  const [state, setState] = useState<SystemState | null>(null)
  const [pending, setPending] = useState<'autoLaunch' | 'shell' | null>(null)

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
