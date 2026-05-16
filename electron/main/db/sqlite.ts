import initSqlJs, { Database } from 'sql.js'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

let db: Database
let dbPath: string

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export async function initDb(dataDir?: string): Promise<void> {
  const baseDir = dataDir || app.getPath('userData')
  fs.mkdirSync(baseDir, { recursive: true })
  dbPath = path.join(baseDir, 'superstudio.db')
  console.log('[db] using database at', dbPath)

  const wasmPath = path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath })

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run('PRAGMA foreign_keys = ON')
  createTables()
  applyMigrations()
  saveDb()
  cleanOldBackups(baseDir)
}

export function saveDb(): void {
  if (!db || !dbPath) return
  const data = db.export()
  fs.writeFileSync(dbPath, Buffer.from(data))
}

function createTables(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      attachments TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      session_id TEXT,
      workflow_id TEXT,
      model_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(created_at);
    CREATE INDEX IF NOT EXISTS idx_gallery_type ON gallery(type);

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      definition TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      global_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_pages (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      source_type TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `)
  saveDb()
}

function applyMigrations(): void {
  // v1: message metadata column
  try { db.run(`ALTER TABLE messages ADD COLUMN meta TEXT`) } catch { /* already exists */ }
  // v2: session archive flag — soft-delete style. Lets users hide noisy
  // sessions without losing history, and provides a recoverable trash bucket.
  try { db.run(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
}

// Helper: run a query and save
export function dbRun(sql: string, params: unknown[] = []): void {
  db.run(sql, params as (string | number | null | Uint8Array)[])
  saveDb()
}

// Helper: query rows as objects
export function dbAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql)
  stmt.bind(params as (string | number | null | Uint8Array)[])
  const rows: T[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return rows
}

// Helper: query single row
export function dbGet<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const rows = dbAll<T>(sql, params)
  return rows[0] ?? null
}

function cleanOldBackups(baseDir: string): void {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  try {
    const backupDir = path.join(baseDir, '.backup')
    if (!fs.existsSync(backupDir)) return
    for (const file of fs.readdirSync(backupDir)) {
      const fullPath = path.join(backupDir, file)
      if (fs.statSync(fullPath).mtimeMs < thirtyDaysAgo) {
        fs.unlinkSync(fullPath)
      }
    }
  } catch {
    // ignore cleanup errors
  }
}
