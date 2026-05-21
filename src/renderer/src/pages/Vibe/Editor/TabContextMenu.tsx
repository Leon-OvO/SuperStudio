import { useEffect, useRef } from 'react'
import {
  X, ArrowLeftRight, ArrowRightToLine, FolderOpen, Copy, FileText,
  PanelLeftOpen, Save, SaveAll, ListChecks
} from 'lucide-react'
import type { OpenTab } from '../store'

interface Props {
  /** The tab the user right-clicked on. */
  tab: OpenTab
  /** Full list of currently-open tabs (used to enable/disable items). */
  tabs: OpenTab[]
  /** Viewport-clamped screen position to render at. */
  x: number
  y: number
  /** Project root path, used to compute relative paths for file tabs. */
  projectPath: string | null
  /** Optional title for request tabs (so "复制标题" copies something meaningful). */
  requestTitle?: string

  onClose: () => void
  onCloseTab: (key: string) => void
  onCloseOthers: (key: string) => void
  onCloseToRight: (key: string) => void
  onCloseAll: () => void
  onSave?: (path: string) => void
  onSaveAll?: () => void
  /** Switch the sidebar to the file-explorer view and dispatch a reveal event. */
  onRevealInSidebar?: (path: string) => void
}

/**
 * Right-click menu for editor tabs — VS Code parity.
 *
 * Closes on outside click / Escape. Items adapt to tab kind:
 *   - file tabs get save, copy-path, copy-relative-path, reveal in OS / sidebar
 *   - request tabs get a smaller set (close-* + copy title)
 */
export function TabContextMenu({
  tab, tabs, x, y, projectPath, requestTitle,
  onClose, onCloseTab, onCloseOthers, onCloseToRight, onCloseAll,
  onSave, onSaveAll, onRevealInSidebar
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const idx = tabs.findIndex(t => t.key === tab.key)
  const hasOthers = tabs.length > 1
  const hasRight = idx >= 0 && idx < tabs.length - 1
  const isFile = tab.kind === 'file'
  const isDirty = isFile && tab.dirty
  const anyDirty = tabs.some(t => t.kind === 'file' && t.dirty)

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard blocked — ignore */ }
  }

  function relativePath(absolute: string): string {
    if (!projectPath) return absolute
    const rootNorm = projectPath.replace(/[\\/]+$/, '')
    if (absolute.startsWith(rootNorm)) {
      const rel = absolute.slice(rootNorm.length).replace(/^[\\/]/, '')
      return rel || absolute
    }
    return absolute
  }

  // Clamp to viewport — estimated height ~340px for the largest menu, width 220.
  const left = Math.min(x, window.innerWidth - 230)
  const top = Math.min(y, window.innerHeight - 360)

  return (
    <div
      ref={ref}
      data-context-menu
      className="fixed z-[200] min-w-[220px] bg-popover border border-border rounded-md shadow-xl py-1 text-sm select-none"
      style={{ left, top }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
    >
      <Item
        icon={<X size={13} />}
        label="关闭"
        shortcut="Ctrl+W"
        onClick={() => { onCloseTab(tab.key); onClose() }}
      />
      <Item
        icon={<ArrowLeftRight size={13} />}
        label="关闭其他"
        disabled={!hasOthers}
        onClick={() => { onCloseOthers(tab.key); onClose() }}
      />
      <Item
        icon={<ArrowRightToLine size={13} />}
        label="关闭右侧"
        disabled={!hasRight}
        onClick={() => { onCloseToRight(tab.key); onClose() }}
      />
      <Item
        icon={<X size={13} />}
        label="关闭全部"
        disabled={tabs.length === 0}
        onClick={() => { onCloseAll(); onClose() }}
      />

      {isFile && (
        <>
          <Divider />
          <Item
            icon={<Save size={13} />}
            label="保存"
            shortcut="Ctrl+S"
            disabled={!isDirty}
            onClick={() => { onSave?.(tab.path); onClose() }}
          />
          <Item
            icon={<SaveAll size={13} />}
            label="全部保存"
            disabled={!anyDirty}
            onClick={() => { onSaveAll?.(); onClose() }}
          />
          <Divider />
          <Item
            icon={<Copy size={13} />}
            label="复制路径"
            onClick={async () => { await copyText(tab.path); onClose() }}
          />
          <Item
            icon={<Copy size={13} />}
            label="复制相对路径"
            disabled={!projectPath}
            onClick={async () => { await copyText(relativePath(tab.path)); onClose() }}
          />
          <Item
            icon={<FileText size={13} />}
            label="复制文件名"
            onClick={async () => {
              const name = tab.path.split(/[\\/]/).pop() ?? tab.path
              await copyText(name)
              onClose()
            }}
          />
          <Divider />
          <Item
            icon={<FolderOpen size={13} />}
            label="在资源管理器中显示"
            onClick={async () => {
              try { await window.api.showItemInFolder?.(tab.path) } catch { /* ignore */ }
              onClose()
            }}
          />
          <Item
            icon={<PanelLeftOpen size={13} />}
            label="在侧边栏中定位"
            disabled={!onRevealInSidebar}
            onClick={() => { onRevealInSidebar?.(tab.path); onClose() }}
          />
        </>
      )}

      {!isFile && requestTitle && (
        <>
          <Divider />
          <Item
            icon={<ListChecks size={13} />}
            label="复制标题"
            onClick={async () => { await copyText(requestTitle); onClose() }}
          />
        </>
      )}
    </div>
  )
}

function Item({
  icon, label, shortcut, disabled, onClick
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
    >
      <span className="text-muted-foreground shrink-0 w-4 flex justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-muted-foreground/70 tabular-nums shrink-0">{shortcut}</span>
      )}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-border/60" />
}
