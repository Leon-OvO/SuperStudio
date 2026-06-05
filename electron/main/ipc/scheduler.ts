import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import {
  IPC,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskInput,
  type ScheduleKind,
  type ScheduleValue,
  type ScheduledRunStatus
} from '../../../src/shared/ipc-types'
import { dbAll, dbGet, dbRun } from '../db/sqlite'
import { computeNextFireAt, validateScheduleValue } from '../services/scheduler-time'
import { triggerNow } from '../services/scheduler'

const TASK_LIMIT = 20

interface TaskRow {
  id: string
  name: string
  prompt: string
  schedule_kind: string
  schedule_value: string
  session_id: string | null
  provider_id: string | null
  model: string | null
  webhook_bot_id: string | null
  computer_mode: number
  enabled: number
  last_fired_at: number | null
  next_fire_at: number
  consecutive_failures: number
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  task_id: string
  fired_at: number
  status: string
  duration_ms: number | null
  cost: number | null
  error: string | null
  message_id: string | null
}

export function schedulerHandlers(): void {
  ipcMain.handle(IPC.SCHEDULER_LIST, () => {
    const rows = dbAll<TaskRow>(
      `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
              webhook_bot_id, computer_mode, enabled, last_fired_at, next_fire_at, consecutive_failures, created_at, updated_at
       FROM scheduled_tasks ORDER BY created_at DESC`
    )
    return rows.map(rowToTask)
  })

  ipcMain.handle(IPC.SCHEDULER_GET, (_e, id: string) => {
    const row = dbGet<TaskRow>(
      `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
              webhook_bot_id, computer_mode, enabled, last_fired_at, next_fire_at, consecutive_failures, created_at, updated_at
       FROM scheduled_tasks WHERE id = ?`,
      [id]
    )
    return row ? rowToTask(row) : null
  })

  ipcMain.handle(IPC.SCHEDULER_CREATE, (_e, input: ScheduledTaskInput) => {
    const total = countTasks()
    if (total >= TASK_LIMIT) {
      throw new Error(`最多 ${TASK_LIMIT} 个任务。删除或暂停一些再试。`)
    }
    validateInput(input)

    const id = randomUUID()
    const now = Date.now()
    const enabled = input.enabled !== false // default true
    const next = computeNextFireAt(input.scheduleKind, input.scheduleValue, new Date(now))

    // Auto-create dedicated session when enabled = true on first save.
    let sessionId: string | null = null
    if (enabled) {
      sessionId = createDedicatedSession(input.name)
    }

    dbRun(
      `INSERT INTO scheduled_tasks (
         id, name, prompt, schedule_kind, schedule_value, session_id,
         provider_id, model, webhook_bot_id, computer_mode, enabled, last_fired_at, next_fire_at,
         consecutive_failures, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      [
        id, input.name, input.prompt, input.scheduleKind, JSON.stringify(input.scheduleValue),
        sessionId, input.providerId ?? null, input.model ?? null, input.webhookBotId ?? null,
        input.computerMode ? 1 : 0, enabled ? 1 : 0, next, now, now
      ]
    )
    return rowToTask(loadRowOrThrow(id))
  })

  ipcMain.handle(IPC.SCHEDULER_UPDATE, (_e, id: string, input: ScheduledTaskInput) => {
    const existing = dbGet<TaskRow>(`SELECT * FROM scheduled_tasks WHERE id = ?`, [id])
    if (!existing) throw new Error(`task not found: ${id}`)
    validateInput(input)

    const now = Date.now()
    // Recompute next_fire_at if either kind or value changed.
    const kindChanged = existing.schedule_kind !== input.scheduleKind
    const valueChanged = existing.schedule_value !== JSON.stringify(input.scheduleValue)
    const next = (kindChanged || valueChanged)
      ? computeNextFireAt(input.scheduleKind, input.scheduleValue, new Date(now))
      : existing.next_fire_at

    dbRun(
      `UPDATE scheduled_tasks SET
         name = ?, prompt = ?, schedule_kind = ?, schedule_value = ?,
         provider_id = ?, model = ?, webhook_bot_id = ?, computer_mode = ?, next_fire_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name, input.prompt, input.scheduleKind, JSON.stringify(input.scheduleValue),
        input.providerId ?? null, input.model ?? null, input.webhookBotId ?? null,
        input.computerMode ? 1 : 0, next, now, id
      ]
    )
    return rowToTask(loadRowOrThrow(id))
  })

  ipcMain.handle(IPC.SCHEDULER_DELETE, (_e, id: string) => {
    // Dedicated chat now lives inside the task's detail view (not the chat
    // list), so deleting the task must also delete its session + messages —
    // otherwise they become unreachable orphans. Confirm copy in TaskList
    // tells the user this.
    const existing = dbGet<{ session_id: string | null }>(
      `SELECT session_id FROM scheduled_tasks WHERE id = ?`,
      [id]
    )
    // scheduled_task_runs CASCADE deletes via FK on the task row.
    dbRun(`DELETE FROM scheduled_tasks WHERE id = ?`, [id])
    if (existing?.session_id) {
      dbRun(`DELETE FROM messages WHERE session_id = ?`, [existing.session_id])
      dbRun(`DELETE FROM sessions WHERE id = ?`, [existing.session_id])
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.SCHEDULER_SET_ENABLED, (_e, id: string, enabled: boolean) => {
    const existing = dbGet<TaskRow>(`SELECT * FROM scheduled_tasks WHERE id = ?`, [id])
    if (!existing) throw new Error(`task not found: ${id}`)

    const now = Date.now()
    let sessionId = existing.session_id

    if (enabled) {
      // If we never created a session, or the user manually deleted it from
      // the sidebar, rebuild a fresh dedicated session now.
      if (!sessionId || !sessionExists(sessionId)) {
        sessionId = createDedicatedSession(existing.name)
      }
      // Reset next_fire_at to the next future occurrence so we don't fire
      // immediately on re-enable.
      const next = computeNextFireAt(
        existing.schedule_kind as ScheduleKind,
        JSON.parse(existing.schedule_value) as ScheduleValue,
        new Date(now)
      )
      dbRun(
        `UPDATE scheduled_tasks SET enabled = 1, session_id = ?, next_fire_at = ?,
                consecutive_failures = 0, updated_at = ? WHERE id = ?`,
        [sessionId, next, now, id]
      )
    } else {
      dbRun(
        `UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?`,
        [now, id]
      )
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.SCHEDULER_TRIGGER_NOW, async (_e, id: string) => {
    await triggerNow(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.SCHEDULER_LIST_RUNS, (_e, taskId: string, limit = 30) => {
    const rows = dbAll<RunRow>(
      `SELECT id, task_id, fired_at, status, duration_ms, cost, error, message_id
       FROM scheduled_task_runs WHERE task_id = ?
       ORDER BY fired_at DESC LIMIT ?`,
      [taskId, Math.min(Math.max(limit, 1), 200)]
    )
    return rows.map(rowToRun)
  })
}

function countTasks(): number {
  const r = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM scheduled_tasks`)
  return r?.c ?? 0
}

function validateInput(input: ScheduledTaskInput): void {
  if (!input || typeof input !== 'object') throw new Error('input is required')
  if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('name 不能为空')
  if (input.name.length > 60) throw new Error('name 太长（最多 60 字符）')
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('prompt 不能为空')
  if (!['daily', 'weekly', 'monthly'].includes(input.scheduleKind)) {
    throw new Error(`schedule_kind 只能是 daily / weekly / monthly`)
  }
  const err = validateScheduleValue(input.scheduleKind, input.scheduleValue)
  if (err) throw new Error('schedule_value 不合法：' + err)
}

function createDedicatedSession(taskName: string): string {
  const id = randomUUID()
  const now = Date.now()
  dbRun(
    `INSERT INTO sessions (id, title, created_at, updated_at, is_scheduled) VALUES (?, ?, ?, ?, 1)`,
    [id, taskName, now, now]
  )
  return id
}

function sessionExists(sessionId: string): boolean {
  const r = dbGet(`SELECT id FROM sessions WHERE id = ?`, [sessionId])
  return !!r
}

function loadRowOrThrow(id: string): TaskRow {
  const row = dbGet<TaskRow>(
    `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
            webhook_bot_id, enabled, last_fired_at, next_fire_at, consecutive_failures, created_at, updated_at
     FROM scheduled_tasks WHERE id = ?`,
    [id]
  )
  if (!row) throw new Error(`task not found after write: ${id}`)
  return row
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    scheduleKind: row.schedule_kind as ScheduleKind,
    scheduleValue: JSON.parse(row.schedule_value) as ScheduleValue,
    sessionId: row.session_id,
    providerId: row.provider_id,
    model: row.model,
    webhookBotId: row.webhook_bot_id,
    computerMode: row.computer_mode === 1,
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToRun(row: RunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    firedAt: row.fired_at,
    status: row.status as ScheduledRunStatus,
    durationMs: row.duration_ms,
    cost: row.cost,
    error: row.error,
    messageId: row.message_id
  }
}
