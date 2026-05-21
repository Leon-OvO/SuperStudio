import { useEffect, useMemo, useState } from 'react'
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown,
  RefreshCw, ExternalLink, Copy, Check, ChevronsDown, FolderTree,
  Search as SearchIcon
} from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { FileTreeNode } from '../../../../../shared/ipc-types'

interface Props {
  root: FileTreeNode | null
  activeFilePath: string | null
  onOpenFile: (path: string) => void
  onRefresh: () => void
  /** Optional — when provided, header shows a collapse chevron that calls this. */
  onCollapse?: () => void
  dirtyPaths?: Set<string>
}

interface ContextMenuState {
  x: number
  y: number
  node: FileTreeNode
}

// Quote a value for safe use inside a CSS attribute selector. Chromium has
// CSS.escape, but we treat backslashes (Windows paths) explicitly so the
// query stays predictable in tests/older runtimes too.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[\\"]/g, '\\$&')
}

function countFiles(node: FileTreeNode | null): number {
  if (!node) return 0
  let total = node.isDir ? 0 : 1
  if (node.children) for (const c of node.children) total += countFiles(c)
  return total
}

function flattenMatches(node: FileTreeNode, q: string, out: FileTreeNode[]): void {
  if (!node.isDir && node.name.toLowerCase().includes(q)) out.push(node)
  if (node.children) for (const c of node.children) flattenMatches(c, q, out)
}

