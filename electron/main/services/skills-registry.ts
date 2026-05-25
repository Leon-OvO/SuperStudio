import { installSkill, type SkillManifest, type SkillScenario } from './skills-db'

/**
 * Remote registry format: a JSON document at each `skill_sources.url`. Either
 * a flat array of skill manifests OR an object with a `skills` field.
 *
 * Validates lightly — fields missing get defaulted; obviously-malformed
 * entries are dropped with a console.warn rather than failing the whole fetch.
 */
export interface RegistryEntry {
  /** Distinguishes a "summary" listing from a fully-inlined manifest. */
  manifest?: SkillManifest
  /** When the registry only ships id/name/description/manifestUrl, the
   *  consumer fetches the manifestUrl separately on install. */
  manifestUrl?: string
  id: string
  name: string
  description: string
  icon?: string
  version?: string
  author?: string
  suggestedScenarios?: SkillScenario[]
  homepage?: string
  /** SkillHub slug. Present → install as a runtime skill (download SKILL.md
   *  bundle); absent → legacy prompt-only skill via manifest/manifestUrl. */
  slug?: string
}

export interface FetchedRegistry {
  sourceUrl: string
  entries: RegistryEntry[]
  /** Server-reported total when known; null for flat registries (treat as
   *  unpaginated — the returned `entries` IS the whole filtered list). */
  total: number | null
  /** When the fetch failed, this is the user-facing error; entries is []. */
  error?: string
}

export interface BrowseParams {
  /** 1-based page index. */
  page: number
  pageSize: number
  /** Free-text search; empty string = no filter. */
  keyword: string
}

const VALID_SCENARIOS: ReadonlySet<SkillScenario> = new Set(['chat', 'vibe', 'video'])

/**
 * Fetch ONE page of a registry. Errors are reported as `error` on the result
 * rather than thrown — the UI shows the source as broken and the user can
 * retry.
 *
 * Supported shapes (auto-detected, in order):
 *   1. Flat array:                 [ {...}, {...} ]
 *   2. Simple wrapper:             { skills: [...] }
 *   3. SkillHub envelope:          { code: 0, data: { skills: [...], total }, message }
 *   4. Generic { data: [...] }
 *
 * The renderer paginates one page at a time and re-calls per page change.
 * For server-paginated registries (SkillHub style — response includes
 * `total`), we forward `page`/`pageSize`/`keyword` as URL params and trust
 * the response. For flat registries (no `total`), we apply the keyword
 * filter + slice client-side so search & pagination still work.
 */
export async function fetchRegistry(url: string, params: BrowseParams): Promise<FetchedRegistry> {
  try {
    const requestUrl = mergeBrowseParams(url, params)
    const res = await fetch(requestUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Accept': 'application/json' }
    })
    if (!res.ok) return { sourceUrl: url, entries: [], total: null, error: `HTTP ${res.status}` }
    const data: unknown = await res.json()
    const raw = extractSkillList(data)
    if (!Array.isArray(raw)) {
      return {
        sourceUrl: url, entries: [], total: null,
        error: 'registry JSON: cannot find skills array (expected [...] or { skills: [...] } or { data: { skills: [...] } })'
      }
    }
    const allEntries: RegistryEntry[] = []
    for (const item of raw) {
      const normalized = normalizeEntry(item)
      if (normalized) allEntries.push(normalized)
    }
    const serverTotal = extractTotal(data)
    if (serverTotal !== null) {
      // Server already paginated/filtered; trust the response.
      return { sourceUrl: url, entries: allEntries, total: serverTotal }
    }
    // Flat registry — apply keyword filter + slice client-side.
    const filtered = params.keyword
      ? allEntries.filter(matchesKeyword(params.keyword))
      : allEntries
    const start = (params.page - 1) * params.pageSize
    const sliced = filtered.slice(start, start + params.pageSize)
    return { sourceUrl: url, entries: sliced, total: filtered.length }
  } catch (e) {
    return { sourceUrl: url, entries: [], total: null, error: (e as Error).message || 'fetch failed' }
  }
}

/** Overwrite page/pageSize/keyword on the source URL with the browse params.
 *  SkillHub honors all three; flat-file URLs ignore unknown query params. */
function mergeBrowseParams(url: string, params: BrowseParams): string {
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(params.page))
    u.searchParams.set('pageSize', String(params.pageSize))
    if (params.keyword) u.searchParams.set('keyword', params.keyword)
    else u.searchParams.delete('keyword')
    return u.toString()
  } catch { return url }
}

function matchesKeyword(keyword: string): (e: RegistryEntry) => boolean {
  const kw = keyword.toLowerCase()
  return (e) =>
    e.name.toLowerCase().includes(kw) ||
    e.description.toLowerCase().includes(kw) ||
    (e.author?.toLowerCase().includes(kw) ?? false)
}

