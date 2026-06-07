import { useEffect, useState } from 'react'
import { Sparkles, Loader2, RefreshCw, Info, MessageSquareText } from 'lucide-react'
import type { AppSettings, ProviderConfig } from '../../../shared/ipc-types'
import { Select } from './ui/Select'
import { BRAND_LINKS } from '@shared/brand-links'

interface Props {
  /** Called after a default chat model has been saved (or the user opted to skip). */
  onDone: () => void
}

/**
 * Second first-run gate — after the data directory is set, ensure the user
 * has picked a default chat / Agent model. We only ask for the chat default
 * here; image / video / embedding defaults are deferred to Settings so the
 * onboarding stays short.
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
      setError('加载 Token Plan 失败：' + ((e as Error).message || '未知错误'))
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
      setError('请选择 Token Plan 和模型')
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
            <Sparkles size={20} className="text-primary-foreground" />
          </div>
          <h1 className="text-xl font-semibold">选择默认对话模型</h1>
          <p className="text-sm text-muted-foreground">
            指定一个用于「对话」和「公司」页面的默认模型。图片、视频、向量等其它任务的模型可以稍后在设置中按需配置。
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
            <Loader2 size={14} className="animate-spin" />
            正在加载 Token Plan…
          </div>
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
            <button
              type="button"
              onClick={skip}
              className="btn-primary w-full"
            >
              稍后在设置中配置
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2 items-start">
              <div className="flex-1 space-y-0.5">
                <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">Token Plan</div>
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
                title="重新拉取此 Token Plan 可用的模型列表"
              >
                {refreshing
                  ? <Loader2 size={13} className="animate-spin" />
                  : <RefreshCw size={13} />
                }
              </button>
            </div>

            {models.length === 0 && (
              <p className="text-xs text-muted-foreground/80 flex items-center gap-1">
                <Info size={11} />
                此套餐暂无模型列表，点击右侧 <RefreshCw size={10} className="inline -mt-0.5" /> 重新拉取。
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={skip}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent transition-colors disabled:opacity-50"
              >
                稍后再说
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={!modelId || saving}
                className="btn-primary flex-[2] flex items-center justify-center gap-2"
              >
                {saving
                  ? <Loader2 size={14} className="animate-spin" />
                  : <MessageSquareText size={14} />
                }
                确认并进入应用
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
