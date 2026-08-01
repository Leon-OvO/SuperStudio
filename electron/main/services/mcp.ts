import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { McpServerConfig } from '../../../src/shared/ipc-types'
import { userAgent } from './ua'
import { getMcpServers, getSettings } from './store'
import { saveGalleryItem } from './gallery'
import { flattenMcpTools } from '../agent/pure'
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_TOOLS_TIMEOUT_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
} from '../agent/timeouts'

/**
 * MCP tool as exposed to the rest of the app — already prefixed with the
 * server's slug so it can be merged with builtin tools without collisions.
 */
export interface McpTool {
  serverId: string
  serverName: string
  qualifiedName: string   // e.g. "minimax__web_search"
  toolName: string        // original name from server
  description?: string
  /** JSON Schema for the tool's input — passed to the AI SDK as-is. */
  inputSchema: Record<string, unknown>
}

export interface McpArtifact {
  type: 'image' | 'video' | 'audio'
  path: string
  mimeType: string
  galleryId?: number
}

export interface McpCallResult {
  /** Concatenated text representation for the model (includes paths to saved artifacts). */
  text: string
  /** Binary content blocks that were decoded + persisted to disk. */
  artifacts: McpArtifact[]
}

export interface McpCallContext {
  /** Used when persisting artifacts to gallery so they're filterable per session. */
  sessionId?: string
  /** Abort the in-flight tool call when the user presses Stop. Forwarded to the
   *  MCP SDK's callTool request options so the underlying request is cancelled,
   *  not just ignored. */
  signal?: AbortSignal
}

interface ConnectedClient {
  client: Client
  config: McpServerConfig
  /**
   * 工具列表缓存。tools 与写入时刻必须同生共死 —— 拆成两个可选字段时存在
   * 「有缓存没时间戳」的非法状态（旧代码里这种状态会让缓存永远不被采用，
   * 每轮都多打一次 listTools）。合成一个可选对象后该状态在类型上不可表达。
   */
  cache?: { tools: McpTool[]; at: number }
}

const TOOL_CACHE_TTL = 60_000

// 有界等待 —— 没有它们，一个从不写握手的错误配置 MCP 子进程能把 agent 循环永远卡住。
// 具体数值一律来自 agent/timeouts.ts：同一个 MCP 服务器还能经 CLI 运行时到达，
// 两边各写一份字面量正是「出图 178s 走 CLI 成功、走内置引擎被 120s 掐断」的根因。
// 绝不要在这里改回本地字面量。
const CONNECT_TIMEOUT_MS = MCP_CONNECT_TIMEOUT_MS
const LIST_TOOLS_TIMEOUT_MS = MCP_LIST_TOOLS_TIMEOUT_MS
const TOOL_CALL_TIMEOUT_MS = MCP_TOOL_CALL_TIMEOUT_MS

// 外层 withTimeout 相对 SDK 自身超时的余量，见 invoke() 里的说明。
const CALL_GRACE_MS = 5_000

class TimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`MCP ${op} 超时（${ms}ms 内未响应）`)
  }
}

/** Race a promise against a timer. Use named operations for clear errors. */
function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(op, ms)), ms)
    p.then(v => { clearTimeout(t); resolve(v) },
           e => { clearTimeout(t); reject(e) })
  })
}

/**
 * 工具限定名的合法字符集：跨厂商的最严交集（字母/数字/下划线/连字符，
 * 首字符为字母或下划线，总长 ≤64）。不合规的名字有的厂商直接 400，
 * 有的静默丢弃整个工具列表。
 */
const QUALIFIED_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/