/** Detect numeric total in known envelope shapes. */
function extractTotal(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.total === 'number') return d.total
  if (d.data && typeof d.data === 'object') {
    const inner = d.data as Record<string, unknown>
    if (typeof inner.total === 'number') return inner.total
    if (typeof inner.totalCount === 'number') return inner.totalCount
  }
  return null
}

/** Walk known shapes to find the skill array. Returns null if none match. */
function extractSkillList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (Array.isArray(d.skills)) return d.skills as unknown[]
  if (d.data && typeof d.data === 'object') {
    const inner = d.data as Record<string, unknown>
    if (Array.isArray(inner.skills)) return inner.skills as unknown[]
    if (Array.isArray(inner.list)) return inner.list as unknown[]
    if (Array.isArray(d.data as unknown[])) return d.data as unknown[]
  }
  return null
}

function normalizeEntry(raw: unknown): RegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  // id: prefer explicit `id`, fall back to `slug` (SkillHub uses slug as the
  // canonical identifier — no `id` field at all).
  const id = typeof r.id === 'string' && r.id ? r.id
    : typeof r.slug === 'string' && r.slug ? r.slug
    : null
  if (!id) return null
  if (typeof r.name !== 'string' || !r.name) return null

  // Description: prefer Chinese variant if present (matches our UI language).
  // Fall back to the English `description`, then empty.
  const description = typeof r.description_zh === 'string' && r.description_zh
    ? r.description_zh
    : typeof r.description === 'string' ? r.description : ''

  // Icon: explicit `icon` (emoji or string), else `iconUrl` (SkillHub uses URL).
  // We keep both as strings — the UI decides whether to render as <img> or as text.
  const icon = typeof r.icon === 'string' && r.icon ? r.icon
    : typeof r.iconUrl === 'string' && r.iconUrl ? r.iconUrl
    : undefined

  // Author: `author` first, then SkillHub's `ownerName`.
  const author = typeof r.author === 'string' && r.author ? r.author
    : typeof r.ownerName === 'string' ? r.ownerName : undefined

  const entry: RegistryEntry = {
    id,
    name: r.name,
    description,
    icon,
    version: typeof r.version === 'string' ? r.version : undefined,
    author,
    slug: typeof r.slug === 'string' && r.slug ? r.slug : undefined,
    homepage: typeof r.homepage === 'string' ? r.homepage : undefined,
    suggestedScenarios: Array.isArray(r.suggestedScenarios)
      ? (r.suggestedScenarios.filter((s): s is SkillScenario => typeof s === 'string' && VALID_SCENARIOS.has(s as SkillScenario)))
      : undefined,
    manifestUrl: typeof r.manifestUrl === 'string' ? r.manifestUrl : undefined,
    manifest: r.manifest && typeof r.manifest === 'object' ? normalizeManifest(r.manifest as Record<string, unknown>) ?? undefined : undefined
  }
  return entry
}

function normalizeManifest(raw: Record<string, unknown>): SkillManifest | null {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  return {
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    icon: typeof raw.icon === 'string' ? raw.icon : '🧩',
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    author: typeof raw.author === 'string' ? raw.author : '',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    toolWhitelist: Array.isArray(raw.toolWhitelist)
      ? raw.toolWhitelist.filter((t): t is string => typeof t === 'string')
      : null,
    starterPrompts: Array.isArray(raw.starterPrompts)
      ? raw.starterPrompts
          .filter((p): p is { label: string; prompt: string } => !!p && typeof (p as { label?: unknown }).label === 'string' && typeof (p as { prompt?: unknown }).prompt === 'string')
      : [],
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    suggestedScenarios: Array.isArray(raw.suggestedScenarios)
      ? raw.suggestedScenarios.filter((s): s is SkillScenario => typeof s === 'string' && VALID_SCENARIOS.has(s as SkillScenario))
      : []
  }
}

/**
 * Fetch the full manifest for a single skill. If the registry entry inlined
 * the manifest, returns it. Otherwise fetches `manifestUrl`.
 */
