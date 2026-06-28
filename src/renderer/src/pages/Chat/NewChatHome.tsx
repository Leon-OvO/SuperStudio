import { Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'
import { SkillIcon } from '../../components/SkillQuickBar'
import { useSkills } from '../../hooks/useSkills'
import type { InstalledSkillInfo } from '../../../../shared/ipc-types'

/**
 * 新对话首页（A 两栏 + C 首页卡片引导的混合）：当当前会话还没有任何消息时，主区
 * 不显示空白对话，而是落到一个"启动台"——问候 + 起步卡片（用户的技能 + 几个示例）。
 * 点技能卡 = 填引子并装备该技能；点示例卡 = 填入示例文字。发出第一条消息后，主区
 * 自动切回正常的消息流。面向小白：进来就知道"能干嘛、点哪开始"。
 */

function greeting(): string {
  const h = new Date().getHours()
  const t = h < 6 ? '凌晨好' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  return `${t}，今天想做点什么？`
}

/** Always-available starter prompts so a brand-new user (no skills yet) still gets
 *  obvious guidance. Plain-language, action-first. */
const EXAMPLES: Array<{ em: string; label: string; text: string }> = [
  { em: '✉️', label: '写一封邮件', text: '帮我写一封邮件：' },
  { em: '📝', label: '总结一段文字', text: '帮我总结这段文字：' },
  { em: '🔎', label: '查个资料', text: '帮我查一下：' },
  { em: '✍️', label: '润色文案', text: '帮我润色这段文案：' }
]

export function NewChatHome({ onPickSkill, onPickText }: {
  onPickSkill: (skill: InstalledSkillInfo) => void
  onPickText: (text: string) => void
}) {
  const { manual, auto } = useSkills('chat')
  const skills = [...manual, ...auto].slice(0, 6)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="min-h-full flex flex-col">
        <div className="w-full max-w-xl mx-auto px-6 py-10 my-auto">
        <h2 className="text-[22px] font-bold text-center tracking-tight">{greeting()}</h2>
        <p className="text-center text-muted-foreground mt-1.5 text-[13px]">直接在下面说需求，或点一张卡片快速开始</p>

        {skills.length > 0 && (
          <div className="mt-7">
            <div className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
              <Sparkles size={13} className="text-primary" /> 我能帮你做的事
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {skills.map(s => {
                const isAuto = s.origin === 'auto'
                return (
                  <button
                    key={s.id}
                    onClick={() => onPickSkill(s)}
                    className="flex items-center gap-2.5 p-3 rounded-xl border border-border bg-card text-left transition-all hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-sm"
                  >
                    <span className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-base',
                      isAuto ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    )}>
                      <SkillIcon skill={s} size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{s.name}</span>
                      <span className="block text-[10.5px] text-muted-foreground truncate">
                        {isAuto ? '✨ 我学会的' : (s.description || '点一下开始')}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="mt-6">
          <div className="text-xs font-medium text-muted-foreground mb-3">💡 不知道做什么？试试这些</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {EXAMPLES.map(e => (
              <button
                key={e.label}
                onClick={() => onPickText(e.text)}
                className="flex flex-col items-center justify-center gap-1.5 p-3.5 rounded-xl border border-border bg-card transition-all hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-sm"
              >
                <span className="text-xl leading-none">{e.em}</span>
                <span className="text-xs font-medium">{e.label}</span>
              </button>
            ))}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
