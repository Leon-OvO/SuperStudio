import { useEffect, useState } from 'react'
import { Sparkles, ChevronDown, Image as ImageIcon, Film, Hash, Zap } from 'lucide-react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { Select, type SelectOption } from '../../components/ui/Select'

interface Props {
  providerId: string
  model: string
  onChange: (providerId: string, model: string) => void
}

type ModelRole = 'chat' | 'image' | 'video' | 'embedding'

function getModelRole(modelName: string, settings: AppSettings | null): ModelRole {
  if (!settings || !modelName) return 'chat'
  if (modelName === settings.defaultImageModel) return 'image'
  if (modelName === settings.defaultVideoModel) return 'video'
  if (modelName === settings.defaultEmbeddingModel) return 'embedding'
  return 'chat'
}

const ROLE_ICON: Record<ModelRole, React.ReactNode> = {
  chat: <Sparkles size={11} />,
  image: <ImageIcon size={11} />,
  video: <Film size={11} />,
  embedding: <Hash size={11} />
}

const ROLE_HINT: Record<ModelRole, string> = {
  chat: '',
  image: '图片',
  video: '视频',
  embedding: '嵌入'
}

/**
 * Single-control picker that flattens all (provider, model) combinations into
 * one popover, grouped by provider, with per-model role icons.
 *
 * Value encoding: "providerId::model". Empty string = use global default.
 */
interface AutoRouteState {
  pending: boolean
  intent?: string
}

export function ModelPicker({ providerId, model, onChange, autoRoute }: Props & { autoRoute?: AutoRouteState }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    window.api.listProviders().then(setProviders)
    window.api.getSettings().then(setSettings)
  }, [])

  const value = providerId && model ? `${providerId}::${model}` : ''

  const options: SelectOption[] = [
    { value: '', label: '使用全局默认', hint: settings?.defaultChatModel || '未设置', icon: <Sparkles size={11} />, groupLabel: '默认' },
    ...providers.flatMap(p => p.models.map(m => {
      const role = getModelRole(m, settings)
      return {
        value: `${p.id}::${m}`,
        label: m,
        groupLabel: p.name,
        hint: ROLE_HINT[role],
        icon: ROLE_ICON[role]
      } satisfies SelectOption
    }))
  ]

  const selectedRole = getModelRole(model, settings)
  const displayLabel = model || '使用全局默认'
  const autoEnabled = settings?.autoModelEnabled

  if (autoRoute?.pending) {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-muted/40 text-muted-foreground animate-pulse">
        <Zap size={11} className="text-amber-500" />
        路由中…
      </span>
    )
  }

  return (
    <Select
      value={value}
      onChange={(v) => {
        if (!v) return onChange('', '')
        const [pid, m] = v.split('::')
        onChange(pid, m)
      }}
      options={options}
      placement="top"
      popoverWidth={280}
      title="切换提供商和模型"
      trigger={({ open }) => (
        <span
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all
            ${open
              ? 'bg-muted text-foreground ring-1 ring-ring/40'
              : 'bg-muted/40 text-foreground/80 hover:bg-muted/70 hover:text-foreground'}`}
        >
          {autoEnabled && <Zap size={11} className="shrink-0 text-amber-500" title="自动切换模型已启用" />}
          <span className="shrink-0 text-muted-foreground">{ROLE_ICON[selectedRole]}</span>
          <span className="max-w-[140px] truncate">{displayLabel}</span>
          <ChevronDown size={11} className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      )}
    />
  )
}
