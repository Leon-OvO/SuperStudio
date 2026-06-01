import { useState, useEffect, useRef, useCallback } from 'react'
import { RefreshCw, Loader2, Info, Check } from 'lucide-react'
import type { AppSettings, ProviderConfig } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'

interface Props {
  tab: 'defaults' | 'search' | 'kb' | 'build'
  settings: AppSettings
  providers: ProviderConfig[]
  onSave: (s: AppSettings) => void | Promise<void>
  onProvidersRefresh?: () => Promise<void> | void
}

export function GlobalSettings({ tab, settings, providers, onSave, onProvidersRefresh }: Props) {
  const [draft, setDraft] = useState(settings)
  // Auto-save state — only relevant for the 模型 (defaults) tab, but kept at
  // component scope so the indicator stays consistent across tab switches.
  const dirty = useRef(false)
  const [savedTick, setSavedTick] = useState(0)  // bumps after each successful auto-save (for the ✓ chip)

  useEffect(() => { setDraft(settings); dirty.current = false }, [settings])

  const update = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    dirty.current = true
    setDraft(prev => ({ ...prev, [k]: v }))
  }

  const updatePair = <K1 extends keyof AppSettings, K2 extends keyof AppSettings>(
    k1: K1, v1: AppSettings[K1], k2: K2, v2: AppSettings[K2]
  ) => {
    dirty.current = true
    setDraft(prev => ({ ...prev, [k1]: v1, [k2]: v2 }))
  }

  // Debounced auto-save for the 模型 tab. Keeps other tabs on manual save
  // (their fields are sensitive — API keys, etc. — so the explicit
  // "保存" button stays intentional there).
  useEffect(() => {
    if (tab !== 'defaults') return
    if (!dirty.current) return
    const t = setTimeout(() => {
      Promise.resolve(onSave(draft)).then(() => {
        dirty.current = false
        setSavedTick(n => n + 1)
      })
    }, 400)
    return () => clearTimeout(t)
  }, [draft, tab, onSave])

  async function save() {
    await onSave(draft)
  }

  const handleRefreshModels = useCallback(async (providerId: string) => {
    await window.api.fetchModels(providerId)
    await onProvidersRefresh?.()
  }, [onProvidersRefresh])

  if (tab === 'defaults') {
    return (
      <div className="space-y-4 max-w-2xl">
        <h2 className="text-lg font-semibold">模型</h2>
        <p className="text-sm text-muted-foreground">为每种任务类型选择 Key 和模型。点击 <RefreshCw size={11} className="inline -mt-0.5 mx-0.5" /> 重新拉取该 Key 可用的模型。</p>

        <ModelPicker
          label="对话 / Agent 模型"
          providers={providers}
          providerId={draft.defaultChatProviderId}
          modelId={draft.defaultChatModel}
          onChange={(p, m) => updatePair('defaultChatProviderId', p, 'defaultChatModel', m)}
          onRefresh={handleRefreshModels}
        />
        <ModelPicker
          label="图片生成"
          providers={providers}
          providerId={draft.defaultImageProviderId}
          modelId={draft.defaultImageModel}
          onChange={(p, m) => updatePair('defaultImageProviderId', p, 'defaultImageModel', m)}
          onRefresh={handleRefreshModels}
        />
        <ModelPicker
          label="视频生成"
          providers={providers}
          providerId={draft.defaultVideoProviderId}
          modelId={draft.defaultVideoModel}
          onChange={(p, m) => updatePair('defaultVideoProviderId', p, 'defaultVideoModel', m)}
          onRefresh={handleRefreshModels}
        />
        <ModelPicker
          label="向量嵌入（知识库）"
          providers={providers}
          providerId={draft.defaultEmbeddingProviderId}
          modelId={draft.defaultEmbeddingModel}
          onChange={(p, m) => updatePair('defaultEmbeddingProviderId', p, 'defaultEmbeddingModel', m)}
          onRefresh={handleRefreshModels}
        />

        <hr className="border-border" />
        <h3 className="text-sm font-semibold">数据存储</h3>
        {!draft.dataDirectory && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Info size={14} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs text-foreground/80 space-y-1">
                <p className="font-medium text-foreground">尚未设置数据目录</p>
                <p>所有图片、视频、知识库和数据库会保存到系统默认目录（AppData），不便于备份和迁移。建议指定一个独立目录。</p>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const paths = await window.api.openFileDialog({ properties: ['openDirectory'] })
                if (paths?.[0]) {
                  const next = { ...draft, dataDirectory: paths[0] }
                  setDraft(next)
                  await onSave(next)
                }
              }}
              className="text-xs px-2.5 py-1 rounded border border-amber-500/40 hover:bg-amber-500/10 text-amber-600 transition-colors"
            >
              立即选择目录…
            </button>
          </div>
        )}
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

        <div className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
          {dirty.current ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              <span>正在保存…</span>
            </>
          ) : savedTick > 0 ? (
            <>
              <Check size={11} className="text-emerald-500" />
              <span>已自动保存</span>
            </>
          ) : (
            <span className="opacity-60">修改后会自动保存</span>
          )}
        </div>
      </div>
    )
  }

  if (tab === 'search') {
    const needsKey = draft.searchProvider === 'tavily' || draft.searchProvider === 'serper'
    const needsUrl = draft.searchProvider === 'searxng'
    const isScraped = ['bing', 'baidu', 'sogou', 'ddg', 'google'].includes(draft.searchProvider)
    return (
      <div className="space-y-4 max-w-2xl">
        <h2 className="text-lg font-semibold">网络搜索</h2>
        <div className="space-y-1.5">
          <label className="text-sm font-medium block">搜索引擎</label>
          <Select<'tavily' | 'serper' | 'searxng' | 'bing' | 'baidu' | 'sogou' | 'ddg' | 'google'>
            value={draft.searchProvider}
            onChange={v => update('searchProvider', v)}
            options={[
              { value: 'bing', label: 'Bing（免费、浏览器抓取）' },
              { value: 'baidu', label: 'Baidu 百度（免费、浏览器抓取）' },
              { value: 'google', label: 'Google 谷歌（免费、浏览器抓取，可能弹验证码）' },
              { value: 'sogou', label: 'Sogou 搜狗（免费、浏览器抓取）' },
              { value: 'ddg', label: 'DuckDuckGo（免费、浏览器抓取）' },
              { value: 'tavily', label: 'Tavily（需 API 密钥）' },
              { value: 'serper', label: 'Serper（需 API 密钥）' },
              { value: 'searxng', label: 'SearXNG（自部署实例）' }
            ]}
            size="md"
            className="w-full [&>span]:w-full"
          />
          <p className="text-[11px] text-muted-foreground">
            作为内置 web_search 工具与工作流搜索节点的默认引擎；所选引擎失败时会自动按 Bing → Baidu → DDG → Sogou 顺序串行兜底。
          </p>
        </div>
        {needsKey && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium block">API 密钥</label>
            <input
              type="password"
              value={draft.searchApiKey}
              onChange={e => update('searchApiKey', e.target.value)}
              placeholder={draft.searchProvider === 'tavily' ? 'tvly-...' : 'serper key'}
              className="input"
            />
          </div>
        )}
        {needsUrl && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium block">SearXNG 实例地址</label>
            <input
              type="text"
              value={draft.searxngUrl || ''}
              onChange={e => update('searxngUrl', e.target.value)}
              placeholder="https://searx.example.com"
              className="input"
            />
            <p className="text-[11px] text-muted-foreground">
              需指向已开启 <code>format=json</code> 的实例。许多公共实例默认禁用 JSON 接口，建议使用自部署节点。
            </p>
          </div>
        )}
        {isScraped && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            该引擎通过一个隐藏的浏览器窗口加载搜索结果页并提取，无需密钥；速度略慢（约 1–3 秒），且可能受引擎改版或反爬影响。
            想观察抓取过程，可到「全局 → 浏览器」打开抓取窗口。
          </p>
        )}
        <button onClick={save} className="btn-primary">保存</button>
      </div>
    )
  }

  if (tab === 'kb') {
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

  // build tab
  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">公司</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.vibeAutoApply}
          onChange={e => update('vibeAutoApply', e.target.checked)}
        />
        新需求拆解完毕后自动开始执行
      </label>
      <p className="text-xs text-muted-foreground">
        开启后，在「公司」页里用「新需求」模式提交后，AI 把需求拆解成任务列表的同时会立刻开始逐个实施，不用再手动点「执行剩余任务」。适合相信 AI 拆解结果、希望一键到位的场景；如果想先 review 任务列表再决定，请关闭。
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
  onRefresh?: (providerId: string) => Promise<void>
}

