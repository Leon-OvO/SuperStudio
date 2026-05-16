import { useEffect, useRef, useState } from 'react'
import { Sparkles, ArrowRight, Check, Loader2, X, Cpu, Key, Link2 } from 'lucide-react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { Select } from './Select'
import { cn } from '../../lib/utils'
import { randomId } from '../../lib/id'

interface Props {
  onDismiss: () => void
}

type Step = 'welcome' | 'provider' | 'model' | 'done'

const PROVIDER_PRESETS: Array<{ key: ProviderConfig['type']; label: string; placeholderUrl: string; placeholderKey: string }> = [
  { key: 'openai',    label: 'OpenAI',                 placeholderUrl: 'https://api.openai.com/v1', placeholderKey: 'sk-...' },
  { key: 'anthropic', label: 'Anthropic',              placeholderUrl: '',                          placeholderKey: 'sk-ant-...' },
  { key: 'gemini',    label: 'Google Gemini',          placeholderUrl: '',                          placeholderKey: 'AIza...' },
  { key: 'custom',    label: '自定义 (OpenAI 兼容)',    placeholderUrl: 'https://your.proxy/v1',     placeholderKey: 'sk-...' }
]

/**
 * First-run onboarding modal. Walks a brand-new user through:
 *   1. Welcome
 *   2. Add one provider (name + type + key + baseUrl)
 *   3. Pick a default chat model (auto-fetched from the provider)
 *   4. Done — drop into the chat
 *
 * Dismissible at any step; reopens next launch only if no providers are
 * configured (so it doesn't pester returning users).
 */
