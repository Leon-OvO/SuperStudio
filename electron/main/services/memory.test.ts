import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import initSqlJs, { type Database } from 'sql.js'
import path from 'path'

/**
 * Tests for the memory auto-cleanup (two-stage decay) + batch delete.
 * Backed by a REAL in-memory sql.js DB so the SQL (COALESCE / NOT EXEMPT / soft-cap
 * ORDER BY / grace delete) is exercised for real, with no Electron dependency.
 */

const H = vi.hoisted(() => ({ db: null as unknown as Database }))

vi.mock('../db/sqlite', () => ({
  dbRun: (sql: string, params: unknown[] = []) => { H.db.run(sql, params as never) },
  dbAll: (sql: string, params: unknown[] = []) => {
    const stmt = H.db.prepare(sql)
    stmt.bind(params as never)
    const rows: unknown[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  },
  dbGet: (sql: string, params: unknown[] = []) => {
    const stmt = H.db.prepare(sql)
    stmt.bind(params as never)
    const r = stmt.step() ? stmt.getAsObject() : null
    stmt.free()
    return r
  },
}))
// Keep module load light: memory.ts pulls these at top level but cleanup never uses them.
vi.mock('./store', () => ({ getSettings: () => ({}) }))
vi.mock('./llm', () => ({ createLLMClient: () => ({}) }))

import { pruneMemories, deleteMemories, deleteArchived, listMemories } from './memory'

const DAY = 86_400_000
const NOW = 1_700_000_000_000 // fixed clock for created/updated timestamps
const daysAgo = (n: number): number => NOW - n * DAY

let seq = 0
interface RowInit {
  id?: string; kind: string; scope_key?: string | null; source?: string
  pinned?: number; status?: string; confidence?: number | null
  created_at?: number; updated_at?: number; last_used_at?: number | null; use_count?: number
}
function insert(r: RowInit): string {
  const id = r.id ?? `m${++seq}`
  H.db.run(
    `INSERT INTO memories (id,kind,scope_key,title,content,tags,source,pinned,status,confidence,created_at,updated_at,last_used_at,use_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, r.kind, r.scope_key ?? null, `t-${id}`, 'c', '[]', r.source ?? 'session:x',
     r.pinned ?? 0, r.status ?? 'active', r.confidence ?? null,
     r.created_at ?? NOW, r.updated_at ?? NOW, r.last_used_at ?? null, r.use_count ?? 0] as never
  )
  return id
}
const statusOf = (id: string): string | undefined =>
  (H.db.exec(`SELECT status FROM memories WHERE id='${id}'`)[0]?.values[0]?.[0] as string | undefined)
const exists = (id: string): boolean =>
  (H.db.exec(`SELECT 1 FROM memories WHERE id='${id}'`).length > 0)

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: () => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  })
  H.db = new SQL.Database()
  H.db.run(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_key TEXT, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', tags TEXT, source TEXT,
      pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      confidence REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0
    );
  `)
})

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  H.db.run('DELETE FROM memories')
  seq = 0
})

describe('pruneMemories — exemptions (four classes never touched)', () => {
  it('never archives pinned / profile / correction / manual / imported, however old', () => {
    const pinned = insert({ kind: 'episode', pinned: 1, last_used_at: daysAgo(500) })
    const profile = insert({ kind: 'profile', created_at: daysAgo(500), source: 'session:x' })
    const correction = insert({ kind: 'correction', created_at: daysAgo(500), source: 'correction' })
    const manual = insert({ kind: 'episode', source: 'manual', last_used_at: daysAgo(500) })
    const imported = insert({ kind: 'skill', source: 'import:foo.json', use_count: 0, created_at: daysAgo(500) })

    const res = pruneMemories()
    expect(res.archived).toBe(0)
    for (const id of [pinned, profile, correction, manual, imported]) expect(statusOf(id)).toBe('active')
  })
})

