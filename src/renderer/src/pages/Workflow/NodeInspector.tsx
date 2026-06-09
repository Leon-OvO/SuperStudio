import { useEffect, useState } from 'react'
import { X, Trash2, FolderOpen } from 'lucide-react'
import type { Node } from '@xyflow/react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { NODE_DEFINITIONS, type NodeKind, type FieldDef, type FieldEditor } from './nodes'
import { Select } from '../../components/ui/Select'

interface Props {
  node: Node
  onUpdate: (data: Record<string, unknown>) => void
  onClose: () => void
  onDelete: () => void
}

export function NodeInspector({ node, onUpdate, onClose, onDelete }: Props) {
  const def = NODE_DEFINITIONS[node.type as NodeKind]
  const data = node.data as Record<string, unknown>
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  // Load providers + settings once (used by provider-model selectors)
  useEffect(() => {
    let alive = true
    Promise.all([window.api.listProviders(), window.api.getSettings()]).then(([ps, s]) => {
      if (!alive) return
      setProviders(ps as ProviderConfig[])
      setSettings(s as AppSettings)
    })
    return () => { alive = false }
  }, [])

  if (!def) return null

  const fields = Object.entries(def.fields)

  return (
    <aside className="w-80 shrink-0 border-l border-border bg-card/50 flex flex-col">
      <div className="p-3 border-b border-border flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{def.label}</div>
          <div className="text-[10px] text-muted-foreground font-mono">{node.type}</div>
        </div>
        <button onClick={onDelete} title="删除节点" className="p-1 text-muted-foreground hover:text-destructive">
          <Trash2 size={14} />
        </button>
        <button onClick={onClose} title="关闭" className="p-1 text-muted-foreground hover:text-foreground">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Node description */}
        <p className="text-[11px] text-muted-foreground leading-relaxed bg-muted/40 rounded-md p-2">
          {def.description}
        </p>

        {/* Port summary */}
        <div className="flex gap-1 flex-wrap text-[10px]">
          {def.inputs.map((p, i) => (
            <span key={`in-${i}`} className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-300">
              ← {p.label} ({p.type})
            </span>
          ))}
          {def.outputs.map((p, i) => (
            <span key={`out-${i}`} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              {p.label} ({p.type}) →
            </span>
          ))}
        </div>

        {/* Label field (always present) */}
        <FieldRow label="节点标签" help="只影响画布显示，不参与执行。">
          <input
            value={(data.label as string) || ''}
            onChange={e => onUpdate({ label: e.target.value })}
            className="input text-xs"
          />
        </FieldRow>

        {/* Schema-driven fields */}
        {fields.map(([key, field]) => (
          <FieldRow key={key} label={field.label} help={field.help}>
            <FieldEditorRenderer
              fieldKey={key}
              field={field}
              value={data[key]}
              onChange={v => onUpdate({ [key]: v })}
              providers={providers}
              settings={settings}
            />
          </FieldRow>
        ))}

        {fields.length === 0 && (
          <p className="text-[11px] text-muted-foreground italic">此节点无可配置项。</p>
        )}

        <p className="text-[10px] text-muted-foreground pt-2 border-t border-border break-all">
          ID：{node.id}
        </p>
      </div>
    </aside>
  )
}

function FieldRow({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium block">{label}</label>
      {children}
      {help && <p className="text-[10px] text-muted-foreground leading-snug">{help}</p>}
    </div>
  )
}

interface RendererProps {
  fieldKey: string
  field: FieldDef
  value: unknown
  onChange: (v: unknown) => void
  providers: ProviderConfig[]
  settings: AppSettings | null
}

