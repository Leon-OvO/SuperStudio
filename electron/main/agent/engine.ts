import { streamText, tool, jsonSchema } from 'ai'
import { z } from 'zod'
import { BrowserWindow } from 'electron'
import { IPC, AgentProgressEvent } from '../../../src/shared/ipc-types'
import { createLLMClient } from '../services/llm'
import { getSettings, getProviders } from '../services/store'
import { generateImage } from '../services/image'
import { generateVideo } from '../services/video'
import { readFile, writeFile } from '../services/fileops'
import { searchWeb } from '../services/search'
import { saveGalleryItem } from '../services/gallery'
import { searchKnowledge } from '../services/knowledge'
import { mcpManager, type McpTool } from '../services/mcp'
import { dbRun, dbAll, dbGet } from '../db/sqlite'
import { randomUUID } from 'crypto'
import path from 'path'
import { app } from 'electron'

interface RunParams {
  sessionId: string
  message: string
  attachments?: Array<{ name: string; path: string; mimeType: string }>
  overrideProviderId?: string
  overrideModel?: string
  mountedSpaceIds?: string[]
  imageSize?: string
  imageQuality?: string
}

const runningAgents = new Map<string, AbortController>()

function buildAutoTitle(message: string, isImage: boolean, isVideo: boolean): string {
  const clean = message.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  const prefix = isImage ? '🖼 ' : isVideo ? '🎬 ' : ''
  const body = clean.slice(0, 22)
  return prefix + body + (clean.length > 22 ? '…' : '')
}

