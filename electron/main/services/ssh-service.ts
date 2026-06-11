import type { Client, ConnectConfig } from 'ssh2'
import { getSshConnection } from './store'
import type { SshConnection } from '../../../src/shared/ipc-types'

/**
 * SSH remote execution service.
 *
 * Pooled model (mirrors the shared-window pattern of web-browse): ONE ssh2
 * connection per saved connection id, lazily opened, reused across exec calls,
 * and torn down after an idle window. Each agent tool call runs a single command
 * via client.exec and returns stdout/stderr/exitCode (output capped). ssh2 is a
 * pure-JS dependency (no native build); we require it lazily so a missing module
 * yields a clear install hint instead of a crash.
 */

const IDLE_MS = 5 * 60_000
const MAX_OUTPUT = 50 * 1024 // cap each stream, mirrors runShell

type SshClientCtor = new () => Client

let SshClientCtor: SshClientCtor | null = null
function loadSsh(): SshClientCtor {
  if (SshClientCtor) return SshClientCtor
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SshClientCtor = (require('ssh2') as { Client: SshClientCtor }).Client
  } catch {
    throw new Error('SSH 模块未安装（ssh2）。请在项目根目录运行 `npm install ssh2` 后重启应用。')
  }
  return SshClientCtor
}

interface Pooled { client: Client; ready: Promise<void>; idleTimer?: NodeJS.Timeout }
const pool = new Map<string, Pooled>()

function connectConfig(c: SshConnection): ConnectConfig {
  const cfg: ConnectConfig = { host: c.host, port: c.port || 22, username: c.username, readyTimeout: 20_000 }
  if (c.authType === 'privateKey') {
    cfg.privateKey = c.privateKey || ''
    if (c.passphrase) cfg.passphrase = c.passphrase
  } else {
    cfg.password = c.password || ''
  }
  return cfg
}

function newClient(c: SshConnection): Pooled {
  const Ctor = loadSsh()
  const client = new Ctor()
  const ready = new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve())
    client.on('error', (e: Error) => reject(e))
    client.on('close', () => { pool.delete(c.id) })
    try { client.connect(connectConfig(c)) } catch (e) { reject(e as Error) }
  })
  // A rejected ready must not become an unhandled rejection if no exec awaits it yet.
  ready.catch(() => { pool.delete(c.id) })
  return { client, ready }
}

function armIdle(id: string): void {
  const p = pool.get(id)
  if (!p) return
  if (p.idleTimer) clearTimeout(p.idleTimer)
  p.idleTimer = setTimeout(() => { try { p.client.end() } catch { /* gone */ } pool.delete(id) }, IDLE_MS)
  p.idleTimer.unref?.()
}