export function isValidQualifiedName(name: string): boolean {
  return QUALIFIED_NAME_RE.test(name)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * 服务器名 → 工具名前缀。
 *
 * 旧实现在折不出 ASCII 的时候一律兜底成 `'server'`：两个中文命名的服务器
 * 拿到同一个前缀，后装载的把先装载的工具索引整个盖掉 —— 表现是「某个服务器的
 * 工具莫名其妙消失了」。兜底改成从 serverId 派生：稳定（同一个服务器每次都一样）
 * 且互不相同（不同服务器绝不会撞）。
 */
function serverSlug(config: McpServerConfig): string {
  const s = slugify(config.name)
  // 首字符必须是字母/下划线，否则整条限定名过不了校验（例："3D 绘图" → "3d"）。
  if (s) return /^[a-z_]/.test(s) ? s : `s_${s}`
  return `srv_${createHash('sha1').update(config.id).digest('hex').slice(0, 8)}`
}

/**
 * MCP 错误三分法。恢复策略完全取决于这个分类，混在一起处理会出两种坏事：
 * 参数写错时反复重连白起子进程，凭据过期时反复重连却永远修不好。
 */
export type McpErrorKind =
  /** 请求本身错（JSON-RPC -32700/-32600/-32601/-32602）：重连无用，直接抛。 */
  | 'request'
  /** 会话坏了（连接关闭 / 管道断 / 子进程没了）：回收 + 重连一次可救。 */
  | 'session'
  /** 凭据坏了（401/403）：要重新授权，不是重连。 */
  | 'auth'
  /** 其它（含超时）：不猜，直接抛。超时尤其不能重连 —— 工具可能还在跑。 */
  | 'other'

const NON_RECOVERABLE_CODES = new Set([-32700, -32600, -32601, -32602])
const CONNECTION_CLOSED_CODE = -32000

export function classifyMcpError(err: unknown): McpErrorKind {
  const code = (err as { code?: unknown })?.code
  if (typeof code === 'number') {
    if (NON_RECOVERABLE_CODES.has(code)) return 'request'
    if (code === CONNECTION_CLOSED_CODE) return 'session'
  }
  const msg = String((err as Error)?.message ?? err ?? '')
  if (/\b(401|403)\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication failed|token expired/i.test(msg)) {
    return 'auth'
  }
  if (/connection closed|not connected|transport (is )?closed|stream closed|socket hang up|epipe|econnreset|write after end|child process (exited|closed)/i.test(msg)) {
    return 'session'
  }
  return 'other'
}

/**
 * 出站下载白名单 —— MCP 返回的 URL（含从纯文本里正则扫出来的）会被无条件 fetch，
 * 等于把「第三方服务器让我们打哪就打哪」的能力交了出去，能用来探内网、读云厂商
 * 元数据服务（169.254.169.254）。规则：
 *   - 只允许 https，以及**回环上的 http**（MCP 服务器常把产物挂在自己起的本地端口上，
 *     这条必须放行，否则本地出图类服务器直接不可用）；
 *   - 拒私网/保留网段：10/8、172.16/12、192.168/16、100.64/10、169.254/16（链路本地，
 *     含元数据服务）、0/8、多播与保留段，IPv6 的 fc00::/7（唯一本地）、fe80::/10（链路本地）。
 *
 * 如实标注：**DNS rebinding 仍可绕过**。我们校验的是 URL 里的主机名，真正连的是
 * DNS 解析后的地址；攻击者可以让域名先解析成公网 IP 通过校验、再重解析到内网地址。
 * 要堵死得在 socket 层做二次校验（自定义 lookup + 锁定已校验的 IP 直连），这里没做。
 */
export function isFetchableUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  // URL 会把 http://2130706433 / 八进制 / 十六进制这类写法规范化成点分十进制，
  // 所以这里只需要处理规范形式。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  const loopback = isLoopbackHost(host)
  if (u.protocol === 'http:' && !loopback) return false
  if (loopback) return true
  return !isPrivateHost(host)
}

function parseIPv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.some(n => n > 255) ? null : parts
}

/** ::ffff:127.0.0.1 / ::ffff:7f00:1 这类映射地址里的 IPv4 部分。 */
function embeddedIPv4(host: string): number[] | null {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dotted) return parseIPv4(dotted[1])
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
  }
  return null
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  const v4 = parseIPv4(host) ?? embeddedIPv4(host)
  return !!v4 && v4[0] === 127
}

