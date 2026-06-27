import { Sparkles, ChevronDown, Wrench } from 'lucide-react'
import { cn } from '../lib/utils'
import { Select } from './ui/Select'
import { useSkills, isSkillDimmed, defaultPrimer } from '../hooks/useSkills'
import type { InstalledSkillInfo, SkillScenario } from '../../../shared/ipc-types'

/**
 * 技能快捷条 — a curated row of skill chips above a composer (Chat & Vibe), tuned
 * for non-technical users. Imported skills and ✨ auto-learned skills sit in two
 * clearly separated groups; a just-learned skill gets a one-shot 「刚学会」
 * celebration; and a clickable 「本周新学会 N / 我学会的 N」recap lets the user look
 * back at everything the app taught itself — so "it's getting smarter" is felt
 * right where they work. Clicking any chip fills a primer into the input AND arms
 * the skill for the next send (the parent handles arming).
 *
 * Click → primer rules:
 *  • imported skill, 1 starterPrompt  → that starter prompt
 *  • imported skill, >1 starterPrompts → a small menu to pick which
 *  • auto-learned / no starterPrompts  → generated `用「<name>」帮我：`
 */

interface Props {
  scenario: SkillScenario
  /** Called with the skill + the primer text to place in the input. */
  onPick: (skill: InstalledSkillInfo, primer: string) => void
  disabled?: boolean
  className?: string
}

export function SkillQuickBar({ scenario, onPick, disabled, className }: Props) {
  const { manual, auto, overflow, newlyLearnedIds, learnedSkills, weeklyAutoCount } = useSkills(scenario)
  if (!manual.length && !auto.length && !overflow.length) return null

  return (
    <div className={cn('flex items-center gap-1.5 flex-wrap', className)}>
      {/* 你导入的技能（顺序固定，不乱跳） */}
      {manual.map(s => (
        <SkillChip key={s.id} skill={s} newly={false} disabled={disabled} onPick={onPick} />
      ))}
      {overflow.length > 0 && <MoreMenu skills={overflow} disabled={disabled} onPick={onPick} />}

      {/* ✨ 软件自己学会的 —— 浅底容器圈成一区，和左边「你导入的」一眼分开 */}
      {auto.length > 0 && (
        <div className="inline-flex items-center gap-1.5 rounded-lg border border-primary/15 bg-primary/[0.06] py-0.5 pl-2 pr-1">
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-primary/80 select-none shrink-0"
            title="软件从你的对话里自动学会的技能">
            <Sparkles size={11} /> 我学会的
          </span>
          {auto.map(s => (
            <SkillChip key={s.id} skill={s} newly={newlyLearnedIds.has(s.id)} disabled={disabled} onPick={onPick} />
          ))}
          <LearnedRecap learned={learnedSkills} weekly={weeklyAutoCount} disabled={disabled} onPick={onPick} />
        </div>
      )}
    </div>
  )
}

function chipClasses(opts: { isAuto: boolean; newly: boolean; dimmed: boolean; disabled?: boolean }): string {
  return cn(
    'inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs border transition-colors max-w-[180px]',
    opts.isAuto
      ? 'border-primary/30 bg-card hover:bg-primary/10 text-foreground' // 站在浅底容器上要够清楚
      : 'border-border/60 bg-card hover:bg-muted/60 text-foreground/90',
    // 刚学会：一次性放大+发光庆祝（settle 后保留淡描边），尊重 reduce-motion。
    opts.newly && 'ring-2 ring-primary/40 animate-skill-pop motion-reduce:animate-none',
    opts.dimmed && 'opacity-60',
    opts.disabled && 'opacity-50 cursor-not-allowed'
  )
}

function ChipFace({ skill, newly }: { skill: InstalledSkillInfo; newly: boolean }) {
  const isAuto = skill.origin === 'auto'
  const multi = !isAuto && (skill.starterPrompts?.length ?? 0) > 1
  return (
    <>
      {isAuto
        ? <Sparkles size={11} className="text-primary shrink-0" />
        : skill.icon
          ? <span className="shrink-0 text-[12px] leading-none">{skill.icon}</span>
          : <Wrench size={11} className="text-muted-foreground shrink-0" />}
      <span className="truncate">{skill.name}</span>
      {isAuto && <span className="shrink-0 text-[9px] leading-none px-1 py-0.5 rounded bg-primary/15 text-primary">自学</span>}
      {newly && <span className="shrink-0 text-[9px] leading-none px-1 py-0.5 rounded bg-primary text-primary-foreground">刚学会</span>}
      {multi && <ChevronDown size={10} className="shrink-0 text-muted-foreground" />}
    </>
  )
}

