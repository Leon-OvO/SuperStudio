/**
 * SQLite DAL for the Vibe / Build page.
 *
 * Tables:
 *   vibe_projects   — per-project metadata (model preference, last opened)
 *   vibe_requests   — change requests filed against a project (the "requirement")
 *   vibe_tasks      — individual implementation tasks under a request
 *   vibe_messages   — chat/tool log per request
 */

import { randomUUID } from 'crypto'
import path from 'path'
import { dbRun, dbAll, dbGet } from '../db/sqlite'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VibeProjectRow {
  path: string
  name: string
  provider_id: string | null
  model_id: string | null
  created_at: number
  last_opened_at: number
}

export type RequestStatus = 'draft' | 'proposed' | 'applying' | 'done' | 'archived'
export type RequestKind = 'explore' | 'change' | 'bugfix' | 'chat'

export interface VibeRequestRow {
  id: string
  project_path: string
  slug: string
  title: string
  summary: string
  status: RequestStatus
  kind: RequestKind
  created_at: number
  /** AI-company employee承接该需求；null = 未指派（PM/默认模型执行）。 */
  assignee_employee_id?: string | null
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface VibeTaskRow {
  id: string
  request_id: string
  ord: number
  title: string
  description: string
  status: TaskStatus
  error_text: string | null
  started_at: number | null
  finished_at: number | null
  /** 子任务级承接员工；null = 回退 request.assignee 或默认模型。 */
  assignee_employee_id?: string | null
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface VibeMessageRow {
  id: string
  request_id: string
  role: MessageRole
  content: string
  tool_name: string | null
  tool_args: string | null
  is_error: number
  task_id: string | null
  created_at: number
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  model: string | null
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function upsertProject(projectPath: string): VibeProjectRow {
  const abs = path.resolve(projectPath)
  const now = Date.now()
  const existing = dbGet<VibeProjectRow>(`SELECT * FROM vibe_projects WHERE path = ?`, [abs])
  if (existing) {
    dbRun(`UPDATE vibe_projects SET last_opened_at = ? WHERE path = ?`, [now, abs])
    return { ...existing, last_opened_at: now }
  }
  const name = path.basename(abs)
  dbRun(
    `INSERT INTO vibe_projects (path, name, provider_id, model_id, created_at, last_opened_at)
     VALUES (?, ?, NULL, NULL, ?, ?)`,
    [abs, name, now, now]
  )
  return { path: abs, name, provider_id: null, model_id: null, created_at: now, last_opened_at: now }
}

export function getProject(projectPath: string): VibeProjectRow | null {
  return dbGet<VibeProjectRow>(`SELECT * FROM vibe_projects WHERE path = ?`, [path.resolve(projectPath)])
}

export function setProjectModel(projectPath: string, providerId: string, modelId: string): void {
  dbRun(
    `UPDATE vibe_projects SET provider_id = ?, model_id = ? WHERE path = ?`,
    [providerId, modelId, path.resolve(projectPath)]
  )
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  const base = title.toLowerCase()
    .replace(/[^a-z0-9一-鿿\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || `change-${Date.now().toString(36)}`
}

export function createRequest(args: {
  projectPath: string
  slug: string
  title: string
  summary: string
  kind?: RequestKind  // default 'change' for backward compat
}): VibeRequestRow {
  const projectPath = path.resolve(args.projectPath)
  let slug = args.slug
  let attempt = 0
  while (dbGet(`SELECT id FROM vibe_requests WHERE project_path = ? AND slug = ?`, [projectPath, slug])) {
    attempt++
    slug = `${args.slug}-${attempt}`
  }
  const id = randomUUID()
  const now = Date.now()
  const kind: RequestKind = args.kind ?? 'change'
  // explore/chat/bugfix don't go through propose/apply lifecycle — status stays 'draft'
  // only 'change' kind starts at 'proposed' (tasks already generated)
  const status: RequestStatus = kind === 'change' ? 'proposed' : 'draft'
  dbRun(
    `INSERT INTO vibe_requests (id, project_path, slug, title, summary, status, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectPath, slug, args.title, args.summary, status, kind, now]
  )
  return { id, project_path: projectPath, slug, title: args.title, summary: args.summary, status, kind, created_at: now }
}

export function listRequests(projectPath: string): VibeRequestRow[] {
  return dbAll<VibeRequestRow>(
    `SELECT * FROM vibe_requests WHERE project_path = ? ORDER BY created_at DESC`,
    [path.resolve(projectPath)]
  )
}

export function getRequest(id: string): VibeRequestRow | null {
  return dbGet<VibeRequestRow>(`SELECT * FROM vibe_requests WHERE id = ?`, [id])
}

/** All requests across every project — for the company-wide 看板. */
export function listAllRequests(): VibeRequestRow[] {
  return dbAll<VibeRequestRow>(`SELECT * FROM vibe_requests ORDER BY created_at DESC`)
}

/** Per-request task counts (done/total/running/error) — one GROUP BY pass, so
 *  the 看板 can show 大需求 → 子任务 progress without an N+1 of vibeTaskList. */
export function taskRollupByRequest(): Record<string, { total: number; done: number; running: number; error: number }> {
  const rows = dbAll<{ request_id: string; total: number; done: number; running: number; error: number }>(
    `SELECT request_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
       FROM vibe_tasks GROUP BY request_id`
  )
  const map: Record<string, { total: number; done: number; running: number; error: number }> = {}
  for (const r of rows) map[r.request_id] = { total: r.total, done: r.done, running: r.running, error: r.error }
  return map
}

export function updateRequestStatus(id: string, status: RequestStatus): void {
  dbRun(`UPDATE vibe_requests SET status = ? WHERE id = ?`, [status, id])
}

export function setRequestAssignee(id: string, employeeId: string | null): void {
  dbRun(`UPDATE vibe_requests SET assignee_employee_id = ? WHERE id = ?`, [employeeId, id])
}

export function deleteRequest(id: string): void {
  // Cascade manually since we don't have FK enforcement in sql.js
  dbRun(`DELETE FROM vibe_messages WHERE request_id = ?`, [id])
  dbRun(`DELETE FROM vibe_tasks WHERE request_id = ?`, [id])
  dbRun(`DELETE FROM vibe_requests WHERE id = ?`, [id])
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function createTask(args: {
  requestId: string
  ord: number
  title: string
  description: string
  assigneeEmployeeId?: string | null
}): VibeTaskRow {
  const id = randomUUID()
  dbRun(
    `INSERT INTO vibe_tasks (id, request_id, ord, title, description, status, assignee_employee_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [id, args.requestId, args.ord, args.title, args.description, args.assigneeEmployeeId ?? null]
  )
  return {
    id, request_id: args.requestId, ord: args.ord, title: args.title,
    description: args.description, status: 'pending',
    assignee_employee_id: args.assigneeEmployeeId ?? null,
    error_text: null, started_at: null, finished_at: null
  }
}

export function getTask(taskId: string): VibeTaskRow | null {
  return dbGet<VibeTaskRow>(`SELECT * FROM vibe_tasks WHERE id = ?`, [taskId])
}

export function setTaskAssignee(taskId: string, employeeId: string | null): void {
  dbRun(`UPDATE vibe_tasks SET assignee_employee_id = ? WHERE id = ?`, [employeeId, taskId])
}

export function listTasks(requestId: string): VibeTaskRow[] {
  return dbAll<VibeTaskRow>(
    `SELECT * FROM vibe_tasks WHERE request_id = ? ORDER BY ord ASC`,
    [requestId]
  )
}

export function deleteTasksForRequest(requestId: string): void {
  dbRun(`DELETE FROM vibe_tasks WHERE request_id = ?`, [requestId])
}

export function updateRequestSummary(id: string, title: string, summary: string): void {
  dbRun(`UPDATE vibe_requests SET title = ?, summary = ? WHERE id = ?`, [title, summary, id])
}

export function updateTaskStatus(taskId: string, status: TaskStatus, error?: string): void {
  const now = Date.now()
  if (status === 'running') {
    dbRun(`UPDATE vibe_tasks SET status = ?, started_at = ?, error_text = NULL WHERE id = ?`, [status, now, taskId])
  } else if (status === 'done' || status === 'skipped') {
    dbRun(`UPDATE vibe_tasks SET status = ?, finished_at = ?, error_text = NULL WHERE id = ?`, [status, now, taskId])
  } else if (status === 'error') {
    dbRun(`UPDATE vibe_tasks SET status = ?, finished_at = ?, error_text = ? WHERE id = ?`, [status, now, error ?? '', taskId])
  } else {
    dbRun(`UPDATE vibe_tasks SET status = ?, started_at = NULL, finished_at = NULL, error_text = NULL WHERE id = ?`, [status, taskId])
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function appendMessage(args: {
  requestId: string
  role: MessageRole
  content: string
  toolName?: string
  toolArgs?: string
  isError?: boolean
  taskId?: string
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  model?: string | null
}): VibeMessageRow {
  const id = randomUUID()
  const now = Date.now()
  const inputTokens = args.inputTokens ?? null
  const outputTokens = args.outputTokens ?? null
  const costUsd = args.costUsd ?? null
  const model = args.model ?? null
  dbRun(
    `INSERT INTO vibe_messages
       (id, request_id, role, content, tool_name, tool_args, is_error, task_id, created_at,
        input_tokens, output_tokens, cost_usd, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, args.requestId, args.role, args.content,
      args.toolName ?? null, args.toolArgs ?? null,
      args.isError ? 1 : 0, args.taskId ?? null, now,
      inputTokens, outputTokens, costUsd, model
    ]
  )
  return {
    id, request_id: args.requestId, role: args.role, content: args.content,
    tool_name: args.toolName ?? null, tool_args: args.toolArgs ?? null,
    is_error: args.isError ? 1 : 0, task_id: args.taskId ?? null, created_at: now,
    input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, model
  }
}

export function listMessages(requestId: string): VibeMessageRow[] {
  return dbAll<VibeMessageRow>(
    `SELECT * FROM vibe_messages WHERE request_id = ? ORDER BY created_at ASC`,
    [requestId]
  )
}
