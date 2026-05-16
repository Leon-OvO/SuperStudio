import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * Lightweight local error log. Keeps the most recent N entries in memory and
 * mirrors them to a rotating JSONL file under userData/logs/. The user can
 * view + copy the log from Settings → About → 错误日志 when something goes
 * wrong, which is far more actionable than telling them "check the dev tools".
 *
 * No telemetry leaves the machine — this is intentionally a LOCAL log only.
 */

export interface LogEntry {
  ts: number
  level: 'error' | 'warn' | 'info'
  source: 'main' | 'renderer'
  message: string
  stack?: string
  context?: Record<string, unknown>
}

const MAX_IN_MEMORY = 200
const MAX_FILE_BYTES = 1_048_576  // 1 MB before we roll into .1

let buffer: LogEntry[] = []
let logFilePath: string | null = null

function resolveLogPath(): string {
  if (logFilePath) return logFilePath
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, 'app.log.jsonl')
  return logFilePath
}

function rolloverIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file)
    if (stat.size < MAX_FILE_BYTES) return
    const rolled = file + '.1'
    if (fs.existsSync(rolled)) fs.unlinkSync(rolled)
    fs.renameSync(file, rolled)
  } catch { /* file doesn't exist yet */ }
}

export function logEntry(entry: Omit<LogEntry, 'ts'>): void {
  const full: LogEntry = { ts: Date.now(), ...entry }
  buffer.push(full)
  if (buffer.length > MAX_IN_MEMORY) buffer = buffer.slice(-MAX_IN_MEMORY)
  try {
    const file = resolveLogPath()
    rolloverIfNeeded(file)
    fs.appendFileSync(file, JSON.stringify(full) + '\n', 'utf8')
  } catch (e) {
    // Logging is best-effort — avoid feedback loops if disk is full
    console.error('[error-log] failed to write:', (e as Error).message)
  }
}

export function getEntries(): LogEntry[] {
  // Snapshot — UI shouldn't mutate
  return [...buffer]
}

export function clearEntries(): void {
  buffer = []
  try {
    const file = resolveLogPath()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    const rolled = file + '.1'
    if (fs.existsSync(rolled)) fs.unlinkSync(rolled)
  } catch { /* ignore */ }
}

/** Read both rolled + current log file from disk — used by UI viewer to
 *  surface entries logged before the user opened settings. */
export function getEntriesFromDisk(limit = 500): LogEntry[] {
  try {
    const file = resolveLogPath()
    const merged: LogEntry[] = []
    for (const f of [file + '.1', file]) {
      if (!fs.existsSync(f)) continue
      const content = fs.readFileSync(f, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try { merged.push(JSON.parse(line)) } catch { /* skip malformed */ }
      }
    }
    return merged.slice(-limit)
  } catch (e) {
    console.error('[error-log] failed to read log file:', (e as Error).message)
    return []
  }
}

/**
 * Wire process-level error handlers so genuinely uncaught failures in main
 * make it into the user-visible log instead of just `console.error`.
 */
export function installMainProcessHooks(): void {
  process.on('uncaughtException', (err) => {
    logEntry({ level: 'error', source: 'main', message: err.message, stack: err.stack })
    console.error('[main] uncaughtException:', err)
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logEntry({ level: 'error', source: 'main', message: err.message, stack: err.stack })
    console.error('[main] unhandledRejection:', err)
  })
}
