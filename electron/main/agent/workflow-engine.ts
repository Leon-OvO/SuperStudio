import { BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { generateImage } from '../services/image'
import { generateVideo } from '../services/video'
import { readFile, writeFile } from '../services/fileops'
import { searchWeb } from '../services/search'
import { saveGalleryItem } from '../services/gallery'
import { createLLMClient } from '../services/llm'
import { getSettings } from '../services/store'
import { generateText } from 'ai'

interface WorkflowNode {
  id: string
  type: string
  data: Record<string, unknown>
}

interface WorkflowEdge {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

const runningWorkflows = new Map<string, AbortController>()

export async function executeWorkflow(
  workflowId: string,
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  variables: Record<string, string>,
  win: BrowserWindow
): Promise<void> {
  const abort = new AbortController()
  runningWorkflows.set(workflowId, abort)
  const { nodes, edges } = definition
  const nodeOutputs: Record<string, unknown> = {}
  const settings = getSettings()

  const emit = (nodeId: string, status: 'pending' | 'running' | 'done' | 'error', message?: string) => {
    win.webContents.send(IPC.WORKFLOW_NODE_STATUS, { workflowId, nodeId, status, message })
  }

  const order = topologicalSort(nodes, edges)

  for (const nodeId of order) {
    if (abort.signal.aborted) break
    const node = nodes.find(n => n.id === nodeId)
    if (!node) continue

    emit(nodeId, 'running')
    try {
      const input = resolveInputs(node, edges, nodeOutputs)
      const output = await executeNode(node, input, variables, settings, win, workflowId)
      nodeOutputs[nodeId] = output
      emit(nodeId, 'done')
    } catch (err) {
      emit(nodeId, 'error', (err as Error).message ?? String(err))
      break
    }
  }

  runningWorkflows.delete(workflowId)
}

export function stopWorkflow(workflowId: string): void {
  runningWorkflows.get(workflowId)?.abort()
}

/** Parse "providerId::model" encoded provider-model picker value. */
function parseProviderModel(value: unknown): { providerId: string; model: string } | null {
  if (typeof value !== 'string' || !value.includes('::')) return null
  const [providerId, model] = value.split('::')
  if (!providerId || !model) return null
  return { providerId, model }
}

/** Replace {{input}} with upstream text and {{name}} with variables[name]. */
function renderTemplate(template: string, input: string, variables: Record<string, string>): string {
  if (!template) return ''
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, name: string) => {
    if (name === 'input') return input
    return variables[name] ?? ''
  })
}

