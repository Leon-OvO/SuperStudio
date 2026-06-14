import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  ReactFlow, Background, BackgroundVariant, Panel, useNodesState, useEdgesState,
  addEdge, ReactFlowProvider, useReactFlow, useViewport, useOnSelectionChange,
  SelectionMode, type Node, type Edge, type Connection
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ImagePlus, FolderOpen, Maximize, Save, Plus, Minus, ChevronDown, FileImage, Trash2, X, Download, Layers, Pencil, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CANVAS_NODE_TYPES, CanvasContext, applyScene, type CanvasHandlers, type ImageCardData, type RefStackData } from './canvas-nodes'
import { GalleryPickerDialog } from './CanvasInspector'
import { blobToBase64, toLocalFileUrl } from '../../lib/attachments'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

interface CanvasMeta {
  id: string
  name: string
  description: string
  definition: { nodes: Node[]; edges: Edge[] }
  created_at: number
  updated_at: number
}

const DEFAULT_W = 200

/** Soft, theme-aware bezier edges — no dashes/arrows, so the canvas reads as a
 *  creative branch tree rather than a workflow pipeline. */
const EDGE_STYLE = { stroke: 'hsl(var(--muted-foreground) / 0.45)', strokeWidth: 2 }
const DEFAULT_EDGE_OPTS = { type: 'default', style: EDGE_STYLE }

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i
const isVideoPath = (p?: string | null): boolean => !!p && VIDEO_EXT.test(p)

/** A node worth persisting: reference stacks always, media cards only once done. */
const isPersistable = (n: Node): boolean => {
  const d = n.data as ImageCardData
  return n.type === 'ref_stack' || (d.status !== 'generating' && d.status !== 'error')
}

/** Optional props let the merged 创作画布 (StudioPage) embed this editor: hide its
 *  own archive switcher, drive open/new from outside, and report list changes. */
export interface StudioEditorProps {
  embedded?: boolean
  openDocId?: string | null
  openNonce?: number
  onDocsChanged?: () => void
  /** Report the editor's real current doc id (incl. the one autosave just created)
   *  so the shell's archive list can highlight / delete / reset it correctly. */
  onDocOpened?: (id: string | null) => void
}

export function CanvasPage(props: StudioEditorProps = {}) {
  return (
    <ReactFlowProvider>
      <CanvasEditor {...props} />
    </ReactFlowProvider>
  )
}

