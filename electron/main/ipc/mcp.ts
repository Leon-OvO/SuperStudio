import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import type { McpServerConfig } from '../../../src/shared/ipc-types'
import { getMcpServers, saveMcpServer, deleteMcpServer } from '../services/store'
import { mcpManager } from '../services/mcp'

export function mcpHandlers(): void {
  ipcMain.handle(IPC.MCP_SERVERS_LIST, () => getMcpServers())

  ipcMain.handle(IPC.MCP_SERVERS_SAVE, async (_e, server: McpServerConfig) => {
    const incoming: McpServerConfig = { ...server, id: server.id || randomUUID() }
    saveMcpServer(incoming)
    // Reset any cached client/tool list for this server so the next agent run
    // picks up the new config (and a possibly different env / command).
    await mcpManager.disconnect(incoming.id).catch(() => {})
    return { ok: true, id: incoming.id }
  })

  ipcMain.handle(IPC.MCP_SERVERS_DELETE, async (_e, id: string) => {
    deleteMcpServer(id)
    await mcpManager.disconnect(id).catch(() => {})
    return { ok: true }
  })

  ipcMain.handle(IPC.MCP_SERVERS_TEST, async (_e, server: McpServerConfig) => {
    try {
      const result = await mcpManager.test(server)
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.MCP_TOOLS_LIST, async () => {
    try {
      const tools = await mcpManager.listAllTools()
      return tools.map(t => ({
        serverId: t.serverId,
        serverName: t.serverName,
        qualifiedName: t.qualifiedName,
        toolName: t.toolName,
        description: t.description
      }))
    } catch (e) {
      console.warn('[mcp] listAllTools failed:', (e as Error).message)
      return []
    }
  })
}