function tryAutoTitle(sessionId: string, userMessage: string, isImage: boolean, isVideo: boolean): string | null {
  try {
    const session = dbGet<{ title: string }>(`SELECT title FROM sessions WHERE id = ?`, [sessionId])
    if (!session?.title?.startsWith('新对话')) return null
    const count = (dbGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?`, [sessionId]))?.cnt ?? 0
    if (count > 2) return null
    const title = buildAutoTitle(userMessage, isImage, isVideo)
    dbRun(`UPDATE sessions SET title = ? WHERE id = ?`, [title, sessionId])
    return title
  } catch { return null }
}

export async function runAgent(
  params: RunParams,
  win: BrowserWindow
): Promise<void> {
  const { sessionId, message, attachments = [], overrideProviderId, overrideModel, mountedSpaceIds = [], imageSize, imageQuality } = params
  const runStartTime = Date.now()
  console.log('[Agent] runAgent called', { sessionId, msgLen: message.length, atts: attachments.length, overrideProviderId, overrideModel })
  const abort = new AbortController()
  runningAgents.set(sessionId, abort)

  const settings = getSettings()
  const effectiveProviderId = overrideProviderId || settings.defaultChatProviderId
  const effectiveModel = overrideModel || settings.defaultChatModel
  const allProviders = getProviders()
  const effectiveProviderName = allProviders.find(p => p.id === effectiveProviderId)?.name || effectiveProviderId
  console.log('[Agent] resolved model', { provider: effectiveProviderId, model: effectiveModel })

  const emit = (event: Omit<AgentProgressEvent, 'sessionId'>) => {
    win.webContents.send(IPC.AGENT_PROGRESS, { ...event, sessionId })
  }

  try {
    // Save user message
    const userMsgId = randomUUID()
    dbRun(
      `INSERT INTO messages (id, session_id, role, content, attachments, created_at) VALUES (?, ?, 'user', ?, ?, ?)`,
      [
        userMsgId, sessionId, message,
        attachments.length ? JSON.stringify(attachments) : null,
        Date.now()
      ]
    )
    console.log('[Agent] user message saved', userMsgId)
  } catch (e) {
    console.error('[Agent] failed to save user message', e)
    win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: `保存用户消息失败：${String(e)}` })
    runningAgents.delete(sessionId)
    return
  }

  // Fetch MCP tools BEFORE building the system prompt so we can describe
  // them inline + decide whether to suppress overlapping builtin tools.
  const mcpTools = await mcpManager.listAllTools().catch(err => {
    console.warn('[Agent] MCP listAllTools failed:', (err as Error).message)
    return [] as McpTool[]
  })

  // Build system prompt with knowledge context (mounted spaces take priority over global)
  const kbContext = await buildKbContext(message, sessionId, settings, mountedSpaceIds)
  const systemPrompt = buildSystemPrompt(kbContext, mcpTools)

  const toolCallLog: Array<{ toolName: string; args: unknown; result: unknown }> = []
  let stepIndex = 0

  let streamErr: Error | null = null
  try {
    if (!effectiveProviderId || !effectiveModel) {
      throw new Error('请先在「设置 → 默认模型」配置对话模型，或在对话顶部下拉框选一个模型。')
    }

    // Direct image generation mode: if the selected model is the configured image model,
    // bypass the chat completions flow and call the image API directly.
    if (effectiveModel === settings.defaultImageModel && settings.defaultImageModel) {
      await runDirectImageGeneration({ message, sessionId, settings, emit, win, toolCallLog, providerId: effectiveProviderId, providerName: effectiveProviderName, model: effectiveModel, imageSize, imageQuality, attachments, runStartTime })
      runningAgents.delete(sessionId)
      return
    }

    // Video-only models are not usable as chat models
    if (effectiveModel === settings.defaultVideoModel && settings.defaultVideoModel) {
      throw new Error(`「${effectiveModel}」是视频生成模型，不支持对话。\n请在对话顶部下拉框选择对话模型。`)
    }

    const model = createLLMClient(effectiveProviderId, effectiveModel)
    console.log('[Agent] LLM client created, calling streamText…')

    // Wrap each MCP tool as an AI SDK tool whose execute callback dispatches
    // via mcpManager.callTool(). (mcpTools was fetched earlier when building
    // the system prompt so the model can be told about them explicitly.)
    const mcpToolEntries: Record<string, ReturnType<typeof tool>> = {}
    for (const mt of mcpTools) {
      mcpToolEntries[mt.qualifiedName] = tool({
        description: mt.description ?? `${mt.toolName} (from MCP server "${mt.serverName}")`,
        parameters: jsonSchema(mt.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args) => {
          emit({
            stepIndex: stepIndex++,
            stepName: `MCP · ${mt.serverName}`,
            toolName: mt.qualifiedName,
            status: 'running',
            message: mt.toolName
          })
          try {
            const text = await mcpManager.callTool(mt.qualifiedName, args)
            emit({ stepIndex: stepIndex - 1, stepName: `MCP · ${mt.serverName}`, toolName: mt.qualifiedName, status: 'done' })
            toolCallLog.push({ toolName: mt.qualifiedName, args, result: text })
            return text
          } catch (err) {
            const msg = (err as Error).message
            emit({ stepIndex: stepIndex - 1, stepName: `MCP · ${mt.serverName}`, toolName: mt.qualifiedName, status: 'error', message: msg })
            toolCallLog.push({ toolName: mt.qualifiedName, args, result: { error: msg } })
            // Surface as a string error so the model can self-correct mid-loop
            return `[MCP error] ${msg}`
          }
        }
      })
    }
    if (mcpTools.length) {
      console.log(`[Agent] merged ${mcpTools.length} MCP tools:`, mcpTools.map(t => t.qualifiedName).join(', '))
    }

    // When an MCP tool provides equivalent capability, drop the builtin so the
    // model doesn't get distracted choosing the simpler-named one. Heuristic
    // by tool name suffix — covers Minimax (web_search, understand_image) and
    // anything else that follows the same naming convention.
    const mcpHasWebSearch = mcpTools.some(t =>
      /(__|^)(web_search|search|browse|fetch_url)$/i.test(t.qualifiedName)
    )
    const mcpHasVision = mcpTools.some(t =>
      /(__|^)(understand_image|vision_analyze|image_understand|see|analyze_image)$/i.test(t.qualifiedName)
    )
    if (mcpHasWebSearch) console.log('[Agent] builtin web_search suppressed — MCP equivalent available')
    if (mcpHasVision) console.log('[Agent] builtin vision_analyze suppressed — MCP equivalent available')

    const result = streamText({
      model,
      system: systemPrompt,
      messages: await buildMessageHistory(sessionId, message, attachments),
      abortSignal: abort.signal,
      maxSteps: 20,
      maxRetries: 5,
      onError: ({ error }) => {
        console.error('[Agent] streamText onError', error)
        streamErr = error as Error
      },
      tools: {
        ...mcpToolEntries,
        ...(mcpHasWebSearch ? {} : {
        web_search: tool({
          description: 'Fallback generic web search (Tavily/Serper). If an MCP web_search tool is available, that one is richer and should be preferred.',
          parameters: z.object({ query: z.string().describe('Search query') }),
          execute: async ({ query }) => {
            emit({ stepIndex: stepIndex++, stepName: 'Web Search', toolName: 'web_search', status: 'running', message: `Searching: ${query}` })
            const result = await searchWeb(query, settings.searchApiKey, settings.searchProvider)
            emit({ stepIndex: stepIndex - 1, stepName: 'Web Search', toolName: 'web_search', status: 'done', message: `Found ${result.results.length} results` })
            toolCallLog.push({ toolName: 'web_search', args: { query }, result })
            return result
          }
        }),
        }),
        image_generate: tool({
          description: 'Generate an image from a text prompt. For n and size, pass null to use defaults (1 image at 1024x1024).',
          parameters: z.object({
            prompt: z.string().describe('Detailed image generation prompt'),
            n: z.number().nullable().describe('Number of images (1-4). Pass null for default 1.'),
            size: z.string().nullable().describe('Image size like 1024x1024. Pass null for default.')
          }),
          execute: async ({ prompt, n, size }) => {
            const actualN = n ?? 1
            const actualSize = size ?? '1024x1024'
            emit({ stepIndex: stepIndex++, stepName: 'Image Generation', toolName: 'image_generate', status: 'running', message: `Generating ${actualN} image(s)...` })
            const result = await generateImage({ prompt, n: actualN, size: actualSize, settings })
            for (const img of result.images) {
              const galleryId = await saveGalleryItem({
                type: 'image', filePath: img.path, prompt,
                source: 'chat', sessionId, modelName: settings.defaultImageModel
              })
              emit({ stepIndex: stepIndex - 1, stepName: 'Image Generation', toolName: 'image_generate', status: 'done',
                artifact: { type: 'image', path: img.path } })
            }
            toolCallLog.push({ toolName: 'image_generate', args: { prompt, n: actualN, size: actualSize }, result })
            return result
          }
        }),
        video_generate: tool({
          description: 'Generate a video from text prompt or reference image. Pass null for referenceImagePath if not doing image-to-video.',
          parameters: z.object({
            prompt: z.string().describe('Video generation prompt'),
            referenceImagePath: z.string().nullable().describe('Path to reference image for image-to-video, or null for text-to-video')
          }),
          execute: async ({ prompt, referenceImagePath }) => {
            emit({ stepIndex: stepIndex++, stepName: 'Video Generation', toolName: 'video_generate', status: 'running', message: 'Generating video...' })
            const result = await generateVideo({ prompt, referenceImagePath: referenceImagePath ?? undefined, settings, win, sessionId })
            if (result.path) {
              await saveGalleryItem({
                type: 'video', filePath: result.path, prompt,
                source: 'chat', sessionId, modelName: settings.defaultVideoModel
              })
              emit({ stepIndex: stepIndex - 1, stepName: 'Video Generation', toolName: 'video_generate', status: 'done',
                artifact: { type: 'video', path: result.path } })
            }
            toolCallLog.push({ toolName: 'video_generate', args: { prompt, referenceImagePath }, result })
            return result
          }
        }),
        ...(mcpHasVision ? {} : {
        vision_analyze: tool({
          description: 'Fallback vision tool using the current chat model. If an MCP vision tool (e.g. understand_image) is available, that one is purpose-built and should be preferred.',
          parameters: z.object({
            imagePath: z.string().describe('Local path to the image'),
            question: z.string().describe('What to analyze or extract from the image')
          }),
          execute: async ({ imagePath, question }) => {
            emit({ stepIndex: stepIndex++, stepName: 'Vision Analysis', toolName: 'vision_analyze', status: 'running' })
            const result = await analyzeImage(imagePath, question, settings)
            emit({ stepIndex: stepIndex - 1, stepName: 'Vision Analysis', toolName: 'vision_analyze', status: 'done' })
            toolCallLog.push({ toolName: 'vision_analyze', args: { imagePath, question }, result })
            return result
          }
        }),
        }),
        file_read: tool({
          description: 'Read and extract text content from XLSX, DOCX, PPTX, or PDF files',
          parameters: z.object({ filePath: z.string().describe('Absolute path to the file') }),
          execute: async ({ filePath }) => {
            emit({ stepIndex: stepIndex++, stepName: 'File Read', toolName: 'file_read', status: 'running', message: path.basename(filePath) })
            const result = await readFile(filePath)
            emit({ stepIndex: stepIndex - 1, stepName: 'File Read', toolName: 'file_read', status: 'done' })
            toolCallLog.push({ toolName: 'file_read', args: { filePath }, result })
            return result
          }
        }),
        file_write: tool({
          description: `Write or modify an XLSX file. Auto-backs up before writing.
operationsJson must be a JSON-encoded array of operations. Each operation:
  { "sheet": "<sheet-name>", "action": "set_cell" | "set_range" | "copy_column", "params": { ... action-specific params ... } }
Examples of params:
  set_cell:   { "cell": "B2", "value": "hello" }
  set_range:  { "range": "A1:C3", "values": [[1,2,3],[4,5,6],[7,8,9]] }
  copy_column: { "fromSheet": "Sheet1", "fromCol": "B", "toCol": "D" }`,
          parameters: z.object({
            filePath: z.string().describe('Absolute path to the XLSX file'),
            operationsJson: z.string().describe('JSON string: array of operation objects. Must be valid JSON.')
          }),
          execute: async ({ filePath, operationsJson }) => {
            emit({ stepIndex: stepIndex++, stepName: 'File Write', toolName: 'file_write', status: 'running', message: path.basename(filePath) })
            let operations: Array<{ sheet: string; action: string; params: Record<string, unknown> }>
            try {
              operations = JSON.parse(operationsJson)
              if (!Array.isArray(operations)) throw new Error('operationsJson must be a JSON array')
            } catch (parseErr) {
              const errMsg = `file_write operationsJson 解析失败：${(parseErr as Error).message}. 收到内容: ${operationsJson.slice(0, 200)}`
              emit({ stepIndex: stepIndex - 1, stepName: 'File Write', toolName: 'file_write', status: 'error', message: errMsg })
              throw new Error(errMsg)
            }
            const result = await writeFile({ filePath, operations })
            emit({ stepIndex: stepIndex - 1, stepName: 'File Write', toolName: 'file_write', status: 'done',
              message: result.backupPath ? `Backup: ${result.backupPath}` : undefined })
            toolCallLog.push({ toolName: 'file_write', args: { filePath, operations }, result })
            return result
          }
        }),
        gallery_save: tool({
          description: 'Save a file (image or video) to the gallery. Pass an empty string for prompt if unknown.',
          parameters: z.object({
            filePath: z.string(),
            type: z.enum(['image', 'video']),
            prompt: z.string().describe('Prompt or caption to associate with the saved item. Empty string if unknown.')
          }),
          execute: async ({ filePath, type, prompt }) => {
            const id = await saveGalleryItem({ type, filePath, prompt: prompt || '', source: 'chat', sessionId })
            toolCallLog.push({ toolName: 'gallery_save', args: { filePath, type, prompt }, result: { id } })
            return { id, saved: true }
          }
        })
      }
    })

    // Collect full response text
    let fullText = ''
    let chunkCount = 0
    console.log('[Agent] streaming started')
    try {
      for await (const chunk of result.textStream) {
        fullText += chunk
        chunkCount++
        if (abort.signal.aborted) break
      }
    } catch (iterErr) {
      console.error('[Agent] textStream iteration threw', iterErr)
      streamErr = iterErr as Error
    }
    console.log('[Agent] streaming finished', { chunks: chunkCount, len: fullText.length, hadErr: !!streamErr })

    if (streamErr && !fullText) {
      throw streamErr
    }
    if (streamErr && fullText) {
      fullText += `\n\n⚠️ 流式响应中途出错：${(streamErr as Error).message || String(streamErr)}`
    }
    if (!fullText && chunkCount === 0) {
      // Model returned nothing — try to get response metadata for a useful error
      let detail = '模型返回了空响应（0 个文本片段）。'
      try {
        const finishReason = await result.finishReason
        const usage = await result.usage
        detail += ` finishReason=${finishReason}, usage=${JSON.stringify(usage)}`
      } catch {/* ignore */}
      throw new Error(detail)
    }

    // Save assistant message with tool call log and metadata
    const asstMsgId = randomUUID()
    const meta = JSON.stringify({
      model: effectiveModel,
      providerId: effectiveProviderId,
      providerName: effectiveProviderName,
      durationMs: Date.now() - runStartTime
    })
    dbRun(
      `INSERT INTO messages (id, session_id, role, content, tool_calls, meta, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
      [
        asstMsgId, sessionId, fullText,
        toolCallLog.length ? JSON.stringify(toolCallLog) : null,
        meta,
        Date.now()
      ]
    )

    // Update session updated_at
    dbRun(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [Date.now(), sessionId])
    const sessionTitle = tryAutoTitle(sessionId, message, false, false)
    const metaParsed = {
      model: effectiveModel,
      providerId: effectiveProviderId,
      providerName: effectiveProviderName,
      durationMs: Date.now() - runStartTime
    }

    win.webContents.send(IPC.AGENT_DONE, {
      sessionId,
      messageId: asstMsgId,
      content: fullText,
      toolCallLog,
      meta: metaParsed,
      ...(sessionTitle ? { sessionTitle } : {})
    })
  } catch (err: unknown) {
    console.error('[Agent] error', err)
    if ((err as Error)?.name === 'AbortError') {
      win.webContents.send(IPC.AGENT_DONE, { sessionId, content: '任务已中断', cancelled: true })
    } else {
      const e = err as Error
      const rawDetail = e?.message || String(err)
      const cause = (e as Error & { cause?: unknown })?.cause
      const detail = friendlyError(rawDetail, cause)
      win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: detail })
    }
  } finally {
    runningAgents.delete(sessionId)
  }
}

