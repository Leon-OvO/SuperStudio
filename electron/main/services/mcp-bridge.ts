import http from 'http'
import type { Socket } from 'net'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentSink } from '../agent/sink'
import { registerBridgeTools } from './mcp-bridge-tools'

/**
 * 进程内 MCP 桥 —— 把 SuperStudio 的独有能力（生图 / 技能）暴露给外部 code CLI 运行时。
 *
 * 背景：切到 Claude Code / OpenCode 当引擎后，整轮对话被甩给 CLI 子进程，自研引擎的技能与
 * 生图完全不经过（见 agent/runtime-run.ts 的分工注释）。CLI 自带工具循环但没有生图、更不
 * 知道用户装了哪些技能，于是「画只猫」既不出图也不触发技能。本服务补上那条通道。
 *
 * 为什么是「进程内 HTTP」而不是 stdio 子进程：generateImage / 画廊 / provider 凭据全在
 * 主进程里；若让 CLI 去 spawn 一个独立的 MCP server，那个子进程够不着这些，只能重实现或
 * 反向 IPC。跑在主进程内则直接调现成函数。
 *
 * 顺带解决一个结构性难题：CLI 的 stdout **丢弃工具结果**（opencode 的事件里只有工具名，
 * 没有 output）。但工具跑在我们进程内，所以产物、画廊落盘、实时缩略图、工具流水都由本服务
 * 直接采集 —— 不必去解析 CLI 的输出。
 *
 * 安全：只绑 127.0.0.1 + 每次 run 一枚一次性 Bearer token（token 只经子进程 env 传递，
 * 不落日志）。无 token / token 已失效一律 401。
 */

export interface BridgeToolCall {
  toolName: string
  args: Record<string, unknown>
  result: unknown
}

/** 一次运行时 run 的上下文——token 是它的钥匙，工具靠它知道自己在为哪条会话干活。 */
export interface BridgeRunContext {
  sessionId: string
  /** 助手消息 id（与 AGENT_DELTA/DONE、落库共用）。 */
  messageId: string
  sink: AgentSink
  signal?: AbortSignal
  /** 工具调用流水：run 结束由适配器取走塞进 AGENT_DONE，并由 invoker 落库。 */
  toolCallLog: BridgeToolCall[]
  /** AGENT_PROGRESS 的步序号，单调递增。 */
  nextStep: number
}

const MCP_PATH = '/mcp'
const runs = new Map<string, BridgeRunContext>()

let server: http.Server | null = null
let origin: string | null = null
/** 活动连接——CLI 会保持 keep-alive，退出时必须主动销毁，否则拖住 before-quit。 */
const sockets = new Set<Socket>()

/** 注册一次 run，返回它的一次性 token。调用方务必在 finally 里 unregisterRun。 */
export function registerRun(ctx: Omit<BridgeRunContext, 'toolCallLog' | 'nextStep'>): string {
  const token = randomBytes(32).toString('hex')
  runs.set(token, { ...ctx, toolCallLog: [], nextStep: 0 })
  return token
}

/** 取走这次 run 采集到的工具流水（token 失效后返回空数组）。 */
export function getRunToolCalls(token: string | undefined): BridgeToolCall[] {
  return (token && runs.get(token)?.toolCallLog) || []
}

export function unregisterRun(token: string | undefined): void {
  if (token) runs.delete(token)
}

function bearer(req: http.IncomingMessage): string | null {
  const raw = req.headers['authorization']
  const v = Array.isArray(raw) ? raw[0] : raw
  const m = v?.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/** 读完整请求体并解析 JSON；超过上限或非法 JSON 返回 undefined（交给 transport 报协议错）。 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const MAX = 4 * 1024 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const buf = c as Buffer
    size += buf.length
    if (size > MAX) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const pathname = (req.url || '').split('?')[0]
  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  // 只服务 POST：无状态模式下没有待恢复的 SSE 流，GET/DELETE 一律拒绝。
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  const ctx = runs.get(bearer(req) ?? '')
  if (!ctx) {
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'unauthorized' },
      id: null,
    })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 413, { error: 'payload too large' })
    return
  }

  // 每请求独立的 server+transport（无状态模式，SDK 不做 session 校验）：并发的多条 run
  // 各自隔离，互不串味；开销可忽略（纯内存对象）。
  const mcp = new McpServer(
    { name: 'superstudio', version: app.getVersion() },
    { capabilities: { tools: {} } }
  )
  registerBridgeTools(mcp, ctx)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  // 拆卸只在 handleRequest 落定之后做。生图这类工具会把响应挂住好几分钟（实测一次出图 178s），
  // 若在 res 'close' 上立刻 close 掉 transport，客户端中途断线就会在处理中途拆掉底座。
  try {
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  } finally {
    void transport.close().catch(() => {})
    void mcp.close().catch(() => {})
  }
}

/** 惰性启动（首个运行时 run 之前调用），返回 MCP 端点 URL。重复调用返回同一个。 */
export async function ensureBridgeStarted(): Promise<string> {
  if (server && origin) return `${origin}${MCP_PATH}`

  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.warn('[mcp-bridge] request failed:', (e as Error).message)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  // 长工具调用必须能把请求挂住：出图实测 178s，而 Node 默认 requestTimeout 只有 300s、
  // headersTimeout 60s——一旦被掐断，用户等了几分钟只换来一个静默失败。这里全部放开，
  // 真正的时长上限交给工具自身（generateImage 有 180s 上限）与 CLI 侧的 MCP 超时。
  srv.requestTimeout = 0
  srv.headersTimeout = 0
  srv.timeout = 0
  srv.keepAliveTimeout = 65_000
  srv.on('connection', (s) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  })

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    // 端口 0 = 让系统给个空闲端口；只绑回环，外部网络碰不到。
    srv.listen(0, '127.0.0.1', () => {
      srv.removeListener('error', reject)
      resolve()
    })
  })

  const addr = srv.address()
  if (!addr || typeof addr === 'string') {
    srv.close()
    throw new Error('MCP 桥启动失败：未能取得监听端口')
  }
  // 别让监听 socket 独自吊住事件循环——退出走 stopMcpBridge，即使漏了也不该拖到强退看门狗。
  srv.unref()
  server = srv
  origin = `http://127.0.0.1:${addr.port}`
  console.log(`[mcp-bridge] listening on ${origin}${MCP_PATH}`)
  return `${origin}${MCP_PATH}`
}

/** 退出时关闭（before-quit 调用）。必须销毁 keep-alive 连接，否则 close 回调永远不来。 */
export async function stopMcpBridge(): Promise<void> {
  runs.clear()
  const srv = server
  server = null
  origin = null
  if (!srv) return
  for (const s of sockets) s.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => srv.close(() => resolve()))
}
