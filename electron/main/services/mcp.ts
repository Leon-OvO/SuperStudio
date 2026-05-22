import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { McpServerConfig } from '../../../src/shared/ipc-types'
import { getMcpServers, getSettings } from './store'
import { saveGalleryItem } from './gallery'

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
}

interface ConnectedClient {
  client: Client
  config: McpServerConfig
  toolsCache?: McpTool[]
  cachedAt?: number
}

const TOOL_CACHE_TTL = 60_000

// Bounded waits — without these, a misconfigured MCP subprocess that never
// writes its handshake can stall the agent loop forever.
const CONNECT_TIMEOUT_MS = 20_000   // initial handshake
const LIST_TOOLS_TIMEOUT_MS = 10_000
const TOOL_CALL_TIMEOUT_MS = 120_000 // some MCP tools generate images/videos, allow real work

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

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server'
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

class McpManager {
  private clients = new Map<string, ConnectedClient>()

  async connect(config: McpServerConfig): Promise<Client> {
    const existing = this.clients.get(config.id)
    if (existing) return existing.client

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
        requestInit: { headers: config.headers ?? {} }
      })
    } else {
      throw new Error(`未支持的 transport: ${config.transport}`)
    }

    const client = new Client(
      { name: 'superstudio', version: '0.1.0' },
      { capabilities: {} }
    )
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 "${config.name}"`)
    } catch (e) {
      // Best-effort cleanup so a hung subprocess gets reaped instead of
      // lingering for the rest of the app lifetime
      try { await client.close() } catch { /* ignore */ }
      throw e
    }
    this.clients.set(config.id, { client, config })
    console.log(`[mcp] connected "${config.name}"`)
    return client
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.clients.get(serverId)
    if (!entry) return
    try {
      await entry.client.close()
    } catch (e) {
      console.warn(`[mcp] close error for ${entry.config.name}:`, (e as Error).message)
    }
    this.clients.delete(serverId)
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.keys()).map(id => this.disconnect(id)))
  }

  async listToolsFor(config: McpServerConfig): Promise<McpTool[]> {
    const cached = this.clients.get(config.id)
    if (cached?.toolsCache && cached.cachedAt && Date.now() - cached.cachedAt < TOOL_CACHE_TTL) {
      return cached.toolsCache
    }
    const client = await this.connect(config)
    const slug = slugify(config.name)
    const res = await withTimeout(client.listTools(), LIST_TOOLS_TIMEOUT_MS, `列出工具 "${config.name}"`)
    const tools: McpTool[] = (res.tools ?? []).map(t => ({
      serverId: config.id,
      serverName: config.name,
      qualifiedName: `${slug}__${t.name}`,
      toolName: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    }))
    const entry = this.clients.get(config.id)
    if (entry) {
      entry.toolsCache = tools
      entry.cachedAt = Date.now()
    }
    return tools
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
    const all = await this.listAllTools()
    const tool = all.find(t => t.qualifiedName === qualifiedName)
    if (!tool) throw new Error(`MCP tool not found: ${qualifiedName}`)
    const entry = this.clients.get(tool.serverId)
    if (!entry) throw new Error(`MCP server not connected for tool: ${qualifiedName}`)
    const result = await withTimeout(
      entry.client.callTool({
        name: tool.toolName,
        arguments: (args ?? {}) as Record<string, unknown>
      }),
      TOOL_CALL_TIMEOUT_MS,
      `工具调用 ${qualifiedName}`
    )
    return await persistAndFlatten(result, tool, ctx)
  }

  async test(config: McpServerConfig): Promise<{ tools: Array<{ name: string; description?: string }> }> {
    const tempId = `__test_${Date.now()}`
    const tempConfig: McpServerConfig = { ...config, id: tempId, enabled: true }
    try {
      const client = await this.connect(tempConfig)
      const res = await withTimeout(client.listTools(), LIST_TOOLS_TIMEOUT_MS, '测试列出工具')
      return { tools: (res.tools ?? []).map(t => ({ name: t.name, description: t.description })) }
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
