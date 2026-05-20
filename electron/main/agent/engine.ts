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
import { mcpManager, type McpTool } from '../services/mcp'
import { getActiveSkillsForScenario, type InstalledSkill } from '../services/skills-db'
import { notifyTaskComplete } from '../services/tray'
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

  // Gather skills configured for the chat scenario — each one contributes a
  // system prompt fragment and (optionally) restricts the tool list.
  let activeSkills: InstalledSkill[] = []
  try {
    activeSkills = getActiveSkillsForScenario('chat')
    if (activeSkills.length) {
      console.log(`[Agent] active chat skills: ${activeSkills.map(s => s.id).join(', ')}`)
    }
  } catch (e) {
    console.warn('[Agent] failed to load active skills:', (e as Error).message)
  }
  const systemPrompt = buildSystemPrompt(kbContext, mcpTools, activeSkills)

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
    const mcpToolEntries: Record<string, unknown> = {}
    for (const mt of mcpTools) {
      mcpToolEntries[mt.qualifiedName] = tool({
        description: mt.description ?? `${mt.toolName} (from MCP server "${mt.serverName}")`,
        parameters: jsonSchema(mt.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args) => {
          const myIdx = stepIndex++
          emit({
            stepIndex: myIdx,
            stepName: `MCP · ${mt.serverName}`,
            toolName: mt.qualifiedName,
            status: 'running',
            message: mt.toolName
          })
          try {
            const { text, artifacts } = await mcpManager.callTool(mt.qualifiedName, args, { sessionId })

            // Emit a "done" event per image/video artifact so the chat progress
            // panel can render a thumbnail for each. Audio doesn't fit the
            // AgentProgressEvent.artifact union (image|video) — its path is
            // still in `text` for the model to mention.
            const visualArts = artifacts.filter(a => a.type === 'image' || a.type === 'video')
            if (visualArts.length === 0) {
              emit({
                stepIndex: myIdx,
                stepName: `MCP · ${mt.serverName}`,
                toolName: mt.qualifiedName,
                status: 'done'
              })
            } else {
              // Reuse the same stepIndex so the progress row updates in place;
              // the LAST artifact "wins" visually. All are still in toolCallLog.
              for (const art of visualArts) {
                emit({
                  stepIndex: myIdx,
                  stepName: `MCP · ${mt.serverName}`,
                  toolName: mt.qualifiedName,
                  status: 'done',
                  artifact: { type: art.type as 'image' | 'video', path: art.path }
                })
              }
            }

            toolCallLog.push({
              toolName: mt.qualifiedName,
              args,
              result: { text, artifacts }
            })
            return text
          } catch (err) {
            const msg = (err as Error).message
            emit({ stepIndex: myIdx, stepName: `MCP · ${mt.serverName}`, toolName: mt.qualifiedName, status: 'error', message: msg })
            toolCallLog.push({ toolName: mt.qualifiedName, args, result: { error: msg } })
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

    const allTools: Record<string, ReturnType<typeof tool>> = {
        ...(mcpToolEntries as Record<string, ReturnType<typeof tool>>),
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
              await saveGalleryItem({
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
            const result = await generateVideo({ prompt, referenceImagePath: referenceImagePath ?? undefined, settings, win, sessionId, abortSignal: abort.signal })
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
            // abort.signal lets Stop interrupt a long PDF/PPTX parse
            const result = await readFile(filePath, abort.signal)
            emit({ stepIndex: stepIndex - 1, stepName: 'File Read', toolName: 'file_read', status: 'done' })
            toolCallLog.push({ toolName: 'file_read', args: { filePath }, result })
            return result
          }
        }),
        file_write: tool({
          description: `Create a new XLSX file OR modify an existing one. ` +
            `If filePath does not exist, a new workbook is created (existing-file path is auto-backed up before writing). ` +
            `For new files, reference any sheet name you want — it will be created on demand; otherwise use the existing sheet names from a prior file_read.\n` +
            `operationsJson must be a JSON-encoded array of operations. Each operation:\n` +
            `  { "sheet": "<sheet-name>", "action": "set_cell" | "set_range" | "copy_column", "params": { ... action-specific params ... } }\n` +
            `Examples of params:\n` +
            `  set_cell:   { "cell": "B2", "value": "hello" }\n` +
            `  set_range:  { "startCell": "A1", "data": [["Header1","Header2"],[1,2],[3,4]] }\n` +
            `  copy_column: { "sourceSheet": "Sheet1", "sourceCol": "B", "targetCol": "D", "startRow": 1, "endRow": 100 }\n` +
            `Always pass a complete absolute filePath. If user didn't specify a location, default to the desktop path given in the system instructions.`,
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
            const result = await writeFile({ filePath, operations: operations as Parameters<typeof writeFile>[0]['operations'] })
            emit({ stepIndex: stepIndex - 1, stepName: 'File Write', toolName: 'file_write', status: 'done',
              message: result.backupPath ? `Backup: ${result.backupPath}` : undefined })
            toolCallLog.push({ toolName: 'file_write', args: { filePath, operations }, result })
            return result
          }
        })
        // NOTE: gallery_save is intentionally NOT exposed as a tool. Every image
        // / video generation path (image_generate, video_generate, image_edit,
        // MCP image/video tools, workflow nodes) already calls saveGalleryItem
        // automatically. Exposing it as a tool only causes the model to either
        // skip it (missing entries) or double-call it (duplicate entries).
      }

    // Apply skill tool whitelist (union across skills; null = unrestricted)
    const allowSet = computeToolAllowSet(activeSkills)
    const tools: Record<string, ReturnType<typeof tool>> = allowSet
      ? Object.fromEntries(Object.entries(allTools).filter(([name]) => allowSet.has(name)))
      : allTools
    if (allowSet) {
      const dropped = Object.keys(allTools).filter(n => !allowSet.has(n))
      if (dropped.length) console.log(`[Agent] skills filtered tools, dropped: ${dropped.join(', ')}`)
    }

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
      tools
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
    notifyTaskComplete(() => win, {
      title: 'SuperStudio：回复已完成',
      body: fullText.slice(0, 120) || '助手已生成回复。'
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

  type UserPart =
    | { type: 'text'; text: string }
    | { type: 'image'; image: Buffer; mimeType: string }
  let userContent: string | UserPart[] = currentMessage
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

    const parts: UserPart[] = [
      { type: 'text', text: textWithManifest }
    ]
    // Inline image attachments as `image` parts so vision-capable models can
    // see them directly. Log every step so when "AI can't see the image" gets
    // reported we can pinpoint whether it's a path / read / mime issue.
    for (const att of attachments) {
      const mt = att.mimeType ?? ''
      if (!mt.startsWith('image/')) {
        console.log(`[Agent] attachment "${att.name}" mime="${mt}" — not an image, will be referenced via manifest only`)
        continue
      }
      if (!fs.existsSync(att.path)) {
        console.warn(`[Agent] ⚠ image attachment file missing on disk — will be skipped:`, att.path)
        const first = parts[0]
        if (first.type === 'text') {
          first.text += `\n\n[警告：附件 ${att.name} 的临时文件不存在 (${att.path})，AI 无法看到该图。可能原因：临时目录被清理、或粘贴时写入失败。请重新粘贴。]`
        }
        continue
      }
      try {
        const data = fs.readFileSync(att.path)
        parts.push({ type: 'image', image: data, mimeType: mt })
        console.log(`[Agent] ✓ inlined image attachment "${att.name}" (${(data.length / 1024).toFixed(1)} KB, ${mt})`)
      } catch (e) {
        console.error(`[Agent] failed to read image attachment "${att.name}":`, (e as Error).message)
        const first = parts[0]
        if (first.type === 'text') {
          first.text += `\n\n[警告：附件 ${att.name} 读取失败：${(e as Error).message}]`
        }
      }
    }
    userContent = parts
  }

  return [...history, { role: 'user' as const, content: userContent }]
}

function buildSystemPrompt(kbContext: string, mcpTools: McpTool[] = [], skills: InstalledSkill[] = []): string {
  const desktop = (() => {
    try { return app.getPath('desktop') } catch { return '' }
  })()

  const base = `You are SuperStudio, a powerful AI productivity assistant. You can generate images, create videos, search the web, analyze files, and manipulate Excel data. Always be helpful and proactive. When a task requires multiple steps, execute them all without asking for confirmation between steps.`

  const displaySection =
    `## Output convention — CRITICAL\n` +
    `Whenever a tool produces an image, video or audio file, the SuperStudio UI displays it INLINE in the chat automatically (a thumbnail is rendered from the tool result; the user can click to enlarge, edit, save, etc.).\n` +
    `Therefore in your final reply:\n` +
    `- Do NOT embed Markdown image syntax (no \`![alt](path)\`, no \`<img>\` tags).\n` +
    `- Do NOT paste local file paths or remote URLs of the generated media — they are noisy and the user already sees the thumbnail.\n` +
    `- DO describe what you generated in natural language (subject, style, key params used). Tell the user it has been saved to the gallery if relevant.\n` +
    `- For multiple generated images in one turn, describe each by index/role (e.g. "第一张是…，第二张是…").`

  const filesystemSection =
    `## File system conventions\n` +
    (desktop
      ? `- User desktop directory (absolute path): ${desktop}\n` +
        `- When the user asks you to save / export / create a file and does NOT specify a directory, default to the desktop above (e.g. "${desktop.replace(/\\/g, '/')}/<filename>.xlsx"). Pick a descriptive Chinese filename matching the task.\n`
      : `- When saving files, always use absolute paths.\n`) +
    `- The file_write tool both CREATES new .xlsx files and modifies existing ones — passing a path that does not exist yet will create the file (sheets you reference are lazily created). No need to ask the user where to put it if they didn't specify; just default to the desktop.\n` +
    `- For new spreadsheets, build the header row with file_write "set_range" (operation type), then fill data rows. Always include a clear header row.`

  const sections: string[] = [base, displaySection, filesystemSection]

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

  if (skills.length) {
    const skillBlocks = skills.map(s => {
      const header = `### ${s.name}${s.version ? ` (v${s.version})` : ''}`
      const body = (s.systemPrompt || '').trim() || `(${s.description || 'no prompt provided'})`
      return `${header}\n${body}`
    }).join('\n\n')
    sections.push(
      `## Active Skills (user-enabled)\n` +
      `The user has enabled the following skills for chat. Follow each skill's guidance below where it applies; ` +
      `they are additive on top of your base behavior.\n\n${skillBlocks}`
    )
  }

  if (kbContext) {
    sections.push(`## Knowledge Base Context\n${kbContext}`)
  }

  return sections.join('\n\n')
}

/**
 * Compute the union of tool whitelists across active skills.
 * Returns `null` if any skill is unrestricted (null/undefined whitelist) —
 * meaning "no filter, allow everything". Returns a `Set<string>` otherwise.
 */
function computeToolAllowSet(skills: InstalledSkill[]): Set<string> | null {
  if (!skills.length) return null
  const allowed = new Set<string>()
  for (const s of skills) {
    if (!s.toolWhitelist) return null // any unrestricted skill removes the filter
    for (const name of s.toolWhitelist) allowed.add(name)
  }
  return allowed
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
    notifyTaskComplete(() => win, {
      title: 'SuperStudio：图片已生成',
      body: replyText.slice(0, 120) || '图片生成完成。'
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
