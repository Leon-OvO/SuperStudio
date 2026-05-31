import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { decryptTalent } from './talent-crypto'
import type { TalentEntry, TalentBrowseResult } from '../../../src/shared/ipc-types'

/**
 * Loads the bundled, encrypted talent catalog (840 agent personas from sources/)
 * into memory once, and serves browse/get queries. Decryption is obfuscation
 * only (see talent-crypto.ts). Missing/corrupt bundle → empty catalog (the UI
 * shows an empty market rather than crashing).
 */

let catalog: TalentEntry[] | null = null

function locate(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'talent-pool.enc')]
    : [
        // __dirname at runtime is out/main; repo root is two levels up.
        path.join(__dirname, '../../resources/talent-pool.enc'),
        path.join(app.getAppPath(), 'resources/talent-pool.enc')
      ]
  return candidates.find(p => fs.existsSync(p)) ?? null
}

function load(): TalentEntry[] {
  if (catalog) return catalog
  const file = locate()
  if (!file) {
    console.warn('[talent] talent-pool.enc not found — empty catalog')
    catalog = []
    return catalog
  }
  try {
    const json = JSON.parse(decryptTalent(fs.readFileSync(file))) as { entries?: TalentEntry[] }
    catalog = Array.isArray(json.entries) ? json.entries : []
    console.log(`[talent] loaded ${catalog.length} 个人才`)
  } catch (e) {
    console.warn('[talent] decrypt/parse failed:', (e as Error).message)
    catalog = []
  }
  return catalog
}

export function browseCatalog(opts: { dept?: string; keyword?: string; page?: number; pageSize?: number } = {}): TalentBrowseResult {
  const all = load()
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
  return load().find(e => e.id === id) ?? null
}
