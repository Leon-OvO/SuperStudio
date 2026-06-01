import { useState } from 'react'
import { X, FileText, Circle, ListChecks, Save } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { MonacoFileEditor } from './MonacoFileEditor'
import { RequestTabContent } from '../Workflow/RequestTabContent'
import { EmptyStateHero } from './EmptyStateHero'
import { TabContextMenu } from './TabContextMenu'
import type { OpenTab } from '../store'
import type { VibeRequestInfo, VibeTaskInfo, VibeMessageInfo } from '../../../../../shared/ipc-types'

interface Props {
  tabs: OpenTab[]
  activeTabKey: string | null
  isDark: boolean

  // For file tabs
  onSwitchTab: (key: string) => void
  onCloseTab: (key: string) => void
  onChangeContent: (path: string, next: string) => void
  onSave: (path: string) => void

  // Bulk-close (right-click menu) — VS Code parity
  onCloseOthers: (key: string) => void
  onCloseToRight: (key: string) => void
  onCloseAll: () => void
  onSaveAll: () => void
  /** Drag-and-drop reorder: place `fromKey` to the chosen side of `toKey`. */
  onReorder: (fromKey: string, toKey: string, side: 'left' | 'right') => void
  /** Switch the sidebar to the file explorer and reveal the file there. */
  onRevealInSidebar: (path: string) => void
  /** Project root, used to compute "Copy Relative Path". */
  projectPath: string | null

  // For request tabs
  requests: VibeRequestInfo[]
  tasks: VibeTaskInfo[]
  messages: VibeMessageInfo[]
  streamingTaskId: string | null
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  onRun: (prompt: string, requestId?: string, forceIntent?: 'chat' | 'explore' | 'bugfix' | 'change') => void
  onApply: () => void
  onStop: () => void
  onToggleTaskStatus: (taskId: string, status: 'pending' | 'done' | 'skipped') => void

  hasProject: boolean
}

