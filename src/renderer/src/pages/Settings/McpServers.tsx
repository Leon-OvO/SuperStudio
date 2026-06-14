import { useEffect, useRef, useState } from 'react'
import { BRAND } from '@shared/brand'
import { Plus, Trash2, Pencil, ArrowLeft, Loader2, CheckCircle2, XCircle, Server, Cpu, Globe, X, ShieldAlert } from 'lucide-react'
import type { McpServerConfig } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { cn } from '../../lib/utils'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

const EMPTY_DRAFT: McpServerConfig = {
  id: '',
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
  description: ''
}

const PRESETS: Array<{ key: string; label: string; description: string; config: Partial<McpServerConfig> }> = [
  {
    key: 'minimax',
    label: 'Minimax (web_search + understand_image)',
    description: '需要先 npm install -g minimax-mcp-js 或直接走 npx。把 MINIMAX_API_KEY 填进 env。',
    config: {
      name: 'Minimax',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'minimax-mcp-js'],
      env: { MINIMAX_API_KEY: '' },
      description: 'Minimax MCP server — exposes web_search and understand_image to the agent.'
    }
  }
]

export function McpServers() {
  const [list, setList] = useState<McpServerConfig[]>([])
  const [draft, setDraft] = useState<McpServerConfig | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; tools?: Array<{ name: string; description?: string }>; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [loading, setLoading] = useState(false)
  const dlg = useConfirmDialog()

  useEffect(() => { reload() }, [])

  async function reload() {
    setLoading(true)
    try {
      const data = await window.api.listMcpServers()
      setList(data)
    } finally {
      setLoading(false)
    }
  }

  function newServer() {
    setDraft({ ...EMPTY_DRAFT })
    setTestResult(null)
  }

  function editServer(s: McpServerConfig) {
    setDraft({ ...EMPTY_DRAFT, ...s })
    setTestResult(null)
  }

  function loadPreset(key: string) {
    const p = PRESETS.find(x => x.key === key)
    if (!p) return
    setDraft({ ...EMPTY_DRAFT, ...p.config })
    setTestResult(null)
  }

  async function saveDraft() {
    if (!draft) return
    if (!draft.name.trim()) { toast.error('请填写服务器名称'); return }
    if (draft.transport === 'stdio' && !draft.command?.trim()) { toast.error('stdio 需要填写 command'); return }
    if (draft.transport === 'sse' && !draft.url?.trim()) { toast.error('SSE 需要填写 URL'); return }
    await window.api.saveMcpServer(draft)
    setDraft(null)
    await reload()
  }

  async function deleteServer(id: string) {
    if (!(await dlg.confirm({
      message: '确定删除该 MCP 服务器配置？',
      tone: 'danger',
      confirmLabel: '删除'
    }))) return
    await window.api.deleteMcpServer(id)
    await reload()
  }

  async function toggleEnabled(s: McpServerConfig) {
    await window.api.saveMcpServer({ ...s, enabled: !s.enabled })
    await reload()
  }

  async function runTest() {
    if (!draft) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.api.testMcpServer(draft)
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  // List mode
  if (!draft) {
    return (
      <div className="space-y-5 max-w-3xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><Server size={16} /> MCP 服务器</h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              通过 <strong>Model Context Protocol</strong> 接入外部工具服务器（与 Claude Code / Cursor / OpenCode 协议互通）。
              添加后 Agent 会在每次对话开始时拉取启用服务器的工具列表，按 <code className="px-1 rounded bg-muted text-[0.85em]">服务器名__工具名</code> 命名注入。
            </p>
          </div>
          <button onClick={newServer} className="btn-primary shrink-0">
            <Plus size={14} /> 添加服务器
          </button>
        </header>

        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : list.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border rounded-xl text-muted-foreground">
            <Server size={28} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">还没有 MCP 服务器</p>
            <p className="text-xs mt-1">点右上方「添加服务器」开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            {list.map(s => (
              <div key={s.id} className="border border-border rounded-lg p-3 flex items-start gap-3">
                <div className="shrink-0 mt-0.5">
                  {s.transport === 'stdio' ? <Cpu size={14} className="text-muted-foreground" /> : <Globe size={14} className="text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{s.name}</span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {s.transport}
                    </span>
                    {!s.enabled && (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">已停用</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-1 truncate" title={summarize(s)}>
                    {summarize(s)}
                  </p>
                  {s.description && (
                    <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-1">{s.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={s.enabled}
                    onChange={() => toggleEnabled(s)}
                    title={s.enabled ? '停用' : '启用'}
                  />
                  <button onClick={() => editServer(s)} title="编辑" className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => deleteServer(s.id)} title="删除" className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {dlg.element}
      </div>
    )
  }

  // Edit mode
  const updateDraft = <K extends keyof McpServerConfig>(k: K, v: McpServerConfig[K]) =>
    setDraft(d => d ? { ...d, [k]: v } : d)

  return (
    <div className="space-y-4 max-w-3xl">
      <button onClick={() => setDraft(null)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> 返回列表
      </button>
      <h2 className="text-lg font-semibold">{draft.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</h2>

      {!draft.id && PRESETS.length > 0 && (
        <div className="rounded-lg border border-dashed border-border p-3 bg-muted/30">
          <p className="text-xs font-medium text-muted-foreground mb-2">预设</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => loadPreset(p.key)}
                className="text-xs px-2.5 py-1 rounded border border-border bg-card hover:bg-accent transition-colors text-left max-w-xs"
                title={p.description}
              >
                <div className="font-medium">{p.label}</div>
                <div className="text-[10px] text-muted-foreground line-clamp-1">{p.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* stdio runs an arbitrary local subprocess — warn the user explicitly
          so they understand what they're authorizing. */}
      {draft.transport === 'stdio' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-2 text-xs">
          <ShieldAlert size={14} className="shrink-0 mt-0.5 text-amber-600" />
          <div className="text-amber-700 dark:text-amber-400 space-y-1">
            <p className="font-medium">安全提示</p>
            <p className="leading-relaxed">
              stdio 服务器会用「启动命令 + 参数 + 环境变量」在你本机启动一个**子进程**，与 {BRAND.displayName}
              共用同一个用户权限。只接入你信任的命令（如官方 MCP 服务器或自己写的脚本）。
              切勿粘贴来历不明的命令，它们能读写你的文件、访问网络、调用外部 API。
            </p>
          </div>
        </div>
      )}

      <Field label="服务器名称">
        <input
          value={draft.name}
          onChange={e => updateDraft('name', e.target.value)}
          placeholder="例如 Minimax"
          className="input"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
      </Field>

      <Field label="传输方式">
        <Select<'stdio' | 'sse'>
          value={draft.transport}
          onChange={v => updateDraft('transport', v)}
          options={[
            { value: 'stdio', label: 'stdio (本地启动子进程)' },
            { value: 'sse', label: 'SSE / HTTP (远程 URL)' }
          ]}
          size="md"
          className="w-full [&>span]:w-full"
        />
      </Field>

      {draft.transport === 'stdio' ? (
        <>
          <Field label="启动命令" help="例如 npx 或 uvx；也可以是绝对路径下的可执行文件。">
            <input
              value={draft.command ?? ''}
              onChange={e => updateDraft('command', e.target.value)}
              placeholder="npx"
              className="input font-mono"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
            />
          </Field>
          <Field label="启动参数 (每行一个)" help="例如：-y、minimax-mcp-js。空行会被忽略。">
            <textarea
              value={(draft.args ?? []).join('\n')}
              onChange={e => updateDraft('args', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
              rows={3}
              className="input font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          <Field label="环境变量" help="按 KEY=VALUE 形式每行一个。运行时会合并到子进程 env。">
            <EnvEditor
              value={draft.env ?? {}}
              onChange={env => updateDraft('env', env)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="服务器 URL" help="MCP 服务的 SSE 端点。例如 https://your-mcp.example.com/sse">
            <input
              value={draft.url ?? ''}
              onChange={e => updateDraft('url', e.target.value)}
              placeholder="https://…/sse"
              className="input font-mono"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
            />
          </Field>
          <Field label="HTTP 请求头" help="例如 Authorization: Bearer xxx。">
            <EnvEditor
              value={draft.headers ?? {}}
              onChange={headers => updateDraft('headers', headers)}
              keyPlaceholder="Header-Name"
              valuePlaceholder="header value"
            />
          </Field>
        </>
      )}

      <Field label="备注（可选）">
        <input
          value={draft.description ?? ''}
          onChange={e => updateDraft('description', e.target.value)}
          placeholder="这个服务器是干嘛的"
          className="input"
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={e => updateDraft('enabled', e.target.checked)}
        />
        启用此服务器（Agent 会拉取它的工具列表）
      </label>

      {/* Test result */}
      {testResult && (
        <div className={cn(
          'rounded-md p-3 text-xs',
          testResult.ok ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-destructive/10 border border-destructive/30'
        )}>
          {testResult.ok ? (
            <>
              <p className="font-medium text-emerald-600 flex items-center gap-1 mb-2">
                <CheckCircle2 size={12} /> 连接成功 · 发现 {testResult.tools?.length ?? 0} 个工具
              </p>
              {testResult.tools && testResult.tools.length > 0 && (
                <ul className="space-y-0.5 text-muted-foreground">
                  {testResult.tools.map(t => (
                    <li key={t.name}>
                      <code className="font-mono">{t.name}</code>
                      {t.description && <span className="ml-2 text-[11px] opacity-70">— {t.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="font-medium text-destructive flex items-center gap-1">
              <XCircle size={12} /> {testResult.error}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={saveDraft} className="btn-primary">保存</button>
        <button onClick={runTest} disabled={testing} className="btn-secondary">
          {testing ? <Loader2 size={14} className="animate-spin" /> : '测试连接'}
        </button>
        <button onClick={() => setDraft(null)} className="btn-secondary">取消</button>
      </div>
    </div>
  )
}

function summarize(s: McpServerConfig): string {
  if (s.transport === 'stdio') {
    return `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() || '(未配置)'
  }
  return s.url ?? '(未配置)'
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      {children}
      {help && <p className="text-xs text-muted-foreground/80 leading-relaxed">{help}</p>}
    </div>
  )
}

/** key/value editor for env vars or HTTP headers. */
function EnvEditor({
  value, onChange, keyPlaceholder = 'KEY', valuePlaceholder = 'value'
}: {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const entries = Object.entries(value)
  const newKeyRef = useRef<HTMLInputElement>(null)
  const newValueRef = useRef<HTMLInputElement>(null)

  function setEntry(oldKey: string, newKey: string, newValue: string) {
    const next: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (k === oldKey) {
        if (newKey) next[newKey] = newValue
      } else {
        next[k] = v
      }
    }
    onChange(next)
  }
  function removeEntry(key: string) {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }
  function addEntry() {
    const k = newKeyRef.current?.value.trim()
    const v = newValueRef.current?.value ?? ''
    if (!k) return
    onChange({ ...value, [k]: v })
    if (newKeyRef.current) newKeyRef.current.value = ''
    if (newValueRef.current) newValueRef.current.value = ''
    newKeyRef.current?.focus()
  }

  return (
    <div className="space-y-1.5">
      {entries.length > 0 && (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1 items-center">
              <input
                defaultValue={k}
                onBlur={e => setEntry(k, e.target.value.trim(), v)}
                placeholder={keyPlaceholder}
                className="input font-mono text-xs flex-1"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
              />
              <span className="text-muted-foreground text-xs">=</span>
              <input
                defaultValue={v}
                onBlur={e => setEntry(k, k, e.target.value)}
                placeholder={valuePlaceholder}
                className="input font-mono text-xs flex-1"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
              />
              <button
                onClick={() => removeEntry(k)}
                className="p-1 text-muted-foreground hover:text-destructive"
                title="删除"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1 items-center">
        <input
          ref={newKeyRef}
          placeholder={keyPlaceholder}
          className="input font-mono text-xs flex-1"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
        <span className="text-muted-foreground text-xs">=</span>
        <input
          ref={newValueRef}
          placeholder={valuePlaceholder}
          className="input font-mono text-xs flex-1"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
        <button onClick={addEntry} className="p-1 text-primary hover:bg-primary/10 rounded" title="添加">
          <Plus size={12} />
        </button>
      </div>
    </div>
  )
}