function isPrivateHost(host: string): boolean {
  const v4 = parseIPv4(host) ?? embeddedIPv4(host)
  if (v4) {
    const [a, b] = v4
    if (a === 0) return true                              // 0.0.0.0/8 «本网络»
    if (a === 10) return true                             // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true      // 172.16/12
    if (a === 192 && b === 168) return true               // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true     // 100.64/10 CGNAT
    if (a === 169 && b === 254) return true               // 169.254/16 链路本地（云元数据）
    if (a === 192 && b === 0) return true                 // 192.0.0/24 IETF 协议分配
    if (a >= 224) return true                             // 多播 224/4 + 保留 240/4 + 广播
    return false
  }
  if (host.includes(':')) {
    if (host === '::') return true
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true     // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true     // fe80::/10 链路本地
    return false
  }
  // 域名：交给 DNS。见上文关于 rebinding 的标注。
  return false
}

function extForMime(mime: string, fallback: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('webm')) return 'webm'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  return fallback
}

function kindForMime(mime: string): 'image' | 'video' | 'audio' | null {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return null
}

/** Guess a kind + mime from a URL's file extension. */
function kindForUrl(url: string): { kind: 'image' | 'video' | 'audio'; mime: string } | null {
  // Strip query/hash before reading the extension
  const path = url.split(/[?#]/)[0]
  const m = path.match(/\.([a-zA-Z0-9]{2,5})$/)
  if (!m) return null
  const ext = m[1].toLowerCase()
  if (['png','jpg','jpeg','webp','gif','bmp','tiff'].includes(ext)) {
    return { kind: 'image', mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` }
  }
  if (['mp4','webm','mov','mkv'].includes(ext)) {
    return { kind: 'video', mime: `video/${ext === 'mov' ? 'quicktime' : ext}` }
  }
  if (['mp3','wav','ogg','m4a','flac'].includes(ext)) {
    return { kind: 'audio', mime: `audio/${ext === 'mp3' ? 'mpeg' : ext}` }
  }
  return null
}

/**
 * Scan free-form text for media URLs that the agent should download. Catches
 * the common pattern where MCP servers (Minimax, OpenAI image-via-MCP, etc.)
 * embed result URLs as plain text instead of structured image/resource blocks.
 */
function extractMediaUrls(text: string): Array<{ url: string; kind: 'image' | 'video' | 'audio'; mime: string }> {
  const out: Array<{ url: string; kind: 'image' | 'video' | 'audio'; mime: string }> = []
  const seen = new Set<string>()
  const re = /https?:\/\/[^\s<>"'`)\]]+/g
  for (const match of text.matchAll(re)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, '')  // strip trailing punctuation
    if (seen.has(url)) continue
    seen.add(url)
    const guess = kindForUrl(url)
    if (guess) out.push({ url, ...guess })
  }
  return out
}

/**
 * Resolve where to write a given binary artifact. Mirrors the layout used by
 * the builtin image/video tools so the gallery picks them up cleanly.
 */
