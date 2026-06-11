import fs from 'fs'
import path from 'path'
import { app } from 'electron'

/**
 * Auto-pick a data directory for DWork's first run so the user isn't asked to
 * choose one during onboarding. Strategy: among the available drive roots, pick
 * the one with the MOST free space and create `<root>/DWorkData` there. Falls
 * back through other drives on permission/read-only failure, and finally to the
 * app's userData dir so startup never breaks.
 */

const FOLDER = 'DWorkData'

function freeBytes(p: string): number {
  try {
    const s = fs.statfsSync(p) as { bavail: number; bsize: number }
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return -1
  }
}

/** Candidate filesystem roots to host the data folder. */
function candidateRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = []
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const r = `${String.fromCharCode(c)}:\\`
      try { if (fs.existsSync(r)) roots.push(r) } catch { /* ignore */ }
    }
    return roots
  }
  // mac/linux: prefer the user's home, then the fs root.
  return [app.getPath('home'), '/']
}

/** Pick the freest writable drive root and ensure `<root>/DWorkData` exists. */
export function autoPickDataDir(): string {
  const ranked = candidateRoots()
    .map(root => ({ root, free: freeBytes(root) }))
    .filter(d => d.free >= 0)
    .sort((a, b) => b.free - a.free)

  for (const d of ranked) {
    const target = path.join(d.root, FOLDER)
    try {
      fs.mkdirSync(target, { recursive: true })
      // Confirm it's actually writable (some roots reject writes despite mkdir).
      fs.accessSync(target, fs.constants.W_OK)
      return target
    } catch { /* try the next drive */ }
  }

  // Last resort: app userData (always writable).
  const fallback = path.join(app.getPath('userData'), FOLDER)
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

// --- Crash-proof data-directory sidecar --------------------------------------
//
// The custom data directory lives in settings (electron-store config.json). If
// that config is ever reset to defaults (e.g. a decrypt failure after an update
// — see store.ts), settings.dataDirectory is lost and the DB silently falls back
// to the default userData → the user's sessions / employees "disappear". We mirror
// the chosen directory into a PLAIN sidecar file in the default userData so it can
// be recovered independently of the (encrypted/resettable) config.

function sidecarPath(): string {
  return path.join(app.getPath('userData'), 'data-dir.path')
}

/** Persist the active data directory to the sidecar (best-effort, plain text). */
export function rememberDataDir(dir: string): void {
  try { if (dir && dir.trim()) fs.writeFileSync(sidecarPath(), dir.trim(), 'utf8') } catch { /* best effort */ }
}

/** Read the last-remembered data directory, or null if none/unreadable. */
export function recallDataDir(): string | null {
  try {
    const p = sidecarPath()
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p, 'utf8').trim() || null
  } catch { return null }
}
