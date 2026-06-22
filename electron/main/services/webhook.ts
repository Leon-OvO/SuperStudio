import { net } from 'electron'
import { createHmac } from 'crypto'
import type { WebhookBot, ScheduledRunStatus } from '../../../src/shared/ipc-types'
import { userAgent } from './ua'

/**
 * Pushes scheduled-task results to a group-chat bot (DingTalk / Feishu /
 * WeChat Work) via its incoming-webhook URL.
 *
 * Why electron.net.fetch (not global fetch): same reason as search.ts — it
 * goes through Chromium's network stack and honours the system proxy, so users
 * behind Clash / corporate proxies can still reach the bot endpoints.
 *
 * Signing (加签): DingTalk and Feishu both offer an optional HMAC-SHA256 "加签"
 * security mode. When the bot has a `secret`, we compute the signature exactly
 * as each platform specifies and attach it (DingTalk: query params; Feishu:
 * body fields). WeChat Work has no signing — the key in the URL is the only
 * credential.
 */

export interface WebhookPayload {
  taskName: string
  status: ScheduledRunStatus
  /** Assistant result text (present on success). */
  content?: string | null
  /** Error text (present on failure / aborted). */
  error?: string | null
  firedAt: number
  durationMs?: number | null
}

// Bots reject overly long messages (WeChat markdown caps at 4096 bytes). Keep
// the result body well under that so title + metadata always fit.
const MAX_BODY_CHARS = 2500

function stamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function truncate(s: string): string {
  const t = s.trim()
  return t.length > MAX_BODY_CHARS ? t.slice(0, MAX_BODY_CHARS) + '\n\n…（内容过长已截断）' : t
}

/** Shared title + body text, reused (with light per-platform tweaks) by each bot. */
function buildText(p: WebhookPayload): { title: string; body: string } {
  const ok = p.status === 'success'
  const title = ok ? `✅ 定时任务完成：${p.taskName}` : `⚠️ 定时任务失败：${p.taskName}`
  const lines: string[] = [`**${title}**`, '', `时间：${stamp(p.firedAt)}`]
  if (p.durationMs != null) lines.push(`耗时：${(p.durationMs / 1000).toFixed(1)}s`)
  lines.push('')
  if (ok) {
    lines.push(p.content?.trim() ? truncate(p.content) : '（本次运行没有产生文本结果）')
  } else {
    lines.push(`错误：${p.error?.trim() || '未知错误'}`)
  }
  return { title, body: lines.join('\n') }
}

async function postJson(url: string, body: unknown): Promise<void> {
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify(body)
    } as never)
  } catch (e) {
    throw new Error((e as Error)?.message || String(e))
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  // All three platforms return a JSON body with a non-zero code on logical
  // failure (bad sign, keyword not matched, rate-limited, …). Surface it.
  let data: { errcode?: number; errmsg?: string; code?: number; msg?: string } = {}
  try { data = await res.json() } catch { /* some success responses are empty */ }
  const code = data.errcode ?? data.code
  if (code != null && code !== 0) {
    throw new Error(`${code} ${data.errmsg || data.msg || ''}`.trim())
  }
}

// --- DingTalk ----------------------------------------------------------
// 加签: sign = urlEncode(base64(HmacSHA256(secret, `${ts}\n${secret}`)))
// appended as &timestamp=<ms>&sign=<sign>.
async function sendDingTalk(bot: WebhookBot, p: WebhookPayload): Promise<void> {
  let url = bot.url
  if (bot.secret) {
    const ts = Date.now()
    const sign = createHmac('sha256', bot.secret).update(`${ts}\n${bot.secret}`).digest('base64')
    const sep = url.includes('?') ? '&' : '?'
    url += `${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`
  }
  const { title, body } = buildText(p)
  await postJson(url, { msgtype: 'markdown', markdown: { title, text: body } })
}

// --- Feishu (Lark) -----------------------------------------------------
// 加签: HMAC-SHA256 with KEY = `${tsSeconds}\n${secret}` over EMPTY data,
// base64-encoded; sent as body fields { timestamp, sign }.
async function sendFeishu(bot: WebhookBot, p: WebhookPayload): Promise<void> {
  const { body } = buildText(p)
  const payload: Record<string, unknown> = { msg_type: 'text', content: { text: body } }
  if (bot.secret) {
    const tsSec = Math.floor(Date.now() / 1000)
    const sign = createHmac('sha256', `${tsSec}\n${bot.secret}`).update('').digest('base64')
    payload.timestamp = String(tsSec)
    payload.sign = sign
  }
  await postJson(bot.url, payload)
}

// --- WeChat Work (企业微信) --------------------------------------------
// No signing; the key query param in the URL is the only credential.
async function sendWechatWork(_bot: WebhookBot, p: WebhookPayload, url: string): Promise<void> {
  const { body } = buildText(p)
  await postJson(url, { msgtype: 'markdown', markdown: { content: body } })
}

export async function sendWebhookNotification(bot: WebhookBot, payload: WebhookPayload): Promise<void> {
  if (!bot.url?.trim()) throw new Error('webhook URL 为空')
  if (bot.type === 'dingtalk') return sendDingTalk(bot, payload)
  if (bot.type === 'feishu') return sendFeishu(bot, payload)
  if (bot.type === 'wechat_work') return sendWechatWork(bot, payload, bot.url)
  throw new Error(`未知的机器人类型：${bot.type}`)
}