function ModelPicker({ label, providers, providerId, modelId, onChange, onRefresh }: PickerProps) {
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  // Auto-select first provider if none is selected yet
  useEffect(() => {
    if (!providerId && providers.length > 0) {
      onChange(providers[0].id, '')
    }
  }, [providerId, providers, onChange])

  const provider = providers.find(p => p.id === providerId) ?? providers[0]
  const effectiveProviderId = provider?.id ?? ''
  const models = provider?.models || []

  async function handleRefresh() {
    if (!effectiveProviderId || !onRefresh) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      await onRefresh(effectiveProviderId)
    } catch (e) {
      setRefreshError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  if (providers.length === 0) {
    return (
      <div className="space-y-1.5">
        <label className="text-sm font-medium block">{label}</label>
        <p className="text-xs text-muted-foreground">暂无可用的 Key，请先在「账号」中初始化或新建。</p>
      </div>
    )
  }

  // Display label: "<platform> · <plan name>" for supercode-managed providers
  // so the picker reads as Token Plans; manual providers fall back to bare name.
  const planLabel = (p: ProviderConfig) =>
    p.source === 'supercode' && p.platform ? `${p.platform} · ${p.name}` : p.name

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium block">{label}</label>
      <div className="flex gap-2 items-start">
        <div className="flex-1 space-y-0.5">
          <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">Token Plan</div>
          <Select
            value={effectiveProviderId}
            onChange={v => onChange(v, '')}
            options={providers.map(p => ({ value: p.id, label: planLabel(p) }))}
            size="md"
            className="w-full [&>span]:w-full"
          />
        </div>
        <div className="flex-1 space-y-0.5">
          <div className="text-[10px] uppercase text-muted-foreground/70 font-medium pl-0.5">模型</div>
          <Select
            value={modelId}
            onChange={v => onChange(effectiveProviderId, v)}
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
        {onRefresh && (
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
        )}
      </div>
      {refreshError && (
        <p className="text-xs text-destructive">{refreshError}</p>
      )}
      {models.length === 0 && !refreshError && (
        <p className="text-xs text-muted-foreground/70">此套餐暂无模型列表，点击右侧 <RefreshCw size={10} className="inline -mt-0.5" /> 重新拉取。</p>
      )}
    </div>
  )
}