function resolveOutputPath(kind: 'image' | 'video' | 'audio', mime: string): string {
  const settings = getSettings()
  const baseDir = settings.dataDirectory || app.getPath('userData')
  const subdir = kind === 'image' ? 'gallery/images'
              : kind === 'video' ? 'gallery/videos'
              : 'gallery/audio'
  const dir = path.join(baseDir, subdir)
  fs.mkdirSync(dir, { recursive: true })
  const ext = extForMime(mime, kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3')
  return path.join(dir, `${randomUUID()}.${ext}`)
}

export class McpManager {
  private clients = new Map<string, ConnectedClient>()
  // qualifiedName → owning server, kept current as tools are listed (store OR
  // ephemeral 工作目录 servers). Lets callTool resolve a tool to its connected
  // client without re-scanning only the store servers.
  private toolIndex = new Map<string, { serverId: string; serverName: string; toolName: string }>()
  /**
   * serverId → 正在进行的连接。并发的 callTool/listTools 命中同一个未连服务器时，
   * 没有它就会各自 spawn 一个 stdio 子进程，最后只有一个进 clients、其余永远泄漏。
   */
  private connecting = new Map<string, Promise<Client>>()

  /**
   * 索引工具，并在两处把不合法的条目挡在外面：
   *  1. 限定名不合规 → 告警 + 跳过。**绝不截断改写** —— 改写会把两个不同的工具
   *     压成同一个名字，模型调 A 实际执行 B，比少一个工具糟糕得多。
   *  2. 限定名已被别的服务器占用 → 告警 + 跳过，保留先到者。覆盖会把调用悄悄
   *     路由到另一个服务器上。
   * 返回真正被接纳的工具；调用方只应把这些暴露给模型，否则模型会看到一个
   * 调不通（或调到别人）的工具。
   */
  private indexTools(tools: McpTool[]): { accepted: McpTool[]; skipped: Array<{ name: string; reason: string }> } {
    const accepted: McpTool[] = []
    const skipped: Array<{ name: string; reason: string }> = []
    for (const t of tools) {
      if (!isValidQualifiedName(t.qualifiedName)) {
        const reason = '名称不符合通用工具名规则（仅字母/数字/下划线/连字符，首字符为字母或下划线，长度 ≤64）'
        skipped.push({ name: t.qualifiedName, reason })
        console.warn(`[mcp] 跳过工具「${t.qualifiedName}」（来自 ${t.serverName}）：${reason}`)
        continue
      }
      const prev = this.toolIndex.get(t.qualifiedName)
      if (prev && prev.serverId !== t.serverId) {
        const reason = `名称已被服务器「${prev.serverName}」占用`
        skipped.push({ name: t.qualifiedName, reason })
        console.warn(`[mcp] 跳过工具「${t.qualifiedName}」（来自 ${t.serverName}）：${reason}，不覆盖既有索引`)
        continue
      }
      this.toolIndex.set(t.qualifiedName, { serverId: t.serverId, serverName: t.serverName, toolName: t.toolName })
      accepted.push(t)
    }
    return { accepted, skipped }
  }

  /** 丢掉一个服务器的全部内存痕迹：连接、工具缓存（挂在 entry 上，随之消失）、工具索引。 */
  private forget(serverId: string): ConnectedClient | undefined {
    const entry = this.clients.get(serverId)
    this.clients.delete(serverId)
    for (const [k, v] of this.toolIndex) if (v.serverId === serverId) this.toolIndex.delete(k)
    return entry
  }

  /**
   * 连接非正常关闭时的回收。**只清理，不去 reject 在途请求**：一次出图可以合法地
   * 跑 178s，这期间若因为别的原因触发回收而我们强行 reject，已经成功的结果会被丢掉。
   * 在途请求让它各自走自己的超时。
   */
  private reap(serverId: string, reason: string): void {
    const entry = this.forget(serverId)
    if (!entry) return  // 主动 disconnect 已经 forget 过，这里不重复告警
    console.warn(`[mcp] 回收连接「${entry.config.name}」：${reason}。工具索引已清空，下次调用会自动重连。`)
  }

  async connect(config: McpServerConfig): Promise<Client> {
    const existing = this.clients.get(config.id)
    if (existing) return existing.client
    const inflight = this.connecting.get(config.id)
    if (inflight) return inflight
    const p = this.doConnect(config).finally(() => { this.connecting.delete(config.id) })
    this.connecting.set(config.id, p)
    return p
  }

  private async doConnect(config: McpServerConfig): Promise<Client> {
    console.log(`[mcp] connecting "${config.name}" (${config.transport})`)
    let transport
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`MCP server "${config.name}" 缺少 command`)
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>
      })
    } else if (config.transport === 'sse') {
      if (!config.url) throw new Error(`MCP server "${config.name}" 缺少 url`)
      transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: { 'User-Agent': userAgent(), ...(config.headers ?? {}) } }
      })
    } else {
      throw new Error(`未支持的 transport: ${config.transport}`)
    }

    const client = new Client(
      { name: 'superstudio', version: '0.1.0' },
      { capabilities: {} }
    )
    // 健康监听必须在 connect 之前挂：stdio 子进程可能在握手途中就崩。
    // 走 client（Protocol）的公开钩子而不是 transport.onclose —— 后者会被 SDK 在
    // connect() 里接管，直接覆盖会打断它自己的内部清理。
    client.onclose = () => this.reap(config.id, '连接已关闭（子进程退出或对端断开）')
    client.onerror = (err) => {
      console.warn(`[mcp] "${config.name}" 传输层错误：`, (err as Error)?.message ?? String(err))
    }
    try {
      await withTimeout(
        client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }),
        CONNECT_TIMEOUT_MS,
        `连接 "${config.name}"`
      )
    } catch (e) {
      // Best-effort cleanup so a hung subprocess gets reaped instead of
      // lingering for the rest of the app lifetime
      client.onclose = undefined
      try { await client.close() } catch { /* ignore */ }
      throw e
    }
    this.clients.set(config.id, { client, config })
    console.log(`[mcp] connected "${config.name}"`)
    return client
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.forget(serverId)
    if (!entry) return
    try {
      await entry.client.close()
    } catch (e) {
      console.warn(`[mcp] close error for ${entry.config.name}:`, (e as Error).message)
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.keys()).map(id => this.disconnect(id)))
  }

  async listToolsFor(config: McpServerConfig): Promise<McpTool[]> {
    const cached = this.clients.get(config.id)?.cache
    if (cached && Date.now() - cached.at < TOOL_CACHE_TTL) return cached.tools
    const client = await this.connect(config)
    const slug = serverSlug(config)
    const res = await withTimeout(
      client.listTools(undefined, { timeout: LIST_TOOLS_TIMEOUT_MS }),
      LIST_TOOLS_TIMEOUT_MS,
      `列出工具 "${config.name}"`
    )
    const tools: McpTool[] = flattenMcpTools(config.id, config.name, slug, res.tools ?? [])
    const { accepted } = this.indexTools(tools)
    const entry = this.clients.get(config.id)
    // 只缓存被接纳的工具：被跳过的调不通（或会调到别的服务器），不能暴露给模型。
    if (entry) entry.cache = { tools: accepted, at: Date.now() }
    return accepted
  }

  async listAllTools(): Promise<McpTool[]> {
    const servers = getMcpServers().filter(s => s.enabled)
    const all: McpTool[] = []
    for (const s of servers) {
      try {
        const tools = await this.listToolsFor(s)
        all.push(...tools)
      } catch (e) {
        console.warn(`[mcp] listTools failed for "${s.name}":`, (e as Error).message)
      }
    }
    return all
  }

  /**
   * Connect + list tools for ad-hoc configs (工作目录 .mcp.json) NOT in the global
   * store. Connections are cached by config.id like store servers; call
   * disconnectEphemeral(ids) when the run ends to reap their subprocesses.
   */
  async listToolsForConfigs(configs: McpServerConfig[]): Promise<McpTool[]> {
    const all: McpTool[] = []
    for (const cfg of configs) {
      try {
        const tools = await this.listToolsFor(cfg)
        all.push(...tools)
      } catch (e) {
        console.warn(`[mcp] 工作目录 MCP "${cfg.name}" 加载失败：`, (e as Error).message)
      }
    }
    return all
  }

  /** Reap ephemeral 工作目录 connections + drop their tool-index entries. */
  async disconnectEphemeral(ids: string[]): Promise<void> {
    for (const id of ids) {
      for (const [k, v] of this.toolIndex) if (v.serverId === id) this.toolIndex.delete(k)
      await this.disconnect(id)
    }
  }

  /**
   * Call a tool. Any image/video/audio content the server returns is decoded
   * from base64, written to disk, and (for image/video) registered in the
   * gallery so it survives across sessions. The returned `text` includes the
   * saved file paths so the LLM can mention them to the user.
   */
  async callTool(
    qualifiedName: string,
    args: unknown,
    ctx: McpCallContext = {}
  ): Promise<McpCallResult> {
    // Resolve via the live tool index (covers store + ephemeral 工作目录 servers).
    // Fall back to a fresh store listing for a cold index (e.g. after a restart).
    let idx = this.toolIndex.get(qualifiedName)
    let entry = idx ? this.clients.get(idx.serverId) : undefined
    if (!idx || !entry) {
      await this.listAllTools()
      idx = this.toolIndex.get(qualifiedName)
      entry = idx ? this.clients.get(idx.serverId) : undefined
    }
    if (!idx) throw new Error(`MCP tool not found: ${qualifiedName}`)
    if (!entry) throw new Error(`MCP server not connected for tool: ${qualifiedName}`)
    const tool: McpTool = { serverId: idx.serverId, serverName: idx.serverName, qualifiedName, toolName: idx.toolName, inputSchema: {} }
    const config = entry.config

    let result: unknown
    try {
      result = await this.invoke(entry.client, tool, args, ctx)
    } catch (e) {
      const kind = classifyMcpError(e)
      // 用户按了停止 → 尊重它，别偷偷重来一次。
      if (kind !== 'session' || ctx.signal?.aborted) {
        if (kind === 'auth') {
          console.warn(`[mcp] 「${config.name}」凭据无效，需要重新授权（不重连：重连不会让过期的凭据变有效）`)
        }
        throw e
      }
      // 会话坏了（子进程崩了 / 对端断开）：回收 + 重连一次再重试。
      // 只重试一次 —— 循环重试会把一个起不来的服务器变成 spawn 风暴。
      this.reap(config.id, `工具调用 ${qualifiedName} 遇到连接已关闭`)
      console.warn(`[mcp] 「${config.name}」连接已失效，重连后重试一次：${qualifiedName}`)
      const client = await this.connect(config)   // 并发去重在 connect 里
      result = await this.invoke(client, tool, args, ctx)
    }
    return await persistAndFlatten(result, tool, ctx)
  }

  private async invoke(client: Client, tool: McpTool, args: unknown, ctx: McpCallContext): Promise<unknown> {
    if (ctx.signal?.aborted) throw new Error(`工具调用已取消 ${tool.qualifiedName}`)
    return await withTimeout(
      client.callTool(
        {
          name: tool.toolName,
          arguments: (args ?? {}) as Record<string, unknown>
        },
        undefined,
        {
          // 取消必须穿透到 SDK：SDK 收到 abort 会给服务器发 notifications/cancelled
          // 并 reject 这次请求，而不是留一个没人管的在途请求。
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          // 不显式传 timeout 的话 SDK 用它自己的 60s 默认值 —— 外层放宽到 300s 也白搭，
          // 178s 的出图照样在 60s 被掐。maxTotalTimeout 保住硬上限，
          // resetTimeoutOnProgress 让会报进度的服务器不被中途误判。
          timeout: TOOL_CALL_TIMEOUT_MS,
          maxTotalTimeout: TOOL_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        }
      ),
      // 比 SDK 的上限多给一点余量，好让 SDK 的超时先赢：它会顺带通知服务器取消，
      // 而外层的 withTimeout 只能让我们自己不再等。这层只是兜底防「transport 永不 reject」。
      TOOL_CALL_TIMEOUT_MS + CALL_GRACE_MS,
      `工具调用 ${tool.qualifiedName}`
    )
  }

  async test(config: McpServerConfig): Promise<{
    tools: Array<{ name: string; description?: string }>
    /** 因名字不合规而不会暴露给模型的工具，列在测试结果里，别让用户以为它们能用。 */
    skipped: Array<{ name: string; reason: string }>
  }> {
    const tempId = `__test_${Date.now()}`
    const tempConfig: McpServerConfig = { ...config, id: tempId, enabled: true }
    try {
      const client = await this.connect(tempConfig)
      const res = await withTimeout(
        client.listTools(undefined, { timeout: LIST_TOOLS_TIMEOUT_MS }),
        LIST_TOOLS_TIMEOUT_MS,
        '测试列出工具'
      )
      const slug = serverSlug(config)
      const tools: Array<{ name: string; description?: string }> = []
      const skipped: Array<{ name: string; reason: string }> = []
      for (const t of res.tools ?? []) {
        // 测试连接不写全局工具索引（临时 id），所以这里只做名字合规性检查。
        if (isValidQualifiedName(`${slug}__${t.name}`)) {
          tools.push({ name: t.name, description: t.description })
        } else {
          skipped.push({ name: t.name, reason: '名称不符合通用工具名规则，将不会提供给模型' })
        }
      }
      return { tools, skipped }
    } finally {
      await this.disconnect(tempId)
    }
  }
}

