import { useEffect, useState, useRef, useCallback } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState,
  addEdge, type Node, type Edge, type Connection, ReactFlowProvider
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Plus, Play, Save, Trash2, FileText, Square as StopIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  NODE_TYPES, NODE_DEFINITIONS, type NodeKind, type WorkflowTemplate,
  isCompatibleConnection, getNodeOutputType, getNodeInputType, buildDefaultData
} from './nodes'
import { NodePalette } from './NodePalette'
import { NodeInspector } from './NodeInspector'
import { useUIStore } from '../../stores/ui'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'
import { useT } from '../../lib/i18n'

interface WorkflowMeta {
  id: string
  name: string
  description: string
  definition: { nodes: Node[]; edges: Edge[] }
  created_at: number
  updated_at: number
}

export function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  )
}

function WorkflowEditor() {
  const [workflows, setWorkflows] = useState<WorkflowMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [name, setName] = useState('未命名工作流')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [running, setRunning] = useState(false)
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({})
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [variableForm, setVariableForm] = useState<Record<string, string> | null>(null)
  const idCounter = useRef(0)
  const { pendingWorkflowId, setPendingWorkflowId } = useUIStore()
  const dlg = useConfirmDialog()
  const t = useT()

  useEffect(() => { loadWorkflows() }, [])

  // Auto-load workflow when navigated here with a pendingWorkflowId (e.g. from chat → workflow)
  useEffect(() => {
    if (!pendingWorkflowId) return
    const id = pendingWorkflowId
    setPendingWorkflowId(null)
    loadWorkflow(id)
  }, [pendingWorkflowId])

  useEffect(() => {
    const unsub = window.api.onWorkflowNodeStatus((event: unknown) => {
      const e = event as { nodeId: string; status: string; message?: string }
      setNodeStatuses(prev => ({ ...prev, [e.nodeId]: e.status }))
      if (e.status === 'done' || e.status === 'error') {
        const allDone = nodes.every(n => {
          const s = e.nodeId === n.id ? e.status : nodeStatuses[n.id]
          return s === 'done' || s === 'error'
        })
        if (allDone) setRunning(false)
      }
    })
    return () => { unsub?.() }
  }, [nodes, nodeStatuses])

  async function loadWorkflows() {
    const data = await window.api.listWorkflows()
    setWorkflows(data)
  }

  async function loadWorkflow(id: string) {
    const all = await window.api.listWorkflows()
    const meta = all.find((w: WorkflowMeta) => w.id === id)
    if (!meta) return
    setCurrentId(id)
    setName(meta.name)
    setNodes(meta.definition.nodes || [])
    setEdges(meta.definition.edges || [])
    setSelectedNode(null)
    setNodeStatuses({})
  }

  async function newWorkflow() {
    setCurrentId(null)
    setName('未命名工作流')
    setNodes([])
    setEdges([])
    setSelectedNode(null)
    setNodeStatuses({})
  }

  async function saveWorkflow() {
    const definition = { nodes, edges }
    const result = await window.api.saveWorkflow({
      id: currentId || undefined,
      name,
      description: '',
      definition
    })
    if (!currentId && result?.id) setCurrentId(result.id)
    await loadWorkflows()
  }

  async function deleteWorkflow(id: string) {
    if (!(await dlg.confirm({ message: '确定删除该工作流？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteWorkflow(id)
    if (currentId === id) await newWorkflow()
    await loadWorkflows()
  }

  async function loadTemplate(template: WorkflowTemplate) {
    if (!(await dlg.confirm(`加载模板「${template.name}」将替换当前画布，确定吗？`))) return
    setCurrentId(null)
    setName(template.name)
    setNodes(template.definition.nodes)
    setEdges(template.definition.edges)
    setSelectedNode(null)
    setNodeStatuses({})
  }

  async function runWorkflow() {
    if (!currentId) {
      toast.error('请先保存工作流')
      return
    }

    // Pre-flight validation — much friendlier than letting the agent crash
    // mid-run when a required input port is empty.
    const validation = validateWorkflow(nodes, edges)
    if (validation.errors.length > 0) {
      // Surface the problems by highlighting the offending nodes via status
      const flagged: Record<string, string> = {}
      for (const err of validation.errors) flagged[err.nodeId] = 'error'
      setNodeStatuses(flagged)
      toast.error(
        `工作流校验失败：\n\n` +
        validation.errors.map(e => `• ${e.message}`).join('\n') +
        `\n\n相关节点已在画布上标红。修复后再点「运行」。`,
        { duration: 6000 }
      )
      return
    }

    // Collect variable nodes and prompt for values
    const variableNodes = nodes.filter(n => n.type === 'variable')
    if (variableNodes.length > 0) {
      const initial: Record<string, string> = {}
      for (const vn of variableNodes) {
        const varName = (vn.data as Record<string, unknown>).variableName as string || vn.id
        const defVal = (vn.data as Record<string, unknown>).defaultValue as string || ''
        initial[varName] = defVal
      }
      setVariableForm(initial)
      return
    }

    doRunWorkflow({})
  }

  /**
   * Pre-flight checks for a workflow. Catches issues the LLM engine would
   * later hit but with much worse error surface — empty graphs, isolated
   * input-having nodes, no producer for a port type, etc.
   */
  function validateWorkflow(
    nodes: Node[],
    edges: Edge[]
  ): { errors: Array<{ nodeId: string; message: string }> } {
    const errors: Array<{ nodeId: string; message: string }> = []
    if (nodes.length === 0) {
      return { errors: [{ nodeId: '', message: '画布为空，请先添加节点。' }] }
    }
    // Map edges by target so we can detect missing inputs quickly
    const incoming = new Map<string, number>()
    for (const e of edges) {
      incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
    }
    for (const n of nodes) {
      const def = NODE_DEFINITIONS[n.type as NodeKind]
      if (!def) continue
      // Any node that DECLARES input ports but receives no edges is almost
      // certainly a misconfiguration. (Defaults / variable / file_read are
      // input-less and skip this.)
      if (def.inputs.length > 0 && !incoming.get(n.id)) {
        const label = (n.data as { label?: string })?.label || def.label
        errors.push({
          nodeId: n.id,
          message: `节点「${label}」需要 ${def.inputs.length} 个输入，但没有任何连线进入。`
        })
      }
    }
    // Workflow needs at least one terminal — output / gallery_save / file_write
    const hasTerminal = nodes.some(n => ['output', 'gallery_save', 'file_write'].includes(n.type as string))
    if (!hasTerminal) {
      errors.push({
        nodeId: '',
        message: '工作流没有终点节点（输出 / 保存到画廊 / 写入文件），运行后结果会丢失。'
      })
    }
    return { errors }
  }

  async function doRunWorkflow(variables: Record<string, string>) {
    setVariableForm(null)
    setNodeStatuses({})
    setRunning(true)
    await window.api.runWorkflow(currentId!, variables)
  }

  async function stopWf() {
    if (currentId) await window.api.stopWorkflow(currentId)
    setRunning(false)
  }

  const onConnect = useCallback((c: Connection) => {
    // Validate connection type compatibility
    const sourceNode = nodes.find(n => n.id === c.source)
    const targetNode = nodes.find(n => n.id === c.target)
    if (sourceNode && targetNode) {
      const outType = getNodeOutputType(sourceNode.type as NodeKind)
      const inType = getNodeInputType(targetNode.type as NodeKind)
      if (!isCompatibleConnection(outType, inType)) {
        setConnectionError(`无法连接：${outType} → ${inType} 类型不兼容`)
        setTimeout(() => setConnectionError(null), 3000)
        return
      }
    }
    setEdges(eds => addEdge(c, eds))
  }, [nodes, setEdges])

  const addNode = useCallback((kind: NodeKind) => {
    idCounter.current += 1
    const newNode: Node = {
      id: `${kind}_${Date.now()}_${idCounter.current}`,
      type: kind,
      position: { x: 100 + Math.random() * 300, y: 100 + Math.random() * 200 },
      data: buildDefaultData(kind)
    }
    setNodes(ns => [...ns, newNode])
  }, [setNodes])

  const updateNodeData = useCallback((nodeId: string, data: Record<string, unknown>) => {
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n))
    setSelectedNode(s => s && s.id === nodeId ? { ...s, data: { ...s.data, ...data } } : s)
  }, [setNodes])

  const styledNodes = nodes.map(n => ({
    ...n,
    data: { ...n.data, _status: nodeStatuses[n.id] }
  }))

  return (
    <div className="flex h-full">
      {/* Workflow list */}
      <aside className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="p-3 border-b border-border">
          <button
            onClick={newWorkflow}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 hover:bg-primary/20 text-sm transition-colors"
          >
            <Plus size={14} /> {t('wf.newWorkflow')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {workflows.map(w => (
            <div
              key={w.id}
              onClick={() => loadWorkflow(w.id)}
              className={cn(
                'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm',
                currentId === w.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              )}
            >
              <FileText size={12} className="shrink-0" />
              <span className="flex-1 truncate">{w.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteWorkflow(w.id) }}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
        <NodePalette onAdd={addNode} onLoadTemplate={loadTemplate} />
      </aside>

      {/* Canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="px-4 py-2 border-b border-border flex items-center gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="flex-1 bg-transparent font-medium outline-none"
          />
          <button onClick={saveWorkflow} className="btn-secondary">
            <Save size={14} /> {t('wf.save')}
          </button>
          {running ? (
            <button onClick={stopWf} className="btn-primary !bg-destructive">
              <StopIcon size={14} /> {t('wf.stop')}
            </button>
          ) : (
            <button onClick={runWorkflow} disabled={!currentId} className="btn-primary">
              <Play size={14} /> {t('wf.run')}
            </button>
          )}
        </header>

        {/* Connection error toast */}
        {connectionError && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground px-4 py-2 rounded-lg text-sm shadow-lg">
            {connectionError}
          </div>
        )}

        <div className="flex-1">
          <ReactFlow
            nodes={styledNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedNode(n)}
            onPaneClick={() => setSelectedNode(null)}
            nodeTypes={NODE_TYPES}
            fitView
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable />
          </ReactFlow>
        </div>
      </div>

      {/* Inspector */}
      {selectedNode && (
        <NodeInspector
          node={selectedNode}
          onUpdate={(data) => updateNodeData(selectedNode.id, data)}
          onClose={() => setSelectedNode(null)}
          onDelete={() => {
            setNodes(ns => ns.filter(n => n.id !== selectedNode.id))
            setEdges(es => es.filter(e => e.source !== selectedNode.id && e.target !== selectedNode.id))
            setSelectedNode(null)
          }}
        />
      )}

      {/* Variable form dialog */}
      {variableForm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-popover border border-border rounded-xl shadow-2xl p-6 w-[400px] max-w-full">
            <h2 className="text-base font-semibold mb-4">{t('wf.fillVariables')}</h2>
            <div className="space-y-3">
              {Object.keys(variableForm).map(varName => (
                <div key={varName}>
                  <label className="block text-sm font-medium mb-1">{varName}</label>
                  <input
                    value={variableForm[varName]}
                    onChange={e => setVariableForm(prev => prev ? { ...prev, [varName]: e.target.value } : null)}
                    className="w-full px-3 py-2 rounded-md border border-border bg-card text-sm outline-none focus:ring-1 focus:ring-ring"
                    placeholder={`${varName} 的值`}
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-5 justify-end">
              <button
                onClick={() => setVariableForm(null)}
                className="btn-secondary"
              >
                {t('wf.cancel')}
              </button>
              <button
                onClick={() => doRunWorkflow(variableForm)}
                className="btn-primary"
              >
                {t('wf.startRun')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dlg.element}
    </div>
  )
}