describe('pruneMemories — stage 1 TTL archive', () => {
  it('archives episodes idle >45d (by last_used_at, else created_at) and keeps fresher ones', () => {
    const stale = insert({ kind: 'episode', last_used_at: daysAgo(46) })
    const fresh = insert({ kind: 'episode', last_used_at: daysAgo(44) })
    const staleByCreated = insert({ kind: 'episode', last_used_at: null, created_at: daysAgo(46) })

    pruneMemories()
    expect(statusOf(stale)).toBe('archived')
    expect(statusOf(staleByCreated)).toBe('archived')
    expect(statusOf(fresh)).toBe('active')
  })

  it('archives never-used skills older than 90d, keeps used or newer skills', () => {
    const unusedOld = insert({ kind: 'skill', use_count: 0, created_at: daysAgo(91) })
    const usedOld = insert({ kind: 'skill', use_count: 3, created_at: daysAgo(200) })
    const unusedNew = insert({ kind: 'skill', use_count: 0, created_at: daysAgo(89) })

    pruneMemories()
    expect(statusOf(unusedOld)).toBe('archived')
    expect(statusOf(usedOld)).toBe('active')
    expect(statusOf(unusedNew)).toBe('active')
  })
})

describe('pruneMemories — stage 1 per-kind soft cap', () => {
  it('archives the lowest-value overflow when a kind exceeds its cap (episode=80)', () => {
    // 82 fresh episodes (created NOW so TTL never fires) → 2 must be archived.
    const ids: string[] = []
    for (let i = 0; i < 82; i++) ids.push(insert({ kind: 'episode', use_count: i, created_at: NOW }))

    const res = pruneMemories()
    expect(res.archived).toBe(2)
    // lowest use_count (0,1) are the ones archived
    expect(statusOf(ids[0])).toBe('archived')
    expect(statusOf(ids[1])).toBe('archived')
    expect(statusOf(ids[2])).toBe('active')
    expect(listMemories({ kind: 'episode', status: 'active' }).length).toBe(80)
  })
})

describe('pruneMemories — stage 2 grace hard-delete', () => {
  it('deletes archived rows older than 30d, keeps those within grace and exempt ones', () => {
    const old = insert({ kind: 'episode', status: 'archived', updated_at: daysAgo(31) })
    const recent = insert({ kind: 'episode', status: 'archived', updated_at: daysAgo(29) })
    const pinnedArchived = insert({ kind: 'episode', status: 'archived', pinned: 1, updated_at: daysAgo(100) })

    const res = pruneMemories()
    expect(res.deleted).toBe(1)
    expect(exists(old)).toBe(false)
    expect(exists(recent)).toBe(true)
    expect(exists(pinnedArchived)).toBe(true)
  })
})

describe('deleteMemories — explicit batch (no exemption)', () => {
  it('hard-deletes exactly the ids given, even pinned ones', () => {
    const a = insert({ kind: 'episode' })
    const b = insert({ kind: 'episode', pinned: 1 })
    const c = insert({ kind: 'skill' })

    const n = deleteMemories([a, c])
    expect(n).toBe(2)
    expect(exists(a)).toBe(false)
    expect(exists(b)).toBe(true)
    expect(exists(c)).toBe(false)
    expect(deleteMemories([])).toBe(0)
  })
})

describe('deleteArchived — empty trash (spares exempt)', () => {
  it('deletes archived rows of a kind but keeps pinned/manual and active rows', () => {
    const archivedSession = insert({ kind: 'episode', status: 'archived' })
    const archivedPinned = insert({ kind: 'episode', status: 'archived', pinned: 1 })
    const archivedManual = insert({ kind: 'episode', status: 'archived', source: 'manual' })
    const activeOne = insert({ kind: 'episode', status: 'active' })
    const otherKind = insert({ kind: 'skill', status: 'archived' })

    const n = deleteArchived('episode' as never)
    expect(n).toBe(1)
    expect(exists(archivedSession)).toBe(false)
    expect(exists(archivedPinned)).toBe(true)
    expect(exists(archivedManual)).toBe(true)
    expect(exists(activeOne)).toBe(true)
    expect(exists(otherKind)).toBe(true) // kind filter
  })
})
