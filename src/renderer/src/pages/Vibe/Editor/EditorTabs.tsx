import { X, FileText, Circle, ListChecks, Save } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { MonacoFileEditor } from './MonacoFileEditor'
import { RequestTabContent } from '../Workflow/RequestTabContent'
import { EmptyStateHero } from './EmptyStateHero'
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

  // For request tabs
  requests: VibeRequestInfo[]
  tasks: VibeTaskInfo[]
  messages: VibeMessageInfo[]
  streamingTaskId: string | null
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  onChat: (prompt: string, requestId?: string) => void
  onExplore: (prompt: string, requestId?: string) => void
  onBugfix: (prompt: string, requestId?: string) => void
  onPropose: (prompt: string, requestId?: string) => void
  onApply: () => void
  onStop: () => void
  onToggleTaskStatus: (taskId: string, status: 'pending' | 'done' | 'skipped') => void

  hasProject: boolean
}

export function EditorTabs({
  tabs, activeTabKey, isDark,
  onSwitchTab, onCloseTab, onChangeContent, onSave,
  requests, tasks, messages, streamingTaskId, running,
  onChat, onExplore, onBugfix, onPropose, onApply, onStop, onToggleTaskStatus,
  hasProject
}: Props) {
  const active = tabs.find(t => t.key === activeTabKey)

  // Show the new-request hero whenever there's no active tab —
  // covers both "no tabs at all" AND "user clicked + 新建需求 to start fresh".
  // Existing tabs stay in the strip so the user can switch back.
  if (!active) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-background">
        {/* Keep tab strip visible if there are background tabs */}
        {tabs.length > 0 && (
          <div className="flex items-stretch border-b border-border bg-card/50 shrink-0">
            <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
              {tabs.map(tab => {
                const label = tab.kind === 'file'
                  ? tab.path.split(/[\\/]/).pop() ?? tab.path
                  : (requests.find(r => r.id === tab.requestId)?.title ?? '对话')
                const isDirty = tab.kind === 'file' && tab.dirty
                return (
                  <div
                    key={tab.key}
                    onClick={() => onSwitchTab(tab.key)}
                    className={cn(
                      'group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border-border min-w-0 shrink-0',
                      'text-muted-foreground hover:text-foreground hover:bg-accent/30'
                    )}
                    title={tab.kind === 'file' ? tab.path : `对话: ${label}`}
                  >
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
            onChat={onChat}
            onExplore={onExplore}
            onBugfix={onBugfix}
            onPropose={onPropose}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-background">
      {/* Tab strip with save button on right */}
      <div className="flex items-stretch border-b border-border bg-card/50 shrink-0">
       <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
        {tabs.map(tab => {
          const isActive = tab.key === activeTabKey
          const label = tab.kind === 'file'
            ? tab.path.split(/[\\/]/).pop() ?? tab.path
            : (requests.find(r => r.id === tab.requestId)?.title ?? '对话')
          const isDirty = tab.kind === 'file' && tab.dirty
          return (
            <div
              key={tab.key}
              onClick={() => onSwitchTab(tab.key)}
              className={cn(
                'group flex items-center gap-1.5 px-3 h-8 text-xs cursor-pointer border-r border-border min-w-0 shrink-0',
                isActive
                  ? 'bg-background text-foreground border-t-2 border-t-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30'
              )}
              title={tab.kind === 'file' ? tab.path : `对话: ${label}`}
            >
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
            onChat={onChat}
            onExplore={onExplore}
            onBugfix={onBugfix}
            onPropose={onPropose}
            onApply={onApply}
            onStop={onStop}
            onToggleTaskStatus={onToggleTaskStatus}
          />
        ) : null}
      </div>
    </div>
  )
}