export function stopAgent(sessionId: string): void {
  runningAgents.get(sessionId)?.abort()
}

async function buildMessageHistory(
  sessionId: string,
  currentMessage: string,
  attachments: Array<{ name: string; path: string; mimeType: string }>
) {
  const rows = dbAll<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY created_at ASC LIMIT 40`,
    [sessionId]
  )

  // Exclude the just-inserted current user message (last row) from history,
  // since we add it explicitly below with attachments.
  const history = rows
    .slice(0, -1)
    .map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }))

  let userContent: string | Array<{ type: string; text?: string; image?: Buffer; mimeType?: string }> = currentMessage
  if (attachments.length) {
    const fs = await import('fs')

    // The model can't infer attachment file paths from thin air. Without this
    // manifest, file_write / file_read / vision_analyze get called with made-up
    // paths and fail with "File not found". List every attachment with its full
    // absolute path so the model can pick the right one.
    const manifestLines = attachments.map((a, i) =>
      `  [${i + 1}] ${a.name}  (${a.mimeType})\n      绝对路径: ${a.path}`
    ).join('\n')
    const manifest =
      `用户附加了 ${attachments.length} 个文件，绝对路径如下：\n${manifestLines}\n\n` +
      `如需读取、修改或分析这些文件，请把上面的"绝对路径"完整拷贝到工具调用的 ` +
      `filePath / imagePath 参数里（不要发明新路径，也不要省略盘符）。\n\n`
    const textWithManifest = manifest + currentMessage

    const parts: Array<{ type: string; text?: string; image?: Buffer; mimeType?: string }> = [
      { type: 'text', text: textWithManifest }
    ]
    for (const att of attachments) {
      if (att.mimeType.startsWith('image/')) {
        parts.push({ type: 'image', image: fs.readFileSync(att.path), mimeType: att.mimeType })
      }
    }
    userContent = parts
  }

  return [...history, { role: 'user' as const, content: userContent }]
}

function buildSystemPrompt(kbContext: string, mcpTools: McpTool[] = []): string {
  const base = `You are SuperStudio, a powerful AI productivity assistant. You can generate images, create videos, search the web, analyze files, and manipulate Excel data. Always be helpful and proactive. When a task requires multiple steps, execute them all without asking for confirmation between steps.`

  const sections: string[] = [base]

  if (mcpTools.length) {
    // Group MCP tools by server name for readability
    const byServer = new Map<string, McpTool[]>()
    for (const t of mcpTools) {
      const arr = byServer.get(t.serverName) ?? []
      arr.push(t)
      byServer.set(t.serverName, arr)
    }
    const lines: string[] = []
    for (const [server, tools] of byServer) {
      lines.push(`Server "${server}":`)
      for (const t of tools) {
        const desc = (t.description ?? '').trim() || '(no description provided)'
        lines.push(`  - ${t.qualifiedName} — ${desc}`)
      }
    }
    sections.push(
      `## MCP Tools (user-configured)\n` +
      `The user has configured the following MCP (Model Context Protocol) tools. ` +
      `These are specialized, user-chosen tools — PREFER them over the generic builtin equivalents when the task fits. ` +
      `For example, if a tool named "<server>__web_search" exists, use it instead of the builtin web_search; ` +
      `if an "<server>__understand_image" exists, use it instead of vision_analyze.\n\n` +
      lines.join('\n')
    )
  }

  if (kbContext) {
    sections.push(`## Knowledge Base Context\n${kbContext}`)
  }

  return sections.join('\n\n')
}

