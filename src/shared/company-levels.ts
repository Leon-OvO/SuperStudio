/**
 * Employee leveling — pure, shared between main (potential future use) and the
 * renderer Company page. Level is derived from completed-requirement count.
 */
export interface Level { min: number; name: string; icon: string }

export const LEVELS: Level[] = [
  { min: 0, name: '实习', icon: '🌱' },
  { min: 1, name: '初级', icon: '⭐' },
  { min: 3, name: '资深', icon: '💪' },
  { min: 6, name: '专家', icon: '👑' }
]

/** Current level for a given number of completed requirements. */
export function levelOf(done: number): Level {
  let lv = LEVELS[0]
  for (const l of LEVELS) if (done >= l.min) lv = l
  return lv
}

/** Next level above the current one, or null if already at the top. */
export function nextLevel(done: number): Level | null {
  return LEVELS.find(l => l.min > done) ?? null
}

/** 0–100 progress toward the next level (100 when maxed). */
export function levelProgress(done: number): number {
  const lv = levelOf(done)
  const nx = nextLevel(done)
  if (!nx) return 100
  return Math.round(((done - lv.min) / (nx.min - lv.min)) * 100)
}
