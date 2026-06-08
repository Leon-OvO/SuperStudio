import { useEffect, useState } from 'react'
import { Zap, Loader2, RefreshCw, Info, MessageSquareText, KeyRound, Check, AlertCircle } from 'lucide-react'
import type { AppSettings, ProviderConfig } from '../../../shared/ipc-types'
import { Select } from './ui/Select'
import { BRAND_LINKS } from '@shared/brand-links'
import { ACCOUNT_MODE } from '@shared/flavor'
import { randomId } from '../lib/id'

interface Props {
  /** Called after a default chat model has been saved (or the user opted to skip). */
  onDone: () => void
}

/**
 * Second first-run gate — after the data directory is set, ensure the user has
 * picked a default chat / Agent model. Only the chat default is required here;
 * image / video / embedding defaults are deferred to Settings.
 *
 * BYOK (DWork): a fresh install has NO providers, so we let the user enter their
 * API key + base URL inline and pick a chat model right here (fetch the list or
 * type a model id) — no detour into Settings. Hosted (account flavor) keeps the
 * Token-Plan picker.
 */
export function ChatModelSetup({ onDone }: Props): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [providerId, setProviderId] = useState<string>('')
  const [modelId, setModelId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>('')

  async function loadProviders() {
    setLoading(true)
    try {
      const list = await window.api.listProviders() as ProviderConfig[]
      setProviders(list)
      if (list.length > 0) {
        const first = list[0]
        setProviderId(prev => prev || first.id)
      }
    } catch (e) {
      setError('加载失败：' + ((e as Error).message || '未知错误'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProviders() }, [])

  const provider = providers.find(p => p.id === providerId) ?? providers[0]
  const effectiveProviderId = provider?.id ?? ''
  const models = provider?.models || []

  async function handleRefresh() {
    if (!effectiveProviderId) return
    setRefreshing(true)
    setError('')
    try {
      await window.api.fetchModels(effectiveProviderId)
      await loadProviders()
    } catch (e) {
      setError('拉取模型失败：' + ((e as Error).message || '未知错误'))
    } finally {
      setRefreshing(false)
    }
  }

  async function confirm() {
    if (!effectiveProviderId || !modelId) {
      setError('请选择提供商和模型')
      return
    }
    setSaving(true)
    setError('')
    try {
      const current = await window.api.getSettings() as AppSettings
      await window.api.setSettings({
        ...current,
        defaultChatProviderId: effectiveProviderId,
        defaultChatModel: modelId
      })
      onDone()
    } catch (e) {
      setError('保存失败：' + ((e as Error).message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  function skip() {
    onDone()
  }

  const planLabel = (p: ProviderConfig) =>
    p.platform ? `${p.platform} · ${p.name}` : p.name

  const hasProviders = providers.length > 0

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center p-6">
      <div className="w-[520px] space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-primary flex items-center justify-center">
            <Zap size={20} className="text-primary-foreground" fill="currentColor" />
          </div>
          <h1 className="text-xl font-semibold">配置对话模型</h1>
          <p className="text-sm text-muted-foreground">
            {hasProviders || ACCOUNT_MODE !== 'byok'
              ? '指定一个用于「对话」和「公司」页面的默认模型。图片、视频、向量等其它任务的模型可以稍后在设置中按需配置。'
              : '填入你的 API 密钥并选择一个默认对话模型即可开始。图片、视频等其它模型可以稍后在设置中再配置。'}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
            <Loader2 size={14} className="animate-spin" />
            正在加载…
          </div>
        ) : !hasProviders && ACCOUNT_MODE === 'byok' ? (
          <AddKeyAndModel onDone={onDone} onSkip={skip} />
        ) : !hasProviders ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2 text-xs text-foreground/80">
                <Info size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium text-foreground">尚无可用的模型</p>
                  <p>{BRAND_LINKS.accountHintZh || '在「设置 → API 提供商」中添加 OpenAI / Anthropic / Gemini 等兼容 OpenAI 协议的 Key，即可开始使用。'}</p>
                </div>
              </div>
            </div>
            <button type="button" onClick={skip} className="btn-primary w-full">稍后在设置中配置</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2 items-start">
              <div className="flex-1 space-y-0.5">
                <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">提供商</div>
                <Select
                  value={effectiveProviderId}
                  onChange={v => { setProviderId(v); setModelId('') }}
                  options={providers.map(p => ({ value: p.id, label: planLabel(p) }))}
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              </div>
              <div className="flex-1 space-y-0.5">
                <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">模型</div>
                <Select
                  value={modelId}
                  onChange={v => setModelId(v)}
                  disabled={models.length === 0}
                  options={
                    models.length === 0
                      ? [{ value: '', label: '— 暂无模型 —' }]
                      : [{ value: '', label: '— 选择模型 —' }, ...models.map(m => ({ value: m, label: m }))]
                  }
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing || !effectiveProviderId}
                className="px-2.5 mt-[18px] py-1.5 rounded border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50 flex items-center gap-1 shrink-0 self-stretch"
                title="重新拉取此提供商可用的模型列表"
              >
                {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              </button>
            </div>

            {models.length === 0 && (
              <p className="text-xs text-muted-foreground/80 flex items-center gap-1">
                <Info size={11} />
                此提供商暂无模型列表，点击右侧 <RefreshCw size={10} className="inline -mt-0.5" /> 重新拉取。
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={skip} disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50">
                稍后再说
              </button>
              <button type="button" onClick={confirm} disabled={!modelId || saving}
                className="btn-primary flex-[2] flex items-center justify-center gap-2">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />}
                确认并进入应用
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** BYOK first-run: enter API key + base URL, fetch (or type) a chat model,
 *  save the provider and set it as the default chat model — all in one screen. */
function AddKeyAndModel({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }): JSX.Element {
  const [pid] = useState(() => randomId())
  const [type, setType] = useState<ProviderConfig['type']>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [fetched, setFetched] = useState<string[]>([])
  const [model, setModel] = useState('')          // chosen from fetched list
  const [manualModel, setManualModel] = useState('') // typed override / fallback
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [fetchedOk, setFetchedOk] = useState(false)

  const defaultName = (t: ProviderConfig['type']): string =>
    ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', custom: '自定义提供商' }[t] || 'API 提供商')

  const chosenModel = (): string => manualModel.trim() || model.trim()

  async function persistProvider(models: string[]): Promise<void> {
    await window.api.saveProvider({
      id: pid, name: defaultName(type), type, apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim() || undefined, models,
    } as ProviderConfig)
  }

  async function handleFetch() {
    if (!apiKey.trim()) { setErr('请先填写 API 密钥'); return }
    setFetching(true); setErr(''); setFetchedOk(false)
    try {
      await persistProvider([])                 // save so fetchModels can read the key by id
      const list = await window.api.fetchModels(pid) as string[]
      const ids = Array.isArray(list) ? list : []
      setFetched(ids)
      setFetchedOk(true)
      if (ids.length && !manualModel.trim()) setModel(pickDefault(ids))
      if (!ids.length) setErr('该接口未返回模型列表,请在下方手动填写模型 ID。')
    } catch (e) {
      setErr('拉取失败：' + ((e as Error).message || '未知错误') + '（可在下方手动填写模型 ID）')
    } finally {
      setFetching(false)
    }
  }

  async function handleFinish() {
    const m = chosenModel()
    if (!apiKey.trim()) { setErr('请填写 API 密钥'); return }
    if (!m) { setErr('请拉取并选择,或手动填写一个对话模型 ID'); return }
    setSaving(true); setErr('')
    try {
      // Persist provider with the latest key/baseUrl and the model list (include
      // the manual model if it isn't already in the fetched list).
      const models = fetched.length ? Array.from(new Set([m, ...fetched])) : [m]
      await persistProvider(models)
      const current = await window.api.getSettings() as AppSettings
      await window.api.setSettings({ ...current, defaultChatProviderId: pid, defaultChatModel: m })
      onDone()
    } catch (e) {
      setErr('保存失败：' + ((e as Error).message || '未知错误'))
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">协议</div>
          <Select<ProviderConfig['type']>
            value={type}
            onChange={setType}
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'custom', label: '兼容 OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'gemini', label: 'Gemini' },
            ]}
            size="md"
            className="w-full [&>span]:w-full"
          />
        </div>
        <div className="col-span-2 space-y-0.5">
          <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">接口地址（可选）</div>
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            placeholder={type === 'openai' ? 'https://api.openai.com/v1' : 'https://your.endpoint/v1'}
            className="input w-full" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </div>
      </div>

      <div className="space-y-0.5">
        <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">API 密钥</div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <KeyRound size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setFetchedOk(false) }}
              placeholder="sk-…" className="input w-full pl-8" autoComplete="off" />
          </div>
          <button type="button" onClick={handleFetch} disabled={fetching || !apiKey.trim()}
            className="px-3 rounded-lg border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
            title="用该密钥拉取可用模型列表(仅 OpenAI 兼容接口)">
            {fetching ? <Loader2 size={14} className="animate-spin" /> : fetchedOk ? <Check size={14} className="text-emerald-500" /> : <RefreshCw size={14} />}
            拉取模型
          </button>
        </div>
      </div>

      <div className="space-y-0.5">
        <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">默认对话模型</div>
        {fetched.length > 0 ? (
          <Select
            value={manualModel.trim() ? '' : model}
            onChange={v => { setModel(v); setManualModel('') }}
            options={[{ value: '', label: '— 选择模型 —' }, ...fetched.map(m => ({ value: m, label: m }))]}
            size="md"
            className="w-full [&>span]:w-full"
          />
        ) : null}
        <input value={manualModel} onChange={e => setManualModel(e.target.value)}
          placeholder={fetched.length ? '或手动输入模型 ID 覆盖上面的选择' : '模型 ID（如 gpt-4o），或先点「拉取模型」'}
          className="input w-full mt-1" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
      </div>

      {err && (
        <p className="text-xs text-destructive flex items-start gap-1">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> <span>{err}</span>
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onSkip} disabled={saving}
          className="flex-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50">
          稍后再说
        </button>
        <button type="button" onClick={handleFinish} disabled={saving || !apiKey.trim() || !chosenModel()}
          className="btn-primary flex-[2] flex items-center justify-center gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />}
          完成配置，进入应用
        </button>
      </div>
    </div>
  )
}

/** Prefer a sensible default chat model from a fetched list. */
function pickDefault(ids: string[]): string {
  const pref = ids.find(m => /(^|[-/])(gpt-4o|claude-3.*sonnet|claude.*sonnet|deepseek-chat|gpt-4\.1|qwen.*max)/i.test(m))
  return pref || ids[0]
}
