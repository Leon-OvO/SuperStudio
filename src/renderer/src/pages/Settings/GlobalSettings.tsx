import { useState, useEffect } from 'react'
import type { AppSettings, ProviderConfig } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'

interface Props {
  tab: 'defaults' | 'search' | 'kb'
  settings: AppSettings
  providers: ProviderConfig[]
  onSave: (s: AppSettings) => void | Promise<void>
}

export function GlobalSettings({ tab, settings, providers, onSave }: Props) {
  const [draft, setDraft] = useState(settings)
  useEffect(() => { setDraft(settings) }, [settings])

  const update = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }))

  const updatePair = <K1 extends keyof AppSettings, K2 extends keyof AppSettings>(
    k1: K1, v1: AppSettings[K1], k2: K2, v2: AppSettings[K2]
  ) => setDraft(prev => ({ ...prev, [k1]: v1, [k2]: v2 }))

  async function save() {
    await onSave(draft)
  }

  if (tab === 'defaults') {
    return (
      <div className="space-y-4 max-w-2xl">
        <h2 className="text-lg font-semibold">默认模型</h2>
        <p className="text-sm text-muted-foreground">为每种任务类型选择默认使用的提供商和模型。</p>

        <ModelPicker
          label="对话 / Agent 模型"
          providers={providers}
          providerId={draft.defaultChatProviderId}
          modelId={draft.defaultChatModel}
          onChange={(p, m) => updatePair('defaultChatProviderId', p, 'defaultChatModel', m)}
        />
        <ModelPicker
          label="图片生成"
          providers={providers}
          providerId={draft.defaultImageProviderId}
          modelId={draft.defaultImageModel}
          onChange={(p, m) => updatePair('defaultImageProviderId', p, 'defaultImageModel', m)}
        />
        <ModelPicker
          label="视频生成"
          providers={providers}
          providerId={draft.defaultVideoProviderId}
          modelId={draft.defaultVideoModel}
          onChange={(p, m) => updatePair('defaultVideoProviderId', p, 'defaultVideoModel', m)}
        />
        <ModelPicker
          label="向量嵌入（知识库）"
          providers={providers}
          providerId={draft.defaultEmbeddingProviderId}
          modelId={draft.defaultEmbeddingModel}
          onChange={(p, m) => updatePair('defaultEmbeddingProviderId', p, 'defaultEmbeddingModel', m)}
        />

        <hr className="border-border" />
        <h3 className="text-sm font-semibold">数据存储</h3>
        <div className="space-y-1.5">
          <label className="text-sm font-medium block">数据目录</label>
          <p className="text-xs text-muted-foreground">图片、视频等生成内容的存储位置。留空使用系统默认（AppData）。</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={draft.dataDirectory}
              onChange={e => update('dataDirectory', e.target.value)}
              placeholder="留空使用默认目录…"
              className="input flex-1"
            />
            <button
              onClick={async () => {
                const paths = await window.api.openFileDialog({ properties: ['openDirectory'] })
                if (paths?.[0]) update('dataDirectory', paths[0])
              }}
              className="px-3 py-1.5 rounded border border-border text-sm hover:bg-accent transition-colors"
            >
              浏览…
            </button>
          </div>
          {draft.dataDirectory && (
            <p className="text-xs text-muted-foreground">图片：{draft.dataDirectory}/gallery/images　视频：{draft.dataDirectory}/gallery/videos</p>
          )}
          {draft.dataDirectory !== settings.dataDirectory && (
            <p className="text-xs text-amber-600">
              ⚠ 切换数据目录需要重启应用后生效。已有的数据不会自动迁移，请手动把旧目录里的 <code className="px-1 bg-muted/60 rounded">gallery/</code>、<code className="px-1 bg-muted/60 rounded">superstudio.db</code> 复制到新目录。
            </p>
          )}
        </div>

        <button onClick={save} className="btn-primary">保存</button>
      </div>
    )
  }

  if (tab === 'search') {
    return (
      <div className="space-y-4 max-w-2xl">
        <h2 className="text-lg font-semibold">网络搜索</h2>
        <div className="space-y-1.5">
          <label className="text-sm font-medium block">搜索引擎</label>
          <Select<'tavily' | 'serper'>
            value={draft.searchProvider}
            onChange={v => update('searchProvider', v)}
            options={[
              { value: 'tavily', label: 'Tavily' },
              { value: 'serper', label: 'Serper' }
            ]}
            size="md"
            className="w-full [&>span]:w-full"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium block">API 密钥</label>
          <input
            type="password"
            value={draft.searchApiKey}
            onChange={e => update('searchApiKey', e.target.value)}
            placeholder="tvly-... 或 serper key"
            className="input"
          />
        </div>
        <button onClick={save} className="btn-primary">保存</button>
      </div>
    )
  }

  // kb tab
  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">知识库</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.kbGlobalEnabled}
          onChange={e => update('kbGlobalEnabled', e.target.checked)}
        />
        为所有对话启用全局知识库上下文
      </label>
      <p className="text-xs text-muted-foreground">
        启用后会在每次对话中自动检索配置为全局的知识空间作为上下文。会话内手动挂载的知识空间仍优先于全局空间。
      </p>
      <button onClick={save} className="btn-primary">保存</button>
    </div>
  )
}

interface PickerProps {
  label: string
  providers: ProviderConfig[]
  providerId: string
  modelId: string
  onChange: (providerId: string, modelId: string) => void
}

function ModelPicker({ label, providers, providerId, modelId, onChange }: PickerProps) {
  const provider = providers.find(p => p.id === providerId)
  const models = provider?.models || []

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium block">{label}</label>
      <div className="flex gap-2">
        <Select
          value={providerId}
          onChange={v => onChange(v, '')}
          options={[
            { value: '', label: '— 选择提供商 —' },
            ...providers.map(p => ({ value: p.id, label: p.name }))
          ]}
          size="md"
          className="flex-1 [&>span]:w-full"
        />
        <Select
          value={modelId}
          onChange={v => onChange(providerId, v)}
          disabled={!provider}
          options={[
            { value: '', label: '— 选择模型 —' },
            ...models.map(m => ({ value: m, label: m }))
          ]}
          size="md"
          className="flex-1 [&>span]:w-full"
        />
      </div>
    </div>
  )
}
