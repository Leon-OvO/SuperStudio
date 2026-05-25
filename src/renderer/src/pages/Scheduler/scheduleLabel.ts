import type { ScheduleKind, ScheduleValue } from '../../../../shared/ipc-types'

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

export function scheduleLabel(kind: ScheduleKind, value: ScheduleValue): string {
  if (kind === 'daily') {
    const v = value as { time: string }
    return `每天 ${v.time}`
  }
  if (kind === 'weekly') {
    const v = value as { days: number[]; time: string }
    if (!v.days?.length) return `每周 ${v.time}`
    const sorted = [...v.days].sort((a, b) => a - b)
    const daysLabel = sorted.map(d => `周${WEEKDAY_NAMES[d] ?? '?'}`).join('/')
    return `${daysLabel} ${v.time}`
  }
  if (kind === 'monthly') {
    const v = value as { day: number; time: string }
    return `每月 ${v.day} 日 ${v.time}`
  }
  return '未知'
}

/** Format unix ms → "MM-DD HH:MM" for the next-fire display. */
export function formatNextFire(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Full "YYYY-MM-DD HH:MM:SS" for the detail page. */
export function formatTimestamp(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