/**
 * Walk an MCP tool result's `content[]`:
 *  - text → append to the model-visible string
 *  - image / video / audio → decode base64 to disk, register in gallery, append
 *    a "[saved to PATH]" hint so the model knows what happened
 *  - resource with http(s) URI → fetch + save
 *
 * Returns text the model gets to see + the list of saved artifacts (so the
 * agent can emit progress events / the chat UI can render thumbnails).
 */
async function persistAndFlatten(
  result: unknown,
  tool: McpTool,
  ctx: McpCallContext
): Promise<McpCallResult> {
  const r = result as {
    content?: Array<{
      type: string
      text?: string
      data?: string
      mimeType?: string
      resource?: { uri?: string; mimeType?: string; blob?: string; text?: string }
    }>
    isError?: boolean
  }
  const artifacts: McpArtifact[] = []
  const textParts: string[] = []

  // Diagnostic snapshot — invaluable when an MCP server uses an unexpected
  // content shape (URL in text, resource without mimeType, etc.).
  const shape = (r?.content ?? []).map(c => {
    if (c.type === 'text') return `text(${(c.text ?? '').length})`
    if (c.type === 'image') return `image(${c.mimeType ?? '?'}, b64Len=${(c.data ?? '').length})`
    if (c.type === 'audio') return `audio(${c.mimeType ?? '?'}, b64Len=${(c.data ?? '').length})`
    if (c.type === 'resource') return `resource(${c.resource?.mimeType ?? '?'}, uri=${c.resource?.uri ?? 'inline'})`
    return c.type
  }).join(', ')
  console.log(`[mcp] ${tool.qualifiedName} returned: [${shape}]`)

  if (!r?.content) {
    return { text: '', artifacts }
  }

  for (const c of r.content) {
    if (c.type === 'text' && c.text) {
      // Many MCP servers (notably Minimax) embed result URLs in plain text
      // rather than emitting structured image/resource blocks. Scan for
      // downloadable media URLs and persist them as artifacts.
      const before = artifacts.length
      const urls = extractMediaUrls(c.text)
      for (const u of urls) {
        try {
          const saved = await saveRemote(u.url, u.mime, u.kind, tool, ctx)
          artifacts.push(saved)
          console.log(`[mcp] auto-downloaded ${u.kind} from text URL → ${saved.path}`)
        } catch (e) {
          console.warn(`[mcp] failed to download ${u.url}:`, (e as Error).message)
        }
      }
      textParts.push(c.text)
      // Append a save hint for each artifact created from this text block
      for (const a of artifacts.slice(before)) {
        textParts.push(formatSavedHint(a.type, a))
      }
      continue
    }

    if ((c.type === 'image' || c.type === 'audio') && c.data) {
      const kind = c.type === 'image' ? 'image' : 'audio'
      const mime = c.mimeType ?? (kind === 'image' ? 'image/png' : 'audio/mpeg')
      try {
        const saved = await saveBase64(c.data, mime, kind, tool, ctx)
        artifacts.push(saved)
        textParts.push(formatSavedHint(kind, saved))
      } catch (e) {
        console.warn(`[mcp] failed to save ${kind}:`, (e as Error).message)
        textParts.push(`[MCP ${kind} content received but failed to save: ${(e as Error).message}]`)
      }
      continue
    }

    if (c.type === 'resource' && c.resource) {
      const { uri, mimeType, blob, text } = c.resource
      const mime = mimeType ?? ''
      // Prefer explicit mime, fall back to extension-sniffing on the URI.
      const kind = kindForMime(mime) ?? (uri ? kindForUrl(uri)?.kind ?? null : null)
      const inferredMime = mime || (uri ? kindForUrl(uri)?.mime ?? '' : '')

      // Inline blob — base64 binary
      if (blob && kind) {
        try {
          const saved = await saveBase64(blob, inferredMime, kind, tool, ctx)
          artifacts.push(saved)
          textParts.push(formatSavedHint(kind, saved))
          continue
        } catch (e) {
          console.warn(`[mcp] failed to save resource blob:`, (e as Error).message)
        }
      }
      // HTTP/HTTPS URI — fetch and save
      if (uri && (uri.startsWith('http://') || uri.startsWith('https://')) && kind) {
        try {
          const saved = await saveRemote(uri, inferredMime, kind, tool, ctx)
          artifacts.push(saved)
          textParts.push(formatSavedHint(kind, saved))
          continue
        } catch (e) {
          console.warn(`[mcp] failed to fetch resource ${uri}:`, (e as Error).message)
          textParts.push(`[remote resource URL: ${uri} (download failed: ${(e as Error).message})]`)
          continue
        }
      }
      if (text) {
        // Resource may carry text payload too — scan it for URLs as well
        const urls = extractMediaUrls(text)
        for (const u of urls) {
          try {
            const saved = await saveRemote(u.url, u.mime, u.kind, tool, ctx)
            artifacts.push(saved)
          } catch (e) {
            console.warn(`[mcp] failed to download ${u.url}:`, (e as Error).message)
          }
        }
        textParts.push(text)
        continue
      }
      textParts.push(JSON.stringify(c.resource))
      continue
    }

    // Unknown content type — fall back to JSON, but still scan for URLs
    const blob = JSON.stringify(c)
    const urls = extractMediaUrls(blob)
    for (const u of urls) {
      try {
        const saved = await saveRemote(u.url, u.mime, u.kind, tool, ctx)
        artifacts.push(saved)
      } catch (e) {
        console.warn(`[mcp] failed to download from unknown content type:`, (e as Error).message)
      }
    }
    textParts.push(blob)
  }

  const text = textParts.join('\n').trim()
  if (artifacts.length) {
    console.log(`[mcp] ${tool.qualifiedName} saved ${artifacts.length} artifact(s):`, artifacts.map(a => `${a.type}:${path.basename(a.path)}`).join(', '))
  }
  return { text: r.isError ? `[MCP tool error] ${text}` : text, artifacts }
}

