import { app } from 'electron'
import path from 'path'
import { dbAll } from '../db/sqlite'

/**
 * Allowlist for what the `local-file://` protocol is permitted to serve.
 *
 * Without this, any path the renderer asks for is happily read from disk —
 * a malicious prompt could make the agent embed `<img src="local-file:///etc/passwd">`
 * to exfiltrate file contents into the next LLM turn.
 *
 * Allowed sources:
 *   1. Anything inside the app's userData directory (gallery, temp, lancedb,
 *      backups — generated/internal files)
 *   2. Anything in the configured dataDirectory (when user moves storage)
 *   3. Files the user has explicitly handed us via dialogs / paste —
 *      tracked in `sessionApproved` and persisted via DB attachments tables
 */

const sessionApproved = new Set<string>()
let dbCachedAt = 0
const dbCached = new Set<string>()
const DB_CACHE_TTL_MS = 5_000

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

/** Add a path the user has explicitly opened/attached this session. */
export function registerApproved(p: string | undefined | null): void {
  if (!p) return
  sessionApproved.add(normalize(p))
}

function loadDbApproved(): Set<string> {
  const now = Date.now()
  if (now - dbCachedAt < DB_CACHE_TTL_MS) return dbCached
  dbCached.clear()
  try {
    // Gallery file paths
    const gallery = dbAll<{ file_path: string; thumbnail_path: string | null }>(
      `SELECT file_path, thumbnail_path FROM gallery`
    )
    for (const r of gallery) {
      if (r.file_path) dbCached.add(normalize(r.file_path))
      if (r.thumbnail_path) dbCached.add(normalize(r.thumbnail_path))
    }
    // KB imported source files
    const sources = dbAll<{ file_path: string }>(
      `SELECT file_path FROM kb_sources WHERE file_path IS NOT NULL`
    )
    for (const r of sources) {
      if (r.file_path) dbCached.add(normalize(r.file_path))
    }
    // Message attachments — JSON array per message, parse defensively
    const msgs = dbAll<{ attachments: string }>(
      `SELECT attachments FROM messages WHERE attachments IS NOT NULL AND attachments != ''`
    )
    for (const r of msgs) {
      try {
        const arr = JSON.parse(r.attachments) as Array<{ path?: string }>
        for (const a of arr) if (a.path) dbCached.add(normalize(a.path))
      } catch { /* skip malformed rows */ }
    }
    dbCachedAt = now
  } catch (e) {
    console.warn('[path-allow] DB load failed (likely pre-init):', (e as Error).message)
  }
  return dbCached
}

/** Reset the DB cache — called after writes so the next check sees fresh rows. */
export function invalidateDbCache(): void {
  dbCachedAt = 0
}

function rootPaths(): string[] {
  const roots: string[] = []
  try { roots.push(app.getPath('userData')) } catch { /* ignore */ }
  try { roots.push(app.getPath('temp')) } catch { /* ignore */ }
  return roots.map(normalize)
}

export function isApproved(filePath: string): boolean {
  if (!filePath) return false
  const norm = normalize(filePath)

  // 1. Under userData (or temp) — always allowed (our own generated content)
  for (const root of rootPaths()) {
    if (norm === root || norm.startsWith(root + '/')) return true
  }

  // 2. Approved this session (file dialog, paste, etc.)
  if (sessionApproved.has(norm)) return true

  // 3. Referenced in DB (attachments, gallery, kb sources)
  const dbSet = loadDbApproved()
  if (dbSet.has(norm)) return true

  return false
}
