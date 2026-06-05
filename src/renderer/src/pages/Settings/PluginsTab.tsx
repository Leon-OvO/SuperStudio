import type { ReactNode } from 'react'
import { Monitor, ToggleLeft, ToggleRight, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AppSettings } from '../../../../shared/ipc-types'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void | Promise<void>
}

/**
 * 插件 (Plugins) settings tab — enable/disable extension capabilities, styled
 * after the Skills Center cards. A plugin that is OFF here is hidden everywhere
 * it would otherwise be offered (e.g. the 电脑操控 toggle in chat input and the
 * scheduled-task form only appear when Computer Use is enabled).
 */
export function PluginsTab({ settings, onSave }: Props) {
  const computerOn = settings.computerUseEnabled === true

  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">插件</h2>
      <p className="text-sm text-muted-foreground">
        在这里启用或停用扩展能力。只有在此启用的插件，才会出现在对话框、定时任务等处。
      </p>

      <PluginCard
        icon={Monitor}
        name="电脑操控（Computer Use）"
        desc="让 AI 看屏幕、操作鼠标和键盘来完成任务。启用后，对话框与定时任务里会出现「电脑操控」选项。"
        enabled={computerOn}
        danger
        onToggle={() => onSave({ ...settings, computerUseEnabled: !computerOn })}
      >
        {computerOn && (
          <div className="space-y-3">
            <p className="text-xs text-foreground/70 leading-relaxed">
              ⚠️ 高危能力：开启后，AI 可截屏并点击、输入到本机<b>任意程序</b>。
              手动对话时每次开始操控会弹窗请你确认；定时任务为无人值守，到点会自动开始。
              操作期间屏幕顶部有红色提示，按 <b>Esc</b> 可随时立即急停。
              仅在你清楚自己在做什么时开启；不信任的任务请勿使用。
              <br />需选 <b>Claude（带视觉）模型</b>才能生效。
            </p>

            <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-border bg-card/60 p-2.5">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={settings.computerUsePrivacyCurtain === true}
                onChange={e => onSave({ ...settings, computerUsePrivacyCurtain: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">隐私黑幕（伪锁屏）</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  运行电脑操控时，用覆盖所有显示器的<b>全屏黑幕</b>遮住屏幕，旁人看不到 AI 在做什么；
                  屏幕只是被遮挡、<b>并未真正锁定</b>，所以 AI 仍能正常截屏与操作（黑幕对截屏隐身、对人可见）。
                  任务结束或按 <b>Esc</b> 后黑幕自动消失。
                  <br />注意：这不是系统级锁屏，<b>也不会阻止旁人用鼠标键盘干预</b>；适合你离开座位时使用。
                  真正的系统锁屏（Win+L）下电脑操控无法工作。
                </span>
              </span>
            </label>
          </div>
        )}
      </PluginCard>
    </div>
  )
}

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
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 transition-all',
        enabled && danger ? 'border-red-500/40 bg-red-500/[0.04]' : 'border-border hover:border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          enabled && danger ? 'bg-red-500/10 text-red-600' : 'bg-muted text-muted-foreground'
        )}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={cn('text-sm font-semibold', enabled && danger && 'text-red-600')}>{name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
        </div>
        <button
          onClick={onToggle}
          className={cn(
            'p-1 rounded-md transition-colors shrink-0',
            enabled ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground hover:bg-accent'
          )}
          title={enabled ? '点击停用' : '点击启用'}
        >
          {enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
        </button>
      </div>
      {children && <div className="mt-3 pl-12">{children}</div>}
    </div>
  )
}
