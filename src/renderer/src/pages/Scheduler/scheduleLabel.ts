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
  if (kind === 'interval') {
    const v = value as { everyMinutes: number }
    const n = v.everyMinutes
    if (n >= 60 && n % 60 === 0) return `每隔 ${n / 60} 小时`
    return `每隔 ${n} 分钟`
  }
  if (kind === 'once') {
    const v = value as { date: string; time: string }
    return `${v.date} ${v.time} · 仅一次`
  }
  return '未知'
}

/** Human "X 月 X 日 周三 HH:MM" for the form's live next-fire preview. */
export function formatWhen(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 周${w} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Coarse "约 X 分钟/小时/天后" for the live preview. */
export function formatRelativeFromNow(ts: number): string {
  const diff = ts - Date.now()
  if (diff <= 0) return '已过期'
  const min = Math.round(diff / 60000)
  if (min < 1) return '即将'
  if (min < 60) return `约 ${min} 分钟后`
  const hr = Math.round(min / 60)
  if (hr < 48) return `约 ${hr} 小时后`
  const day = Math.round(hr / 24)
  return `约 ${day} 天后`
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