async function buildKbContext(message: string, _sessionId: string, _settings: AppSettings, mountedSpaceIds: string[] = []): Promise<string> {
  try {
    const { searchKnowledge } = await import('../services/knowledge')
    const parts: string[] = []
    // Mounted (session-level) spaces have higher priority
    if (mountedSpaceIds.length) {
      const mounted = await searchKnowledge(message, mountedSpaceIds)
      if (mounted.length) {
        parts.push('## Session Knowledge\n' + mounted.map((r: { content: string }) => r.content).join('\n\n'))
      }
    }
    // Global spaces — source of truth is kb_spaces.global_enabled (kept in sync by the UI toggle)
    const globalRows = dbAll<{ id: string }>(`SELECT id FROM kb_spaces WHERE global_enabled = 1`)
    const globalIds = globalRows.map(r => r.id).filter(id => !mountedSpaceIds.includes(id))
    if (globalIds.length) {
      const global = await searchKnowledge(message, globalIds)
      if (global.length) {
        parts.push('## Global Knowledge\n' + global.map((r: { content: string }) => r.content).join('\n\n'))
      }
    }
    return parts.join('\n\n')
  } catch (e) {
    console.warn('[kb] buildKbContext failed:', (e as Error).message)
    return ''
  }
}

function parseSizeFromMessage(msg: string): string {
  const m = msg.match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/)
  if (m) return `${m[1]}x${m[2]}`
  if (/竖[图图]|纵向|竖版|portrait/i.test(msg)) return '1024x1792'
  if (/横[图图]|横向|横版|landscape/i.test(msg)) return '1792x1024'
  return '1024x1024'
}

