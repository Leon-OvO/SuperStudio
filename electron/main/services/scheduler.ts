import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/sqlite'
import { computeNextFireAt } from './scheduler-time'
import { runAgent } from '../agent/engine'
import { getSettings } from './store'
import { sendWebhookNotification } from './webhook'
import {
  IPC,
  type ScheduledRunStatus,
  type ScheduleKind,
  type ScheduleValue,
  type ScheduledRunCompletedEvent
} from '../../../src/shared/ipc-types'

/**
 * Main-process scheduler for scheduled prompt tasks.
 *
 * Design notes (see openspec/changes/add-scheduled-prompts/design.md):
 *   - D1: setInterval(30s) tick, computeNextFireAt does the cron math.
 *   - D2: at fire time, call runAgent — fully reuses streaming / cost / persist.
 *   - D5: startup catch-up window = 24h.
 *   - D6: 5 consecutive failures → auto-disable + system notification.
 *
 * Concurrency model:
 *   - Same task: never more than one run in flight (`inFlight` set).
 *   - Different tasks: allowed to run in parallel (no global lock).
 */

const TICK_MS = 30_000
const FAILURE_THRESHOLD = 5
const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000

let tickTimer: ReturnType<typeof setInterval> | null = null
const inFlight = new Set<string>()

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
  enabled: number
  last_fired_at: number | null
  next_fire_at: number
  consecutive_failures: number
}

export function startScheduler(): void {
  if (tickTimer) return
  console.log('[scheduler] starting')
  // 1) Catch up on missed fires from the < 24h window.
  catchUpOnStartup()
  // 2) Start the periodic tick.
  tickTimer = setInterval(() => {
    tickOnce().catch(e => console.error('[scheduler] tick error:', e))
  }, TICK_MS)
  // First tick after a short delay so missed-on-boot tasks fire promptly
  // without waiting a full 30s after startup.
  setTimeout(() => {
    tickOnce().catch(e => console.error('[scheduler] first-tick error:', e))
  }, 2_000).unref?.()
}

export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
    console.log('[scheduler] stopped')
  }
}

/**
 * Manual "run now" — bypasses the cron schedule but otherwise behaves like a
 * normal tick-driven run (writes a run record, updates failure counter).
 * Does NOT modify next_fire_at: the next scheduled fire still happens on time.
 */
export async function triggerNow(taskId: string): Promise<void> {
  const row = loadTask(taskId)
  if (!row) throw new Error(`scheduled task not found: ${taskId}`)
  await executeTask(row, { isManual: true })
}

async function tickOnce(): Promise<void> {
  const now = Date.now()
  const due = dbAll<TaskRow>(
    `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
            webhook_bot_id, enabled, last_fired_at, next_fire_at, consecutive_failures
     FROM scheduled_tasks
     WHERE enabled = 1 AND next_fire_at <= ?
     ORDER BY next_fire_at ASC`,
    [now]
  )
  if (due.length === 0) return
  for (const row of due) {
    if (inFlight.has(row.id)) continue
    // Fire-and-forget per-task. Different tasks run in parallel; same task is
    // blocked by the inFlight set.
    executeTask(row, { isManual: false }).catch(e =>
      console.error('[scheduler] executeTask threw for', row.id, e)
    )
  }
}

function catchUpOnStartup(): void {
  const now = Date.now()
  const tasks = dbAll<TaskRow>(
    `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
            webhook_bot_id, enabled, last_fired_at, next_fire_at, consecutive_failures
     FROM scheduled_tasks
     WHERE enabled = 1`
  )
  for (const row of tasks) {
    const overdueBy = now - row.next_fire_at
    if (overdueBy <= 0) continue // future, nothing to do
    if (overdueBy <= CATCHUP_WINDOW_MS) {
      // < 24h overdue → fire once now, then advance.
      console.log('[scheduler] catch-up firing task', row.id, 'overdue by ms:', overdueBy)
      executeTask(row, { isManual: false }).catch(e =>
        console.error('[scheduler] catch-up executeTask threw for', row.id, e)
      )
    } else {
      // > 24h overdue → skip, just push forward to the next future occurrence
      // so the user doesn't get an avalanche after returning from vacation.
      console.log('[scheduler] skipping catch-up (>24h) for', row.id)
      try {
        const next = computeNextFireAt(
          row.schedule_kind as ScheduleKind,
          JSON.parse(row.schedule_value) as ScheduleValue,
          new Date(now)
        )
        dbRun(`UPDATE scheduled_tasks SET next_fire_at = ?, updated_at = ? WHERE id = ?`,
          [next, now, row.id])
      } catch (e) {
        console.error('[scheduler] failed to advance next_fire_at on >24h skip:', e)
      }
    }
  }
}

