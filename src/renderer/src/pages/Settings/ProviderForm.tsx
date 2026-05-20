import { useState } from 'react'
import { ArrowLeft, Loader2, Plus, X, Check, AlertCircle } from 'lucide-react'
import type { ProviderConfig } from '../../../../shared/ipc-types'
import { randomId } from '../../lib/id'
import { Select } from '../../components/ui/Select'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'

interface Props {
  initial: ProviderConfig | null
  onSave: (p: ProviderConfig) => void | Promise<void>
  onCancel: () => void
}

export function ProviderForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name || '')
  const [type, setType] = useState<ProviderConfig['type']>(initial?.type || 'openai')
  const [apiKey, setApiKey] = useState(initial?.apiKey || '')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '')
  const [models, setModels] = useState<string[]>(initial?.models || [])
  const [newModel, setNewModel] = useState('')
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; modelCount?: number; error?: string } | null>(null)

  async function handleTestConnection() {
    if (!apiKey.trim()) { toast.error('请先填写 API 密钥'); return }
    setTesting(true)
    setTestResult(null)
    try {
      const probe: ProviderConfig = {
        id: initial?.id || 'probe',
        name: name || 'probe',
        type, apiKey, baseUrl, models
      }
      const result = await window.api.testProvider(probe)
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function handleFetchModels() {
    if (!apiKey) { toast.error('请先填写 API 密钥'); return }
    setFetching(true)
    try {
      const id = initial?.id || 'temp_' + randomId()
      const tempProvider: ProviderConfig = { id, name: name || 'temp', type, apiKey, baseUrl, models }
      await window.api.saveProvider(tempProvider)
      const fetched = await window.api.fetchModels(id)
      if (Array.isArray(fetched)) {
        setModels(Array.from(new Set([...models, ...fetched])))
      }
      if (!initial) await window.api.deleteProvider(id)
    } catch (e) {
      toast.error('拉取模型失败：' + (e as Error).message)
    } finally {
      setFetching(false)
    }
  }

  function addModel() {
    const trimmed = newModel.trim()
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed])
      setNewModel('')
    }
  }

  function removeModel(m: string) {
    setModels(models.filter(x => x !== m))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name || !apiKey) { toast.error('名称和 API 密钥不能为空'); return }
    setSaving(true)
    try {
      await onSave({
        id: initial?.id || randomId(),
        name, type, apiKey, baseUrl: baseUrl || undefined, models
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
      <button type="button" onClick={onCancel} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> 返回
      </button>
      <h2 className="text-lg font-semibold">{initial ? '编辑提供商' : '添加提供商'}</h2>

      <Field label="显示名称">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="例如：我的 OpenAI"
          className="input"
        />
      </Field>

      <Field label="协议类型">
        <Select<ProviderConfig['type']>
          value={type}
          onChange={setType}
          options={[
            { value: 'openai', label: 'OpenAI' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'gemini', label: 'Google Gemini' },
            { value: 'custom', label: '自定义（兼容 OpenAI 协议）' }
          ]}
          size="md"
          className="w-full [&>span]:w-full"
        />
      </Field>

      <Field label="API 密钥">
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="input"
        />
      </Field>

      <Field label="接口地址（可选）">
        <input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder={type === 'openai' ? 'https://api.openai.com/v1' : 'https://your.endpoint/v1'}
          className="input"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>

      <Field label="可用模型">
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
              placeholder="模型 ID（如 gpt-4o）"
              className="input flex-1"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" onClick={addModel} className="btn-secondary">
              <Plus size={14} />
            </button>
            <button type="button" onClick={handleFetchModels} disabled={fetching} className="btn-secondary">
              {fetching ? <Loader2 size={14} className="animate-spin" /> : '拉取列表'}
            </button>
          </div>
          {models.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {models.map(m => (
                <span key={m} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-xs">
                  {m}
                  <button type="button" onClick={() => removeModel(m)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </Field>

      {/* Test result panel */}
      {testResult && (
        <div className={cn(
          'rounded-md p-2.5 text-xs flex items-start gap-2 border',
          testResult.ok
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
            : 'bg-destructive/10 border-destructive/30 text-destructive'
        )}>
          {testResult.ok
            ? <Check size={13} className="mt-0.5 shrink-0" />
            : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <div className="flex-1">
            {testResult.ok ? (
              <span>
                连接成功
                {testResult.modelCount != null && ` · 服务器返回了 ${testResult.modelCount} 个可用模型`}
              </span>
            ) : (
              <span>{testResult.error}</span>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={14} className="animate-spin" /> : '保存'}
        </button>
        <button type="button" onClick={handleTestConnection} disabled={testing} className="btn-secondary">
          {testing ? <Loader2 size={14} className="animate-spin" /> : '测试连接'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">取消</button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      {children}
    </div>
  )
}
