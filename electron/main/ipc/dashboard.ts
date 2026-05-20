/**
 * IPC handlers for SuperCode dashboard / usage analytics endpoints.
 */

import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { superCodeFetch, apiGetMe, apiListKeys } from '../supercode-api'
import { getAllKeys, getKeysMeta } from '../auth-store'

const BASE = 'https://www.supercode.help'

interface DateParams {
  preset?: 'today' | 'last7d' | 'last30d'
  start_date?: string
  end_date?: string
  timezone?: string
}

function buildQs(params: Record<string, string | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`)
  }
  return parts.length > 0 ? '?' + parts.join('&') : ''
}

export function dashboardHandlers(): void {
  // DASHBOARD_STATS — today's overview + user balance
  ipcMain.handle(IPC.DASHBOARD_STATS, async () => {
    const [statsRes, userRes] = await Promise.all([
      superCodeFetch(`${BASE}/api/v1/usage/dashboard/stats`),
      apiGetMe().catch(() => null)
    ])
    if (!statsRes.ok) throw new Error(`获取统计失败 (${statsRes.status})`)
    const stats = await statsRes.json() as Record<string, unknown>
    return { ...stats, balance: (userRes as { balance?: number } | null)?.balance ?? 0 }
  })

  // DASHBOARD_TREND — time-series data
  ipcMain.handle(IPC.DASHBOARD_TREND, async (_e, params: DateParams & { granularity?: string }) => {
    const qs = buildQs({
      granularity: params.granularity || 'day',
      preset: params.preset,
      start_date: params.start_date,
      end_date: params.end_date,
      timezone: params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    const res = await superCodeFetch(`${BASE}/api/v1/usage/dashboard/trend${qs}`)
    if (!res.ok) throw new Error(`获取趋势失败 (${res.status})`)
    return res.json()
  })

  // DASHBOARD_MODELS — per-model breakdown
  ipcMain.handle(IPC.DASHBOARD_MODELS, async (_e, params: DateParams) => {
    const qs = buildQs({
      preset: params.preset,
      start_date: params.start_date,
      end_date: params.end_date,
      timezone: params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    const res = await superCodeFetch(`${BASE}/api/v1/usage/dashboard/models${qs}`)
    if (!res.ok) throw new Error(`获取模型统计失败 (${res.status})`)
    return res.json()
  })

  // DASHBOARD_KEYS_USAGE — per-key breakdown (POST with all key IDs the user owns)
  ipcMain.handle(IPC.DASHBOARD_KEYS_USAGE, async (_e, params: DateParams) => {
    // Prefer the full meta list (every key the user owns, including non-active ones)
    // Fall back to active-only allKeys; if both are empty, fetch fresh from API
    let keyIds: number[] = getKeysMeta().map(k => k.id)
    if (keyIds.length === 0) keyIds = getAllKeys().map(k => k.id)
    if (keyIds.length === 0) {
      try {
        const fresh = await apiListKeys()
        keyIds = fresh.map(k => k.id)
      } catch { /* leave empty */ }
    }

    // Build name map for nicer rendering
    const nameMap = new Map<number, { name: string; platform: string; groupName: string }>()
    for (const m of getKeysMeta()) {
      nameMap.set(m.id, { name: m.name, platform: m.platform, groupName: m.groupName })
    }

    if (keyIds.length === 0) return { items: [], names: {} }

    const qs = buildQs({
      preset: params.preset,
      start_date: params.start_date,
      end_date: params.end_date,
      timezone: params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    const res = await superCodeFetch(`${BASE}/api/v1/usage/dashboard/api-keys-usage${qs}`, {
      method: 'POST',
      body: JSON.stringify({ api_key_ids: keyIds })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[dashboard] keys-usage ${res.status}: ${body.slice(0, 200)}`)
      throw new Error(`获取 Key 统计失败 (${res.status})`)
    }
    const raw = await res.json() as Record<string, unknown>
    console.log('[dashboard] keys-usage raw:', JSON.stringify(raw).slice(0, 500))

    // API shape: { stats: { "27": { api_key_id: 27, today_actual_cost, total_actual_cost, ... }, ... } }
    // Convert the keyed object to an array so the renderer can iterate it directly.
    let items: Record<string, unknown>[] = []
    const stats = raw.stats
    if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
      items = Object.values(stats as Record<string, Record<string, unknown>>)
    } else if (Array.isArray(stats)) {
      items = stats as Record<string, unknown>[]
    } else if (Array.isArray(raw)) {
      items = raw as unknown as Record<string, unknown>[]
    } else if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
      items = Object.values(raw.data as Record<string, Record<string, unknown>>)
    } else if (Array.isArray(raw.data)) {
      items = raw.data as Record<string, unknown>[]
    }

    return { items, names: Object.fromEntries(nameMap) }
  })
}
