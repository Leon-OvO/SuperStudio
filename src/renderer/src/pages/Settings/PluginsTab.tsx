import { useState, type ReactNode } from 'react'
import { Monitor, Terminal, ToggleLeft, ToggleRight, ChevronDown, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AppSettings } from '../../../../shared/ipc-types'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void | Promise<void>
}

/**
 * 插件 (Plugins) settings tab — enable/disable extension capabilities. Laid out
 * as a compact 2-column grid so it scales as more plugins are added: each card
 * shows just icon + name + one-line desc + toggle; click a card to expand its
 * details and per-plugin sub-options. A plugin that is OFF here is hidden
 * everywhere it would otherwise be offered (e.g. the 电脑操控 toggle in chat
 * input and the scheduled-task form only appear when Computer Use is enabled).
 */
export function PluginsTab({ settings, onSave }: Props) {
  const computerOn = settings.computerUseEnabled === true
  const scriptsOn = settings.localScriptsEnabled !== false

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">插件</h2>
        <p className="text-sm text-muted-foreground mt-1">
          在这里启用或停用扩展能力。只有在此启用的插件，才会出现在对话框、定时任务等处。点卡片可展开详情与设置。
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
        <PluginCard
          icon={Monitor}
          name="电脑操控"
          desc="让 AI 看屏幕、操作鼠标键盘完成任务。"
          enabled={computerOn}
          danger
          onToggle={() => onSave({ ...settings, computerUseEnabled: !computerOn })}
        >
          <p className="text-xs text-foreground/70 leading-relaxed">
            ⚠️ 高危能力：开启后，AI 可截屏并点击、输入到本机<b>任意程序</b>。
            手动对话时每次开始操控会弹窗请你确认；定时任务为无人值守，到点会自动开始。
            操作期间屏幕顶部有红色提示，按 <b>Esc</b> 可随时立即急停。
            仅在你清楚自己在做什么时开启；不信任的任务请勿使用。
            <br />需选 <b>Claude（带视觉）模型</b>才能生效。
          </p>
          {computerOn && (
            <SubToggle
              label="隐私黑幕（伪锁屏）"
              checked={settings.computerUsePrivacyCurtain === true}
              onChange={v => onSave({ ...settings, computerUsePrivacyCurtain: v })}
            >
              运行电脑操控时，用覆盖所有显示器的<b>全屏黑幕</b>遮住屏幕，旁人看不到 AI 在做什么；
              屏幕只是被遮挡、<b>并未真正锁定</b>，所以 AI 仍能正常截屏与操作（黑幕对截屏隐身、对人可见）。
              任务结束或按 <b>Esc</b> 后黑幕自动消失。
              <br />注意：这不是系统级锁屏，<b>也不会阻止旁人用鼠标键盘干预</b>；适合你离开座位时使用。
              真正的系统锁屏（Win+L）下电脑操控无法工作。
            </SubToggle>
          )}
        </PluginCard>

        <PluginCard
          icon={Terminal}
          name="本地脚本执行"
          desc="让 AI 在本机运行命令 / 脚本（python、bat、sh、node）。"
          enabled={scriptsOn}
          onToggle={() => onSave({ ...settings, localScriptsEnabled: !scriptsOn })}
        >
          <p className="text-xs text-foreground/70 leading-relaxed">
            开启后 AI 可在你的电脑上真实执行命令（处理数据、查大表、跑脚本等）。
            <b>默认无需逐条确认</b>，直接执行以保证流畅；危险 / 不可逆操作 AI 会在回复里先说明。
            如需更谨慎，可勾选下方「每条新命令前确认」。
          </p>
          {scriptsOn && (
            <SubToggle
              label="每条新命令前确认"
              checked={settings.localScriptsConfirmEachRun === true}
              onChange={v => onSave({ ...settings, localScriptsConfirmEachRun: v })}
            >
              勾选后，每条<b>新命令</b>执行前弹窗请你确认（相同命令在本次运行内不再重复询问）。默认关闭。
            </SubToggle>
          )}
        </PluginCard>
      </div>
    </div>
  )
}

/** Compact plugin card: top row always visible; click to expand details. */
function PluginCard({
  icon: Icon, name, desc, enabled, danger, onToggle, children
}: {
  icon: LucideIcon
  name: string
  desc: string
  enabled: boolean
  danger?: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'rounded-xl border bg-card transition-all',
        enabled && danger ? 'border-red-500/40 bg-red-500/[0.04]' : 'border-border'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-3 text-left"
        title={open ? '收起' : '展开详情'}
      >
        <div className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          enabled && danger ? 'bg-red-500/10 text-red-600' : 'bg-muted text-muted-foreground'
        )}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={cn('text-sm font-semibold truncate', enabled && danger && 'text-red-600')}>{name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{desc}</p>
        </div>
        <span
          role="switch"
          aria-checked={enabled}
          onClick={e => { e.stopPropagation(); onToggle() }}
          className={cn(
            'p-1 rounded-md transition-colors shrink-0 cursor-pointer',
            enabled ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:bg-accent'
          )}
          title={enabled ? '点击停用' : '点击启用'}
        >
          {enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
        </span>
        <ChevronDown
          size={16}
          className={cn('text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && children && (
        <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border/60 mt-0">
          <div className="pt-3 space-y-3">{children}</div>
        </div>
      )}
    </div>
  )
}

/** A bordered checkbox row used for a plugin's per-feature sub-option. */
function SubToggle({
  label, checked, onChange, children
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-border bg-card/60 p-2.5">
      <input
        type="checkbox"
        className="mt-0.5 shrink-0"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="block text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{children}</span>
      </span>
    </label>
  )
}
