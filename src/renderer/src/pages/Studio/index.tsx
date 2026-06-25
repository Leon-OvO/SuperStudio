import { useState, useEffect, useRef, useCallback } from 'react'
import { LayoutDashboard, Workflow as WorkflowIcon, Film, ChevronDown, Plus, FileImage, FileText, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/ui'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Segmented } from '../../components/ui/Segmented'
import { WorkspaceTabs } from './WorkspaceTabs'
import { CanvasPage } from '../Canvas'
import { WorkflowPage } from '../Workflow'
import { VideoPage } from '../Video'

/**
 * 「创作」(Studio)：把「图片画布」「工作流」「视频」合并到一个入口下。
 * 顶部切换三种模式（画布 / 工作流 / 视频），画布·工作流共用一个「我的存档」列表
 * （按类型分组；视频暂无存档概念，故视频模式下隐藏该入口）。三个编辑器各自范式不变、
 * 且常驻挂载（用 hidden 切换），切走不卸载——保住各自视口、进行中的出图/生成与
 * 画布自动保存。画布·工作流同表存储靠 workflows.kind 区分；视频沿用原页面 UI 不动。
 */
type Mode = 'canvas' | 'workflow' | 'video'
/** Doc-backed modes (have entries in the 我的存档 list); 'video' is excluded. */
type DocKind = 'canvas' | 'workflow'
interface DocMeta { id: string; name: string }

export function StudioPage() {
  const [mode, setMode] = useState<Mode>('canvas')
  const [canvasOpen, setCanvasOpen] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 })
  const [workflowOpen, setWorkflowOpen] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 })
  const [canvasDocs, setCanvasDocs] = useState<DocMeta[]>([])
  const [workflowDocs, setWorkflowDocs] = useState<DocMeta[]>([])
  // Open canvases shown as the top tab strip (bookmarks over the single editor).
  const [openTabs, setOpenTabs] = useState<DocMeta[]>([])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const { pendingWorkflowId, setPendingWorkflowId } = useUIStore()
  const dlg = useConfirmDialog()
  const refreshTimer = useRef<number | null>(null)

  const refreshDocs = useCallback(async () => {
    const [cv, wf] = await Promise.all([
      window.api.listWorkflows({ kind: 'canvas' }) as Promise<DocMeta[]>,
      window.api.listWorkflows() as Promise<DocMeta[]>, // default kind = 'workflow'
    ])
    setCanvasDocs(cv || []); setWorkflowDocs(wf || [])
  }, [])

  // Throttle the editors' onDocsChanged — canvas autosave fires per-edit during a
  // generation burst; coalesce so the archive list doesn't churn while browsing.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => { void refreshDocs() }, 800)
  }, [refreshDocs])

  useEffect(() => { void refreshDocs() }, [refreshDocs])
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current) }, [])

  // Chat「保存为工作流」→ App maps page:'workflow' to studio + pendingWorkflowId; open it.
  useEffect(() => {
    if (!pendingWorkflowId) return
    const id = pendingWorkflowId
    setPendingWorkflowId(null)
    setMode('workflow')
    setWorkflowOpen(o => ({ id, nonce: o.nonce + 1 }))
  }, [pendingWorkflowId, setPendingWorkflowId])

  const upsertTab = useCallback((id: string, name: string) => {
    setOpenTabs(tabs => tabs.some(t => t.id === id) ? tabs.map(t => t.id === id ? { ...t, name } : t) : [...tabs, { id, name }])
  }, [])
  const openCanvas = (id: string | null, name?: string) => {
    setMode('canvas'); setCanvasOpen(o => ({ id, nonce: o.nonce + 1 })); setArchiveOpen(false)
    if (id) upsertTab(id, name ?? canvasDocs.find(d => d.id === id)?.name ?? '画布')
  }
  const openWorkflow = (id: string | null) => { setMode('workflow'); setWorkflowOpen(o => ({ id, nonce: o.nonce + 1 })); setArchiveOpen(false) }
  // Close a canvas tab; if it was active, fall back to the last remaining tab or a blank canvas.
  const closeTab = (id: string) => {
    setOpenTabs(tabs => {
      const next = tabs.filter(t => t.id !== id)
      if (canvasOpen.id === id) {
        const fb = next[next.length - 1]
        setCanvasOpen(o => ({ id: fb ? fb.id : null, nonce: o.nonce + 1 }))
      }
      return next
    })
  }
  // Reconcile tab names against the latest doc list (renamed/just-saved canvases).
  // Name-only — never drop here (a just-autosaved id may not be in canvasDocs yet);
  // deletion removes the tab explicitly in deleteDoc.
  useEffect(() => {
    setOpenTabs(tabs => tabs.map(t => {
      const d = canvasDocs.find(d => d.id === t.id)
      return d ? { ...t, name: d.name } : t
    }))
  }, [canvasDocs])

  const deleteDoc = useCallback(async (kind: DocKind, id: string) => {
    if (!(await dlg.confirm({ message: kind === 'canvas' ? '确定删除这个画布？' : '确定删除该工作流？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteWorkflow(id)
    if (kind === 'canvas') {
      setOpenTabs(tabs => tabs.filter(t => t.id !== id))
      if (canvasOpen.id === id) setCanvasOpen(o => ({ id: null, nonce: o.nonce + 1 }))
    }
    if (kind === 'workflow' && workflowOpen.id === id) setWorkflowOpen(o => ({ id: null, nonce: o.nonce + 1 }))
    void refreshDocs()
  }, [dlg, canvasOpen.id, workflowOpen.id, refreshDocs])

  return (
    <div className="flex flex-col h-full">
      {/* Top strip: mode tabs + unified archive dropdown */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'canvas', label: '画布', icon: <LayoutDashboard size={14} /> },
            { value: 'video', label: '视频', icon: <Film size={14} /> },
            { value: 'workflow', label: '工作流', icon: <WorkflowIcon size={14} /> }
          ]}
        />
        <div className="flex-1" />
        {mode !== 'video' && (
        <div className="relative"
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setArchiveOpen(false) }}>
          <button onClick={() => setArchiveOpen(o => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-accent/50">
            我的存档 <ChevronDown size={14} className={cn('text-muted-foreground transition-transform', archiveOpen && 'rotate-180')} />
          </button>
          {archiveOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-50 w-72 max-h-[70vh] overflow-y-auto bg-popover border border-border rounded-xl shadow-xl py-1.5 origin-top-right animate-popover-in">
              <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"><LayoutDashboard size={11} /> 画布</div>
              <button onClick={() => openCanvas(null)} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-primary hover:bg-accent/50"><Plus size={13} /> 新建画布</button>
              {canvasDocs.length === 0 && <p className="px-3 py-1 text-xs text-muted-foreground/60">还没有画布</p>}
              {canvasDocs.map(d => (
                <DocRow key={d.id} name={d.name} icon={<FileImage size={12} />} active={mode === 'canvas' && canvasOpen.id === d.id}
                  onOpen={() => openCanvas(d.id, d.name)} onDelete={() => deleteDoc('canvas', d.id)} />
              ))}
              <div className="my-1.5 border-t border-border/60" />
              <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"><WorkflowIcon size={11} /> 工作流</div>
              <button onClick={() => openWorkflow(null)} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-primary hover:bg-accent/50"><Plus size={13} /> 新建工作流</button>
              {workflowDocs.length === 0 && <p className="px-3 py-1 text-xs text-muted-foreground/60">还没有工作流</p>}
              {workflowDocs.map(d => (
                <DocRow key={d.id} name={d.name} icon={<FileText size={12} />} active={mode === 'workflow' && workflowOpen.id === d.id}
                  onOpen={() => openWorkflow(d.id)} onDelete={() => deleteDoc('workflow', d.id)} />
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Canvas-only: browser-style workspace tab strip of open canvases. */}
      {mode === 'canvas' && (
        <WorkspaceTabs
          tabs={openTabs}
          activeId={canvasOpen.id}
          unsavedActive={canvasOpen.id === null}
          onSelect={(id) => openCanvas(id)}
          onClose={closeTab}
          onNew={() => openCanvas(null)}
        />
      )}

      {/* All editors stay mounted; hidden toggle preserves viewport / in-flight work. */}
      <div className="flex-1 min-h-0 relative">
        <div className={mode === 'canvas' ? 'absolute inset-0' : 'hidden'}>
          <CanvasPage embedded openDocId={canvasOpen.id} openNonce={canvasOpen.nonce} onDocsChanged={scheduleRefresh}
            onDocOpened={id => { setCanvasOpen(o => ({ ...o, id })); if (id) upsertTab(id, canvasDocs.find(d => d.id === id)?.name ?? '未命名画布') }} />
        </div>
        <div className={mode === 'workflow' ? 'absolute inset-0' : 'hidden'}>
          <WorkflowPage embedded openDocId={workflowOpen.id} openNonce={workflowOpen.nonce} onDocsChanged={scheduleRefresh}
            onDocOpened={id => setWorkflowOpen(o => ({ ...o, id }))} />
        </div>
        {/* Video reuses the existing page UI unchanged — just hosted as a third mode.
            VideoPage is `h-full overflow-hidden` and manages its own scroll, so the
            host mirrors the old `<main>` (absolute inset-0 = definite height). */}
        <div className={mode === 'video' ? 'absolute inset-0 overflow-hidden' : 'hidden'}>
          <VideoPage />
        </div>
      </div>

      {dlg.element}
    </div>
  )
}

function DocRow({ name, icon, active, onOpen, onDelete }: { name: string; icon: React.ReactNode; active?: boolean; onOpen: () => void; onDelete: () => void }) {
  return (
    // preventDefault on mousedown keeps focus on the trigger so the dropdown's
    // onBlur doesn't close (unmount) this row before the click registers — otherwise
    // React 18 flushes the focusout-driven close synchronously and the open is lost.
    <div onMouseDown={e => e.preventDefault()}
      className={cn('group flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer', active ? 'bg-accent' : 'hover:bg-accent/50')} onClick={onOpen}>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{name}</span>
      <button onClick={e => { e.stopPropagation(); onDelete() }} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"><Trash2 size={11} /></button>
    </div>
  )
}
