import type { ScheduleKind, ScheduleValue } from '../../../src/shared/ipc-types'

/**
 * Pure-function next-fire-time calculator for the scheduler. No node-cron, no
 * external deps — just Date arithmetic against the three supported kinds:
 *
 *   daily   : { time: "HH:MM" }                    → every day at that wall-clock time
 *   weekly  : { days: number[], time: "HH:MM" }    → 0=Sun..6=Sat
 *   monthly : { day: number, time: "HH:MM" }       → 1..31; skip months that lack the day
 *
 * All times are interpreted in the *local* timezone (matches what the user
 * picked in the UI). The returned value is a unix-ms timestamp suitable for
 * sqlite storage.
 *
 * The function is `from`-relative so the same code handles three callers:
 *   - tick: from=now → "next future occurrence"
 *   - startup catch-up: from=last_fired_at → "next occurrence after the last run"
 *   - tests: from=fixed → deterministic
 */
export function computeNextFireAt(
  kind: ScheduleKind,
  value: ScheduleValue,
  from: Date = new Date()
): number {
  if (kind === 'daily') {
    const v = value as { time: string }
    const [h, m] = parseHHMM(v.time)
    return nextOccurrenceForToday(from, h, m, /* allowEqual */ false).getTime()
  }

  if (kind === 'weekly') {
    const v = value as { days: number[]; time: string }
    if (!Array.isArray(v.days) || v.days.length === 0) {
      throw new Error('weekly schedule requires at least one day')
    }
    const [h, m] = parseHHMM(v.time)
    const set = new Set(v.days.filter(d => d >= 0 && d <= 6))
    if (set.size === 0) throw new Error('weekly schedule has no valid days (must be 0-6)')
    // Walk forward day by day from today; for each, if dow matches and that
    // day's time is strictly after `from`, pick it. At most 8 iterations needed.
    for (let offset = 0; offset < 8; offset++) {
      const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, h, m, 0, 0)
      if (!set.has(candidate.getDay())) continue
      if (candidate.getTime() > from.getTime()) return candidate.getTime()
    }
    // Logically unreachable — within 8 days at least one match exists.
    throw new Error('weekly schedule: no occurrence found in 8 days (bug)')
  }

  if (kind === 'monthly') {
    const v = value as { day: number; time: string }
    if (!Number.isInteger(v.day) || v.day < 1 || v.day > 31) {
      throw new Error(`monthly schedule day must be 1..31, got ${v.day}`)
    }
    const [h, m] = parseHHMM(v.time)
    // Walk forward month by month. Cap at 24 to keep the loop bounded even
    // for absurd inputs.
    const start = new Date(from.getFullYear(), from.getMonth(), 1)
    for (let i = 0; i < 24; i++) {
      const y = start.getFullYear() + Math.floor((start.getMonth() + i) / 12)
      const mo = (start.getMonth() + i) % 12
      const lastDay = new Date(y, mo + 1, 0).getDate()
      if (v.day > lastDay) continue // e.g. day=31 on Feb → skip
      const candidate = new Date(y, mo, v.day, h, m, 0, 0)
      if (candidate.getTime() > from.getTime()) return candidate.getTime()
    }
    throw new Error('monthly schedule: no occurrence found in 24 months (bug)')
  }

  if (kind === 'interval') {
    const v = value as { everyMinutes: number }
    const n = Number(v.everyMinutes)
    if (!Number.isFinite(n) || n < 1) throw new Error(`interval everyMinutes must be >= 1, got ${v.everyMinutes}`)
    // Anchored to `from` (now / last run / catch-up baseline) → fire N minutes later.
    return from.getTime() + Math.round(n) * 60_000
  }

  if (kind === 'once') {
    const v = value as { date: string; time: string }
    // Fixed wall-clock instant in local time. May be in the past relative to
    // `from` (the caller — create/update — rejects past instants; the scheduler
    // fires then auto-pauses).
    return parseLocalDateTime(v.date, v.time)
  }

  throw new Error(`unknown schedule kind: ${kind}`)
}

/** Parse "YYYY-MM-DD" + "HH:MM" as a LOCAL-time unix-ms instant. */
function parseLocalDateTime(date: string, time: string): number {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date?.trim() ?? '')
  if (!dm) throw new Error(`invalid date format, expected "YYYY-MM-DD", got "${date}"`)
  const [h, mi] = parseHHMM(time)
  const y = Number(dm[1]); const mo = Number(dm[2]); const d = Number(dm[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`invalid date: ${date}`)
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

function parseHHMM(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time?.trim() ?? '')
  if (!m) throw new Error(`invalid time format, expected "HH:MM", got "${time}"`)
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23) throw new Error(`hour out of range: ${h}`)
  if (mi < 0 || mi > 59) throw new Error(`minute out of range: ${mi}`)
  return [h, mi]
}

function nextOccurrenceForToday(from: Date, h: number, m: number, allowEqual: boolean): Date {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m, 0, 0)
  const ok = allowEqual ? today.getTime() >= from.getTime() : today.getTime() > from.getTime()
  if (ok) return today
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, h, m, 0, 0)
}

/**
 * Validate that schedule_value matches its kind. Returns null on success or an
 * error string. Used by IPC create/update before persisting.
 */
export function validateScheduleValue(kind: ScheduleKind, value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'schedule_value must be an object'
  const v = value as Record<string, unknown>
  const timeOk = typeof v.time === 'string' && /^(\d{1,2}):(\d{2})$/.test(v.time)
  if (kind === 'daily') return timeOk ? null : 'time must be "HH:MM"'
  if (kind === 'weekly') {
    if (!timeOk) return 'time must be "HH:MM"'
    if (!Array.isArray(v.days)) return 'weekly.days must be an array'
    if (v.days.length === 0) return 'weekly.days requires at least one day'
    for (const d of v.days) {
      if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) {
        return 'weekly.days values must be 0..6'
      }
    }
    return null
  }
  if (kind === 'monthly') {
    if (!timeOk) return 'time must be "HH:MM"'
    if (!Number.isInteger(v.day) || (v.day as number) < 1 || (v.day as number) > 31) {
      return 'monthly.day must be 1..31'
    }
    return null
  }
  if (kind === 'interval') {
    const n = v.everyMinutes
    if (!Number.isInteger(n) || (n as number) < 1) return 'interval.everyMinutes must be an integer >= 1'
    if ((n as number) > 7 * 24 * 60) return 'interval.everyMinutes too large (max 7 days)'
    return null
  }
  if (kind === 'once') {
    if (!timeOk) return 'time must be "HH:MM"'
    if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return 'once.date must be "YYYY-MM-DD"'
    return null
  }
  return `unknown schedule kind: ${kind}`
}