async function getClient(c: SshConnection): Promise<Client> {
  let p = pool.get(c.id)
  if (!p) { p = newClient(c); pool.set(c.id, p) }
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = undefined }
  await p.ready
  return p.client
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[输出已截断，共 ${s.length} 字节]` : s
}

export interface SshExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** Run a single command on a pooled connection. Never rejects on remote command
 *  failure (non-zero exit is a normal result); rejects only on connect/exec
 *  transport errors. */
export async function sshExec(connId: string, command: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<SshExecResult> {
  const conn = getSshConnection(connId)
  if (!conn) throw new Error(`未找到 SSH 连接：${connId}`)
  const client = await getClient(conn)

  return new Promise<SshExecResult>((resolve, reject) => {
    let stdout = '', stderr = '', settled = false, timedOut = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      armIdle(connId)
    }
    const done = (r: SshExecResult): void => { if (settled) return; settled = true; cleanup(); resolve(r) }
    const fail = (e: Error): void => { if (settled) return; settled = true; cleanup(); reject(e) }
    const onAbort = (): void => { timedOut = true; done({ code: -1, stdout: cap(stdout), stderr: cap(stderr + '\n[已中止]'), timedOut: true }) }
    const timer = setTimeout(() => { timedOut = true; done({ code: -1, stdout: cap(stdout), stderr: cap(stderr + `\n[超时 ${timeoutMs}ms]`), timedOut: true }) }, timeoutMs)
    timer.unref?.()
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    // Become-root: run the command as root via a BARE `sudo su - root` when the
    // connection opts in (key-auth boxes where root can't SSH in directly). The
    // command is piped into su's STDIN rather than passed as `su - root -c "…"`,
    // because a NOPASSWD sudoers rule (`… NOPASSWD: /bin/su - root`) only matches
    // the exact `su - root` argv — adding `-c "…"` changes argv and forces a
    // password prompt even when sudo is supposed to be passwordless. base64 keeps
    // any quoting / special chars intact through the pipe. Skip if the model
    // already prefixed sudo/su itself (avoid double escalation).
    let execCommand = command
    if (conn.becomeRoot && !/^\s*sudo\b/.test(command) && !/^\s*su\b/.test(command)) {
      const b64 = Buffer.from(command, 'utf8').toString('base64')
      execCommand = `echo ${b64} | base64 -d | sudo su - root`
    }
    const sudoPw = conn.sudoPassword || conn.password || ''
    // A PTY is only needed to ANSWER a sudo password prompt. With NOPASSWD sudo
    // (no password configured) skip it — cleaner output, and su's login shell
    // won't go interactive on a TTY. When a sudo password IS set we allocate a
    // PTY (so sudo reads the password from the TTY, leaving stdin free for the
    // piped command) and auto-feed it on the prompt below.
    const hasSudo = /(^|[\s;&|(])(sudo|su)([\s;&|)]|$)/.test(execCommand)
    const needsPty = hasSudo && !!sudoPw
    const opts = needsPty ? { pty: { cols: 200, rows: 50, term: 'xterm-256color' } } : {}
    const sudoPromptRe = /\[sudo\]\s*password|password for\s+\S+:|(^|\n)\s*password:\s*$|密码\s*[:：]?\s*$|口令\s*[:：]?\s*$/i
    let sudoSent = false
    client.exec(execCommand, opts, (err, stream) => {
      if (err) { fail(err); return }
      stream.on('close', (code: number | null) => done({ code: code ?? 0, stdout: cap(stdout), stderr: cap(stderr), timedOut }))
      stream.on('data', (d: Buffer) => {
        const s = d.toString('utf8')
        if (stdout.length < MAX_OUTPUT) stdout += s
        if (sudoPw && !sudoSent && sudoPromptRe.test(s)) {
          sudoSent = true
          try { stream.write(sudoPw + '\n') } catch { /* stream may already be closed */ }
        }
      })
      stream.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8') })
    })
  })
}

/** One-shot handshake to validate a connection's host/auth, then disconnect. */
export async function testSshConnection(conn: SshConnection): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let client: Client
    let done = false
    const fin = (ok: boolean, error?: string): void => {
      if (done) return
      done = true
      clearTimeout(t)
      try { client?.end() } catch { /* gone */ }
      resolve({ ok, error })
    }
    const t = setTimeout(() => fin(false, '连接超时'), 20_000)
    t.unref?.()
    try {
      client = new (loadSsh())()
    } catch (e) {
      clearTimeout(t)
      resolve({ ok: false, error: (e as Error).message })
      return
    }
    client.on('ready', () => fin(true))
    client.on('error', (e: Error) => fin(false, e.message))
    try { client.connect(connectConfig(conn)) } catch (e) { fin(false, (e as Error).message) }
  })
}

/** Tear down all pooled connections (app quit / window closed). */
export function closeAllSsh(): void {
  for (const [, p] of pool) { try { p.client.end() } catch { /* gone */ } }
  pool.clear()
}

// --- Lenient connection resolution --------------------------------------
//
// The model naturally refers to a server by its hostname, but imported
// connections often carry display-name suffixes (e.g. "host (root)"). Resolve a
// query against id / name / host / user@host, accepting a UNIQUE fuzzy match so
// `ssh_exec(connection: "jps1.fq.ito8.com")` finds "jps1.fq.ito8.com (root)".

function listNames(conns: SshConnection[], cap = 30): string {
  const names = conns.map(c => c.name)
  return names.length > cap ? `${names.slice(0, cap).join('、')} …（共 ${names.length} 个，详见「设置 → SSH 连接」）` : names.join('、')
}

export function resolveSshConnection(query: string, conns: SshConnection[]): { conn?: SshConnection; error?: string } {
  const q = (query || '').trim()
  if (!q) return { error: '未指定连接名。可用：' + listNames(conns) }
  const ql = q.toLowerCase()

  // 1. exact id  2. exact name (case-insensitive)
  const exact = conns.find(c => c.id === q) || conns.find(c => c.name.trim().toLowerCase() === ql)
  if (exact) return { conn: exact }

  // 3. exact host (case-insensitive) — accept if unique
  const hostHits = conns.filter(c => c.host.trim().toLowerCase() === ql)
  if (hostHits.length === 1) return { conn: hostHits[0] }
  if (hostHits.length > 1) return { error: `连接「${q}」不唯一,匹配到多个,请用完整连接名:${listNames(hostHits)}` }

  // 4. fuzzy: name / host / user@host contains the query — accept if unique
  const fuzzy = conns.filter(c =>
    c.name.toLowerCase().includes(ql) ||
    c.host.toLowerCase().includes(ql) ||
    `${c.username}@${c.host}`.toLowerCase().includes(ql))
  if (fuzzy.length === 1) return { conn: fuzzy[0] }
  if (fuzzy.length > 1) return { error: `连接「${q}」不唯一,匹配到多个,请用完整连接名:${listNames(fuzzy)}` }

  return { error: `未找到 SSH 连接「${q}」。请在「设置 → SSH 连接」添加,或改用已有连接(可传连接名或 host):${listNames(conns)}` }
}
