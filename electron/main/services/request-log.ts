import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSettings } from './store'
import { redactSecrets } from './redact'

/**
 * Opt-in API request log. When the user turns it on in 设置 → 关于&更新, every
 * outbound API call (LLM chat, image generation, account/subscription) appends a
 * one-line JSON record to userData/logs/api-requests.jsonl — endpoint, model,
 * status, latency and any error — so support/内部 can diagnose "why did my
 * request fail / why is it slow" from a single file.
 *
 * Privacy: LOCAL only, nothing is uploaded. We deliberately record request
 * METADATA, never request/response bodies (prompts, images) nor auth headers —
 * the URL query string is stripped too, since some providers carry the API key
 * there (?key=…). Off by default.
 */

export interface ApiRequestLog {
  ts: number
  kind: 'llm' | 'image' | 'account' | string
  method: string
  url: string
  model?: string
  status?: number
  ok: boolean
  durationMs: number
  reqBytes?: number
  /** Whether the outgoing request body carried Anthropic `thinking` (and its budget),
   *  e.g. "enabled:12000" — for diagnosing why a relay shows no reasoning. */
  think?: string
  error?: string
}

const MAX_FILE_BYTES = 4 * 1024 * 1024 // 4 MB before rolling into .1

let logFilePath: string | null = null

function resolvePath(): string {
  if (logFilePath) return logFilePath
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, 'api-requests.jsonl')
  return logFilePath
}

export function getApiRequestLogPath(): string {
  return resolvePath()
}

export function isApiRequestLoggingEnabled(): boolean {
  try { return !!getSettings().apiRequestLogging } catch { return false }
}

/** Strip the query string (may carry ?key=…) and keep origin + path only. */
export function sanitizeUrl(u: string): string {
  try {
    const parsed = new URL(u)
    return parsed.origin + parsed.pathname
  } catch {
    return String(u).split('?')[0]
  }
}

/** Best-effort model extraction from a JSON request body without full parse. */
export function modelFromBody(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined
  const m = body.slice(0, 4096).match(/"model"\s*:\s*"([^"]+)"/)
  return m ? m[1] : undefined
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

export function logApiRequest(entry: Omit<ApiRequestLog, 'ts'>): void {
  if (!isApiRequestLoggingEnabled()) return
  // error 字段常常直接携带失败请求体/上游报错原文，可能夹带密钥——落盘前脱敏。
  const redacted: Omit<ApiRequestLog, 'ts'> = {
    ...entry,
    error: entry.error ? redactSecrets(entry.error) : entry.error,
  }
  const full: ApiRequestLog = { ts: Date.now(), ...redacted }
  try {
    const file = resolvePath()
    rolloverIfNeeded(file)
    fs.appendFileSync(file, JSON.stringify(full) + '\n', 'utf8')
  } catch (e) {
    // Best-effort — never let logging break a request.
    console.error('[request-log] write failed:', (e as Error).message)
  }
}

export function listApiRequestLog(limit = 500): ApiRequestLog[] {
  try {
    const file = resolvePath()
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    const out: ApiRequestLog[] = []
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line) as ApiRequestLog) } catch { /* skip bad line */ }
    }
    return out
  } catch {
    return []
  }
}

export function clearApiRequestLog(): void {
  try {
    const file = resolvePath()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    const rolled = file + '.1'
    if (fs.existsSync(rolled)) fs.unlinkSync(rolled)
  } catch { /* ignore */ }
}
