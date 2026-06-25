import { dbGet } from '../db/sqlite'
import { getSettings } from './store'
import {
  listAutoSkills, setSkillStatus, recordSkillLoad, recordSkillOutcome,
  type InstalledSkill,
} from './skills-db'
import { listMemories } from './memory'
import { induceFromMemory, refineInducedSkill } from './skill-induction'

/**
 * SkillOps — the EVOLVE stage of the auto-skill loop (the part Voyager-style
 * append-only libraries lack). Rule-first + cost-bounded, mirroring session-tidy:
 * runs at startup + on an interval, .unref()'d, with a hard per-sweep LLM-call cap.
 *
 *   recordSkillSignals  — per-run A1/A2 trust signal (called by the engine post-run)
 *   runSkillOps         — deprecate-stale → merge-dupes → promote-from-memory → refine-on-failure
 */

const STALE_DAYS = 21
const MIN_SAMPLES_FOR_PRUNE = 4
const LOW_SUCCESS_FLOOR = 0.34
const STABLE_CONFIDENCE = 0.7        // ≥ this + enough samples = mature/stable (protected from prune/refine)
const REFINE_FAIL_THRESHOLD = 3
const PROMOTE_USE_COUNT = 3          // a skill-memory recalled this many times graduates to a SKILL.md
const MAX_PROMOTE_PER_SWEEP = 2
const SWEEP_INTERVAL_MS = 4 * 60 * 60 * 1000

const DAY = 86_400_000

/** Per-run trust signal: record that these skills were consulted and how the run went. */
export function recordSkillSignals(opts: {
  consultedSkillIds: string[]
  success: boolean
  artifacts: number
  sessionId: string | null
}): void {
  const ids = [...new Set(opts.consultedSkillIds)].filter(Boolean)
  for (const id of ids) {
    try {
      recordSkillLoad(id, opts.sessionId)
      recordSkillOutcome(id, opts.success, opts.artifacts, opts.sessionId)
    } catch (e) {
      console.warn('[skill-evolution] signal record failed:', (e as Error).message)
    }
  }
}

function isStable(s: InstalledSkill): boolean {
  const total = s.timesSucceeded + s.timesFailed
  return total >= MIN_SAMPLES_FOR_PRUNE && (s.confidence ?? 0) >= STABLE_CONFIDENCE
}

/** Archive (don't delete) auto skills that never get used or consistently fail. */
function deprecateStale(autos: InstalledSkill[], now: number): number {
  let n = 0
  for (const s of autos) {
    if (s.status !== 'active') continue
    if (isStable(s)) continue                          // protect mature, proven skills
    const total = s.timesSucceeded + s.timesFailed
    const ageDays = (now - (s.lastUsedAt ?? s.installedAt)) / DAY
    const neverUsed = s.timesLoaded === 0 && ageDays > STALE_DAYS
    const lowUtility = total >= MIN_SAMPLES_FOR_PRUNE && (s.confidence ?? 0.5) < LOW_SUCCESS_FLOOR
    if (neverUsed || lowUtility) {
      try { setSkillStatus(s.id, 'deprecated'); n++ } catch { /* best-effort */ }
    }
  }
  return n
}

/** Merge body-hash collisions (rare — induction dedups, but refine can collide):
 *  keep the highest-trust active one, deprecate the rest. */
function mergeDupes(autos: InstalledSkill[]): number {
  const byHash = new Map<string, InstalledSkill[]>()
  for (const s of autos) {
    if (!s.bodyHash || s.status === 'deprecated') continue
    const arr = byHash.get(s.bodyHash) ?? []
    arr.push(s); byHash.set(s.bodyHash, arr)
  }
  let n = 0
  const trust = (s: InstalledSkill) => (s.confidence ?? 0.5) * 10 + s.timesSucceeded - s.timesFailed
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    const sorted = group.slice().sort((a, b) => trust(b) - trust(a))
    for (const loser of sorted.slice(1)) {
      try { setSkillStatus(loser.id, 'deprecated'); n++ } catch { /* best-effort */ }
    }
  }
  return n
}

// Memories whose promotion attempt produced no skill (lint-fail / dedup collision)
// this process-run — don't re-spend an LLM call on them every 4h sweep.
const triedPromote = new Set<string>()

/** Promote recurring kind='skill' memories into loadable SKILL.md skills. */
async function promoteFromMemory(): Promise<number> {
  const mems = listMemories({ kind: 'skill', status: 'active' })
    .filter(m => m.use_count >= PROMOTE_USE_COUNT)
  let n = 0
  for (const m of mems) {
    if (n >= MAX_PROMOTE_PER_SWEEP) break
    if (triedPromote.has(m.id)) continue
    const already = dbGet<{ id: string }>(`SELECT id FROM skills WHERE source_memory_id = ? LIMIT 1`, [m.id])
    if (already) continue
    const skill = await induceFromMemory(m)
    if (skill) n++
    else triedPromote.add(m.id)   // terminal for this run — don't retry the same memory
  }
  return n
}

/** Refine one plastic, frequently-failing auto skill from its failing trace. */
async function refineOnFailure(autos: InstalledSkill[]): Promise<number> {
  const candidate = autos
    .filter(s => s.status === 'active' && !isStable(s) && s.timesFailed >= REFINE_FAIL_THRESHOLD)
    .sort((a, b) => b.timesFailed - a.timesFailed)[0]
  if (!candidate) return 0
  const refined = await refineInducedSkill(candidate.id)
  return refined ? 1 : 0
}

let sweeping = false

export async function runSkillOps(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const now = Date.now()
    const autos = listAutoSkills()
    const deprecated = deprecateStale(autos, now)
    const merged = mergeDupes(autos)
    const promoted = await promoteFromMemory()
    const refined = await refineOnFailure(autos)
    if (deprecated || merged || promoted || refined) {
      console.log(`[skill-evolution] sweep: -${deprecated} stale, -${merged} dup, +${promoted} promoted, ~${refined} refined`)
    }
  } catch (e) {
    console.warn('[skill-evolution] sweep failed:', (e as Error).message)
  } finally {
    sweeping = false
  }
}

let started = false

/** Start the periodic SkillOps sweep (startup + every few hours, unref'd). */
export function startSkillOps(): void {
  if (started) return
  started = true
  const kick = setTimeout(() => { if (getSettings().skillInductionEnabled !== false) void runSkillOps() }, 60_000)
  ;(kick as { unref?: () => void }).unref?.()
  const iv = setInterval(() => { if (getSettings().skillInductionEnabled !== false) void runSkillOps() }, SWEEP_INTERVAL_MS)
  ;(iv as { unref?: () => void }).unref?.()
}