async function executeTask(row: TaskRow, opts: { isManual: boolean }): Promise<void> {
  if (inFlight.has(row.id)) return
  inFlight.add(row.id)
  const startedAt = Date.now()
  let status: ScheduledRunStatus = 'success'
  let errorText: string | null = null
  let messageIdAtStart: string | null = null

  try {
    const wins = BrowserWindow.getAllWindows()
    const mainWindow = wins.length > 0 ? wins[0] : null

    if (!mainWindow) {
      status = 'aborted_no_window'
      errorText = 'no BrowserWindow available'
      console.warn('[scheduler] aborted task (no window):', row.id)
    } else if (!row.session_id) {
      status = 'failed'
      errorText = 'task has no dedicated session_id (re-enable to recreate)'
      console.warn('[scheduler] task missing session_id:', row.id)
    } else {
      // Capture the latest message id BEFORE the run so we can identify the new
      // assistant message produced by this run for the run-history "jump to
      // message" link.
      const lastBefore = dbGet<{ id: string }>(
        `SELECT id FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
        [row.session_id]
      )
      messageIdAtStart = lastBefore?.id ?? null

      console.log('[scheduler] firing task', row.id, row.name, opts.isManual ? '(manual)' : '(scheduled)')
      await runAgent({
        sessionId: row.session_id,
        message: row.prompt,
        overrideProviderId: row.provider_id ?? undefined,
        overrideModel: row.model ?? undefined,
        scheduledContext: true
      }, mainWindow)
    }
  } catch (e) {
    status = 'failed'
    errorText = (e as Error)?.message ?? String(e)
    console.error('[scheduler] run failed:', row.id, errorText)
  } finally {
    const finishedAt = Date.now()
    const duration = finishedAt - startedAt

    // Identify the new assistant message (if any) produced by this run.
    let newMessageId: string | null = null
    if (row.session_id && status === 'success') {
      const lastAfter = dbGet<{ id: string }>(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'assistant'
         AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
        [row.session_id, startedAt]
      )
      if (lastAfter && lastAfter.id !== messageIdAtStart) newMessageId = lastAfter.id
    }

    // Aggregate cost of any messages written during this run.
    let runCost: number | null = null
    if (row.session_id) {
      const c = dbGet<{ s: number | null }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM messages
         WHERE session_id = ? AND created_at >= ?`,
        [row.session_id, startedAt]
      )
      runCost = c?.s ?? null
    }

    // Persist run record.
    try {
      dbRun(
        `INSERT INTO scheduled_task_runs (id, task_id, fired_at, status, duration_ms, cost, error, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), row.id, startedAt, status, duration, runCost, errorText, newMessageId]
      )
    } catch (e) {
      console.error('[scheduler] failed to write run record:', e)
    }

    // Update task counters / schedule (skip for manual runs).
    if (!opts.isManual) {
      try {
        const next = computeNextFireAt(
          row.schedule_kind as ScheduleKind,
          JSON.parse(row.schedule_value) as ScheduleValue,
          new Date(finishedAt)
        )
        const newConsec = status === 'success' ? 0 : row.consecutive_failures + 1
        const shouldPause = newConsec >= FAILURE_THRESHOLD
        dbRun(
          `UPDATE scheduled_tasks
           SET last_fired_at = ?, next_fire_at = ?, consecutive_failures = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
          [finishedAt, next, newConsec, shouldPause ? 0 : row.enabled, finishedAt, row.id]
        )
        if (shouldPause) {
          console.warn('[scheduler] auto-pausing task after 5 failures:', row.id)
          notifyAutoPause(row.name)
        }
      } catch (e) {
        console.error('[scheduler] failed to advance next_fire_at:', e)
      }
    }

    // Push a run-completed event to renderer so it can update red-dot state +
    // optionally show a desktop notification when the user isn't watching the
    // dedicated session.
    try {
      const wins = BrowserWindow.getAllWindows()
      const w = wins[0]
      if (w && !w.isDestroyed()) {
        const payload: ScheduledRunCompletedEvent = {
          taskId: row.id,
          sessionId: row.session_id,
          status
        }
        w.webContents.send(IPC.SCHEDULER_RUN_COMPLETED, payload)
        // Desktop notification (only when window isn't focused — same rule as
        // notifyTaskComplete). Skip for aborted/manual to avoid noise.
        if (!opts.isManual && status === 'success' && !w.isFocused()) {
          notifyRunDone(row.name, row.id)
        }
      }
    } catch (e) {
      console.warn('[scheduler] failed to emit RUN_COMPLETED event:', (e as Error).message)
    }

    // Push the result to the task's configured bot, if any. Best-effort: a
    // webhook failure must never affect the scheduler's own bookkeeping.
    await maybeSendWebhook(row, status, newMessageId, errorText, startedAt, duration)

    inFlight.delete(row.id)
  }
}

