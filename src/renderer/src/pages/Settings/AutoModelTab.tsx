import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import type { AppSettings, ProviderConfig, AutoModelIntent } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'

interface Props {
  settings: AppSettings
  providers: ProviderConfig[]
  onSave: (s: AppSettings) => void | Promise<void>
}

const INTENTS: { key: AutoModelIntent; label: string; description: string }[] = [
  { key: 'vision', label: '图片分析 / Vision', description: '消息含图片附件，或询问图片内容' },
  { key: 'code', label: '代码 / 编程', description: '代码、调试、算法相关' },
  { key: 'math', label: '数学 / 推理', description: '数学计算、公式推导、逻辑证明' },
  { key: 'creative', label: '创意 / 写作', description: '故事、文案、诗歌、创意内容' },
  { key: 'quick', label: '快速问答', description: '短消息（≤80字），简单问题' },
  { key: 'default', label: '默认（兜底）', description: '未匹配其他意图时使用' },
]

export function AutoModelTab({ settings, providers, onSave }: Props) {
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(settings) }, [settings])

  const allModels = providers.flatMap(p =>
    p.models.map(m => ({ value: `${p.id}::${m}`, label: m, groupLabel: p.name }))
  )

  const modelOptions = [
    { value: '', label: '— 不指定（用全局默认）—' },
    ...allModels
  ]

  function setRoute(intent: AutoModelIntent, value: string) {
    setDraft(prev => ({
      ...prev,
      autoModelRoutes: { ...prev.autoModelRoutes, [intent]: value }
    }))
  }

  async function save() {
    setSaving(true)
    try { await onSave(draft) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">自动切换模型</h2>
        <p className="text-sm text-muted-foreground mt-1">根据对话内容自动选择最合适的模型</p>
      </div>

      {/* Enable toggle */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={draft.autoModelEnabled}
          onChange={e => setDraft(prev => ({ ...prev, autoModelEnabled: e.target.checked }))}
          className="w-4 h-4"
        />
        <span className="text-sm font-medium">启用自动切换</span>
      </label>

      {draft.autoModelEnabled && (
        <>
          {/* Mode selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">切换模式</label>
            <div className="flex gap-4">
              {(['standard', 'smart'] as const).map(mode => (
                <label key={mode} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="autoModelMode"
                    value={mode}
                    checked={draft.autoModelMode === mode}
                    onChange={() => setDraft(prev => ({ ...prev, autoModelMode: mode }))}
                  />
                  <span>
                    {mode === 'standard' ? '标准（关键词规则）' : '智能（LLM 分类）'}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {draft.autoModelMode === 'standard'
                ? '纯本地规则匹配，无需额外 API 调用，即时生效'
                : '发送前用轻量模型判断意图，更准确但有约 200-500ms 延迟；超时自动降级到标准模式'}
            </p>
          </div>

          {/* Smart mode: classifier model picker */}
          {draft.autoModelMode === 'smart' && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">分类模型</label>
              <p className="text-xs text-muted-foreground">用于判断意图的轻量模型（建议选快速且便宜的）</p>
              <Select
                value={draft.autoModelSmartModel}
                onChange={v => setDraft(prev => ({ ...prev, autoModelSmartModel: v }))}
                options={modelOptions}
                size="md"
                className="w-full [&>span]:w-full"
              />
            </div>
          )}

          {/* Route table */}
          <div className="space-y-3">
            <label className="block text-sm font-medium">意图路由表</label>
            <p className="text-xs text-muted-foreground">为每种意图指定使用的模型，未配置的意图回退到"默认"</p>
            {INTENTS.map(({ key, label, description }) => (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{label}</span>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </div>
                <Select
                  value={draft.autoModelRoutes?.[key] ?? ''}
                  onChange={v => setRoute(key, v)}
                  options={modelOptions}
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              </div>
            ))}
          </div>
        </>
      )}

      <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2">
        {saving && <Loader2 size={13} className="animate-spin" />}
        保存
      </button>
    </div>
  )
}
