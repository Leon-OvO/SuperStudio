// Seam: TalentSource
//
// Core consumes the talent catalog only through this interface. The DEFAULT
// implementation loads the bundled talent-pool.enc when present (the catalog is
// licensed content shipped per entitlement) and degrades to an empty market
// when absent — so a build with no bundle simply shows no personas instead of
// crashing. A different source can be injected via setTalentSource (e.g. a
// customer's own plain-text roster).
//
// Synchronous on purpose: callers (ipc/talent.ts, employees-db.ts, ipc/vibe.ts
// apply loop) read the catalog synchronously. The loader caches after first use.

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { decryptTalent } from './talent-crypto'
import type { TalentEntry } from '../../../src/shared/ipc-types'

export type { TalentEntry }

export interface TalentSource {
  /** The full in-memory catalog (already loaded/decrypted). Empty when none. */
  list(): TalentEntry[]
}

let catalog: TalentEntry[] | null = null

function locate(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'talent-pool.enc')]
    : [
        // __dirname at runtime is out/main; repo root is two levels up.
        path.join(__dirname, '../../resources/talent-pool.enc'),
        path.join(app.getAppPath(), 'resources/talent-pool.enc'),
      ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/** Default source: load the bundled catalog if present, else empty. */
const bundledTalentSource: TalentSource = {
  list() {
    if (catalog) return catalog
    const file = locate()
    if (!file) {
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
  },
}

let current: TalentSource = bundledTalentSource

export function setTalentSource(source: TalentSource): void {
  current = source
}

export function getTalentSource(): TalentSource {
  return current
}
