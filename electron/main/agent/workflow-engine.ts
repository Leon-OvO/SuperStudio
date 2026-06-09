import { BrowserWindow } from 'electron'
import { IPC, type WorkflowDoneEvent } from '../../../src/shared/ipc-types'
import { generateImage } from '../services/image'
import { generateVideo } from '../services/video'
import { readFile, writeFile } from '../services/fileops'
import { searchWeb } from '../services/search'
import { saveGalleryItem } from '../services/gallery'
import { createLLMClient } from '../services/llm'
import { getSettings } from '../services/store'
import { generateText } from 'ai'
import { topologicalLevels } from './pure'
import { agentRunSemaphore } from './semaphore'

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

/** True when the given workflow already has a run in flight. */
export function isWorkflowRunning(workflowId: string): boolean {
  return runningWorkflows.has(workflowId)
}

/** Thrown when a node is cut short because the user pressed 停止. Distinct from a
 *  real node error so it isn't surfaced as one. */
class WorkflowAbortError extends Error {
  constructor() { super('workflow aborted'); this.name = 'WorkflowAbortError' }
}

/** Bail out of a node before a side effect if the user pressed 停止 in the window
 *  between an await resolving and the effect running (raceAbort rejects async, so
 *  it can't catch this gap — an explicit check before persisting does). */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkflowAbortError()
}

/**
 * Reject as soon as `signal` aborts, so the engine stops awaiting a node whose
 * underlying call cannot be hard-cancelled (e.g. a headless search). Calls that
 * DO accept an abortSignal (LLM / image / video) are additionally cancelled at
 * the source; this race just guarantees the engine itself never hangs on stop.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new WorkflowAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new WorkflowAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
}

export async function executeWorkflow(
  workflowId: string,
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  variables: Record<string, string>,
  win: BrowserWindow
): Promise<void> {
  // Run-guard: a second concurrent run of the same workflow would overwrite the
  // first's AbortController (making it unstoppable) and collide on cleanup. The
  // IPC layer rejects the duplicate before we get here; this is the backstop.
  if (runningWorkflows.has(workflowId)) return

  const abort = new AbortController()
  runningWorkflows.set(workflowId, abort)
  const { nodes, edges } = definition

  const emit = (nodeId: string, status: 'pending' | 'running' | 'done' | 'error', message?: string): void => {
    try { win.webContents.send(IPC.WORKFLOW_NODE_STATUS, { workflowId, nodeId, status, message }) } catch { /* window gone */ }
  }

  const ran = new Set<string>()
  let runStatus: WorkflowDoneEvent['status'] = 'completed'
  let runError: string | undefined

  try {
    const settings = getSettings()
    const nodeOutputs: Record<string, unknown> = {}

    // Mark every node queued up-front so the UI can tell "waiting" apart from
    // "never scheduled" (the latter stay pending and become 'skipped' on done).
    for (const n of nodes) emit(n.id, 'pending')

    // Execute by topological LEVELS: every node in a level has its dependencies
    // satisfied and is independent of its siblings, so the whole level runs in
    // parallel (bounded by the shared agent semaphore). nodeOutputs is keyed by
    // id, so concurrent writes target distinct keys — no race.
    const levels = topologicalLevels(nodes, edges)
    let failFastStop = false

    for (const level of levels) {
      if (abort.signal.aborted || failFastStop) break
      await Promise.all(level.map(async (nodeId) => {
        if (abort.signal.aborted || failFastStop) return
        const node = nodes.find(n => n.id === nodeId)
        if (!node) return
        ran.add(nodeId)
        emit(nodeId, 'running')
        try {
          const input = resolveInputs(node, edges, nodeOutputs)
          const output = await agentRunSemaphore.run(() => {
            // Re-check on slot acquisition — a node may have waited in the
            // semaphore queue while the user pressed 停止.
            if (abort.signal.aborted) throw new WorkflowAbortError()
            return raceAbort(executeNode(node, input, variables, settings, win, workflowId, abort.signal), abort.signal)
          })
          nodeOutputs[nodeId] = output
          emit(nodeId, 'done')
        } catch (err) {
          // A stop is not a node failure — leave its status as-is; the terminal
          // WORKFLOW_DONE event reports the run as 'stopped'.
          if (err instanceof WorkflowAbortError || abort.signal.aborted) return
          const msg = (err as Error).message ?? String(err)
          emit(nodeId, 'error', msg)
          // Per-node error policy (default fail-fast preserves prior behavior).
          // 'continue' / 'skip-downstream' record an error sentinel and let the
          // rest of the workflow proceed; downstream resolveInputs sees it.
          const policy = typeof node.data?.errorPolicy === 'string' ? node.data.errorPolicy : 'fail-fast'
          if (policy === 'continue' || policy === 'skip-downstream') {
            nodeOutputs[nodeId] = { error: msg }
          } else {
            failFastStop = true
            runStatus = 'error'
            runError = msg
          }
        }
      }))
    }

    if (abort.signal.aborted) runStatus = 'stopped'
  } catch (err) {
    // Anything thrown OUTSIDE the per-node try (getSettings, topologicalLevels,
    // an unexpected throw) lands here instead of leaking as an unhandled
    // rejection — and the finally still cleans up + notifies the renderer.
    runStatus = 'error'
    runError = (err as Error).message ?? String(err)
  } finally {
    runningWorkflows.delete(workflowId)
    const unreached = nodes.filter(n => !ran.has(n.id)).map(n => n.id)
    const done: WorkflowDoneEvent = { workflowId, status: runStatus, error: runError, unreached }
    try { win.webContents.send(IPC.WORKFLOW_DONE, done) } catch { /* window gone */ }
  }
}

export function stopWorkflow(workflowId: string): void {
  runningWorkflows.get(workflowId)?.abort()
}

/** Parse "providerId::model" encoded provider-model picker value. Splits on the
 *  FIRST "::" only, so a model id that itself contains "::" survives intact. */
function parseProviderModel(value: unknown): { providerId: string; model: string } | null {
  if (typeof value !== 'string') return null
  const idx = value.indexOf('::')
  if (idx < 0) return null
  const providerId = value.slice(0, idx)
  const model = value.slice(idx + 2)
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
  workflowId: string,
  signal: AbortSignal
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
        messages: [{ role: 'user', content: rendered }],
        abortSignal: signal
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
        settings: effectiveSettings,
        abortSignal: signal
      })
      // Don't persist if the user stopped while the request was completing.
      throwIfAborted(signal)
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
        sessionId: workflowId,
        abortSignal: signal
      })
      // Don't persist if the user stopped while the request was completing.
      throwIfAborted(signal)
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
      const provider = ((d.provider as string) || settings.searchProvider) as 'tavily' | 'serper' | 'searxng' | 'bing' | 'baidu' | 'sogou' | 'ddg'
      const maxResults = (d.maxResults as number) || 5
      const result = await searchWeb(query, settings.searchApiKey, provider, maxResults, { searxngUrl: settings.searxngUrl, browserVisible: settings.searchBrowserVisible })
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
      throwIfAborted(signal)
      const operations = Array.isArray(d.operations) ? d.operations : []
      const result = await writeFile({ filePath, operations: operations as never })
      return result
    }

    case 'gallery_save': {
      const imagePath = input['image'] as string | undefined
      const videoPath = input['video'] as string | undefined
      const filePath = imagePath || videoPath
      if (!filePath) throw new Error('保存画廊节点没有接收到图片或视频')
      throwIfAborted(signal)
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