function CanvasEditor({ embedded = false, openDocId = null, openNonce = 0, onDocsChanged, onDocOpened }: StudioEditorProps) {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [name, setName] = useState('未命名画布')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)
  // 素材库选图的目标：'card' = 加为画布卡片；{stackId} = 加进某个参考组。
  const [galleryTarget, setGalleryTarget] = useState<null | 'card' | { stackId: string }>(null)
  const [showList, setShowList] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [imageModelName, setImageModelName] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [expanding, setExpanding] = useState<Set<string>>(new Set())
  const idc = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()
  const dlg = useConfirmDialog()
  // Autosave plumbing: refs hold the latest state for the debounced saver so it
  // never creates a duplicate canvas or saves stale nodes.
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges
  const currentIdRef = useRef<string | null>(currentId); currentIdRef.current = currentId
  const nameRef = useRef(name); nameRef.current = name
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  // Bumped on every new/load so a save resolving after a canvas switch can't bind
  // the returned id to the wrong (now-current) canvas.
  const genTokenRef = useRef(0)
  const hasGenerated = useRef(false)
  // Latest onDocsChanged via ref so persistCanvas (useCallback []) can notify the
  // shell after autosave without re-creating itself (keeps its self-retry stable).
  const onDocsChangedRef = useRef(onDocsChanged); onDocsChangedRef.current = onDocsChanged
  const onDocOpenedRef = useRef(onDocOpened); onDocOpenedRef.current = onDocOpened

  useEffect(() => { loadCanvases() }, [])
  useEffect(() => {
    window.api.getSettings?.().then((s: { defaultImageModel?: string }) => setImageModelName(s?.defaultImageModel || '')).catch(() => { /* chip stays hidden */ })
  }, [])
  // When embedded in StudioPage, the shell drives which canvas is open (or new).
  // openNonce bumps on every request so re-opening the same id still triggers.
  useEffect(() => {
    if (openNonce <= 0) return
    if (openDocId) loadCanvas(openDocId); else newCanvas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce])
  // Track the box-/shift-selected cards for the batch action bar.
  useOnSelectionChange({ onChange: useCallback(({ nodes: sel }: { nodes: Node[] }) => setSelectedIds(sel.map(n => n.id)), []) })

  async function loadCanvases() {
    const data = await window.api.listWorkflows({ kind: 'canvas' }) as CanvasMeta[]
    setCanvases(data)
  }
  async function loadCanvas(id: string) {
    const all = await window.api.listWorkflows({ kind: 'canvas' }) as CanvasMeta[]
    const meta = all.find(w => w.id === id)
    if (!meta) return
    setCurrentId(id); setName(meta.name)
    const loaded = meta.definition.nodes || []
    // Re-approve every local path: path approval is in-memory and cleared on restart,
    // so a reloaded canvas would otherwise 403 (裂图) on the local-file protocol.
    // Covers image/video cards (.path) and reference stacks (.refs[]).
    loaded.forEach(n => {
      const d = n.data as ImageCardData & RefStackData
      if (d?.path) window.api.approvePath?.(d.path)
      if (Array.isArray(d?.refs)) d.refs.forEach(p => p && window.api.approvePath?.(p))
    })
    setNodes(loaded)
    // Re-style edges saved before the soft-edge change (they had animated dashes).
    setEdges((meta.definition.edges || []).map(e => ({ ...e, animated: false, ...DEFAULT_EDGE_OPTS })))
    setShowList(false)
    genTokenRef.current++         // invalidate any in-flight save's id writeback
    currentIdRef.current = id     // adopt the loaded canvas id immediately
    onDocOpenedRef.current?.(id)  // tell the shell which doc is now active
    hasGenerated.current = false  // opening a canvas shouldn't autosave until a new generate
    setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1 }), 60)
  }
  function newCanvas() {
    genTokenRef.current++
    currentIdRef.current = null
    onDocOpenedRef.current?.(null)
    setCurrentId(null); setName('未命名画布'); setNodes([]); setEdges([]); setShowList(false)
    hasGenerated.current = false
  }
  async function saveCanvas() {
    await persistCanvas(true) // shares the gate/token with autosave → no duplicate canvas
    toast.success('已保存')
  }
  async function deleteCanvas(id: string) {
    if (!(await dlg.confirm({ message: '确定删除这个画布？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteWorkflow(id)
    if (currentId === id) newCanvas()
    await loadCanvases()
    onDocsChanged?.()
  }

  // ── Add image cards ──────────────────────────────────────────────────────
  const addImageNode = useCallback((path: string, pos: { x: number; y: number }, size = DEFAULT_W) => {
    idc.current += 1
    const node: Node = {
      id: `img_${Date.now()}_${idc.current}`,
      type: 'image_card',
      position: pos,
      style: { width: size, height: size },
      data: { path, status: 'done' } as ImageCardData
    }
    window.api.approvePath?.(path)
    setNodes(ns => [...ns, node])
    return node.id
  }, [setNodes])

  const fileToPath = useCallback(async (file: File): Promise<string | null> => {
    try {
      const real = window.api.getPathForFile(file)
      if (real) { await window.api.approvePath(real); return real }
      const base64 = await blobToBase64(file)
      const ext = (file.name.split('.').pop() || 'png').toLowerCase()
      const rand = Math.random().toString(36).slice(2, 8)
      const r = await window.api.writeTempFile({ name: `canvas-${Date.now()}-${rand}.${ext}`, data: base64 })
      return r.path
    } catch { return null }
  }, [])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    let i = 0
    for (const f of files) {
      const p = await fileToPath(f)
      if (p) addImageNode(p, { x: at.x + i * 30, y: at.y + i * 30 })
      i++
    }
  }, [rf, fileToPath, addImageNode])

  const addAtCenter = useCallback((path: string) => {
    const el = wrapRef.current
    const at = el
      ? rf.screenToFlowPosition({ x: el.getBoundingClientRect().left + el.clientWidth / 2, y: el.getBoundingClientRect().top + el.clientHeight / 2 })
      : { x: 200, y: 200 }
    addImageNode(path, { x: at.x - DEFAULT_W / 2 + Math.random() * 40, y: at.y - DEFAULT_W / 2 + Math.random() * 40 })
  }, [rf, addImageNode])

  const importLocal = useCallback(async () => {
    const paths = await window.api.openFileDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
    if (paths?.length) paths.forEach((p: string, i: number) => setTimeout(() => addAtCenter(p), i * 10))
  }, [addAtCenter])

  // ── Generate: reference image(s) + prompt → N cards fanned out + filled live ───
  // Shared by single-card generate and multi-image (model+clothing) joint generate.
  const runImageGen = useCallback((refPaths: string[], prompt: string, count: number, sourceIds: string[], size: string, quality: string) => {
    if (!refPaths.length || !sourceIds.length) return
    const srcNodes = nodes.filter(n => sourceIds.includes(n.id))
    if (!srcNodes.length) return
    // Mark generation happened → autosave kicks in; auto-name a fresh canvas from the prompt.
    hasGenerated.current = true
    if (!currentIdRef.current && nameRef.current.trim() === '未命名画布' && prompt.trim()) setName(prompt.trim().slice(0, 24))
    const stamp = Date.now()
    const variantGroupId = `canvas:${sourceIds[0]}:${stamp}`
    // Result cards take the chosen aspect ratio (max side ~160) so 9:16 etc. read right.
    const [sw, sh] = size.split('x').map(Number)
    const ar = sw && sh ? sw / sh : 1
    const cardW = Math.round(ar >= 1 ? 160 : 160 * ar)
    const cardH = Math.round(ar >= 1 ? 160 / ar : 160)
    const spacing = cardH + 18
    const rightX = Math.max(...srcNodes.map(n => n.position.x + (Number((n.style as { width?: number } | undefined)?.width) || DEFAULT_W)))
    const avgY = srcNodes.reduce((s, n) => s + n.position.y, 0) / srcNodes.length
    const baseX = rightX + 130
    const startY = avgY - ((count - 1) / 2) * spacing

    const placeholders: Node[] = Array.from({ length: count }, (_, i) => {
      idc.current += 1
      return {
        id: `img_${stamp}_${idc.current}`,
        type: 'image_card',
        position: { x: baseX, y: startY + i * spacing },
        style: { width: cardW, height: cardH },
        data: { status: 'generating', prompt, genRefs: refPaths, genSize: size, genQuality: quality } as ImageCardData
      }
    })
    setNodes(ns => [...ns, ...placeholders])
    setEdges(es => [...es, ...placeholders.flatMap(p => sourceIds.map(sid => ({ id: `e_${sid}_${p.id}`, source: sid, target: p.id, ...DEFAULT_EDGE_OPTS })))])
    setBusy(b => { const n = new Set(b); sourceIds.forEach(id => n.add(id)); return n })

    let remaining = count
    const done = () => { remaining--; if (remaining === 0) setBusy(b => { const n = new Set(b); sourceIds.forEach(id => n.delete(id)); return n }) }
    for (const p of placeholders) {
      window.api.canvasGenerateOne({ prompt, n: 1, size, quality, referenceImagePaths: refPaths, sceneLabel: prompt.slice(0, 30), variantGroupId })
        .then(r => {
          const path = r?.paths?.[0]
          if (path) window.api.approvePath?.(path)
          setNodes(ns => ns.map(n => n.id === p.id ? { ...n, data: { ...(n.data as ImageCardData), status: path ? 'done' : 'error', path } } : n))
        })
        .catch(() => setNodes(ns => ns.map(n => n.id === p.id ? { ...n, data: { ...(n.data as ImageCardData), status: 'error' } } : n)))
        .finally(done)
    }
  }, [nodes, setNodes, setEdges])

  const onGenerate = useCallback((sourceId: string, prompt: string, count: number, size: string, quality: string, scene: string) => {
    const src = nodes.find(n => n.id === sourceId)
    const srcPath = (src?.data as ImageCardData | undefined)?.path
    if (!src || !srcPath) return
    runImageGen([srcPath], applyScene(scene, prompt), count, [sourceId], size, quality)
  }, [nodes, runImageGen])

  // Prompt draft lives on the node's data (recorded + survives deselect).
  const onDraftChange = useCallback((nodeId: string, text: string) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...(n.data as Record<string, unknown>), draftPrompt: text } } : n))
  }, [setNodes])

  // 扩写 runs page-side so it survives the node being deselected (clicking away)
  // mid-request — the result is written back to the node's draftPrompt regardless.
  const onExpand = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    const d = node.data as ImageCardData & RefStackData
    const draft = String(d.draftPrompt || '').trim()
    if (!draft) return
    const refs = node.type === 'ref_stack'
      ? (Array.isArray(d.refs) ? d.refs : [])
      : (d.path ? [d.path] : [])
    setExpanding(s => { const n = new Set(s); n.add(nodeId); return n })
    window.api.canvasExpandPrompt({ prompt: draft, referenceImagePaths: refs.length ? refs : undefined })
      .then(r => {
        if (r?.ok && r.text) setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...(n.data as Record<string, unknown>), draftPrompt: r.text } } : n))
        else toast.error(r?.error || '扩写失败')
      })
      .catch(e => toast.error(e instanceof Error ? e.message : '扩写失败'))
      .finally(() => setExpanding(s => { const n = new Set(s); n.delete(nodeId); return n }))
  }, [setNodes])

  // ── 重新生成：用产出这张卡时的同一 prompt/参考图/尺寸/画质，就地再出一次 ───
  const onRegenerate = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    const d = node.data as ImageCardData
    const refs = Array.isArray(d.genRefs) ? d.genRefs : []
    const prompt = String(d.prompt || '').trim()
    if (!refs.length || !prompt) return
    hasGenerated.current = true
    const variantGroupId = `canvas:regen:${nodeId}:${Date.now()}`
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...(n.data as ImageCardData), status: 'generating' } } : n))
    setBusy(b => new Set(b).add(nodeId))
    // On failure keep the existing image (revert to done) rather than破坏成 error 占位.
    const settle = (extra: Partial<ImageCardData>) => setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...(n.data as ImageCardData), status: 'done', ...extra } } : n))
    window.api.canvasGenerateOne({ prompt, n: 1, size: d.genSize as string | undefined, quality: d.genQuality as string | undefined, referenceImagePaths: refs, sceneLabel: prompt.slice(0, 30), variantGroupId })
      .then(r => {
        const path = r?.paths?.[0]
        if (path) { window.api.approvePath?.(path); settle({ path }) }
        else { toast.error('重新生成失败'); settle({}) }
      })
      .catch(() => { toast.error('重新生成失败'); settle({}) })
      .finally(() => setBusy(b => { const n = new Set(b); n.delete(nodeId); return n }))
  }, [setNodes])

  const onDelete = useCallback((nodeId: string) => {
    setNodes(ns => ns.filter(n => n.id !== nodeId))
    setEdges(es => es.filter(e => e.source !== nodeId && e.target !== nodeId))
  }, [setNodes, setEdges])

  // ── Reference stack (图堆): 多张图叠成一摞 = 一个提示词的联合参考范围 ────────
  const createStack = useCallback((refs: string[], pos: { x: number; y: number }) => {
    const uniq = Array.from(new Set(refs))
    idc.current += 1
    const node: Node = {
      id: `stack_${Date.now()}_${idc.current}`,
      type: 'ref_stack',
      position: pos,
      style: { width: 300, height: 220 },
      data: { refs: uniq } as RefStackData
    }
    uniq.forEach(p => window.api.approvePath?.(p))
    setNodes(ns => [...ns, node])
    return node.id
  }, [setNodes])

  const appendRefsToStack = useCallback((stackId: string, paths: string[]) => {
    if (!paths.length) return
    paths.forEach(p => window.api.approvePath?.(p))
    setNodes(ns => ns.map(n => {
      if (n.id !== stackId) return n
      const prev = (n.data as RefStackData).refs || []
      const seen = new Set(prev)
      const add = paths.filter(p => !seen.has(p)) // dedupe: same image is only one ref
      return add.length ? { ...n, data: { ...(n.data as RefStackData), refs: [...prev, ...add] } } : n
    }))
  }, [setNodes])

  const createStackAtCenter = useCallback(() => {
    const el = wrapRef.current
    const at = el
      ? rf.screenToFlowPosition({ x: el.getBoundingClientRect().left + el.clientWidth / 2, y: el.getBoundingClientRect().top + el.clientHeight / 2 })
      : { x: 200, y: 200 }
    createStack([], { x: at.x - 150, y: at.y - 110 })
  }, [rf, createStack])

  const onStackAddLocal = useCallback(async (stackId: string) => {
    const paths = await window.api.openFileDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
    if (paths?.length) appendRefsToStack(stackId, paths)
  }, [appendRefsToStack])

  const onStackRemoveRef = useCallback((stackId: string, index: number) => {
    setNodes(ns => ns.map(n => n.id === stackId
      ? { ...n, data: { ...(n.data as RefStackData), refs: ((n.data as RefStackData).refs || []).filter((_, i) => i !== index) } }
      : n))
  }, [setNodes])

  const onStackUngroup = useCallback((stackId: string) => {
    const stack = nodes.find(n => n.id === stackId)
    if (!stack) return
    const refs = (stack.data as RefStackData).refs || []
    const base = stack.position
    setNodes(ns => {
      const rest = ns.filter(n => n.id !== stackId)
      const cards: Node[] = refs.map((p, i) => {
        idc.current += 1
        return {
          id: `img_${Date.now()}_${idc.current}`,
          type: 'image_card',
          position: { x: base.x + (i % 3) * 180, y: base.y + Math.floor(i / 3) * 180 },
          style: { width: DEFAULT_W, height: DEFAULT_W },
          data: { path: p, status: 'done' } as ImageCardData
        }
      })
      return [...rest, ...cards]
    })
    setEdges(es => es.filter(e => e.source !== stackId && e.target !== stackId))
  }, [nodes, setNodes, setEdges])

  const onGenerateFromStack = useCallback((stackId: string, prompt: string, count: number, size: string, quality: string, scene: string) => {
    const stack = nodes.find(n => n.id === stackId)
    const refs = (stack?.data as RefStackData | undefined)?.refs || []
    if (!stack || refs.length === 0) return
    runImageGen(refs, applyScene(scene, prompt), count, [stackId], size, quality)
  }, [nodes, runImageGen])

  // Pull one reference out of a stack onto the canvas as a standalone editable card.
  const onStackExtract = useCallback((stackId: string, index: number) => {
    const stack = nodes.find(n => n.id === stackId)
    const refs = (stack?.data as RefStackData | undefined)?.refs || []
    const p = refs[index]
    if (!stack || !p) return
    const w = Number((stack.style as { width?: number } | undefined)?.width) || 300
    addImageNode(p, { x: stack.position.x + w + 60, y: stack.position.y + index * 28 })
  }, [nodes, addImageNode])

  // Drag an image card onto another card / a stack to pile them — the literal
  // "叠放放一起". Requires the dragged card's center to land over the target.
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: Node) => {
    const dd = node.data as ImageCardData
    if (node.type !== 'image_card' || dd.kind === 'video' || dd.status !== 'done' || !dd.path) return
    const sizeOf = (n: Node) => ({
      w: Number((n.style as { width?: number } | undefined)?.width) || DEFAULT_W,
      h: Number((n.style as { height?: number } | undefined)?.height) || DEFAULT_W
    })
    const s = sizeOf(node)
    const cx = node.position.x + s.w / 2
    const cy = node.position.y + s.h / 2
    const centerInside = (t: Node) => {
      const ts = sizeOf(t)
      return cx >= t.position.x && cx <= t.position.x + ts.w && cy >= t.position.y && cy <= t.position.y + ts.h
    }
    const hits = rf.getIntersectingNodes(node).filter(t => t.id !== node.id && centerInside(t))
    if (!hits.length) return
    const stackTarget = hits.find(t => t.type === 'ref_stack')
    if (stackTarget) {
      appendRefsToStack(stackTarget.id, [dd.path])
      setNodes(ns => ns.filter(n => n.id !== node.id))
      setEdges(es => es.filter(e => e.source !== node.id && e.target !== node.id))
      return
    }
    const cardTarget = hits.find(t => {
      const td = t.data as ImageCardData
      return t.type === 'image_card' && td.kind !== 'video' && td.status === 'done' && !!td.path
    })
    if (cardTarget) {
      const tPath = (cardTarget.data as ImageCardData).path as string
      const ids = new Set([node.id, cardTarget.id])
      setNodes(ns => ns.filter(n => !ids.has(n.id)))
      setEdges(es => es.filter(e => !ids.has(e.source) && !ids.has(e.target)))
      createStack([tPath, dd.path], { x: cardTarget.position.x, y: cardTarget.position.y })
    }
  }, [rf, appendRefsToStack, createStack, setNodes, setEdges])

  // ── Multi-select batch (download / delete / merge into a reference stack) ──
  const selNodes = useMemo(() => nodes.filter(n => selectedIds.includes(n.id)), [nodes, selectedIds])
  const selDonePaths = useMemo(() => selNodes
    .filter(n => { const dd = n.data as ImageCardData; return dd.status !== 'generating' && dd.status !== 'error' && !!dd.path })
    .map(n => (n.data as ImageCardData).path as string), [selNodes])
  const selImageNodes = useMemo(() => selNodes.filter(n => {
    const dd = n.data as ImageCardData
    return dd.kind !== 'video' && dd.status !== 'generating' && dd.status !== 'error' && !!dd.path
  }), [selNodes])

  const downloadSelected = useCallback(async () => {
    if (!selDonePaths.length) return
    const r = await window.api.exportFilesToDir(selDonePaths)
    if (r?.canceled) return
    toast.success(`已导出 ${r?.saved ?? 0} 个文件到所选文件夹`)
  }, [selDonePaths])

  const deleteSelected = useCallback(async () => {
    if (!selectedIds.length) return
    if (!(await dlg.confirm({ message: `确定删除选中的 ${selectedIds.length} 张？`, tone: 'danger', confirmLabel: '删除' }))) return
    const ids = new Set(selectedIds)
    setNodes(ns => ns.filter(n => !ids.has(n.id)))
    setEdges(es => es.filter(e => !ids.has(e.source) && !ids.has(e.target)))
    setSelectedIds([])
  }, [selectedIds, setNodes, setEdges, dlg])

  const mergeSelectedToStack = useCallback(() => {
    if (selImageNodes.length < 2) return
    const refs = selImageNodes.map(n => (n.data as ImageCardData).path as string)
    const cx = selImageNodes.reduce((s, n) => s + n.position.x, 0) / selImageNodes.length
    const cy = selImageNodes.reduce((s, n) => s + n.position.y, 0) / selImageNodes.length
    const ids = new Set(selImageNodes.map(n => n.id))
    setNodes(ns => ns.filter(n => !ids.has(n.id)))
    setEdges(es => es.filter(e => !ids.has(e.source) && !ids.has(e.target)))
    createStack(refs, { x: cx, y: cy })
    setSelectedIds([])
  }, [selImageNodes, setNodes, setEdges, createStack])

  const handlers: CanvasHandlers = useMemo(() => ({
    onGenerate, onDelete,
    onDownload: (path) => { window.api.saveFileAs?.(path) },
    onLightbox: (path) => setLightbox(path),
    onRegenerate,
    onDraftChange,
    onExpand,
    expanding,
    onGenerateFromStack,
    onStackAddLocal,
    onStackAddGallery: (id) => setGalleryTarget({ stackId: id }),
    onStackRemoveRef,
    onStackUngroup,
    onStackExtract,
    busy, imageModelName
  }), [onGenerate, onDelete, onRegenerate, onDraftChange, onExpand, expanding, onGenerateFromStack, onStackAddLocal, onStackRemoveRef, onStackUngroup, onStackExtract, busy, imageModelName])

  const onConnect = useCallback((c: Connection) => setEdges(es => addEdge({ ...c, ...DEFAULT_EDGE_OPTS }, es)), [setEdges])

  // ── Persist (shared by autosave + manual save). Auto-creates on first save. ──
  // One gate (savingRef) so concurrent calls can't double-INSERT; a generation
  // token so a save that resolves after a canvas switch never binds its id to the
  // wrong canvas; a pending flag so a change skipped during an in-flight save is
  // retried (the last edit always lands).
  const persistCanvas = useCallback(async (allowEmpty = false): Promise<void> => {
    if (savingRef.current) { pendingRef.current = true; return }
    const keep = nodesRef.current.filter(isPersistable)
    if (!keep.length && !allowEmpty) return
    savingRef.current = true
    const myToken = genTokenRef.current
    const myId = currentIdRef.current
    try {
      const keepIds = new Set(keep.map(n => n.id))
      const cleanEdges = edgesRef.current.filter(e => keepIds.has(e.source) && keepIds.has(e.target))
      const result = await window.api.saveWorkflow({
        id: myId || undefined, name: nameRef.current || '未命名画布',
        description: '', kind: 'canvas', definition: { nodes: keep, edges: cleanEdges }
      }) as { id?: string }
      // Adopt the new id only if we're still on the same canvas this save started for.
      if (genTokenRef.current === myToken && !myId && result?.id) {
        currentIdRef.current = result.id
        setCurrentId(result.id)
        onDocOpenedRef.current?.(result.id) // shell now knows the autosave-created id
      }
      await loadCanvases()
      onDocsChangedRef.current?.()
    } catch { /* best-effort; manual 保存 still available */ }
    finally {
      savingRef.current = false
      if (pendingRef.current) { pendingRef.current = false; void persistCanvas() }
    }
  }, [])

  useEffect(() => {
    if (!hasGenerated.current) return
    const t = window.setTimeout(() => { void persistCanvas() }, 1500)
    return () => window.clearTimeout(t)
  }, [nodes, edges, persistCanvas])

  // ── Lightbox 上一张/下一张：所有画布图片资源(图卡 + 参考组里的图)按顺序成表 ──
  const mediaList = useMemo(() => {
    const out: string[] = []
    for (const n of nodes) {
      const d = n.data as ImageCardData & RefStackData
      if (n.type === 'ref_stack') (Array.isArray(d.refs) ? d.refs : []).forEach(p => { if (p) out.push(p) })
      else if (d.path && d.status !== 'generating' && d.status !== 'error') out.push(d.path)
    }
    return Array.from(new Set(out)) // dedupe so prev/next + counter index uniquely
  }, [nodes])

  const navLightbox = useCallback((dir: number) => {
    setLightbox(cur => {
      if (!cur || mediaList.length < 2) return cur
      const i = mediaList.indexOf(cur)
      if (i < 0) return cur
      return mediaList[(i + dir + mediaList.length) % mediaList.length]
    })
  }, [mediaList])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') navLightbox(-1)
      else if (e.key === 'ArrowRight') navLightbox(1)
      else if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, navLightbox])

  return (
    <CanvasContext.Provider value={handlers}>
      <div ref={wrapRef} className="relative h-full"
        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDragOver(false) }}
        onDrop={onDrop}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={CANVAS_NODE_TYPES}
          defaultEdgeOptions={DEFAULT_EDGE_OPTS}
          selectionMode={SelectionMode.Partial}
          // While the lightbox is open, disable React Flow's keyboard delete so
          // Delete/Backspace can't silently remove a still-selected card behind it.
          deleteKeyCode={lightbox ? null : ['Backspace', 'Delete']}
          minZoom={0.1}
          maxZoom={2.5}
          fitView
          // Clamp auto-fit to 100% — fitting a single small node (e.g. a fresh
          // reference stack on a new canvas) would otherwise zoom to the 2.5 cap
          // (250%) and make that one box fill the screen.
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} className="!bg-muted/20" color="hsl(var(--muted-foreground) / 0.25)" />

          {/* Bottom-left: custom zoom slider (replaces the workflow-style Controls). */}
          <Panel position="bottom-left">
            <ZoomControl />
          </Panel>

          {/* Top-left: one restrained bar — switcher · title · save.
              When embedded in StudioPage, the shell owns the archive switcher, so
              hide this one (keep title + save). */}
          <Panel position="top-left">
            <div className="flex items-center gap-0.5 pl-1 pr-1.5 py-1 rounded-xl bg-card/95 backdrop-blur border border-border shadow-sm">
              {!embedded && (
              <div className="relative">
                <button onClick={() => setShowList(s => !s)} className="p-1.5 rounded-lg hover:bg-accent/60 text-muted-foreground" title="我的画布">
                  <ChevronDown size={15} />
                </button>
                {showList && (
                  <div className="absolute left-0 top-full mt-1.5 z-50 w-60 max-h-80 overflow-y-auto bg-popover border border-border rounded-xl shadow-xl py-1">
                    <button onClick={newCanvas} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 text-primary"><Plus size={14} /> 新建画布</button>
                    <div className="my-1 border-t border-border/60" />
                    {canvases.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground/60">还没有画布</p>}
                    {canvases.map(w => (
                      <div key={w.id} className={cn('group flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer', currentId === w.id ? 'bg-accent' : 'hover:bg-accent/50')} onClick={() => loadCanvas(w.id)}>
                        <FileImage size={12} className="shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{w.name}</span>
                        <button onClick={(e) => { e.stopPropagation(); deleteCanvas(w.id) }} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"><Trash2 size={11} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}
              <input value={name} onChange={e => setName(e.target.value)} className="bg-transparent font-medium text-sm outline-none w-40 px-1" />
              <div className="w-px h-4 bg-border mx-0.5" />
              <button onClick={saveCanvas} title="保存画布" className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60">
                <Save size={14} />
              </button>
            </div>
          </Panel>

          {/* Top-center: batch action bar (box-/shift-select ≥2 cards). */}
          {selectedIds.length >= 2 && (
            <Panel position="top-center">
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-2xl bg-card/95 backdrop-blur border border-border shadow-lg" onPointerDown={e => e.stopPropagation()}>
                <span className="text-xs text-muted-foreground px-1 whitespace-nowrap">已选 {selectedIds.length} 张</span>
                {selImageNodes.length >= 2 && (
                  <>
                    <div className="w-px h-5 bg-border" />
                    <button onClick={mergeSelectedToStack} title="把选中的图叠成一个参考组（一起当参考生成）"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs hover:opacity-90">
                      <Layers size={13} /> 合并为参考组
                    </button>
                  </>
                )}
                <div className="w-px h-5 bg-border" />
                <button onClick={downloadSelected} disabled={!selDonePaths.length} title="导出所选到文件夹" className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-40"><Download size={15} /></button>
                <button onClick={deleteSelected} title="删除所选" className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"><Trash2 size={15} /></button>
              </div>
            </Panel>
          )}

          {/* Bottom-center: insert tools */}
          <Panel position="bottom-center">
            <div className="flex items-center gap-1 px-1.5 py-1.5 rounded-2xl bg-card border border-border shadow-lg">
              <BarBtn icon={<ImagePlus size={16} />} label="导入本地图片" onClick={importLocal} />
              <BarBtn icon={<FolderOpen size={16} />} label="从素材库" onClick={() => setGalleryTarget('card')} />
              <BarBtn icon={<Layers size={16} />} label="新建参考组（多图联合参考）" onClick={createStackAtCenter} />
              <div className="w-px h-5 bg-border mx-0.5" />
              <BarBtn icon={<Maximize size={16} />} label="适应视图" onClick={() => rf.fitView({ padding: 0.2, maxZoom: 1 })} />
            </div>
          </Panel>
        </ReactFlow>

        {/* Drag-over hint */}
        {dragOver && (
          <div className="absolute inset-0 z-40 grid place-items-center bg-primary/[0.05] border-2 border-dashed border-primary/40 pointer-events-none">
            <span className="flex items-center gap-2 text-primary font-medium"><ImagePlus size={18} /> 松手把图片放到画布</span>
          </div>
        )}

        {/* Empty hint */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center text-muted-foreground/70">
              <ImagePlus size={32} className="mx-auto mb-3 opacity-60" />
              <p className="text-sm">把图片拖进来，或从下方「导入」开始</p>
              <p className="text-xs mt-1 text-muted-foreground/50">选中一张图 → 下方输入提示词 → 一次生成多张</p>
              <p className="text-xs mt-0.5 text-muted-foreground/50">多张图想一起当参考？把它们叠成「参考组」（拖一张到另一张上，或下方「新建参考组」）</p>
            </div>
          </div>
        )}
      </div>

      {galleryTarget && (
        <GalleryPickerDialog
          onClose={() => setGalleryTarget(null)}
          onConfirm={(paths) => {
            if (galleryTarget === 'card') paths.forEach((p, i) => setTimeout(() => addAtCenter(p), i * 10))
            else appendRefsToStack(galleryTarget.stackId, paths)
          }}
        />
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6" onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 w-9 h-9 grid place-items-center rounded-lg bg-white/10 hover:bg-white/20 text-white"><X size={16} /></button>
          {mediaList.length > 1 && (
            <>
              <button onClick={e => { e.stopPropagation(); navLightbox(-1) }} title="上一张（←）"
                className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 grid place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white"><ChevronLeft size={20} /></button>
              <button onClick={e => { e.stopPropagation(); navLightbox(1) }} title="下一张（→）"
                className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 grid place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white"><ChevronRight size={20} /></button>
              <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/70 text-xs tabular-nums">{mediaList.indexOf(lightbox) + 1} / {mediaList.length}</div>
            </>
          )}
          {isVideoPath(lightbox)
            ? <video src={toLocalFileUrl(lightbox)} controls autoPlay loop className="max-w-full max-h-[82vh] rounded-xl shadow-2xl" onClick={e => e.stopPropagation()} />
            : <img src={toLocalFileUrl(lightbox)} alt="" className="max-w-full max-h-[82vh] object-contain rounded-xl shadow-2xl" onClick={e => e.stopPropagation()} />}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <button onClick={() => window.api.saveFileAs?.(lightbox)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm backdrop-blur">
              <Download size={15} /> 下载
            </button>
            {!isVideoPath(lightbox) && (
              <button onClick={() => { addAtCenter(lightbox); setLightbox(null) }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90">
                <Pencil size={15} /> 放到画布编辑
              </button>
            )}
          </div>
        </div>
      )}

      {dlg.element}
    </CanvasContext.Provider>
  )
}

function BarBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} className="flex items-center justify-center w-9 h-9 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors">
      {icon}
    </button>
  )
}

/** Bottom-left zoom widget: − / slider / + / live percent. */
function ZoomControl() {
  const { zoom } = useViewport()
  const rf = useReactFlow()
  const pct = Math.round(zoom * 100)
  return (
    <div className="flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-xl bg-card/95 backdrop-blur border border-border shadow-sm">
      <button onClick={() => rf.zoomTo(Math.max(0.1, +(zoom - 0.15).toFixed(2)), { duration: 150 })} title="缩小" className="text-muted-foreground hover:text-foreground">
        <Minus size={14} />
      </button>
      <input
        type="range" min={10} max={250} value={pct}
        onChange={e => rf.zoomTo(Number(e.target.value) / 100)}
        className="w-24 h-1 accent-primary cursor-pointer"
      />
      <button onClick={() => rf.zoomTo(Math.min(2.5, +(zoom + 0.15).toFixed(2)), { duration: 150 })} title="放大" className="text-muted-foreground hover:text-foreground">
        <Plus size={14} />
      </button>
      <button onClick={() => rf.zoomTo(1, { duration: 150 })} title="重置为 100%" className="text-[11px] text-muted-foreground hover:text-foreground tabular-nums w-9 text-right">
        {pct}%
      </button>
    </div>
  )
}
