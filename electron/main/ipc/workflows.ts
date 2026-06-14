import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { dbRun, dbAll, dbGet } from '../db/sqlite'
import { randomUUID } from 'crypto'
import { getMainWindow } from '../index'
import { executeWorkflow, stopWorkflow, isWorkflowRunning } from '../agent/workflow-engine'

export function workflowHandlers(): void {
  // `kind` splits the automation 工作流 from the 图片画布 — both share this table +
  // the execution engine, but each page lists only its own kind. Old rows default
  // to 'workflow' (the migration's column default).
  ipcMain.handle(IPC.WORKFLOWS_LIST, (_e, opts?: { kind?: string }) => {
    const kind = opts?.kind || 'workflow'
    const rows = dbAll<{ id: string; name: string; description: string; definition: string; created_at: number; updated_at: number }>(
      `SELECT id, name, description, definition, created_at, updated_at FROM workflows WHERE COALESCE(kind, 'workflow') = ? ORDER BY updated_at DESC`,
      [kind]
    )
    return rows.map(r => ({
      ...r,
      definition: r.definition ? JSON.parse(r.definition) : { nodes: [], edges: [] }
    }))
  })

  ipcMain.handle(IPC.WORKFLOWS_SAVE, (_e, workflow) => {
    const now = Date.now()
    const kind = workflow.kind || 'workflow'
    if (workflow.id) {
      dbRun(`UPDATE workflows SET name = ?, description = ?, definition = ?, updated_at = ? WHERE id = ?`,
        [workflow.name, workflow.description || '', JSON.stringify(workflow.definition), now, workflow.id])
      return { id: workflow.id, ok: true }
    } else {
      const id = randomUUID()
      dbRun(`INSERT INTO workflows (id, name, description, definition, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, workflow.name, workflow.description || '', JSON.stringify(workflow.definition), now, now, kind])
      return { id, ok: true }
    }
  })

  ipcMain.handle(IPC.WORKFLOWS_DELETE, (_e, id: string) => {
    dbRun(`DELETE FROM workflows WHERE id = ?`, [id])
    return { ok: true }
  })

  ipcMain.handle(IPC.WORKFLOW_RUN, async (_e, workflowId: string, variables?: Record<string, string>) => {
    const win = getMainWindow()
    if (!win) return { error: 'No window' }
    // Reject a duplicate run (e.g. a second window) so it can't clobber the
    // in-flight run's AbortController and make it unstoppable.
    if (isWorkflowRunning(workflowId)) return { error: '该工作流已在运行中', started: false }
    const row = dbGet<{ definition: string }>(`SELECT definition FROM workflows WHERE id = ?`, [workflowId])
    if (!row) throw new Error('Workflow not found')
    const definition = JSON.parse(row.definition)
    // Fire-and-forget: the run drives the UI via WORKFLOW_NODE_STATUS / WORKFLOW_DONE
    // events. executeWorkflow has its own try/finally and resolves on every path,
    // but keep a defensive .catch so nothing can become an unhandled rejection.
    void executeWorkflow(workflowId, definition, variables || {}, win).catch(err =>
      console.error('[workflow] unexpected run failure:', err))
    return { started: true }
  })

  ipcMain.handle(IPC.WORKFLOW_STOP, (_e, workflowId: string) => {
    stopWorkflow(workflowId)
    return { ok: true }
  })

  ipcMain.handle(IPC.WORKFLOW_FROM_CHAT, async (_e, sessionId: string) => {
    const messages = dbAll<{ tool_calls: string | null }>(
      `SELECT tool_calls FROM messages WHERE session_id = ? AND tool_calls IS NOT NULL ORDER BY created_at ASC`,
      [sessionId]
    )
    const allToolCalls = messages.flatMap(m => m.tool_calls ? JSON.parse(m.tool_calls) : [])
    if (allToolCalls.length === 0) return { nodes: [], edges: [] }

    const { createLLMClient } = await import('../services/llm')
    const { getSettings } = await import('../services/store')
    const settings = getSettings()
    const { generateText } = await import('ai')
    const model = createLLMClient(settings.defaultChatProviderId, settings.defaultChatModel)

    const result = await generateText({
      model,
      messages: [{
        role: 'user',
        content: `Convert this tool call sequence into a React Flow workflow JSON with nodes and edges arrays.
Tool calls: ${JSON.stringify(allToolCalls, null, 2)}

Return ONLY valid JSON: { "nodes": [...], "edges": [...] }
Each node: { "id": string, "type": string, "position": { "x": number, "y": number }, "data": { "label": string, ...config } }
Each edge: { "id": string, "source": string, "target": string }
Node types: text_input, llm, image_generate, video_generate, web_search, file_read, file_write, gallery_save, output`
      }]
    })

    try {
      const json = result.text.replace(/```json\n?|\n?```/g, '').trim()
      return JSON.parse(json)
    } catch {
      return { nodes: [], edges: [], error: 'Failed to parse workflow JSON' }
    }
  })
}
