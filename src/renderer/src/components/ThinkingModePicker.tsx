import { useEffect, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import type { ProviderConfig, AppSettings } from '../../../shared/ipc-types'
import { Select, type SelectOption } from './ui/Select'
import { supportsThinkingMode } from '../lib/model-utils'

export type ThinkingMode = 'auto' | 'fast' | 'deep'

interface Props {
  /** Per-session/per-project model override (may be '' → resolves to global default). */
  providerId: string
  model: string
  /** Per-turn thinking mode. 'auto' = follow the global setting (no override). */
  value: ThinkingMode
  onChange: (mode: ThinkingMode) => void
}

const OPTIONS: SelectOption<ThinkingMode>[] = [
  { value: 'auto', label: '自动', hint: '跟随全局' },
  { value: 'fast', label: '快速', hint: '不思考·直接答' },
  { value: 'deep', label: '深度', hint: '更强推理·更慢' },
]

const SHORT: Record<ThinkingMode, string> = { auto: '自动', fast: '快速', deep: '深度' }

/**
 * 思考模式 picker shown NEXT TO the model picker — only for models that actually
 * support extended thinking (Claude family on an Anthropic-native route). For any
 * other model it renders nothing (the control would be a no-op). Self-contained:
 * loads providers + settings to resolve the effective model and gate visibility.
 */
export function ThinkingModePicker({ providerId, model, value, onChange }: Props) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.api.listProviders().then(setProviders)
    window.api.getSettings().then(setSettings)
  }, [])

  // Resolve what will actually run: per-session/per-project override, else global
  // default. Gate adaptively on the model being Claude-family (or an anthropic
  // provider) — no hardcoded version allowlist.
  const effModel = model || settings?.defaultChatModel || ''
  const effProviderId = providerId || settings?.defaultChatProviderId || ''
  const provider = providers.find(p => p.id === effProviderId)

  if (!supportsThinkingMode(provider, effModel)) return null

  return (
    <Select
      value={value}
      onChange={onChange}
      options={OPTIONS}
      placement="top"
      popoverWidth={172}
      title="思考模式（仅深度思考模型可用）"
      trigger={({ open }) => (
        <span
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all
            ${open
              ? 'bg-muted text-foreground ring-1 ring-ring/40'
              : 'bg-muted/40 text-foreground/80 hover:bg-muted/70 hover:text-foreground'}
            ${value === 'deep' ? '!text-primary' : ''}`}
          title="思考模式"
        >
          <Brain size={11} className="shrink-0" />
          <span className="truncate">思考·{SHORT[value]}</span>
          <ChevronDown size={11} className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      )}
    />
  )
}