async function saveBase64(
  base64: string,
  mime: string,
  kind: 'image' | 'video' | 'audio',
  tool: McpTool,
  ctx: McpCallContext
): Promise<McpArtifact> {
  const filePath = resolveOutputPath(kind, mime)
  // Some MCP servers prefix with "data:image/png;base64,"
  const clean = base64.replace(/^data:[^;]+;base64,/, '')
  fs.writeFileSync(filePath, Buffer.from(clean, 'base64'))
  return registerArtifact(filePath, mime, kind, tool, ctx)
}

async function saveRemote(
  uri: string,
  mime: string,
  kind: 'image' | 'video' | 'audio',
  tool: McpTool,
  ctx: McpCallContext
): Promise<McpArtifact> {
  // 这里的 uri 完全由第三方 MCP 服务器控制（甚至是从纯文本里正则扫出来的），
  // 无条件 fetch 等于把内网探测能力交出去。见 isFetchableUrl 的说明。
  if (!isFetchableUrl(uri)) {
    let where = uri
    try { where = new URL(uri).host || uri } catch { /* 原样展示 */ }
    throw new Error(`已拒绝下载不在白名单内的地址（${where}）：只允许 https 或本机回环地址`)
  }
  const res = await fetch(uri)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const finalMime = mime || res.headers.get('content-type') || ''
  const finalKind = kindForMime(finalMime) ?? kind
  const filePath = resolveOutputPath(finalKind, finalMime)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(filePath, buf)
  return registerArtifact(filePath, finalMime, finalKind, tool, ctx)
}