async function runDirectImageGeneration(opts: {
  message: string
  sessionId: string
  settings: AppSettings
  emit: (e: Omit<AgentProgressEvent, 'sessionId'>) => void
  win: BrowserWindow
  toolCallLog: Array<{ toolName: string; args: unknown; result: unknown }>
  providerId: string
  providerName: string
  model: string
  imageSize?: string
  imageQuality?: string
  attachments?: Array<{ name: string; path: string; mimeType: string }>
  runStartTime: number
}): Promise<void> {
  const { message, sessionId, settings, emit, win, toolCallLog, providerId, providerName, model, imageSize, imageQuality, attachments, runStartTime } = opts
  const size = imageSize || parseSizeFromMessage(message)
  const referenceImagePaths = attachments?.filter(a => a.mimeType.startsWith('image/')).map(a => a.path)
  const refCount = referenceImagePaths?.length ?? 0
  emit({ stepIndex: 0, stepName: 'Image Generation', toolName: 'image_generate', status: 'running',
    message: refCount ? `Generating image (${size}, ${refCount} reference${refCount > 1 ? 's' : ''})…` : `Generating image (${size})…` })
  try {
    // Use the provider selected in ChatHeader, not the global default image provider
    const imageSettings = { ...settings, defaultImageProviderId: providerId }
    const result = await generateImage({
      prompt: message, n: 1, size, quality: imageQuality, settings: imageSettings,
      referenceImagePaths: refCount ? referenceImagePaths : undefined
    })
    for (const img of result.images) {
      await saveGalleryItem({
        type: 'image', filePath: img.path, prompt: message,
        source: 'chat', sessionId, modelName: settings.defaultImageModel
      })
      emit({ stepIndex: 0, stepName: 'Image Generation', toolName: 'image_generate', status: 'done',
        artifact: { type: 'image', path: img.path } })
    }
    toolCallLog.push({ toolName: 'image_generate', args: { prompt: message, n: 1, size }, result })

    const replyText = result.referencesIgnored
      ? `已为你生成图片：${message}\n\n> ⚠️ 当前 API 不支持参考图功能，已按文本提示直接生成。`
      : `已为你生成图片：${message}`

    // Save assistant message with metadata
    const asstMsgId = randomUUID()
    const meta = JSON.stringify({
      model,
      providerId,
      providerName,
      durationMs: Date.now() - runStartTime
    })
    dbRun(
      `INSERT INTO messages (id, session_id, role, content, tool_calls, meta, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
      [asstMsgId, sessionId, replyText, JSON.stringify(toolCallLog), meta, Date.now()]
    )
    dbRun(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [Date.now(), sessionId])
    const sessionTitle = tryAutoTitle(sessionId, message, true, false)
    const metaParsed = { model, providerId, providerName, durationMs: Date.now() - runStartTime }
    win.webContents.send(IPC.AGENT_DONE, {
      sessionId, messageId: asstMsgId,
      content: replyText,
      toolCallLog,
      meta: metaParsed,
      ...(sessionTitle ? { sessionTitle } : {})
    })
  } catch (err) {
    const msg = (err as Error)?.message || String(err)
    win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: `图片生成失败：${msg}` })
  }
}

async function analyzeImage(imagePath: string, question: string, settings: AppSettings): Promise<{ description: string }> {
  const fs = await import('fs')
  const imageData = fs.readFileSync(imagePath)
  const model = createLLMClient(settings.defaultChatProviderId, settings.defaultChatModel)
  const { generateText } = await import('ai')
  const result = await generateText({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', image: imageData, mimeType: 'image/png' },
        { type: 'text', text: question }
      ]
    }]
  })
  return { description: result.text }
}

function friendlyError(message: string, cause?: unknown): string {
  const causeStr = cause ? String(cause) : ''
  const full = `${message} ${causeStr}`.toLowerCase()

  if (full.includes('temporarily unavailable') || full.includes('service unavailable') || full.includes('503')) {
    return `服务暂时不可用（503）。这通常是模型服务过载，请稍等片刻后重试。\n\n原始信息：${message}`
  }
  if (full.includes('rate limit') || full.includes('429') || full.includes('too many requests')) {
    return `请求频率超限（429 Rate Limit）。请稍等几秒后重试，或切换到其他模型。\n\n原始信息：${message}`
  }
  if (full.includes('401') || full.includes('invalid api key') || full.includes('unauthorized')) {
    return `API Key 无效或未授权（401）。请到「设置 → 提供商」检查 API Key 是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('403') || full.includes('forbidden')) {
    return `访问被拒绝（403）。请确认 API Key 有权限调用该模型。\n\n原始信息：${message}`
  }
  if (full.includes('404') || full.includes('model not found') || full.includes('no such model')) {
    return `模型不存在（404）。请到「设置 → 默认模型」检查模型名称是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('connection') || full.includes('econnrefused') || full.includes('network')) {
    return `网络连接失败。请检查网络连接和 Base URL 配置是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('timeout') || full.includes('timed out')) {
    return `请求超时。模型响应时间过长，请重试或尝试更短的输入。\n\n原始信息：${message}`
  }
  if (full.includes('context length') || full.includes('token') || full.includes('maximum context')) {
    return `输入内容超过模型最大上下文长度。请缩短消息或开启新会话。\n\n原始信息：${message}`
  }

  return causeStr ? `${message}\n原因：${causeStr}` : message
}

// Import AppSettings type for internal use
import type { AppSettings } from '../../../src/shared/ipc-types'
