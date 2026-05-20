import { useEffect, useState } from 'react'
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown,
  RefreshCw, ExternalLink, Copy, Check, ChevronsDown
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

export function FileExplorer({ root, activeFilePath, onOpenFile, onRefresh, onCollapse, dirtyPaths }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(root ? [root.path] : []))
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!ctxMenu) return
    function onDown(e: MouseEvent) {
      // Close on any outside click
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
    // Keep menu open briefly to show "已复制"
    setTimeout(() => setCtxMenu(null), 600)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 shrink-0">
        <span className="text-[10px] uppercase text-muted-foreground/60 font-semibold">文件</span>
        <div className="flex gap-0.5">
          {root && (
            <button
              onClick={async () => { try { await window.api.showItemInFolder?.(root.path) } catch {} }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              title="在文件管理器中打开项目"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            onClick={onRefresh}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            title="刷新文件树"
          >
            <RefreshCw size={11} />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              title="折叠文件浏览器"
            >
              <ChevronsDown size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-xs font-mono">
        {root ? (
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
        ) : (
          <div className="text-muted-foreground/60 text-center py-6 px-3">未打开项目</div>
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
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-accent/60 rounded',
          isSelected && !node.isDir && 'bg-primary/10 text-primary'
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
        <span className={cn('truncate flex-1', isRoot && 'font-semibold')}>{node.name}</span>
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
