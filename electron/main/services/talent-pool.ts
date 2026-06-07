import type { TalentEntry, TalentBrowseResult } from '../../../src/shared/ipc-types'
import { getTalentSource } from './talent-source'

/**
 * Talent catalog browse/get over whatever TalentSource is injected.
 *
 * The catalog ENTRIES come from the seam (talent-source.ts) — the deliverable
 * default is empty, a proprietary overlay injects the encrypted bundle, a
 * customer could inject a plain-text roster. This module is source-free: it only
 * filters / paginates / counts, so a missing catalog just yields an empty market
 * (the UI shows it rather than crashing) and no proprietary decryption code or
 * .enc path lives in core.
 */

export function browseCatalog(opts: { dept?: string; keyword?: string; page?: number; pageSize?: number } = {}): TalentBrowseResult {
  const all = getTalentSource().list()
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 24))

  let filtered = all
  if (opts.dept && opts.dept !== 'all') filtered = filtered.filter(e => e.dept === opts.dept)
  if (opts.keyword && opts.keyword.trim()) {
    const k = opts.keyword.trim().toLowerCase()
    filtered = filtered.filter(e => (e.name + ' ' + e.description).toLowerCase().includes(k))
  }

  const deptCounts: Record<string, number> = {}
  for (const e of all) deptCounts[e.dept] = (deptCounts[e.dept] || 0) + 1

  const start = (page - 1) * pageSize
  return { entries: filtered.slice(start, start + pageSize), total: filtered.length, deptCounts }
}

export function getSoul(id: string): TalentEntry | null {
  return getTalentSource().list().find(e => e.id === id) ?? null
}
