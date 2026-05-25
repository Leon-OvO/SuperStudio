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
  // mkdirSync({ recursive: true }) on an EXISTING drive root (e.g. "D:\") still
  // throws EPERM on Windows — a Node quirk; the recursive flag only no-ops for
  // existing non-root directories. Skip the mkdir entirely when the path
  // already exists so users who picked a drive root as their data directory
  // don't crash startup.
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true })
  }
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

    -- Vibe / Build page: project-level metadata
    CREATE TABLE IF NOT EXISTS vibe_projects (
      path           TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      provider_id    TEXT,
      model_id       TEXT,
      created_at     INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );

    -- Vibe: a "requirement" / change request the user filed against a project
    CREATE TABLE IF NOT EXISTS vibe_requests (
      id           TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      slug         TEXT NOT NULL,
      title        TEXT NOT NULL,
      summary      TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'draft',
      kind         TEXT NOT NULL DEFAULT 'change',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vibe_requests_project ON vibe_requests(project_path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vibe_requests_slug ON vibe_requests(project_path, slug);

    -- Vibe: individual tasks under a request (mirrors tasks.md on disk)
    CREATE TABLE IF NOT EXISTS vibe_tasks (
      id          TEXT PRIMARY KEY,
      request_id  TEXT NOT NULL,
      ord         INTEGER NOT NULL,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending',
      error_text  TEXT,
      started_at  INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vibe_tasks_request ON vibe_tasks(request_id, ord);

    -- Vibe: chat/tool message log per request
    CREATE TABLE IF NOT EXISTS vibe_messages (
      id         TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      tool_name  TEXT,
      tool_args  TEXT,
      is_error   INTEGER NOT NULL DEFAULT 0,
      task_id    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vibe_messages_request ON vibe_messages(request_id, created_at);

    -- Skills: installed prompt + tool-whitelist bundles. Per design:
    -- skill = a reusable persona/preset that combines a system-prompt fragment
    -- with an optional tool whitelist, optionally scoped to specific scenarios
    -- (chat / vibe / video). Enabled skills get auto-merged into the active
    -- LLM request for matching scenarios.
    CREATE TABLE IF NOT EXISTS skills (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      icon               TEXT NOT NULL DEFAULT '',         -- emoji or short token
      version            TEXT NOT NULL DEFAULT '0.0.0',
      author             TEXT NOT NULL DEFAULT '',
      system_prompt      TEXT NOT NULL DEFAULT '',         -- prompt fragment, merged at runtime
      tool_whitelist     TEXT,                             -- JSON array | null (null = all tools)
      starter_prompts    TEXT NOT NULL DEFAULT '[]',       -- JSON array of {label, prompt}
      homepage           TEXT,
      enabled            INTEGER NOT NULL DEFAULT 1,
      enabled_scenarios  TEXT NOT NULL DEFAULT '[]',       -- JSON array: ('chat'|'vibe'|'video')[]
      source_url         TEXT,                             -- where it was installed from
      installed_at       INTEGER NOT NULL
    );

    -- Skill registry sources: list of URLs pointing to skill manifest JSON
    -- documents. App ships a built-in entry; users can add more.
    CREATE TABLE IF NOT EXISTS skill_sources (
      url       TEXT PRIMARY KEY,
      name      TEXT NOT NULL DEFAULT '',
      enabled   INTEGER NOT NULL DEFAULT 1,
      builtin   INTEGER NOT NULL DEFAULT 0,                -- 1 = shipped with app, can't be deleted
      added_at  INTEGER NOT NULL
    );

    -- Scheduled prompts: user-defined daily/weekly/monthly triggers that
    -- automatically dispatch a prompt to a dedicated chat session while the
    -- app is running. schedule_value is JSON whose shape depends on
    -- schedule_kind (daily: {time}, weekly: {days, time}, monthly: {day, time}).
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      prompt               TEXT NOT NULL,
      schedule_kind        TEXT NOT NULL,
      schedule_value       TEXT NOT NULL,
      session_id           TEXT,
      provider_id          TEXT,
      model                TEXT,
      enabled              INTEGER NOT NULL DEFAULT 1,
      last_fired_at        INTEGER,
      next_fire_at         INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled, next_fire_at);

    -- Per-execution history for scheduled tasks. status:
    -- 'success' / 'failed' / 'aborted_no_window'. message_id links back to the
    -- chat messages row produced by the run (null for aborted runs).
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      fired_at    INTEGER NOT NULL,
      status      TEXT NOT NULL,
      duration_ms INTEGER,
      cost        REAL,
      error       TEXT,
      message_id  TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, fired_at);
  `)
  saveDb()
}

function applyMigrations(): void {
  // v1: message metadata column
  try { db.run(`ALTER TABLE messages ADD COLUMN meta TEXT`) } catch { /* already exists */ }
  // v2: session archive flag — soft-delete style. Lets users hide noisy
  // sessions without losing history, and provides a recoverable trash bucket.
  try { db.run(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // v3: distinguish quick chat vs structured change requests in the Vibe page.
  // 'chat' = simple Q&A with tools; 'change' = propose → tasks → apply.
  try { db.run(`ALTER TABLE vibe_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'change'`) } catch { /* already exists */ }
  // v4: mark built-in skills that ship with the app — they auto-install on
  // first launch and can't be uninstalled (only disabled).
  try { db.run(`ALTER TABLE skills ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // v5: per-message token + cost accounting. Lets the UI surface "this request
  // cost $0.0023" and aggregate per-session totals. Nullable everywhere
  // because old rows pre-date this feature.
  try { db.run(`ALTER TABLE messages ADD COLUMN input_tokens INTEGER`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE messages ADD COLUMN output_tokens INTEGER`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE messages ADD COLUMN cost_usd REAL`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE messages ADD COLUMN model TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE vibe_messages ADD COLUMN input_tokens INTEGER`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE vibe_messages ADD COLUMN output_tokens INTEGER`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE vibe_messages ADD COLUMN cost_usd REAL`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE vibe_messages ADD COLUMN model TEXT`) } catch { /* already exists */ }
  // v6: runtime skills — a skill is now a downloaded SKILL.md bundle on disk,
  // loaded progressively (name+description always in context, full body on
  // demand) instead of a single always-injected prompt string. Legacy
  // prompt-only skills keep runtime=0 and behave exactly as before.
  try { db.run(`ALTER TABLE skills ADD COLUMN runtime INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN slug TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN install_path TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN skill_body TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN resource_files TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN allow_scripts INTEGER NOT NULL DEFAULT 1`) } catch { /* already exists */ }
  // v7: scheduled prompts — flag dedicated sessions so SessionList can render
  // them under a separate "📅 定时" group, and so cascade rules (delete
  // dedicated session → auto-pause owning task) can target them.
  try { db.run(`ALTER TABLE sessions ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // v8: scheduled-task webhook notification — links a task to a globally
  // configured bot (DingTalk/Feishu/WeChat Work) by id; null = no notification.
  try { db.run(`ALTER TABLE scheduled_tasks ADD COLUMN webhook_bot_id TEXT`) } catch { /* already exists */ }
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