function FieldEditorRenderer({ field, value, onChange, providers, settings }: RendererProps) {
  const editor: FieldEditor = field.editor

  if (editor.kind === 'text') {
    return (
      <input
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={editor.placeholder}
        className="input text-xs"
      />
    )
  }

  if (editor.kind === 'textarea') {
    return (
      <textarea
        value={(value as string) ?? ''}
        onChange={e => onChange(e.target.value)}
        rows={editor.rows ?? 4}
        placeholder={editor.placeholder}
        className="input text-xs leading-relaxed"
      />
    )
  }

  if (editor.kind === 'number') {
    const num = typeof value === 'number' ? value : Number(value) || 0
    return (
      <input
        type="number"
        value={num}
        min={editor.min}
        max={editor.max}
        step={editor.step ?? 1}
        onChange={e => onChange(Number(e.target.value))}
        className="input text-xs"
      />
    )
  }

  if (editor.kind === 'select') {
    return (
      <Select
        value={String(value ?? '')}
        onChange={onChange}
        options={editor.options}
        size="sm"
      />
    )
  }

  if (editor.kind === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border"
      />
    )
  }

  if (editor.kind === 'file') {
    return <FilePicker value={value as string} onChange={onChange} filters={editor.filters} placeholder={editor.placeholder} />
  }

  if (editor.kind === 'json') {
    return <JsonEditor value={value} onChange={onChange} rows={editor.rows ?? 5} />
  }

  if (editor.kind === 'provider-model') {
    return (
      <ProviderModelPicker
        value={(value as string) ?? ''}
        onChange={onChange}
        providers={providers}
        settings={settings}
        role={editor.role}
      />
    )
  }

  return null
}

function FilePicker({
  value,
  onChange,
  filters,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  filters?: Array<{ name: string; extensions: string[] }>
  placeholder?: string
}) {
  async function pickFile() {
    const paths = await window.api.openFileDialog({ properties: ['openFile'], filters })
    if (paths?.length) onChange(paths[0])
  }
  return (
    <div className="flex gap-1">
      <input
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '路径'}
        className="input text-xs flex-1 min-w-0"
      />
      <button
        type="button"
        onClick={pickFile}
        title="浏览…"
        className="px-2 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 shrink-0"
      >
        <FolderOpen size={13} />
      </button>
    </div>
  )
}

function JsonEditor({ value, onChange, rows }: { value: unknown; onChange: (v: unknown) => void; rows: number }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2))
  const [error, setError] = useState<string | null>(null)

  // Reset when external value changes (e.g. node switched)
  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2))
    setError(null)
  }, [value])

  function handleChange(next: string) {
    setText(next)
    try {
      onChange(JSON.parse(next))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="space-y-1">
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="input text-xs font-mono leading-relaxed"
      />
      {error && <p className="text-[10px] text-destructive">JSON 解析错误：{error}</p>}
    </div>
  )
}

function ProviderModelPicker({
  value,
  onChange,
  providers,
  settings,
  role
}: {
  value: string
  onChange: (v: string) => void
  providers: ProviderConfig[]
  settings: AppSettings | null
  role: 'chat' | 'image' | 'video' | 'embedding'
}) {
  // Encoded as "providerId::modelName"; empty string means "use global default".
  // Split on the FIRST "::" only so a model id that contains "::" stays intact
  // (mirrors parseProviderModel in the workflow engine).
  const sep = value.indexOf('::')
  const providerId = sep >= 0 ? value.slice(0, sep) : ''
  const modelName = sep >= 0 ? value.slice(sep + 2) : ''

  const provider = providers.find(p => p.id === providerId)
  const models = provider?.models ?? []

  const defaultLabel = settings ? formatDefault(settings, role) : '使用全局默认'

  function setProvider(pid: string) {
    if (!pid) return onChange('')
    const p = providers.find(x => x.id === pid)
    const firstModel = p?.models[0] || ''
    onChange(firstModel ? `${pid}::${firstModel}` : `${pid}::`)
  }

  function setModel(m: string) {
    if (!providerId) return
    onChange(`${providerId}::${m}`)
  }

  return (
    <div className="space-y-1.5">
      <Select
        value={providerId}
        onChange={setProvider}
        options={[
          { value: '', label: `⚙ 全局默认`, hint: defaultLabel },
          ...providers.map(p => ({ value: p.id, label: p.name }))
        ]}
        size="sm"
      />
      {providerId && (
        <Select
          value={modelName}
          onChange={setModel}
          options={
            models.length === 0
              ? [{ value: '', label: '（该提供商尚未添加模型）', disabled: true }]
              : models.map(m => ({ value: m, label: m }))
          }
          size="sm"
        />
      )}
    </div>
  )
}

function formatDefault(settings: AppSettings, role: 'chat' | 'image' | 'video' | 'embedding'): string {
  switch (role) {
    case 'chat': return settings.defaultChatModel || '未设置'
    case 'image': return settings.defaultImageModel || '未设置'
    case 'video': return settings.defaultVideoModel || '未设置'
    case 'embedding': return settings.defaultEmbeddingModel || '未设置'
  }
}