export function EditorTabs({
  tabs, activeTabKey, isDark,
  onSwitchTab, onCloseTab, onChangeContent, onSave,
  onCloseOthers, onCloseToRight, onCloseAll, onSaveAll, onReorder, onRevealInSidebar, projectPath,
  requests, tasks, messages, streamingTaskId, running,
  onRun, onApply, onStop, onToggleTaskStatus,
  hasProject
}: Props) {
  const active = tabs.find(t => t.key === activeTabKey)
  const [ctxMenu, setCtxMenu] = useState<{ tab: OpenTab; x: number; y: number } | null>(null)
  // Drag-and-drop state.
  //   draggingKey  — the tab currently being dragged (used to fade it).
  //   dropTarget   — where the drop indicator should render right now.
  // We track both so the indicator can disappear when the user drags out of
  // the strip entirely (onDragLeave on the container).
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; side: 'left' | 'right' } | null>(null)

  function openCtx(e: React.MouseEvent, tab: OpenTab) {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ tab, x: e.clientX, y: e.clientY })
  }

  // Drag-and-drop helpers. The handlers are pure DOM event listeners we attach
  // to every tab via `tabDragProps(tab)` so the JSX below stays readable.
  function tabDragProps(tab: OpenTab) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
        setDraggingKey(tab.key)
        // We don't actually need the data on `drop`, but Firefox refuses to
        // initiate a drag unless `dataTransfer` has *something*. Setting
        // text/plain also lets the OS render a tab-name drag preview.
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', tab.key) } catch { /* ignore */ }
      },
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        if (!draggingKey || draggingKey === tab.key) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        const side: 'left' | 'right' = e.clientX < r.left + r.width / 2 ? 'left' : 'right'
        // Avoid redundant setState — the indicator re-renders every pixel
        // otherwise, which kills the drag's feel.
        if (dropTarget?.key !== tab.key || dropTarget.side !== side) {
          setDropTarget({ key: tab.key, side })
        }
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        const from = draggingKey
        const r = e.currentTarget.getBoundingClientRect()
        const side: 'left' | 'right' = e.clientX < r.left + r.width / 2 ? 'left' : 'right'
        if (from && from !== tab.key) onReorder(from, tab.key, side)
        setDraggingKey(null)
        setDropTarget(null)
      },
      onDragEnd: () => {
        setDraggingKey(null)
        setDropTarget(null)
      }
    }
  }

  // Drop on the empty trailing space of the tab strip → append to the end by
  // dropping to the right of the last tab.
  function stripDropProps() {
    return {
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        if (!draggingKey) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        if (!draggingKey) return
        e.preventDefault()
        const last = tabs[tabs.length - 1]
        if (last && draggingKey !== last.key) {
          onReorder(draggingKey, last.key, 'right')
        }
        setDraggingKey(null)
        setDropTarget(null)
      },
      onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
        // Only clear when the cursor leaves the entire strip, not when
        // moving between tabs inside it.
        if (e.currentTarget === e.target) setDropTarget(null)
      }
    }
  }

  function renderCtxMenu() {
    if (!ctxMenu) return null
    const t = ctxMenu.tab
    const requestTitle = t.kind === 'request'
      ? requests.find(r => r.id === t.requestId)?.title
      : undefined
    return (
      <TabContextMenu
        tab={ctxMenu.tab}
        tabs={tabs}
        x={ctxMenu.x}
        y={ctxMenu.y}
        projectPath={projectPath}
        requestTitle={requestTitle}
        onClose={() => setCtxMenu(null)}
        onCloseTab={onCloseTab}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
        onCloseAll={onCloseAll}
        onSave={onSave}
        onSaveAll={onSaveAll}
        onRevealInSidebar={onRevealInSidebar}
      />
    )
  }

  // Show the new-request hero whenever there's no active tab —
  // covers both "no tabs at all" AND "user clicked + 新建需求 to start fresh".
  // Existing tabs stay in the strip so the user can switch back.
  if (!active) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-background">
        {/* Keep tab strip visible if there are background tabs */}
        {tabs.length > 0 && (
          <div className="flex items-stretch border-b border-border bg-card/50 shrink-0">
            <div className="flex items-stretch overflow-x-auto flex-1 min-w-0" {...stripDropProps()}>
              {tabs.map(tab => {
                const label = tab.kind === 'file'
                  ? tab.path.split(/[\\/]/).pop() ?? tab.path
                  : (requests.find(r => r.id === tab.requestId)?.title ?? '对话')
                const isDirty = tab.kind === 'file' && tab.dirty
                const showLeftBar = dropTarget?.key === tab.key && dropTarget.side === 'left'
                const showRightBar = dropTarget?.key === tab.key && dropTarget.side === 'right'
                const isDragging = draggingKey === tab.key
                return (
                  <div
                    key={tab.key}
                    onClick={() => onSwitchTab(tab.key)}
                    onContextMenu={(e) => openCtx(e, tab)}
                    {...tabDragProps(tab)}
                    className={cn(
                      'relative group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border-border min-w-0 shrink-0',
                      'text-muted-foreground hover:text-foreground hover:bg-accent/30',
                      isDragging && 'opacity-50'
                    )}
                    title={tab.kind === 'file' ? tab.path : `对话: ${label}`}
                  >
                    {showLeftBar && <DropIndicator side="left" />}
                    {tab.kind === 'file'
                      ? <FileText size={11} className="shrink-0 text-muted-foreground/70" />
                      : <ListChecks size={11} className="shrink-0 text-primary" />
                    }
                    <span className={cn('truncate max-w-[200px]', isDirty && 'italic')}>{label}</span>
                    {isDirty
                      ? <Circle size={6} className="fill-primary text-primary shrink-0" />
                      : <span className="w-1.5" />
                    }
                    <button
                      onClick={e => { e.stopPropagation(); onCloseTab(tab.key) }}
                      className="p-0.5 rounded shrink-0 ml-0.5 hover:bg-foreground/10 opacity-0 group-hover:opacity-100"
                      title="关闭"
                    >
                      <X size={11} />
                    </button>
                    {showRightBar && <DropIndicator side="right" />}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty-state hero with prominent new-request input */}
        <div className="flex-1 flex items-center justify-center bg-muted/10 px-8 py-6 overflow-y-auto">
          <EmptyStateHero
            hasProject={hasProject}
            running={running}
            onRun={onRun}
          />
        </div>
        {renderCtxMenu()}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-background">
      {/* Tab strip with save button on right */}
      <div className="flex items-stretch border-b border-border bg-card/50 shrink-0">
       <div className="flex items-stretch overflow-x-auto flex-1 min-w-0" {...stripDropProps()}>
        {tabs.map(tab => {
          const isActive = tab.key === activeTabKey
          const label = tab.kind === 'file'
            ? tab.path.split(/[\\/]/).pop() ?? tab.path
            : (requests.find(r => r.id === tab.requestId)?.title ?? '对话')
          const isDirty = tab.kind === 'file' && tab.dirty
          const showLeftBar = dropTarget?.key === tab.key && dropTarget.side === 'left'
          const showRightBar = dropTarget?.key === tab.key && dropTarget.side === 'right'
          const isDragging = draggingKey === tab.key
          return (
            <div
              key={tab.key}
              onClick={() => onSwitchTab(tab.key)}
              onContextMenu={(e) => openCtx(e, tab)}
              {...tabDragProps(tab)}
              className={cn(
                'relative group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border-border min-w-0 shrink-0',
                isActive
                  ? 'bg-background text-foreground border-t-2 border-t-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30',
                isDragging && 'opacity-50'
              )}
              title={tab.kind === 'file' ? tab.path : `对话: ${label}`}
            >
              {showLeftBar && <DropIndicator side="left" />}
              {tab.kind === 'file'
                ? <FileText size={11} className="shrink-0 text-muted-foreground/70" />
                : <ListChecks size={11} className="shrink-0 text-primary" />
              }
              <span className={cn('truncate max-w-[200px]', isDirty && 'italic')}>
                {label}
              </span>
              {isDirty ? (
                <Circle size={6} className="fill-primary text-primary shrink-0" />
              ) : (
                <span className="w-1.5" />
              )}
              <button
                onClick={e => { e.stopPropagation(); onCloseTab(tab.key) }}
                className={cn(
                  'p-0.5 rounded shrink-0 ml-0.5 hover:bg-foreground/10',
                  !isActive && 'opacity-0 group-hover:opacity-100'
                )}
                title="关闭"
              >
                <X size={11} />
              </button>
              {showRightBar && <DropIndicator side="right" />}
            </div>
          )
        })}
       </div>
       {/* Right-side action bar: save button (only when active tab is a dirty file) */}
       {active?.kind === 'file' && active.dirty && (
         <button
           onClick={() => onSave(active.path)}
           className="flex items-center gap-1 px-2.5 h-8 text-[11px] font-medium text-primary hover:bg-primary/10 border-l border-border shrink-0"
           title="保存到磁盘 (Ctrl+S)"
         >
           <Save size={11} /> 保存
         </button>
       )}
      </div>

      {renderCtxMenu()}

      {/* Active tab content */}
      <div className="flex-1 min-h-0">
        {active?.kind === 'file' ? (
          <MonacoFileEditor
            filePath={active.path}
            value={active.content}
            onChange={(next) => onChangeContent(active.path, next)}
            onSave={() => onSave(active.path)}
            theme={isDark ? 'vs-dark' : 'light'}
          />
        ) : active?.kind === 'request' ? (
          <RequestTabContent
            request={requests.find(r => r.id === active.requestId) ?? null}
            tasks={tasks}
            messages={messages}
            streamingTaskId={streamingTaskId}
            running={running}
            onRun={onRun}
            onApply={onApply}
            onStop={onStop}
            onToggleTaskStatus={onToggleTaskStatus}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Thin vertical line rendered on the leading/trailing edge of a tab to show
 * where the drop will land — same visual cue VS Code uses.
 */
function DropIndicator({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary',
        side === 'left' ? '-left-px' : '-right-px'
      )}
    />
  )
}
