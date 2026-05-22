import { dbRun, dbAll, dbGet } from '../db/sqlite'
import fs from 'fs'
import type { GalleryItem } from '../../../src/shared/ipc-types'
import { invalidateDbCache, registerApproved } from './path-allow'

interface SaveParams {
  type: 'image' | 'video' | 'audio'
  filePath: string
  thumbnailPath?: string
  prompt: string
  source: 'chat' | 'workflow' | 'import'
  sessionId?: string
  workflowId?: string
  modelName?: string
}

export async function saveGalleryItem(params: SaveParams): Promise<number> {
  dbRun(
    `INSERT INTO gallery (type, file_path, thumbnail_path, prompt, source, session_id, workflow_id, model_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.type,
      params.filePath,
      params.thumbnailPath ?? null,
      params.prompt,
      params.source,
      params.sessionId ?? null,
      params.workflowId ?? null,
      params.modelName ?? null,
      Date.now()
    ]
  )
  // Gallery items live under userData so they'd already be allowed by the root
  // prefix check, but invalidate the cache + explicitly register so deleted
  // items don't linger and the search is O(1).
  invalidateDbCache()
  registerApproved(params.filePath)
  if (params.thumbnailPath) registerApproved(params.thumbnailPath)
  const row = dbGet<{ id: number }>(`SELECT last_insert_rowid() as id`)
  return row?.id ?? 0
}

export function listGallery(filters?: { type?: string; source?: string }): GalleryItem[] {
  let sql = `SELECT id, type, file_path AS filePath, thumbnail_path AS thumbnailPath,
    prompt, source, session_id AS sessionId, workflow_id AS workflowId,
    model_name AS modelName, created_at AS createdAt FROM gallery WHERE 1=1`
  const params: unknown[] = []
  if (filters?.type && filters.type !== 'all') {
    sql += ` AND type = ?`; params.push(filters.type)
  }
  if (filters?.source && filters.source !== 'all') {
    sql += ` AND source = ?`; params.push(filters.source)
  }
  sql += ` ORDER BY created_at DESC`
  return dbAll<GalleryItem>(sql, params)
}

export function deleteGalleryItem(id: number): void {
  const item = dbGet<{ file_path: string }>(`SELECT file_path FROM gallery WHERE id = ?`, [id])
  if (item?.file_path) {
    try { fs.unlinkSync(item.file_path) } catch { /* ignore */ }
  }
  dbRun(`DELETE FROM gallery WHERE id = ?`, [id])
}

export function batchDeleteGallery(ids: number[]): void {
  for (const id of ids) deleteGalleryItem(id)
}
