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

/**
 * Search IMAGE items for the composer's @-mention picker. Pushes the filter +
 * LIMIT into SQL so a huge library never loads wholesale into the renderer.
 * Empty query → the most recent `limit` images.
 */
export function searchGalleryImages(query: string, limit = 40): GalleryItem[] {
  const lim = Math.max(1, Math.min(Math.floor(limit) || 40, 200))
  let sql = `SELECT id, type, file_path AS filePath, thumbnail_path AS thumbnailPath,
    prompt, source, session_id AS sessionId, workflow_id AS workflowId,
    model_name AS modelName, created_at AS createdAt FROM gallery WHERE type = 'image'`
  const params: unknown[] = []
  const q = (query || '').trim()
  if (q) {
    sql += ` AND (file_path LIKE ? OR prompt LIKE ?)`
    params.push(`%${q}%`, `%${q}%`)
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`
  params.push(lim)
  return dbAll<GalleryItem>(sql, params)
}

/** Set or replace the thumbnail file for an existing gallery item.
 *  Used by the Video page after the renderer extracts a still frame. */
export function updateGalleryThumbnail(id: number, thumbnailPath: string): boolean {
  const row = dbGet<{ id: number }>(`SELECT id FROM gallery WHERE id = ?`, [id])
  if (!row) return false
  dbRun(`UPDATE gallery SET thumbnail_path = ? WHERE id = ?`, [thumbnailPath, id])
  invalidateDbCache()
  registerApproved(thumbnailPath)
  return true
}

export function deleteGalleryItem(id: number): void {
  const item = dbGet<{ file_path: string; thumbnail_path: string | null }>(
    `SELECT file_path, thumbnail_path FROM gallery WHERE id = ?`, [id]
  )
  if (item?.file_path) {
    try { fs.unlinkSync(item.file_path) } catch { /* ignore */ }
  }
  if (item?.thumbnail_path) {
    try { fs.unlinkSync(item.thumbnail_path) } catch { /* ignore */ }
  }
  dbRun(`DELETE FROM gallery WHERE id = ?`, [id])
}

export function batchDeleteGallery(ids: number[]): void {
  for (const id of ids) deleteGalleryItem(id)
}
