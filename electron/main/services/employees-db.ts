import { randomUUID } from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/sqlite'
import { getProviders, getSettings } from './store'
import { getSoul } from './talent-pool'
import type { EmployeeInfo, EmployeeStats } from '../../../src/shared/ipc-types'

const DEFAULT_STATS: EmployeeStats = { assigned: 0, done: 0, out: 0, rate: 100, cost: 0 }

interface EmployeeRow {
  id: string; company_id: string; soul_id: string; name: string; dept: string
  avatar: string | null; provider_id: string | null; model_id: string | null
  status: string; stats: string; hired_at: number
}

function rowToInfo(r: EmployeeRow): EmployeeInfo {
  let stats = DEFAULT_STATS
  try { stats = { ...DEFAULT_STATS, ...JSON.parse(r.stats || '{}') } } catch { /* keep default */ }
  return {
    id: r.id, companyId: r.company_id, soulId: r.soul_id, name: r.name,
    dept: r.dept, avatar: r.avatar ?? undefined,
    providerId: r.provider_id ?? '', modelId: r.model_id ?? '',
    status: r.status === 'busy' ? 'busy' : 'idle', stats, hiredAt: r.hired_at
  }
}

/** Lazily seed + return the single default company. */
export function ensureCompany(): string {
  const existing = dbGet<{ id: string }>(`SELECT id FROM companies ORDER BY created_at ASC LIMIT 1`)
  if (existing) return existing.id
  const id = randomUUID()
  dbRun(`INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)`, [id, '我的工作室', Date.now()])
  return id
}

/** Pick a real {providerId, modelId} for a hired soul from the user's configured
 *  providers, biased toward the soul's recommended model family. Mirrors the
 *  fallback chain of resolveProjectModel (vibe.ts). Exported so the 面试 试聊
 *  flow can resolve a model for an un-hired candidate too. */
export function resolveEmployeeModel(recModel: string): { providerId: string; modelId: string } {
  const providers = getProviders()
  const settings = getSettings()
  const hint = (recModel || '').toLowerCase()
  const fam = hint.includes('opus') ? 'opus'
            : hint.includes('haiku') ? 'haiku'
            : hint.includes('sonnet') ? 'sonnet'
            : hint.includes('gpt') ? 'gpt'
            : hint.includes('gemini') ? 'gemini'
            : ''
  if (fam) {
    for (const p of providers) {
      const m = p.models.find(x => x.toLowerCase().includes(fam))
      if (m) return { providerId: p.id, modelId: m }
    }
  }
  if (settings.defaultChatProviderId && settings.defaultChatModel) {
    return { providerId: settings.defaultChatProviderId, modelId: settings.defaultChatModel }
  }
  const any = providers.find(p => p.models.length > 0)
  if (any) return { providerId: any.id, modelId: any.models[0] }
  return { providerId: '', modelId: '' }
}

export function listEmployees(): EmployeeInfo[] {
  const employees = dbAll<EmployeeRow>(`SELECT * FROM employees ORDER BY hired_at ASC`).map(rowToInfo)
  // Live-aggregate spend per employee from the vibe message cost log (their
  // assigned requests). Cheap GROUP BY; not stored in the stats JSON.
  try {
    const costRows = dbAll<{ eid: string; cost: number }>(
      `SELECT r.assignee_employee_id AS eid, COALESCE(SUM(m.cost_usd), 0) AS cost
         FROM vibe_messages m JOIN vibe_requests r ON m.request_id = r.id
        WHERE r.assignee_employee_id IS NOT NULL
        GROUP BY r.assignee_employee_id`
    )
    const costMap = new Map(costRows.map(c => [c.eid, c.cost]))
    for (const e of employees) e.stats.cost = costMap.get(e.id) ?? 0
  } catch { /* cost is best-effort */ }
  return employees
}

export function getEmployee(id: string): EmployeeInfo | null {
  const r = dbGet<EmployeeRow>(`SELECT * FROM employees WHERE id = ?`, [id])
  return r ? rowToInfo(r) : null
}

/** Hire a soul as an employee. Idempotent per (company, soul): re-hiring an
 *  already-employed soul returns the existing record. */
export function hireEmployee(soulId: string): EmployeeInfo {
  const soul = getSoul(soulId)
  if (!soul) throw new Error(`人才不存在：${soulId}`)
  const companyId = ensureCompany()
  const dup = dbGet<EmployeeRow>(`SELECT * FROM employees WHERE company_id = ? AND soul_id = ?`, [companyId, soulId])
  if (dup) return rowToInfo(dup)
  const { providerId, modelId } = resolveEmployeeModel(soul.recModel)
  const id = randomUUID()
  dbRun(
    `INSERT INTO employees (id, company_id, soul_id, name, dept, avatar, provider_id, model_id, status, stats, hired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    [id, companyId, soulId, soul.name, soul.dept, null, providerId, modelId, JSON.stringify(DEFAULT_STATS), Date.now()]
  )
  return getEmployee(id)!
}

export function fireEmployee(id: string): void {
  dbRun(`DELETE FROM employees WHERE id = ?`, [id])
}

export function setEmployeeModel(id: string, providerId: string, modelId: string): void {
  dbRun(`UPDATE employees SET provider_id = ?, model_id = ? WHERE id = ?`, [providerId, modelId, id])
}

export function setEmployeeDept(id: string, dept: string): void {
  dbRun(`UPDATE employees SET dept = ? WHERE id = ?`, [dept, id])
}

export function setEmployeeStatus(id: string, status: 'idle' | 'busy'): void {
  dbRun(`UPDATE employees SET status = ? WHERE id = ?`, [status, id])
}

/** Merge-increment an employee's stats (used by the apply loop on task events). */
export function bumpEmployeeStats(id: string, patch: Partial<EmployeeStats>): void {
  const e = getEmployee(id)
  if (!e) return
  const next: EmployeeStats = {
    assigned: e.stats.assigned + (patch.assigned ?? 0),
    done: e.stats.done + (patch.done ?? 0),
    out: e.stats.out + (patch.out ?? 0),
    rate: patch.rate ?? e.stats.rate
  }
  dbRun(`UPDATE employees SET stats = ? WHERE id = ?`, [JSON.stringify(next), id])
}
