import { dbAll, dbRun } from '../db/sqlite'
import type { TalentEntry } from '../../../src/shared/ipc-types'

/**
 * Persistence for user-imported souls (see the `user_souls` table in sqlite.ts).
 * The bundled persona catalog is read-only encrypted content; these are the
 * user's own imported soul.md files, stored plain. talent-source.ts merges
 * listUserSouls() into the catalog so they browse / hire like any other talent.
 */

interface UserSoulRow {
  id: string
  source: string
  name: string
  description: string
  dept: string
  tools: string
  rec_model: string
  system_prompt: string
  origin_path: string | null
  imported_at: number
}

export interface NewUserSoul {
  name: string
  description: string
  dept: string
  tools: string[]
  recModel: string
  systemPrompt: string
  originPath?: string
}

function rowToEntry(r: UserSoulRow): TalentEntry {
  let tools: string[] = []
  try { tools = JSON.parse(r.tools || '[]') as string[] } catch { tools = [] }
  return {
    id: r.id,
    source: r.source,
    name: r.name,
    description: r.description,
    dept: r.dept,
    tools,
    recModel: r.rec_model,
    systemPrompt: r.system_prompt,
    imported: true,
  }
}

export function listUserSouls(): TalentEntry[] {
  return dbAll<UserSoulRow>(`SELECT * FROM user_souls ORDER BY imported_at DESC`).map(rowToEntry)
}

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

/** Restrict to a safe id charset so an imported name can't collide oddly; the
 *  `local/` namespace + a path-derived hash keep it distinct from bundled ids
 *  (`${pack}/${localId}`) and stable across re-imports of the same file. */
function makeId(name: string, originPath: string): string {
  const clean = (name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40).toLowerCase() || 'soul'
  return `local/${clean}-${shortHash(originPath || name)}`
}

/** Insert (or replace, keyed by stable id) imported souls. Re-importing the same
 *  file updates it in place; importing a different file with the same name makes
 *  a distinct entry (different origin path → different id). */
export function insertUserSouls(entries: NewUserSoul[]): { inserted: number } {
  const now = Date.now()
  let inserted = 0
  for (const e of entries) {
    if (!e.name.trim() || !e.systemPrompt.trim()) continue
    const id = makeId(e.name, e.originPath || e.name)
    dbRun(
      `INSERT OR REPLACE INTO user_souls (id, source, name, description, dept, tools, rec_model, system_prompt, origin_path, imported_at)
       VALUES (?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.name, e.description, e.dept, JSON.stringify(e.tools ?? []), e.recModel || '', e.systemPrompt, e.originPath ?? null, now]
    )
    inserted++
  }
  return { inserted }
}

export function deleteUserSoul(id: string): void {
  dbRun(`DELETE FROM user_souls WHERE id = ?`, [id])
}
