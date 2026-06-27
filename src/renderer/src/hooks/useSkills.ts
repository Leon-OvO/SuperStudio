import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledSkillInfo, SkillScenario } from '../../../shared/ipc-types'

/**
 * Shared skill model for the input-box 技能快捷条 (SkillQuickBar), used by both the
 * Chat composer and the Vibe (公司工作台) composer.
 *
 * Tuned for non-technical users ("A 减法版"): order is STABLE so chips don't
 * shuffle under the cursor (protects muscle memory) — manual skills keep a fixed
 * order, auto skills only re-sort when something new is learned. Imported vs
 * auto-learned are returned as two groups so the bar can separate them clearly,
 * and `learnedSkills` powers a clickable 「回看」of everything the app taught
 * itself — making "it's getting smarter" visible right where the user works.
 */

const MANUAL_CAP = 4
const AUTO_CAP = 2
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface UseSkillsResult {
  /** Visible imported skills (stable order). */
  manual: InstalledSkillInfo[]
  /** Visible auto-learned skills (just-learned first, then most-recently learned). */
  auto: InstalledSkillInfo[]
  /** Imported skills beyond the visible cap — shown under 「更多」. (Extra
   *  auto-learned skills live in the 回看 recap, not here, to keep the two
   *  groups visually clean.) */
  overflow: InstalledSkillInfo[]
  /** Ids freshly auto-learned this session — drive the 「刚学会」celebration (~12s). */
  newlyLearnedIds: Set<string>
  /** ALL auto-learned skills (recent-first) — backs the clickable 回看 recap. */
  learnedSkills: InstalledSkillInfo[]
  /** Auto-learned skills installed in the last 7 days (the "本周新学会 N" count). */
  weeklyAutoCount: number
}

/** Auto skill that isn't 'active', or any disabled skill: shown but de-emphasized.
 *  Still clickable — forcing/arming bypasses gating, so the user can use it anyway. */
export function isSkillDimmed(s: InstalledSkillInfo): boolean {
  return (s.origin === 'auto' && s.status !== 'active') || !s.enabled
}

/** Generated invocation line for skills without a starter prompt (e.g. auto-learned). */
export function generatedPrimer(s: InstalledSkillInfo): string {
  return `用「${s.name}」帮我：`
}

/** The primer text to drop into the input when a skill is picked (a quick-bar chip
 *  or a new-chat home card): imported skill → its first starter prompt; otherwise
 *  a generated invocation line. */
export function defaultPrimer(s: InstalledSkillInfo): string {
  if (s.origin !== 'auto' && s.starterPrompts?.length) return s.starterPrompts[0].prompt
  return generatedPrimer(s)
}

const dim = (s: InstalledSkillInfo): number => (isSkillDimmed(s) ? 1 : 0)

export function useSkills(scenario: SkillScenario): UseSkillsResult {
  const [raw, setRaw] = useState<InstalledSkillInfo[]>([])
  const [newlyLearnedIds, setNewly] = useState<Set<string>>(() => new Set())
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const refresh = (): void => {
      window.api.listSkills?.()
        .then((list: unknown) => setRaw(Array.isArray(list) ? (list as InstalledSkillInfo[]) : []))
        .catch(() => {/* keep previous list */})
    }
    refresh()
    // Live: a skill just got auto-learned → refresh the list and celebrate it.
    const off = window.api.onSkillInduced?.((d: { id: string; name: string; status: string }) => {
      refresh()
      setNewly(prev => new Set(prev).add(d.id))
      const prevTimer = timers.current.get(d.id)
      if (prevTimer) clearTimeout(prevTimer)
      const t = setTimeout(() => {
        setNewly(prev => { const n = new Set(prev); n.delete(d.id); return n })
        timers.current.delete(d.id)
      }, 12000)
      timers.current.set(d.id, t)
    })
    const pending = timers.current
    return () => {
      off?.()
      pending.forEach(t => clearTimeout(t))
      pending.clear()
    }
  }, [])

  return useMemo<UseSkillsResult>(() => {
    const now = Date.now()
    const inScope = raw.filter(s => s.enabledScenarios?.includes(scenario))

    // Imported: fixed order (usable before dimmed, then by install time) so the
    // user's familiar skills never jump around.
    const manualAll = inScope
      .filter(s => s.origin !== 'auto')
      .sort((a, b) => dim(a) - dim(b) || a.installedAt - b.installedAt)

    // Auto-learned: just-learned floats first (celebrate), then usable before
    // 待审, then most-recently-learned first. Only changes when learning happens.
    const autoAll = inScope
      .filter(s => s.origin === 'auto')
      .sort((a, b) =>
        (newlyLearnedIds.has(b.id) ? 1 : 0) - (newlyLearnedIds.has(a.id) ? 1 : 0) ||
        dim(a) - dim(b) ||
        b.installedAt - a.installedAt)

    const manual = manualAll.slice(0, MANUAL_CAP)
    const auto = autoAll.slice(0, AUTO_CAP)
    // 「更多」只收导入技能的溢出；自学技能多出来的由「回看」(learnedSkills) 承载，
    // 这样左「你导入的」/ 右「软件学会的」两区视觉上彻底分开。
    const overflow = manualAll.slice(MANUAL_CAP)
    const weeklyAutoCount = autoAll.filter(s => now - s.installedAt < WEEK_MS).length

    return { manual, auto, overflow, newlyLearnedIds, learnedSkills: autoAll, weeklyAutoCount }
  }, [raw, newlyLearnedIds, scenario])
}