export function WelcomeWizard({ onDismiss }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [provider, setProvider] = useState<ProviderConfig>({
    id: '',
    name: '',
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    models: []
  })
  const [fetching, setFetching] = useState(false)
  const [chatModel, setChatModel] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'provider') {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [step])

  const currentPreset = PROVIDER_PRESETS.find(p => p.key === provider.type) ?? PROVIDER_PRESETS[0]

  async function saveAndFetchModels(): Promise<boolean> {
    if (!provider.name.trim() || !provider.apiKey.trim()) {
      setError('请填写名称和 API Key')
      return false
    }
    setError(null)
    setFetching(true)
    const id = randomId()
    const final: ProviderConfig = {
      ...provider,
      id,
      models: provider.models
    }
    try {
      await window.api.saveProvider(final)
      // Try auto-fetching models for OpenAI-compatible types
      if (final.type === 'openai' || final.type === 'custom') {
        try {
          const fetched = await window.api.fetchModels(id)
          if (Array.isArray(fetched) && fetched.length) {
            const merged = Array.from(new Set([...(final.models ?? []), ...fetched]))
            await window.api.saveProvider({ ...final, models: merged })
            setProvider({ ...final, models: merged })
            // Best-effort sensible defaults
            const chatGuess = merged.find(m => /gpt-4|claude|gemini-2|gemini-1.5/i.test(m)) ?? merged[0]
            const imageGuess = merged.find(m => /dall-e|gpt-image|imagen|sd-/i.test(m))
            setChatModel(chatGuess ?? '')
            setImageModel(imageGuess ?? '')
            return true
          }
        } catch (e) {
          console.warn('[onboarding] fetch models failed:', (e as Error).message)
          // Continue without auto-fetched models — user can pick later
        }
      }
      setProvider(final)
      return true
    } catch (e) {
      setError((e as Error).message || '保存失败')
      return false
    } finally {
      setFetching(false)
    }
  }

  async function saveDefaultsAndFinish() {
    setFetching(true)
    try {
      const current = (await window.api.getSettings()) as AppSettings
      await window.api.setSettings({
        ...current,
        defaultChatProviderId: provider.id,
        defaultChatModel: chatModel,
        ...(imageModel ? {
          defaultImageProviderId: provider.id,
          defaultImageModel: imageModel
        } : {})
      })
      setStep('done')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[400] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-popover border border-border rounded-2xl shadow-2xl w-[560px] max-w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Top */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <Sparkles size={14} className="text-primary-foreground" />
            </div>
            <h2 className="font-semibold">欢迎使用 SuperStudio</h2>
          </div>
          <button
            onClick={onDismiss}
            title="稍后再配（聊天页仍会提示你）"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            <X size={16} />
          </button>
        </header>

        {/* Step indicator */}
        <div className="px-6 pt-4 pb-2 flex items-center gap-1.5">
          <StepDot active={step === 'welcome'} done={step !== 'welcome'} label="开始" />
          <StepConnector done={step !== 'welcome'} />
          <StepDot active={step === 'provider'} done={step === 'model' || step === 'done'} label="提供商" />
          <StepConnector done={step === 'model' || step === 'done'} />
          <StepDot active={step === 'model'} done={step === 'done'} label="默认模型" />
          <StepConnector done={step === 'done'} />
          <StepDot active={step === 'done'} done={step === 'done'} label="完成" />
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {step === 'welcome' && (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                SuperStudio 是一个本地优先的 AI 桌面应用，把对话、生图、生视频、知识库、工作流编排放在一个地方。所有 API Key 都加密保存在你的本机 keychain，不会上传。
              </p>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center gap-2"><Check size={14} className="text-primary shrink-0" /> 多家模型提供商（OpenAI / Anthropic / Gemini / 任意 OpenAI 兼容代理）</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-primary shrink-0" /> 图片 / 视频生成 + 内置画布编辑器</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-primary shrink-0" /> 本地知识库（向量检索 + 文件导入）</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-primary shrink-0" /> 可视化工作流 + MCP 工具集成</li>
              </ul>
              <p className="text-xs text-muted-foreground/70 pt-2">
                只需 1 分钟把第一个模型提供商接进来。
              </p>
            </>
          )}

          {step === 'provider' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium block">协议类型</label>
                <Select<ProviderConfig['type']>
                  value={provider.type}
                  onChange={v => setProvider(p => ({ ...p, type: v }))}
                  options={PROVIDER_PRESETS.map(p => ({ value: p.key, label: p.label }))}
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium flex items-center gap-1"><Cpu size={11} /> 显示名称</label>
                <input
                  ref={inputRef}
                  value={provider.name}
                  onChange={e => setProvider(p => ({ ...p, name: e.target.value }))}
                  placeholder="例如：我的 OpenAI"
                  className="input"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium flex items-center gap-1"><Key size={11} /> API Key</label>
                <input
                  type="password"
                  value={provider.apiKey}
                  onChange={e => setProvider(p => ({ ...p, apiKey: e.target.value }))}
                  placeholder={currentPreset.placeholderKey}
                  className="input font-mono"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                />
              </div>
              {(provider.type === 'openai' || provider.type === 'custom') && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium flex items-center gap-1">
                    <Link2 size={11} />
                    Base URL <span className="text-muted-foreground/60 font-normal">(可选)</span>
                  </label>
                  <input
                    value={provider.baseUrl ?? ''}
                    onChange={e => setProvider(p => ({ ...p, baseUrl: e.target.value }))}
                    placeholder={currentPreset.placeholderUrl}
                    className="input font-mono"
                    autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  />
                  <p className="text-[10px] text-muted-foreground/70">用第三方代理时填代理地址，留空走官方接口</p>
                </div>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          {step === 'model' && (
            <div className="space-y-3">
              {provider.models.length === 0 ? (
                <div className="text-xs text-muted-foreground bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
                  没拉到模型列表。可以稍后在「设置 → 提供商」手动添加模型 ID。或者跳过这一步，先用默认模型。
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">从 <strong>{provider.name}</strong> 拉到 {provider.models.length} 个模型，请选用作默认的：</p>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium block">对话模型（必选）</label>
                    <Select
                      value={chatModel}
                      onChange={setChatModel}
                      options={provider.models.map(m => ({ value: m, label: m }))}
                      size="md"
                      className="w-full [&>span]:w-full"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium block">图片生成模型（可选）</label>
                    <Select
                      value={imageModel}
                      onChange={setImageModel}
                      options={[
                        { value: '', label: '— 不配置 —' },
                        ...provider.models.map(m => ({ value: m, label: m }))
                      ]}
                      size="md"
                      className="w-full [&>span]:w-full"
                    />
                  </div>
                </>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          {step === 'done' && (
            <div className="text-center py-6 space-y-3">
              <div className="w-14 h-14 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
                <Check size={28} className="text-green-600" />
              </div>
              <h3 className="text-base font-semibold">一切就绪</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
                你已经可以在「对话」里直接提问、生图、生视频。需要进一步配置（视频模型、Embedding、搜索 API、MCP 服务器）时去「设置」即可。
              </p>
              <p className="text-xs text-muted-foreground/70">按 <kbd className="px-1 py-0.5 rounded bg-muted/60 border border-border font-mono text-[10px]">Ctrl/Cmd</kbd> + <kbd className="px-1 py-0.5 rounded bg-muted/60 border border-border font-mono text-[10px]">/</kbd> 可以随时查看快捷键列表。</p>
            </div>
          )}
        </div>

        {/* Footer / nav */}
        <footer className="flex items-center justify-between gap-2 px-6 py-3 border-t border-border bg-muted/30">
          <button
            onClick={onDismiss}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            稍后再配
          </button>

          <div className="flex gap-2">
            {step === 'welcome' && (
              <button
                onClick={() => setStep('provider')}
                className="btn-primary"
              >
                开始 <ArrowRight size={13} />
              </button>
            )}
            {step === 'provider' && (
              <>
                <button onClick={() => setStep('welcome')} className="btn-secondary">上一步</button>
                <button
                  onClick={async () => { if (await saveAndFetchModels()) setStep('model') }}
                  disabled={fetching}
                  className="btn-primary"
                >
                  {fetching ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                  下一步
                </button>
              </>
            )}
            {step === 'model' && (
              <>
                <button onClick={() => setStep('provider')} className="btn-secondary">上一步</button>
                <button
                  onClick={saveDefaultsAndFinish}
                  disabled={fetching || (provider.models.length > 0 && !chatModel)}
                  className={cn('btn-primary', !chatModel && provider.models.length > 0 && 'opacity-50 cursor-not-allowed')}
                >
                  {fetching ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  完成
                </button>
              </>
            )}
            {step === 'done' && (
              <button onClick={onDismiss} className="btn-primary">
                开始使用 <ArrowRight size={13} />
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold',
          done ? 'bg-primary text-primary-foreground' : active ? 'bg-primary/20 text-primary ring-2 ring-primary/30' : 'bg-muted text-muted-foreground'
        )}
      >
        {done ? <Check size={11} /> : null}
      </div>
      <span className={cn('text-[11px]', active ? 'text-foreground font-medium' : 'text-muted-foreground')}>{label}</span>
    </div>
  )
}

function StepConnector({ done }: { done: boolean }) {
  return <div className={cn('flex-1 h-px', done ? 'bg-primary/40' : 'bg-border')} />
}