async function executeNode(
  node: WorkflowNode,
  input: Record<string, unknown>,
  variables: Record<string, string>,
  settings: ReturnType<typeof getSettings>,
  win: BrowserWindow,
  workflowId: string
): Promise<unknown> {
  const d = node.data
  const upstreamText = String(input['text'] ?? '')

  switch (node.type) {
    case 'text_input':
      return (d.value as string) ?? ''

    case 'variable': {
      const name = (d.variableName as string) || node.id
      const fallback = (d.defaultValue as string) || ''
      return variables[name] ?? fallback
    }

    case 'llm': {
      const override = parseProviderModel(d.providerModel)
      const providerId = override?.providerId || settings.defaultChatProviderId
      const modelId = override?.model || settings.defaultChatModel
      if (!providerId || !modelId) throw new Error('LLM 节点未配置模型，且全局默认对话模型为空')

      const model = createLLMClient(providerId, modelId)
      const promptTemplate = (d.prompt as string) || '{{input}}'
      const rendered = renderTemplate(promptTemplate, upstreamText, variables)
      const system = (d.systemPrompt as string)?.trim() || undefined
      const temperature = typeof d.temperature === 'number' ? d.temperature : 0.7

      const result = await generateText({
        model,
        system,
        temperature,
        messages: [{ role: 'user', content: rendered }]
      })
      return result.text
    }

    case 'image_generate': {
      const override = parseProviderModel(d.providerModel)
      const effectiveSettings = override
        ? { ...settings, defaultImageProviderId: override.providerId, defaultImageModel: override.model }
        : settings
      const promptTemplate = (d.prompt as string) || ''
      const prompt = upstreamText || renderTemplate(promptTemplate, upstreamText, variables)
      if (!prompt) throw new Error('图片生成节点缺少 prompt')

      const result = await generateImage({
        prompt,
        n: (d.n as number) || 1,
        size: (d.size as string) || '1024x1024',
        quality: (d.quality as string) || undefined,
        settings: effectiveSettings
      })
      for (const img of result.images) {
        await saveGalleryItem({
          type: 'image',
          filePath: img.path,
          prompt,
          source: 'workflow',
          workflowId,
          modelName: effectiveSettings.defaultImageModel
        })
      }
      return result.images[0]?.path
    }

    case 'video_generate': {
      const override = parseProviderModel(d.providerModel)
      const effectiveSettings = override
        ? { ...settings, defaultVideoProviderId: override.providerId, defaultVideoModel: override.model }
        : settings
      const promptTemplate = (d.prompt as string) || ''
      const prompt = upstreamText || renderTemplate(promptTemplate, upstreamText, variables)
      if (!prompt) throw new Error('视频生成节点缺少 prompt')

      const refImagePath = (input['image'] as string | undefined) || (d.referenceImagePath as string) || undefined
      const duration = parseInt(String(d.duration ?? ''), 10) || undefined

      const result = await generateVideo({
        prompt,
        referenceImagePath: refImagePath,
        duration,
        settings: effectiveSettings,
        win,
        sessionId: workflowId
      })
      if (result.path) {
        await saveGalleryItem({
          type: 'video',
          filePath: result.path,
          prompt,
          source: 'workflow',
          workflowId,
          modelName: effectiveSettings.defaultVideoModel
        })
      }
      return result.path
    }

    case 'web_search': {
      const query = upstreamText || (d.query as string) || ''
      if (!query.trim()) throw new Error('搜索节点缺少查询内容')
      const provider = ((d.provider as string) || settings.searchProvider) as 'tavily' | 'serper'
      const maxResults = (d.maxResults as number) || 5
      const result = await searchWeb(query, settings.searchApiKey, provider, maxResults)
      return result.results.map(r => `${r.title}: ${r.snippet}`).join('\n')
    }

    case 'file_read': {
      const filePath = String(input['filePath'] || d.filePath || '')
      if (!filePath) throw new Error('读取文件节点未设置 filePath')
      const result = await readFile(filePath)
      return result.content
    }

    case 'file_write': {
      const filePath = String(d.filePath || '')
      if (!filePath) throw new Error('写入文件节点未设置 filePath')
      const operations = Array.isArray(d.operations) ? d.operations : []
      const result = await writeFile({ filePath, operations: operations as never })
      return result
    }

    case 'gallery_save': {
      const imagePath = input['image'] as string | undefined
      const videoPath = input['video'] as string | undefined
      const filePath = imagePath || videoPath
      if (!filePath) throw new Error('保存画廊节点没有接收到图片或视频')
      const type = videoPath ? 'video' : 'image'
      await saveGalleryItem({
        type,
        filePath,
        prompt: (d.prompt as string) || '',
        source: 'workflow',
        workflowId
      })
      return { saved: true, path: filePath }
    }

    case 'output':
      return input['text'] ?? input['image'] ?? input['video'] ?? input['any'] ?? ''

    default:
      return input
  }
}

/**
 * Walk incoming edges, infer each input's data kind from the upstream node's
 * output port type, and put it under the matching handle key (text/image/video/file).
 */
function resolveInputs(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  outputs: Record<string, unknown>
): Record<string, unknown> {
  const incoming = edges.filter(e => e.target === node.id)
  const result: Record<string, unknown> = {}
  for (const edge of incoming) {
    const upstreamValue = outputs[edge.source]
    // Use explicit handle if set, else infer kind from upstream output type
    const handle = edge.targetHandle || inferHandleByValue(upstreamValue, edge.source)
    result[handle] = upstreamValue
    // Also expose under generic "any" for nodes that don't care about kind
    if (!('any' in result)) result['any'] = upstreamValue
  }
  return result
}

/** Best-effort guess of which handle slot an upstream value should fill. */
function inferHandleByValue(value: unknown, _sourceId: string): string {
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm')) return 'video'
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp') || lower.endsWith('.gif')) return 'image'
    return 'text'
  }
  return 'text'
}

function topologicalSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const inDegree: Record<string, number> = {}
  const adj: Record<string, string[]> = {}

  for (const n of nodes) { inDegree[n.id] = 0; adj[n.id] = [] }
  for (const e of edges) {
    if (!adj[e.source]) continue
    adj[e.source].push(e.target)
    inDegree[e.target] = (inDegree[e.target] || 0) + 1
  }

  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id)
  const result: string[] = []

  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of adj[id]) {
      inDegree[next]--
      if (inDegree[next] === 0) queue.push(next)
    }
  }
  return result
}