async function registerArtifact(
  filePath: string,
  mime: string,
  kind: 'image' | 'video' | 'audio',
  tool: McpTool,
  ctx: McpCallContext
): Promise<McpArtifact> {
  let galleryId: number | undefined
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    try {
      galleryId = await saveGalleryItem({
        type: kind,
        filePath,
        prompt: `MCP · ${tool.serverName} · ${tool.toolName}`,
        source: 'chat',
        sessionId: ctx.sessionId,
        modelName: tool.qualifiedName
      })
    } catch (e) {
      console.warn('[mcp] gallery insert failed (non-fatal):', (e as Error).message)
    }
  }
  return { type: kind, path: filePath, mimeType: mime, galleryId }
}

function formatSavedHint(kind: 'image' | 'video' | 'audio', _a: McpArtifact): string {
  // No path leaked here on purpose — UI auto-renders the thumbnail; if the
  // model echoes the path the user sees a duplicate. The system prompt
  // explicitly forbids re-embedding paths / markdown image syntax.
  const noun = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
  return kind === 'audio'
    ? `[已生成 1 个${noun}文件，已自动保存到本地。请用自然语言向用户描述生成的内容，不要输出文件路径。]`
    : `[已生成 1 ${noun}，已自动入画廊并在聊天中显示缩略图。请用自然语言描述生成内容，不要再插入 Markdown 图片语法或路径。]`
}

export const mcpManager = new McpManager()