export async function fetchManifest(entry: RegistryEntry): Promise<SkillManifest> {
  if (entry.manifest) return entry.manifest
  if (!entry.manifestUrl) {
    // Build a minimal manifest from registry fields. Registries like SkillHub
    // only expose summary metadata (no system prompt body in the list endpoint),
    // so we seed the systemPrompt from the description as a useful starting
    // point — the user can edit it later. Far better than empty content that
    // produces a silently-broken skill.
    const seededPrompt = entry.description
      ? `${entry.description}\n\n(由 ${entry.author || '未知'} 提供。完整说明见：${entry.homepage || '无'})`
      : ''
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      icon: entry.icon ?? '🧩',
      version: entry.version ?? '0.0.0',
      author: entry.author ?? '',
      systemPrompt: seededPrompt,
      toolWhitelist: null,
      starterPrompts: [],
      homepage: entry.homepage,
      suggestedScenarios: entry.suggestedScenarios ?? ['chat']
    }
  }
  const res = await fetch(entry.manifestUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { 'Accept': 'application/json' }
  })
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`)
  const manifest = normalizeManifest(await res.json() as Record<string, unknown>)
  if (!manifest) throw new Error('manifest JSON missing required id/name fields')
  return manifest
}

// ============================================================================
// Bundled fallback registry — shown when the remote registry is unreachable
// (offline, behind a firewall, GH down). Gives users a curated starting set
// even without internet.
// ============================================================================

/**
 * Auto-install the bundled skill set as protected built-ins. Idempotent:
 * re-running on app launch is safe — installSkill upserts and preserves the
 * user's enable/scenario choices, while the builtin flag is sticky.
 */
export function ensureBundledInstalled(): void {
  for (const manifest of BUNDLED_SKILLS) {
    try { installSkill(manifest, 'bundled://', true) } catch { /* keep going for the rest */ }
  }
}

export const BUNDLED_SKILLS: SkillManifest[] = [
  {
    id: 'web-browser',
    name: '网页浏览',
    description: '用内置浏览器打开任意网页并读取内容；需要登录的页面会弹窗提示你登录',
    icon: '🌐',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你是一个会"上网"的助手，能用 web_open 工具在内置浏览器里打开网页并读取渲染后的内容。

何时使用 web_open：
- 用户给出一个具体网址，或想看某个页面（文章、榜单、商品页、某站的"热门/排行"页等）的内容。
- 用户的需求要某个特定页面的实时内容，而不是泛泛的搜索结果（那种用 web_search）。

关于"动态加载 / 评论区"——务必先读这条：
web_open 打开的是一个真实浏览器，不是简单的 HTML 抓取。它会自动等待页面 JS 渲染完成、自动向下滚动若干次以触发懒加载内容（评论区、无限信息流、瀑布流等），并且能读取封装在 Web Component（Shadow DOM）里的内容（例如 B站评论区的 <bili-comments>）。
- 因此"评论区是 JS 动态加载的，所以抓不到"这类说法是过时且错误的。绝对不要凭训练里的旧印象，在没实际打开页面之前就拒绝或说做不到。
- 正确做法：先用 web_open 打开目标页，再从返回的 text 里查找用户要的内容（评论、回复等）。只有当 web_open 实际返回的 text 里确实没有该内容、或返回 needsLogin=true 时，才如实说明拿不到的原因。

如何使用：
1. 用 web_open 传入完整 http(s) 网址打开页面，从返回的 title / text / links 里提炼用户要的信息，整理成简洁中文呈现，并附上来源链接。
   （例：用户想看 B站 热门，就 web_open https://www.bilibili.com/h5/popular ，从中梳理出热门视频清单：标题、UP主、播放量、BV/b23 链接。）
2. 如果 web_open 返回 needsLogin=true：浏览器窗口已自动弹出，明确告诉用户「这个页面需要你在弹出的浏览器窗口里登录，登录完成后回复我一声，我再继续」。绝不要编造数据或假装成功。
3. 提炼链接时只保留与用户需求相关的，过滤掉导航 / 页脚 / 广告等噪音链接。
4. 不要凭空编造页面里没有的内容；拿不到就如实说明，必要时建议用户换个页面或先登录。

始终用中文回复。`,
    toolWhitelist: ['web_open', 'web_search'],
    starterPrompts: [
      { label: '打开网页', prompt: '帮我打开这个网页看看里面的内容：' },
      { label: '看B站热门', prompt: '帮我打开 B站 热门页，看看现在有哪些热门视频' }
    ],
    suggestedScenarios: ['chat', 'vibe']
  },
  {
    id: 'web-frontend-expert',
    name: 'Web 前端专家',
    description: '专注于 HTML/CSS/JS、React、Vue、Tailwind，回复贴合现代前端最佳实践',
    icon: '🎨',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你是一名资深 Web 前端工程师。
- 默认使用现代框架：React 18+ / Vue 3 / Tailwind CSS
- 给代码示例时优先函数式组件 + Hooks，避免过时模式（class component、jQuery、内联样式）
- 关心可访问性 (a11y)、响应式、性能（React 重渲染、bundle 大小、CLS）
- 用中文回复，代码注释也用中文`,
    toolWhitelist: null,
    starterPrompts: [
      { label: '审查我的组件', prompt: '帮我审查这个 React 组件的代码质量与可访问性问题：\n\n```tsx\n\n```' },
      { label: 'Tailwind 配色', prompt: '我想做一个 [描述] 风格的网页，给我一套 Tailwind 配色方案与示例组件。' }
    ],
    suggestedScenarios: ['chat', 'vibe']
  },
  {
    id: 'bug-detective',
    name: 'BUG 侦探',
    description: '系统地排查问题：复现 → 假设 → 验证 → 定位。不上来就乱改代码',
    icon: '🔎',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你是一名擅长 debug 的工程师，遵循"假设-验证"循环：
1. 先确认现象与复现步骤，不要假设用户没告诉你的信息
2. 列出 2-3 个最可能的根因假设，按概率排序
3. 对每个假设设计验证方法（看哪个文件、加什么 log、跑什么命令）
4. 验证后再动代码，绝不在没有定位到根因之前就提出"试试看"的修改

如果用户给的信息不足以形成假设，直接问，不要瞎猜。`,
    toolWhitelist: null,
    starterPrompts: [
      { label: '复盘一个 BUG', prompt: '我遇到这个问题：[描述现象]。复现步骤：[步骤]。预期：[预期]。实际：[实际]。帮我分析。' }
    ],
    suggestedScenarios: ['chat', 'vibe']
  },
  {
    id: 'openspec-workflow',
    name: 'OpenSpec 工作法',
    description: '把需求拆成 proposal / design / tasks，遵循 OpenSpec 规范文档驱动开发',
    icon: '📐',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `按 OpenSpec 规范处理需求：
- 任何新需求先生成 proposal.md（为什么 + 是什么）
- 复杂需求加 design.md（架构决策、关键 tradeoff）
- 再拆 tasks.md（可勾选的实现步骤）
- 改动现有 spec 时明确标注 SPEC DELTA

回复时使用上述文档结构，不要直接跳到代码实现。`,
    toolWhitelist: null,
    starterPrompts: [
      { label: '新功能提案', prompt: '我想实现 [功能]，按 OpenSpec 规范给我 proposal + 任务拆解。' }
    ],
    suggestedScenarios: ['vibe']
  },
  {
    id: 'web-search-expert',
    name: '网络搜索',
    description: '主动调用 web_search 工具获取最新信息，并在回复中引用来源链接',
    icon: '🔍',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你是一名擅长信息检索的研究助手。

何时使用 web_search 工具：
- 用户问到当前事件、最近新闻、价格、版本号、文档等可能在训练截止后变化的信息
- 用户给出陌生的库 / API / 错误信息，你不确定它的当前用法
- 用户明确要求"查一下"、"搜索"、"看看现在 …"

如何使用：
1. 先把用户问题拆成 1-3 个简短的查询关键词，每次只发一个最关键的查询
2. 拿到 results 后再决定是否需要补充检索（避免一次性发太多重复查询）
3. 如果工具返回 fallbackReason，说明所选引擎失败、已自动切到兜底引擎（Bing/Baidu/DDG/Sogou 之一）；若 source 为 none 则全部失败，提醒用户去"设置 → 网络搜索"换引擎或检查网络/代理
4. 回复中必须给出引用：用 [标题](url) 的 markdown 链接列出主要来源；不要凭空编造 URL
5. 如果搜索结果之间互相矛盾，明确指出并说明你采信哪一个、为什么

避免：
- 不要因为"以防万一"就调用搜索；用户问 1+1 不需要搜索
- 不要把搜索结果原文整段贴出来，提炼要点即可
- 不要在没有 web_search 结果的情况下假装引用了某个网页`,
    toolWhitelist: ['web_search'],
    starterPrompts: [
      { label: '查最新动态', prompt: '帮我查一下 [话题] 最近有什么新进展？给我 3 条最重要的，附上来源链接。' },
      { label: '查库的用法', prompt: '帮我搜一下 [库名] 现在最新版本怎么用 [功能]，给一个最小示例。' }
    ],
    suggestedScenarios: ['chat', 'vibe']
  },
  {
    id: 'concise-replier',
    name: '极简回答',
    description: '只给答案，不啰嗦。适合熟练用户快速过问题',
    icon: '⚡',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `回复极度精简：
- 直接给答案，不复述问题
- 代码就是代码，最多一行说明
- 不写"好的，我来帮你..."这类客气话
- 不解释你为什么这么做，除非用户问

用户已经是专业人士，不需要兜底。`,
    toolWhitelist: null,
    starterPrompts: [],
    suggestedScenarios: ['chat']
  }
]
