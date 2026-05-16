import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { dbRun, dbAll } from '../db/sqlite'
import { indexContent, deleteBySourceId, deleteBySpaceId, searchKnowledge } from '../services/knowledge'
import { readFile } from '../services/fileops'
import { randomUUID } from 'crypto'
import { getMainWindow } from '../index'

export function kbHandlers(): void {
  ipcMain.handle(IPC.KB_SPACES_LIST, () =>
    dbAll(`SELECT * FROM kb_spaces ORDER BY created_at ASC`)
  )

  ipcMain.handle(IPC.KB_SPACES_SAVE, (_e, space) => {
    const now = Date.now()
    if (space.id) {
      dbRun(`UPDATE kb_spaces SET name = ?, global_enabled = ? WHERE id = ?`,
        [space.name, space.globalEnabled ? 1 : 0, space.id])
    } else {
      const id = randomUUID()
      dbRun(`INSERT INTO kb_spaces (id, name, global_enabled, created_at) VALUES (?, ?, ?, ?)`,
        [id, space.name, space.globalEnabled ? 1 : 0, now])
      return { id, name: space.name, globalEnabled: false, createdAt: now }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.KB_SPACES_DELETE, async (_e, id: string) => {
    await deleteBySpaceId(id)
    dbRun(`DELETE FROM kb_pages WHERE space_id = ?`, [id])
    dbRun(`DELETE FROM kb_sources WHERE space_id = ?`, [id])
    dbRun(`DELETE FROM kb_spaces WHERE id = ?`, [id])
    return { ok: true }
  })

  ipcMain.handle(IPC.KB_PAGES_LIST, (_e, spaceId: string) =>
    dbAll(`SELECT * FROM kb_pages WHERE space_id = ? ORDER BY created_at ASC`, [spaceId])
  )

  ipcMain.handle(IPC.KB_PAGES_SAVE, async (_e, page) => {
    const now = Date.now()
    const isNew = !page.id
    const id = page.id || randomUUID()
    if (isNew) {
      dbRun(`INSERT INTO kb_pages (id, space_id, title, content, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, page.spaceId, page.title, page.content, now, now])
    } else {
      await deleteBySourceId(`page:${id}`)
      dbRun(`UPDATE kb_pages SET title = ?, content = ?, updated_at = ? WHERE id = ?`,
        [page.title, page.content, now, id])
    }
    if (page.content?.trim()) {
      try {
        await indexContent(page.spaceId, `page:${id}`, page.content)
      } catch (e) {
        console.warn('[kb] page indexing failed:', (e as Error).message)
        return { id, ok: true, indexError: (e as Error).message }
      }
    }
    return { id, ok: true }
  })

  ipcMain.handle(IPC.KB_PAGES_DELETE, async (_e, id: string) => {
    await deleteBySourceId(`page:${id}`)
    dbRun(`DELETE FROM kb_pages WHERE id = ?`, [id])
    return { ok: true }
  })

  ipcMain.handle(IPC.KB_IMPORT_FILE, async (_e, params: { spaceId: string; filePath: string; name: string }) => {
    const { spaceId, filePath, name } = params
    const sourceId = randomUUID()
    const now = Date.now()
    dbRun(`INSERT INTO kb_sources (id, space_id, name, file_path, source_type, chunk_count, created_at) VALUES (?, ?, ?, ?, 'file', 0, ?)`,
      [sourceId, spaceId, name, filePath, now])

    const win = getMainWindow()
    const { content } = await readFile(filePath)
    let chunkCount = 0

    try {
      await indexContent(spaceId, sourceId, content, (current, total) => {
        chunkCount = total
        win?.webContents.send('kb:import-progress', { sourceId, name, current, total })
      })
    } catch (e) {
      // Roll back on failure so user sees a clean state
      dbRun(`DELETE FROM kb_sources WHERE id = ?`, [sourceId])
      throw e
    }

    dbRun(`UPDATE kb_sources SET chunk_count = ? WHERE id = ?`, [chunkCount, sourceId])
    return { sourceId, chunkCount, ok: true }
  })

  ipcMain.handle(IPC.KB_SEARCH, async (_e, query: string, spaceIds?: string[]) => {
    // If caller didn't specify, fall back to globally-enabled spaces
    const ids = spaceIds?.length
      ? spaceIds
      : dbAll<{ id: string }>(`SELECT id FROM kb_spaces WHERE global_enabled = 1`).map(r => r.id)
    const hits = await searchKnowledge(query, ids)

    // Resolve source titles (page title or file name) for nicer UI
    const sourceIds = Array.from(new Set(hits.map(h => h.sourceId)))
    const titleMap: Record<string, { title: string; kind: 'page' | 'file'; pageId?: string }> = {}
    for (const sid of sourceIds) {
      if (sid.startsWith('page:')) {
        const pageId = sid.slice(5)
        const page = dbAll<{ title: string }>(`SELECT title FROM kb_pages WHERE id = ? LIMIT 1`, [pageId])[0]
        if (page) titleMap[sid] = { title: page.title || '未命名', kind: 'page', pageId }
      } else {
        const src = dbAll<{ name: string }>(`SELECT name FROM kb_sources WHERE id = ? LIMIT 1`, [sid])[0]
        if (src) titleMap[sid] = { title: src.name, kind: 'file' }
      }
    }
    return hits.map(h => ({ ...h, source: titleMap[h.sourceId] ?? { title: '未知来源', kind: 'file' as const } }))
  })

  ipcMain.handle(IPC.KB_SOURCES_LIST, (_e, spaceId: string) =>
    dbAll(`SELECT * FROM kb_sources WHERE space_id = ? ORDER BY created_at DESC`, [spaceId])
  )

  ipcMain.handle(IPC.KB_SOURCES_DELETE, async (_e, sourceId: string) => {
    await deleteBySourceId(sourceId)
    dbRun(`DELETE FROM kb_sources WHERE id = ?`, [sourceId])
    return { ok: true }
  })

  ipcMain.handle(IPC.KB_REINDEX_SPACE, async (_e, spaceId: string) => {
    const win = getMainWindow()
    // 1. drop all existing vectors for this space
    await deleteBySpaceId(spaceId)

    // 2. re-vectorize pages
    const pages = dbAll<{ id: string; content: string }>(
      `SELECT id, content FROM kb_pages WHERE space_id = ? AND content != ''`,
      [spaceId]
    )

    // 3. re-vectorize file sources (re-read original file)
    const sources = dbAll<{ id: string; name: string; file_path: string }>(
      `SELECT id, name, file_path FROM kb_sources WHERE space_id = ? AND source_type = 'file'`,
      [spaceId]
    )

    const totalUnits = pages.length + sources.length
    let unitIdx = 0
    const errors: Array<{ name: string; error: string }> = []

    for (const page of pages) {
      unitIdx++
      win?.webContents.send('kb:import-progress', {
        sourceId: `page:${page.id}`,
        name: '页面',
        current: unitIdx,
        total: totalUnits
      })
      try {
        await indexContent(spaceId, `page:${page.id}`, page.content)
      } catch (e) {
        errors.push({ name: page.id, error: (e as Error).message })
      }
    }

    for (const src of sources) {
      unitIdx++
      win?.webContents.send('kb:import-progress', {
        sourceId: src.id,
        name: src.name,
        current: unitIdx,
        total: totalUnits
      })
      try {
        const { content } = await readFile(src.file_path)
        let chunkCount = 0
        await indexContent(spaceId, src.id, content, (_c, t) => { chunkCount = t })
        dbRun(`UPDATE kb_sources SET chunk_count = ? WHERE id = ?`, [chunkCount, src.id])
      } catch (e) {
        errors.push({ name: src.name, error: (e as Error).message })
      }
    }

    return { ok: true, total: totalUnits, errors }
  })
}