function SkillChip({ skill, newly, disabled, onPick }: {
  skill: InstalledSkillInfo
  newly: boolean
  disabled?: boolean
  onPick: Props['onPick']
}) {
  const isAuto = skill.origin === 'auto'
  const dimmed = isSkillDimmed(skill)
  const multi = !isAuto && (skill.starterPrompts?.length ?? 0) > 1
  const cls = chipClasses({ isAuto, newly, dimmed, disabled })
  const title = skill.description || skill.name

  // Multiple starter prompts → a themed menu to pick which to insert.
  if (multi) {
    return (
      <Select
        value=""
        onChange={v => onPick(skill, skill.starterPrompts[Number(v)].prompt)}
        options={skill.starterPrompts.map((sp, i) => ({ value: String(i), label: sp.label || `用法 ${i + 1}` }))}
        disabled={disabled}
        placement="top"
        popoverWidth={240}
        title={title}
        trigger={() => <span className={cls}><ChipFace skill={skill} newly={newly} /></span>}
      />
    )
  }

  return (
    <button type="button" disabled={disabled} title={title} className={cls}
      onClick={() => onPick(skill, defaultPrimer(skill))}>
      <ChipFace skill={skill} newly={newly} />
    </button>
  )
}

/** 「更多」overflow: a menu listing the remaining skills, auto ones grouped first. */
function MoreMenu({ skills, disabled, onPick }: {
  skills: InstalledSkillInfo[]
  disabled?: boolean
  onPick: Props['onPick']
}) {
  const ordered = [...skills].sort((a, b) => (a.origin === 'auto' ? 0 : 1) - (b.origin === 'auto' ? 0 : 1))
  const options = ordered.map(s => ({
    value: s.id,
    label: s.name,
    icon: s.origin === 'auto'
      ? <Sparkles size={12} className="text-primary" />
      : s.icon
        ? <span className="text-[12px] leading-none">{s.icon}</span>
        : <Wrench size={12} />,
    hint: s.origin === 'auto' ? '自学' : undefined,
    groupLabel: s.origin === 'auto' ? '✨ 软件自己学会的' : '你导入的技能'
  }))
  return (
    <Select
      value=""
      onChange={id => { const s = skills.find(x => x.id === id); if (s) onPick(s, defaultPrimer(s)) }}
      options={options}
      disabled={disabled}
      placement="top"
      popoverWidth={240}
      searchable={skills.length > 8}
      searchPlaceholder="搜索技能…"
      trigger={({ open }) => (
        <span className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs border border-border/60 bg-card hover:bg-muted/60 text-muted-foreground">
          更多 <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} />
        </span>
      )}
    />
  )
}

/** Plain-language "learned X days ago · used N times" line for the recap rows. */
function recapHint(s: InstalledSkillInfo): string {
  const days = Math.floor((Date.now() - s.installedAt) / (24 * 60 * 60 * 1000))
  const when = days <= 0 ? '今天学会' : days === 1 ? '昨天学会' : `${days} 天前学会`
  const used = (s.timesLoaded || 0) > 0 ? `用过 ${s.timesLoaded} 次` : '还没用过'
  const pending = s.status !== 'active' ? ' · 待采纳' : ''
  return `${when} · ${used}${pending}`
}

/** Clickable 「回看」pill: list everything the app auto-learned (recent-first);
 *  pick a row to use it. Makes accumulating intelligence tangible & actionable. */
function LearnedRecap({ learned, weekly, disabled, onPick }: {
  learned: InstalledSkillInfo[]
  weekly: number
  disabled?: boolean
  onPick: Props['onPick']
}) {
  // 容器已带「✨ 我学会的」前缀，这里只用计数标识 freshness/总量，避免重复。
  const label = weekly > 0 ? `本周 +${weekly}` : `全部 ${learned.length}`
  const options = learned.map(s => ({
    value: s.id,
    label: s.name,
    icon: <Sparkles size={12} className="text-primary" />,
    hint: recapHint(s),
    groupLabel: '✨ 软件帮你学会的技能（点一条就用）'
  }))
  return (
    <Select
      value=""
      onChange={id => { const s = learned.find(x => x.id === id); if (s) onPick(s, defaultPrimer(s)) }}
      options={options}
      disabled={disabled}
      placement="top"
      popoverWidth={280}
      searchable={learned.length > 10}
      searchPlaceholder="搜索学会的技能…"
      title="点开回看软件帮你学会的技能（学会时间·用量），点一条直接用"
      trigger={({ open }) => (
        <span className={cn(
          'inline-flex items-center gap-1 h-6 px-1.5 rounded text-[11px] text-primary/90 transition-colors hover:bg-primary/10',
          open && 'bg-primary/10'
        )}>
          {label}
          <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} />
        </span>
      )}
    />
  )
}