/** Strip chain-of-thought blocks so the bot receives the clean answer only. */
function stripReasoning(content: string): string {
  return content.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '').trim()
}

async function maybeSendWebhook(
  row: TaskRow,
  status: ScheduledRunStatus,
  newMessageId: string | null,
  errorText: string | null,
  firedAt: number,
  durationMs: number
): Promise<void> {
  // No bot bound, or the run never actually executed (no window) → nothing to do.
  if (!row.webhook_bot_id) return
  if (status === 'aborted_no_window') return
  try {
    const bot = getSettings().webhookBots?.find(b => b.id === row.webhook_bot_id)
    if (!bot || !bot.enabled) return

    let content: string | null = null
    if (status === 'success' && newMessageId) {
      const r = dbGet<{ content: string }>(`SELECT content FROM messages WHERE id = ?`, [newMessageId])
      content = r?.content ? stripReasoning(r.content) : null
    }

    await sendWebhookNotification(bot, {
      taskName: row.name,
      status,
      content,
      error: errorText,
      firedAt,
      durationMs
    })
    console.log('[scheduler] webhook sent for task', row.id, 'via', bot.type)
  } catch (e) {
    console.warn('[scheduler] webhook send failed for', row.id, (e as Error).message)
  }
}

function loadTask(taskId: string): TaskRow | null {
  return dbGet<TaskRow>(
    `SELECT id, name, prompt, schedule_kind, schedule_value, session_id, provider_id, model,
            webhook_bot_id, enabled, last_fired_at, next_fire_at, consecutive_failures
     FROM scheduled_tasks WHERE id = ?`,
    [taskId]
  )
}

function notifyAutoPause(taskName: string): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({
      title: 'SuperStudio · 定时任务已暂停',
      body: `任务「${taskName}」已自动暂停（连续失败 5 次），点击查看原因`,
      silent: false
    })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    })
    n.show()
  } catch (e) {
    console.warn('[scheduler] notifyAutoPause failed:', (e as Error).message)
  }
}

function notifyRunDone(taskName: string, taskId: string): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({
      title: 'SuperStudio · 定时任务完成',
      body: `任务「${taskName}」已完成，点击查看结果`,
      silent: false
    })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      if (!w.isDestroyed()) {
        try { w.webContents.send(IPC.SCHEDULER_FOCUS_TASK, { taskId }) }
        catch (e) { console.warn('[scheduler] focus-task send failed:', (e as Error).message) }
      }
    })
    n.show()
  } catch (e) {
    console.warn('[scheduler] notifyRunDone failed:', (e as Error).message)
  }
}
