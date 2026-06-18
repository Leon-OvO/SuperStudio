import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react'

/** Minimal shape SshTree needs — satisfied by both SshConnection and the
 *  credential-free SshConnectionMeta. */
interface TreeItem { id: string; name: string; group?: string }

/**
 * MobaXterm-style nested folder tree for SSH connections, built from each
 * connection's `group` path (`/`-separated, e.g. "电魂/web/A类"). Folders are
 * collapsible; leaves are rendered by the caller via `renderItem` so both the
 * Settings list (edit/delete/select) and the 服务器 page (connect) can reuse it.
 */

interface TreeNode<T> {
  name: string
  path: string
  children: Map<string, TreeNode<T>>
  items: T[]
}

function buildTree<T extends TreeItem>(conns: T[]): TreeNode<T> {
  const root: TreeNode<T> = { name: '', path: '', children: new Map(), items: [] }
  for (const c of conns) {
    const path = (c.group || '').trim()
    if (!path) { root.items.push(c); continue }
    const segs = path.split('/').map(s => s.trim()).filter(Boolean)
    let node = root
    let acc = ''
    for (const seg of segs) {
      acc = acc ? acc + '/' + seg : seg
      let child = node.children.get(seg)
      if (!child) { child = { name: seg, path: acc, children: new Map(), items: [] }; node.children.set(seg, child) }
      node = child
    }
    node.items.push(c)
  }
  return root
}

function flatItems<T>(n: TreeNode<T>): T[] {
  const out = [...n.items]
  for (const ch of n.children.values()) out.push(...flatItems(ch))
  return out
}

interface Props<T extends TreeItem> {
  /** Already filtered by the caller (search etc.). */
  connections: T[]
  renderItem: (conn: T) => ReactNode
  /** Inject content into a folder header's left side (e.g. a group checkbox). */
  renderFolderExtra?: (folderPath: string, conns: T[]) => ReactNode
  /** Force-expand all folders (e.g. while a search query is active). */
  forceExpand?: boolean
  /** Sort comparator for leaf connections within a folder. */
  sortItems?: (a: T, b: T) => number
  /** Right-click on a folder header (path + all connections under it). */
  onFolderContextMenu?: (folderPath: string, conns: T[], e: React.MouseEvent) => void
}

export function SshTree<T extends TreeItem>({ connections, renderItem, renderFolderExtra, forceExpand, sortItems, onFolderContextMenu }: Props<T>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildTree(connections), [connections])
  const cmp = sortItems ?? ((a: T, b: T) => a.name.localeCompare(b.name))

  const toggle = (path: string) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n })

  const renderNode = (node: TreeNode<T>, depth: number): ReactNode => {
    const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
    const items = [...node.items].sort(cmp)
    return (
      <>
        {items.map(c => (
          <div key={c.id} style={{ paddingLeft: depth * 14 }}>{renderItem(c)}</div>
        ))}
        {folders.map(f => {
          const isCollapsed = !forceExpand && collapsed.has(f.path)
          return (
            <div key={f.path}>
              <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 14 }}
                onContextMenu={onFolderContextMenu ? (e => onFolderContextMenu(f.path, flatItems(f), e)) : undefined}>
                {renderFolderExtra?.(f.path, flatItems(f))}
                <button onClick={() => toggle(f.path)} className="flex items-center gap-1 hover:text-foreground min-w-0">
                  {isCollapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
                  {isCollapsed ? <Folder size={13} className="shrink-0 text-amber-500" fill="currentColor" /> : <FolderOpen size={13} className="shrink-0 text-amber-500" />}
                  <span className="font-medium truncate text-foreground/80">{f.name}</span>
                  <span className="text-muted-foreground/60 shrink-0">· {flatItems(f).length}</span>
                </button>
              </div>
              {!isCollapsed && renderNode(f, depth + 1)}
            </div>
          )
        })}
      </>
    )
  }

  return <div className="space-y-1.5">{renderNode(tree, 0)}</div>
}
