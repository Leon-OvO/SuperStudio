import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig } from '../../../src/shared/ipc-types'
import { getMcpServers } from './store'

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

interface ConnectedClient {
  client: Client
  config: McpServerConfig
  toolsCache?: McpTool[]
  cachedAt?: number
}

const TOOL_CACHE_TTL = 60_000  // 1 min — long enough to avoid re-listing within one Agent run

/** Convert a server name into a safe tool-name prefix (ASCII, no separators). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server'
}

class McpManager {
  private clients = new Map<string, ConnectedClient>()

  /**
   * Establish (or reuse) a connection to a server. Throws on connect failure.
   */
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
    await client.connect(transport)
    this.clients.set(config.id, { client, config })
    console.log(`[mcp] connected "${config.name}"`)
    return client
  }

  /** Disconnect and remove a client. Safe to call when not connected. */
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

  /**
   * List tools from one server. Prefixes each tool with the server slug so
   * names are globally unique when merged with other servers + builtins.
   */
  async listToolsFor(config: McpServerConfig): Promise<McpTool[]> {
    const cached = this.clients.get(config.id)
    if (cached?.toolsCache && cached.cachedAt && Date.now() - cached.cachedAt < TOOL_CACHE_TTL) {
      return cached.toolsCache
    }
    const client = await this.connect(config)
    const slug = slugify(config.name)
    const res = await client.listTools()
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

  /** Aggregate tools from every enabled server. Server failures are logged, not thrown. */
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
   * Call a tool. The qualifiedName is what the agent sees (with prefix);
   * we resolve back to (serverId, toolName) before dispatching.
   */
  async callTool(qualifiedName: string, args: unknown): Promise<string> {
    const all = await this.listAllTools()
    const tool = all.find(t => t.qualifiedName === qualifiedName)
    if (!tool) throw new Error(`MCP tool not found: ${qualifiedName}`)
    const entry = this.clients.get(tool.serverId)
    if (!entry) throw new Error(`MCP server not connected for tool: ${qualifiedName}`)
    const result = await entry.client.callTool({
      name: tool.toolName,
      arguments: (args ?? {}) as Record<string, unknown>
    })
    return flattenContent(result)
  }

  /** Test a config without persisting it — returns tool count, or throws. */
  async test(config: McpServerConfig): Promise<{ tools: Array<{ name: string; description?: string }> }> {
    // Use a transient client so we don't taint the running pool with an unsaved config
    const tempId = `__test_${Date.now()}`
    const tempConfig: McpServerConfig = { ...config, id: tempId, enabled: true }
    try {
      const client = await this.connect(tempConfig)
      const res = await client.listTools()
      return { tools: (res.tools ?? []).map(t => ({ name: t.name, description: t.description })) }
    } finally {
      await this.disconnect(tempId)
    }
  }
}

/** Best-effort string extraction from MCP tool result content. */
function flattenContent(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }
  if (!r?.content) return ''
  const parts: string[] = []
  for (const c of r.content) {
    if (c.type === 'text' && c.text) parts.push(c.text)
    else if (c.type === 'image' && c.data) parts.push(`[image:${c.mimeType ?? 'unknown'} base64-omitted]`)
    else parts.push(JSON.stringify(c))
  }
  const joined = parts.join('\n')
  return r.isError ? `[MCP tool error] ${joined}` : joined
}

export const mcpManager = new McpManager()
