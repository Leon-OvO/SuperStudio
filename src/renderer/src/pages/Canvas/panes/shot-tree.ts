import type { GalleryItem } from '../../../../../shared/ipc-types'

/**
 * Derive a Shot → Group → file hierarchy from flat gallery items WITHOUT any DB
 * migration. The fields already exist (every canvas generation writes
 * sceneLabel + variantGroupId, see Canvas runImageGen/canvasGenerateOne):
 *   Shot   = sceneLabel (items with none fall under "未分镜 · <date>")
 *   Group  = variantGroupId within a shot (a "一批出图" batch of >1)
 *   file   = the GalleryItem leaf (image / video)
 * Single items (no variant batch) hang directly under the shot.
 */

function getDateGroup(ts: number): string {
  const now = Date.now()
  const day = 86_400_000
  const diff = now - ts
  if (diff < day && new Date(ts).getDate() === new Date().getDate()) return '今天'
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return '本周'
  return '更早'
}

export interface ShotTreeGroup { key: string; label: string; items: GalleryItem[] }
export interface ShotTreeNode {
  key: string
  label: string
  count: number
  groups: ShotTreeGroup[]
  singles: GalleryItem[]
  latest: number
}

const maxBy = (arr: GalleryItem[], f: (i: GalleryItem) => number): number =>
  arr.reduce((m, i) => Math.max(m, f(i)), -Infinity)

export function buildShotTree(items: GalleryItem[]): ShotTreeNode[] {
  // 1) bucket into shots by sceneLabel (else a date-bucketed "未分镜" shot)
  const shotMap = new Map<string, GalleryItem[]>()
  for (const it of items) {
    const key = it.sceneLabel?.trim() || `未分镜 · ${getDateGroup(it.createdAt)}`
    const arr = shotMap.get(key) ?? []
    arr.push(it); shotMap.set(key, arr)
  }
  // 2) within each shot, sub-group by variantGroupId (batches of >1)
  const shots: ShotTreeNode[] = []
  for (const [key, shotItems] of shotMap) {
    const groupMap = new Map<string, GalleryItem[]>()
    const singles: GalleryItem[] = []
    for (const it of shotItems) {
      const g = it.variantGroupId?.trim()
      if (g) { const a = groupMap.get(g) ?? []; a.push(it); groupMap.set(g, a) }
      else singles.push(it)
    }
    const groups: ShotTreeGroup[] = []
    let gi = 1
    for (const [gkey, gitems] of groupMap) {
      if (gitems.length > 1) groups.push({ key: gkey, label: `组 ${gi++} · ${gitems.length} 张`, items: gitems })
      else singles.push(...gitems) // a "batch" of one is just a single
    }
    groups.sort((a, b) => maxBy(b.items, i => i.createdAt) - maxBy(a.items, i => i.createdAt))
    singles.sort((a, b) => b.createdAt - a.createdAt)
    shots.push({ key, label: key, count: shotItems.length, groups, singles, latest: maxBy(shotItems, i => i.createdAt) })
  }
  shots.sort((a, b) => b.latest - a.latest) // 最新优先
  return shots
}
