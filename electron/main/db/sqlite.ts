import initSqlJs, { Database } from 'sql.js'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { BRAND } from '../../../src/shared/brand'

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
  // Per-brand DB filename so SuperStudio and DWork never open the SAME file when
  // they share a custom dataDirectory (sql.js rewrites the whole file on save →
  // last-writer-wins corruption). SuperStudio's namespace IS "superstudio.db", so
  // it's unchanged; DWork uses "dwork.db", seeded once from the shared legacy DB.
  dbPath = path.join(baseDir, `${BRAND.dataNamespace}.db`)
  const legacyDbPath = path.join(baseDir, 'superstudio.db')
  if (BRAND.dataNamespace !== 'superstudio' && !fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    try { fs.copyFileSync(legacyDbPath, dbPath); console.log('[db] seeded', dbPath, 'from legacy', legacyDbPath) }
    catch (e) { console.warn('[db] legacy DB seed failed:', (e as Error).message) }
  }
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
      finished_at INTEGER,
      assignee_employee_id TEXT
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

    -- AI Company: a company is the top-level org owning the employee roster
    -- (cross-project assets). Default single "我的工作室" seeded on first use.
    CREATE TABLE IF NOT EXISTS companies (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- AI Company: an employee = a hired soul (talent-pool persona) with a chosen
    -- underlying model. soul_id references the encrypted talent catalog id.
    CREATE TABLE IF NOT EXISTS employees (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      soul_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      dept        TEXT NOT NULL,
      avatar      TEXT,
      provider_id TEXT,
      model_id    TEXT,
      status      TEXT NOT NULL DEFAULT 'idle',   -- idle | busy
      stats       TEXT NOT NULL DEFAULT '{}',      -- JSON EmployeeStats
      hired_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);

    -- AI Company: user-imported souls. The bundled persona catalog ships as an
    -- encrypted read-only bundle; THIS table holds personas the user imported
    -- from external soul.md files (plain text, the user's own assets). The
    -- talent source merges these into the in-memory catalog so they appear in
    -- the market and can be hired exactly like bundled souls. Columns mirror
    -- TalentEntry; tools is a JSON string[].
    CREATE TABLE IF NOT EXISTS user_souls (
      id            TEXT PRIMARY KEY,                 -- local/<name>-<hash>
      source        TEXT NOT NULL DEFAULT 'imported',
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      dept          TEXT NOT NULL DEFAULT 'engineering',
      tools         TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
      rec_model     TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      origin_path   TEXT,
      imported_at   INTEGER NOT NULL
    );

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

    -- Long-term memory (Hermes-style). Replaces the vector knowledge base.
    -- One row per memory, discriminated by kind:
    --   profile  — durable facts about the user (global, scope_key NULL)
    --   project  — facts/decisions for a company(Vibe) project (scope_key = vibe_projects.path)
    --   episode  — summary of a past chat session (scope_key = session id)
    --   skill    — a reusable how-to distilled from solving something (scope_key NULL or project path)
    -- Recall is lightweight: scope + tag-keyword hits + recency + pinned (NO vectors / NO FTS).
    -- tags is a JSON string[] assigned at capture so recall can match without CJK tokenization.
    CREATE TABLE IF NOT EXISTS memories (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      scope_key    TEXT,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      tags         TEXT,                              -- JSON string[]
      source       TEXT,                              -- 'session:<id>' | 'request:<id>' | 'manual'
      pinned       INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'archived'
      confidence   REAL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mem_kind_scope ON memories(kind, scope_key, status);
    CREATE INDEX IF NOT EXISTS idx_mem_recent ON memories(updated_at);
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
  // v9: AI Company — a requirement can be assigned to an employee, whose soul
  // persona + chosen model drives that request's task execution.
  try { db.run(`ALTER TABLE vibe_requests ADD COLUMN assignee_employee_id TEXT`) } catch { /* already exists */ }
  // v10: 子任务级派活 —— 每个 vibe_task 可由不同员工承接（一需求多员工并行）。
  // null = 回退到 request.assignee_employee_id 或默认模型。
  try { db.run(`ALTER TABLE vibe_tasks ADD COLUMN assignee_employee_id TEXT`) } catch { /* already exists */ }
  // v11: 子任务依赖 DAG —— deps 存「必须先完成」的前置任务 id 数组（JSON）。
  // 空 / NULL = 无依赖，可与同批任务并行。apply 阶段据此用 topologicalLevels 分层
  // 执行（层内并行、层间串行），取代「无脑全并发」，让有先后顺序的任务正确排队。
  try { db.run(`ALTER TABLE vibe_tasks ADD COLUMN deps TEXT`) } catch { /* already exists */ }
  // 逐任务回滚：revert_info 存 { cp: 改动前快照 id, files: 本任务碰过的相对路径[] }（JSON），
  // 让「撤销此任务改动」只还原本任务的文件、保留同批其他任务的成果。
  try { db.run(`ALTER TABLE vibe_tasks ADD COLUMN revert_info TEXT`) } catch { /* already exists */ }
  // v12: long-term memory replaced the vector knowledge base — drop legacy KB
  // tables (their data lived only here; vectors were in a separate lancedb dir).
  try { db.run(`DROP TABLE IF EXISTS kb_pages`) } catch { /* ignore */ }
  try { db.run(`DROP TABLE IF EXISTS kb_sources`) } catch { /* ignore */ }
  try { db.run(`DROP TABLE IF EXISTS kb_spaces`) } catch { /* ignore */ }
  // v13: scheduled tasks can run in 电脑操控 (computer-use) mode — the timed run
  // drives the desktop via the screenshot loop instead of a plain chat reply.
  // Unattended, so it auto-arms (no confirm dialog); still gated behind the
  // global computerUseEnabled switch. 0 = normal chat run, 1 = computer-use.
  try { db.run(`ALTER TABLE scheduled_tasks ADD COLUMN computer_mode INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // v14: per-session 工作目录 (opt-in). The absolute path the user pinned for a
  // conversation: the agent default-saves new files there, registers it as an
  // approved root (whole subtree read/write), and exposes list_dir so the model
  // can discover what's inside. NULL/'' = unset → fall back to the desktop default.
  try { db.run(`ALTER TABLE sessions ADD COLUMN working_dir TEXT`) } catch { /* already exists */ }
  // v15: 工作台对话支持附件 —— 用户消息可附图片/文件。存 JSON 数组
  // [{name,path,mimeType}]；NULL = 无附件。图片在运行时 inline 给视觉模型，
  // 文件以绝对路径清单注入，与「对话」页一致。
  try { db.run(`ALTER TABLE vibe_messages ADD COLUMN attachments TEXT`) } catch { /* already exists */ }
  // v16: 对话会话可绑定一名已入职员工 —— 注入其岗位人格(soul)且默认用其模型，
  // 实现「找某员工单独训话/咨询」。NULL = 普通对话（不绑定）。
  try { db.run(`ALTER TABLE sessions ADD COLUMN employee_id TEXT`) } catch { /* already exists */ }
  // v17: 员工群聊 —— 一个会话可由多名员工参与，彼此能看到对方发言并轮流回应。
  // 存 JSON 数组 [employeeId,...]；非空 ⇒ 这是群聊（员工单聊仍用 employee_id 单值）。
  try { db.run(`ALTER TABLE sessions ADD COLUMN group_employee_ids TEXT`) } catch { /* already exists */ }
  // v18: 群聊里每条 assistant 消息标明是哪位员工说的，渲染层据此显示发言者头像+名字。
  // NULL = 普通/单聊助手消息（无需区分发言者）。
  try { db.run(`ALTER TABLE messages ADD COLUMN speaker_employee_id TEXT`) } catch { /* already exists */ }
  // v19: 图片创作画布 —— 一次「批量场景出图」产出的多张图属于同一变体组，按场景标注，
  // 供画布回显与素材库分组/导出。NULL = 非画布批量产物。
  try { db.run(`ALTER TABLE gallery ADD COLUMN variant_group_id TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE gallery ADD COLUMN scene_label TEXT`) } catch { /* already exists */ }
  // v20: 区分「工作流」与「图片画布」—— 两者共用 workflows 表与执行引擎，用 kind 分流，
  // 列表各管各的。NULL/'workflow' = 自动化工作流；'canvas' = 图片创作画布。
  try { db.run(`ALTER TABLE workflows ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow'`) } catch { /* already exists */ }
  // v21: 会话置顶 —— 置顶的会话排在列表最前的「置顶」区，且不参与自动归档。
  // 1 = 置顶；0/NULL = 普通。
  try { db.run(`ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0`) } catch { /* already exists */ }
  // v22: 群聊「主持人持续推进」—— host_mode=1 时主持人会一轮接一轮自动推进到需求完成或
  // 达上限；group_goal 记下用户的需求(目标),供主持人跨多轮始终对齐。0/NULL = 旧的单轮行为。
  try { db.run(`ALTER TABLE sessions ADD COLUMN host_mode INTEGER DEFAULT 0`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE sessions ADD COLUMN group_goal TEXT`) } catch { /* already exists */ }
  // v23: 对话自动学习 —— 从对话蒸馏可装载的 SKILL 技能(origin='auto')，并给所有技能加
  // 生命周期态 + 使用计数，支撑「检测→起草→校验→采纳→召回→进化」回路。status:
  // 'active'(进 run) | 'pending'(待审) | 'deprecated'(停用，存档不删)。confidence =
  // 成熟度(可塑↔稳定门控)。skill_events 记 A1/A2 信号(load/success/fail)。
  try { db.run(`ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN source_memory_id TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN induced_version INTEGER NOT NULL DEFAULT 1`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN body_hash TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN trigger_reason TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN induced_from TEXT`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN times_loaded INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN times_succeeded INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN times_failed INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN last_used_at INTEGER`) } catch { /* already exists */ }
  try { db.run(`ALTER TABLE skills ADD COLUMN confidence REAL`) } catch { /* already exists */ }
  try {
    db.run(`CREATE TABLE IF NOT EXISTS skill_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id   TEXT NOT NULL,
      session_id TEXT,
      ts         INTEGER NOT NULL,
      kind       TEXT NOT NULL,                 -- 'load' | 'success' | 'fail'
      artifacts  INTEGER NOT NULL DEFAULT 0     -- A1 signal: artifact count produced that run
    )`)
  } catch { /* already exists */ }
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_skill_events_skill ON skill_events(skill_id, ts)`) } catch { /* already exists */ }
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