export function FileExplorer({ root, activeFilePath, onOpenFile, onRefresh, onCollapse, dirtyPaths }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root ? [root.path] : []))
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!ctxMenu) return
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-context-menu]')) setCtxMenu(null)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [ctxMenu])

  // Listen for "reveal in side bar" requests fired from tab right-click menus.
  // Expand every ancestor folder of the target path so the file becomes
  // visible — selection highlight is already driven by `activeFilePath`.
  useEffect(() => {
    function onReveal(e: Event) {
      const detail = (e as CustomEvent<{ path: string }>).detail
      const target = detail?.path
      if (!target || !root) return
      const rootPath = root.path.replace(/[\\/]+$/, '')
      if (!target.startsWith(rootPath)) return
      const ancestors: string[] = [rootPath]
      let cur = target
      // Strip the file itself
      const lastSep = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))
      if (lastSep >= 0) cur = cur.slice(0, lastSep)
      // Walk up from the file's directory until we hit the project root.
      while (cur.length > rootPath.length) {
        ancestors.push(cur)
        const sep = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))
        if (sep < 0) break
        cur = cur.slice(0, sep)
      }
      setExpanded(prev => {
        const next = new Set(prev)
        for (const a of ancestors) next.add(a)
        return next
      })
      // Defer the scroll so the newly-expanded folders have rendered first.
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-file-path="${cssEscape(target)}"]`)
        if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
          ;(el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      })
    }
    window.addEventListener('vibe:reveal-file', onReveal)
    return () => window.removeEventListener('vibe:reveal-file', onReveal)
  }, [root])

  const fileCount = useMemo(() => countFiles(root), [root])
  const trimmed = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!trimmed || !root) return null
    const out: FileTreeNode[] = []
    flattenMatches(root, trimmed, out)
    return out
  }, [root, trimmed])

  const toggle = (p: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  function handleContextMenu(e: React.MouseEvent, node: FileTreeNode) {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, node })
  }

  async function handleRevealInFolder() {
    if (!ctxMenu) return
    try {
      await window.api.showItemInFolder?.(ctxMenu.node.path)
    } catch (e) {
      console.error('reveal failed:', e)
    }
    setCtxMenu(null)
  }

  async function handleCopyPath() {
    if (!ctxMenu) return
    try {
      await navigator.clipboard.writeText(ctxMenu.node.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch (e) {
      console.error('copy failed:', e)
    }
    setTimeout(() => setCtxMenu(null), 600)
  }

  function relativeName(p: string): string {
    if (!root) return p
    const rootP = root.path
    if (p.startsWith(rootP)) {
      const rel = p.slice(rootP.length).replace(/^[\\/]/, '')
      const parts = rel.split(/[\\/]/)
      parts.pop()
      return parts.join('/') || ''
    }
    return ''
  }

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FolderTree size={13} className="text-amber-500 shrink-0" />
          <span className="text-[12px] font-semibold tracking-tight">文件</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{fileCount}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {root && (
            <button
              onClick={async () => { try { await window.api.showItemInFolder?.(root.path) } catch {} }}
              className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
              title="在文件管理器中打开项目"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            onClick={onRefresh}
            className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
            title="刷新文件树"
          >
            <RefreshCw size={11} />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
              title="折叠文件浏览器"
            >
              <ChevronsDown size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      {root && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative">
            <SearchIcon size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="按文件名筛选…"
              className="w-full h-7 pl-7 pr-2 rounded-md bg-background border border-border text-[11px] outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 placeholder:text-muted-foreground/50"
            />
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-1 pb-2 text-[12px]">
        {!root ? (
          <div className="text-[12px] text-muted-foreground text-center py-8 px-3 leading-relaxed">
            未打开项目
          </div>
        ) : trimmed && matches ? (
          matches.length === 0 ? (
            <div className="text-[12px] text-muted-foreground text-center py-8 px-3 leading-relaxed">
              没有匹配「{query}」的文件
            </div>
          ) : (
            <div className="px-1 space-y-px">
              <div className="text-[11px] text-muted-foreground px-2 pt-1 pb-1.5">
                {matches.length} 个匹配
              </div>
              {matches.map(n => {
                const isSelected = activeFilePath === n.path
                const isDirty = dirtyPaths?.has(n.path)
                const dir = relativeName(n.path)
                return (
                  <div
                    key={n.path}
                    onClick={() => onOpenFile(n.path)}
                    onContextMenu={(e) => handleContextMenu(e, n)}
                    className={cn(
                      'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors',
                      isSelected
                        ? 'bg-primary/10 ring-1 ring-primary/30 text-foreground'
                        : 'hover:bg-accent/40 text-foreground/85'
                    )}
                    title={n.path}
                  >
                    <FileIcon size={11} className="shrink-0 text-muted-foreground/70" />
                    <span className="truncate flex-1">{n.name}</span>
                    {dir && (
                      <span className="text-[11px] text-muted-foreground/80 truncate max-w-[40%]">{dir}</span>
                    )}
                    {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <TreeNode
            node={root}
            depth={0}
            expanded={expanded}
            activeFilePath={activeFilePath}
            dirtyPaths={dirtyPaths}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onContextMenu={handleContextMenu}
            isRoot
          />
        )}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          data-context-menu
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          className="fixed z-[150] min-w-[180px] rounded-lg border border-border bg-popover shadow-2xl py-1 text-xs"
        >
          <div className="px-3 py-1 text-[10px] text-muted-foreground/60 truncate border-b border-border/60 mb-1">
            {ctxMenu.node.path.split(/[\\/]/).pop()}
          </div>
          {!ctxMenu.node.isDir && (
            <button
              onClick={() => { onOpenFile(ctxMenu.node.path); setCtxMenu(null) }}
              className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"
            >
              <FileIcon size={11} /> 在编辑器中打开
            </button>
          )}
          <button
            onClick={handleRevealInFolder}
            className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"
          >
            <ExternalLink size={11} /> 在文件管理器中显示
          </button>
          <button
            onClick={handleCopyPath}
            className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"
          >
            {copied
              ? <><Check size={11} className="text-emerald-500" /> 已复制</>
              : <><Copy size={11} /> 复制完整路径</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

function TreeNode({
  node, depth, expanded, activeFilePath, dirtyPaths,
  onToggle, onOpenFile, onContextMenu, isRoot
}: {
  node: FileTreeNode
  depth: number
  expanded: Set<string>
  activeFilePath: string | null
  dirtyPaths?: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void
  isRoot?: boolean
}) {
  const isOpen = expanded.has(node.path)
  const isSelected = activeFilePath === node.path
  const isDirty = dirtyPaths?.has(node.path)
  const indent = depth * 12

  return (
    <div>
      <div
        onClick={() => node.isDir ? onToggle(node.path) : onOpenFile(node.path)}
        onDoubleClick={() => !node.isDir && onOpenFile(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
        data-file-path={node.path}
        className={cn(
          'group flex items-center gap-1 px-2 py-1 mx-0.5 cursor-pointer rounded-md transition-colors',
          isSelected && !node.isDir
            ? 'bg-primary/10 ring-1 ring-primary/30 text-foreground'
            : 'hover:bg-accent/50 text-foreground/85'
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        title={node.path}
      >
        {node.isDir ? (
          <>
            {isOpen
              ? <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" />
              : <ChevronRight size={11} className="shrink-0 text-muted-foreground/60" />
            }
            {isOpen
              ? <FolderOpen size={12} className="shrink-0 text-amber-500" />
              : <Folder size={12} className="shrink-0 text-amber-500" />
            }
          </>
        ) : (
          <>
            <span className="w-[11px] shrink-0" />
            <FileIcon size={11} className="shrink-0 text-muted-foreground/60" />
          </>
        )}
        <span className={cn('truncate flex-1 leading-tight', isRoot && 'font-semibold')}>{node.name}</span>
        {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
      </div>

      {node.isDir && isOpen && node.children && node.children.length > 0 && (
        <div>
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeFilePath={activeFilePath}
              dirtyPaths={dirtyPaths}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  )
}
