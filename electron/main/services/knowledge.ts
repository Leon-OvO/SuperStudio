import * as lancedb from '@lancedb/lancedb'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { getSettings } from './store'
import { randomUUID } from 'crypto'

let lanceDb: Awaited<ReturnType<typeof lancedb.connect>> | null = null
let lanceDbDir: string | null = null

async function getDb() {
  const settings = getSettings()
  const baseDir = settings.dataDirectory || app.getPath('userData')
  const dir = path.join(baseDir, 'lancedb')
  if (!lanceDb || lanceDbDir !== dir) {
    fs.mkdirSync(dir, { recursive: true })
    lanceDb = await lancedb.connect(dir)
    lanceDbDir = dir
  }
  return lanceDb
}

/** Hard ceiling for a single embedding HTTP call. A dead/slow provider that
 *  holds the TCP connection open without ever responding would otherwise hang
 *  the caller forever — and because callers run under the shared agentRun
 *  semaphore, a few such hangs leak every slot and freeze 对话 + 工作台 alike. */
const EMBEDDING_TIMEOUT_MS = 12_000

async function getEmbedding(text: string, signal?: AbortSignal): Promise<number[]> {
  const settings = getSettings()
  const { getProviders } = await import('./store')
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultEmbeddingProviderId)
  if (!provider) throw new Error('请先在「设置 → 默认模型」配置 Embedding 提供商。')

  // Strip trailing /v1 so users can configure baseUrl with or without it
  const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
  const model = settings.defaultEmbeddingModel || 'text-embedding-3-small'
  // Combine the caller's abort signal (so Stop interrupts it) with a timeout
  // (so an unresponsive provider can never hang the request indefinitely).
  const timeout = AbortSignal.timeout(EMBEDDING_TIMEOUT_MS)
  const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({ model, input: text }),
      signal: reqSignal
    })
  } catch (e) {
    if (timeout.aborted) throw new Error(`Embedding 请求超时（>${EMBEDDING_TIMEOUT_MS / 1000}s），Embedding 服务无响应`)
    throw e
  }
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Embedding (${res.status}): ${err}`)
  }
  const data = await res.json() as { data?: Array<{ embedding: number[] }> }
  if (!data.data?.[0]?.embedding) throw new Error('Embedding 返回内容为空')
  return data.data[0].embedding
}

function chunkText(text: string, maxTokens = 400): string[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let current = ''
  for (const para of paragraphs) {
    if ((current + para).length > maxTokens * 4) {
      if (current) chunks.push(current.trim())
      current = para
    } else {
      current += (current ? '\n\n' : '') + para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(c => c.length > 20)
}

export async function indexContent(
  spaceId: string,
  sourceId: string,
  content: string,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const chunks = chunkText(content)
  if (chunks.length === 0) return
  const db = await getDb()

  const tableName = 'kb_chunks'
  let table: Awaited<ReturnType<typeof db.openTable>> | null = null
  try {
    table = await db.openTable(tableName)
  } catch {
    // table doesn't exist yet, will be created on first add
  }

  // Snapshot the first vector's dimension so we can detect a model change
  // before LanceDB throws a much less actionable error.
  const records: Array<{ id: string; space_id: string; source_id: string; content: string; vector: number[] }> = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i + 1, chunks.length)
    const vector = await getEmbedding(chunks[i])
    records.push({ id: randomUUID(), space_id: spaceId, source_id: sourceId, content: chunks[i], vector })
  }

  if (!table) {
    await db.createTable(tableName, records)
    return
  }

  // If the existing table holds vectors of a different dimension, LanceDB
  // would throw something like "expected vector of length 1536 but got 768".
  // Re-shape that into a user-actionable error pointing at the reindex flow.
  try {
    await table.add(records)
  } catch (e) {
    const msg = (e as Error).message || ''
    const dimMatch = msg.match(/(\d+)[^\d]+(\d+)/)
    if (/dimension|length|width|shape|expected/i.test(msg) && dimMatch) {
      throw new Error(
        `Embedding 模型维度与已有索引不匹配（期望 ${dimMatch[1]}，本次得到 ${dimMatch[2]}）。\n` +
        `通常是你切换了「设置 → 默认模型 → Embedding 模型」之后旧索引还没重建。\n` +
        `请进入「知识库」页 → 当前空间右上角 🔄 「重建索引」按钮，一键删除旧向量并按当前模型重新生成。`
      )
    }
    throw e
  }
}

export async function deleteBySourceId(sourceId: string): Promise<void> {
  const db = await getDb()
  try {
    const table = await db.openTable('kb_chunks')
    await table.delete(`source_id = '${sourceId}'`)
  } catch { /* table may not exist */ }
}

export async function searchKnowledge(
  query: string,
  spaceIds: string[],
  topK = 5,
  signal?: AbortSignal
): Promise<Array<{ content: string; score: number; spaceId: string; sourceId: string }>> {
  if (spaceIds.length === 0) return []
  const db = await getDb()
  try {
    const table = await db.openTable('kb_chunks')
    const queryVec = await getEmbedding(query, signal)
    const results = await table
      .vectorSearch(queryVec)
      .limit(topK * 4)
      .toArray()

    return results
      .filter((r: { space_id: string; _distance: number }) => spaceIds.includes(r.space_id) && r._distance < 0.7)
      .slice(0, topK)
      .map((r: { content: string; _distance: number; space_id: string; source_id: string }) => ({
        content: r.content,
        score: 1 - r._distance,
        spaceId: r.space_id,
        sourceId: r.source_id
      }))
  } catch (e) {
    console.warn('[kb] searchKnowledge failed:', (e as Error).message)
    return []
  }
}

/** Delete every vector chunk belonging to a space (used when reindexing or deleting). */
export async function deleteBySpaceId(spaceId: string): Promise<void> {
  const db = await getDb()
  try {
    const table = await db.openTable('kb_chunks')
    await table.delete(`space_id = '${spaceId}'`)
  } catch { /* table may not exist */ }
}
