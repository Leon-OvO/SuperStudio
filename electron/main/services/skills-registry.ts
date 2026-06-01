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
2. 需要登录的页面：浏览器窗口会自动弹出，web_open 会原地等待用户登录——用户在窗口里登录完点一下「我已登录完成，继续」按钮（不点也会自动检测），随后 web_open 通常会在这同一次调用里直接返回登录后的真实内容，你照常处理即可。只有当返回 needsLogin=true（用户始终没登录、超时或关掉了窗口）时，才明确告诉用户「请在弹出的浏览器窗口里登录，登录后我再继续」，然后等用户回应后再 web_open 一次。绝不要编造数据或假装成功。
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
    id: 'web-automation',
    name: '网页操作',
    description: '在已打开的网页里自动点击、填写、上传图片并提交（如帮你在小红书发帖）；通用，任意网站可用',
    icon: '🖱️',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你能在浏览器里操作网页：点击、填写、上传图片、提交表单。

# 工具
- web_open(url)：打开页面。返回值【自带 elements】（可操作元素清单），不要再调 web_snapshot。
- web_click(ref) / web_fill(ref, value)：操作后【自带最新 elements】（已等 DOM 稳定后重抓），不要再调 web_snapshot。
- web_upload({ filePaths })：上传图片/视频。**ref 是可选的**——首选省略 ref 让工具自动定位 input[type=file]，尤其是 elements 里看不到 file 输入框时。也返回最新 elements。
- web_snapshot()：仅在工具返回 ok:false 提示元素失效、或用户手动操作后（登录、过验证码）需要重新看页面时才调。
- image_generate / web_search 辅助。

# 操作流程（严格按此执行）
**最重要的规则**：你的每一次"看一下页面" / "找按钮" / "下一步是…" 的念头，都【已经】通过上一个工具返回值里的 elements 满足了——直接从里面找 ref 调下一个工具，不要再单独调 web_snapshot，更不要在两个工具调用之间输出"现在我来获取最新快照…"、"接下来找发布按钮…"这种状态预告。状态预告 + 没有立刻接下一个工具调用 = 整轮被中断停止。

**hint 字段的处理（重要）**：如果某次工具返回里出现 hint 字段（说明这次没拿到 elements），你【必须】立刻按 hint 的提示调下一个工具——通常是 web_snapshot 重抓一次；如果连 web_snapshot 都失败，就用 web_click 的 text 参数按按钮文字（如"上传图文"、"发布"、"下一步"）直接点。**绝对不要**因为这次没拿到 elements 就停下来跟用户解释"我现在切换到了 xxx 模式" / "需要进一步操作"——一停就是整轮终止。看到 hint = 立刻继续动手。

正确节奏（一气呵成）：
\`\`\`
[user] 帮我发动态：xxx
[tool] web_open https://t.bilibili.com/                  → 返回 elements，里面有编辑器 ref
[tool] web_fill <编辑器ref> "xxx"                         → 返回 elements，里面有"发布"按钮 ref
[tool] web_click <发布按钮ref>                            → 返回 elements，里面应能看到"已发布"提示
[assistant] 已发布。✅
\`\`\`

错误节奏（会被中断）：
\`\`\`
[tool] web_fill ...                                       → ok:true
[assistant] 内容已填入编辑器，现在获取最新快照找到发布按钮。      ← ❌ 在这里就 stop 了
\`\`\`

另一种已知的死法：声明"让我用 web_snapshot 看看是否有更多元素"然后就结束 turn。**严禁**——如果你的下一句话以"让我"/"我来"/"接下来"/"让我看看"/"现在我"开头描述将要调的工具，那句话就别说，直接发起那次工具调用。说出来 = turn 结束。说"已经做完汇报"是允许的，说"接下来要做"不允许。

# 入口 URL（直接打开发布页，不要先开首页再找）
- B站发动态 → https://t.bilibili.com/
- 小红书发帖 → https://creator.xiaohongshu.com/publish/publish?source=official
- 微博发帖 → https://weibo.com/
- 知乎写回答 → 用户给的具体问题 URL
- 其他平台：用户没给 URL 就 web_search 找到发布页 URL 后再 web_open

# 小红书发帖正确流程（重要，否则发布按钮找不到）
1. web_open 发布页 → web_click(text='上传图文') 切到图文模式 → web_upload({filePaths})。
2. **图片上传完成前，标题/正文/发布按钮都不会出现**——web_upload 已自动等到图片处理完
   （最长约 45 秒）才返回，返回后再填标题、正文。**别在 web_upload 没返回前就去找发布按钮。**
3. 填完用 web_click(text='发布') 提交。**「发布」就是最终提交按钮；侧栏的「发布笔记」是导航入口、
   点它会进草稿箱，绝对不要点它当提交。** 若出现「确认发布」二次确认，再 web_click(text='确认发布')。
4. 万一报「发布区未挂载」，说明图片还没传完或页面异常——别走草稿箱恢复，web_open 重开发布页从头来。

# 上传图片
不要点「上传图文 / 选择图片」按钮（弹系统文件框你操作不了）。

**最佳实践（直接传 filePaths，省略 ref）**：
\`\`\`
web_upload({ filePaths: ["F:\\\\path\\\\to\\\\img.png"] })   // 不传 ref
\`\`\`
工具会自己在页面上找 input[type=file] 并把文件注入（覆盖 light DOM + shadow DOM + 同源 iframe）。这是首选方式——尤其是当 elements 里没有 file 输入框、或 web_snapshot 失败时。

只有当你 100% 确定某个 ref 就是 input[type=file]（elements 里的 tag="input" type="file"）时，才传 ref。传错了 ref（比如把"上传图片"按钮的 ref 传进来）会得到清晰报错。

如果 web_upload 返回 ok:false 且 error 提示「找不到 input[type=file]」，说明页面还没切到图文编辑模式：先 web_click 点一下「图文模式」/「图片」tab，再 web_upload(filePaths)（仍然省略 ref）。

**图片路径来自哪里（按优先级）：**
1. **用户在对话里已经附了图片** → 直接用 user message 开头那段「用户附加了 N 个文件，绝对路径如下」manifest 里列出的绝对路径。**这种情况下不要再调 image_generate**——用户已经给图了，再生成就是不听话。
2. 用户没附图但要求"先生成配图再发"或没图可发 → image_generate 出图，用返回的 images[].path。
3. 用户附了图 + 又要求再加生成图 → 两者路径都传给 web_upload（filePaths 是数组）。

# 提交
所有字段填好就【自行调 web_click 点发布按钮】，不要停下来等用户确认（用户已授权全自动）。点完发布按钮，看返回的 elements 里是不是出现了「发布成功」「动态已发布」之类的提示再汇报。

**❌ 禁止点的"假发布按钮"——侧栏导航**
小红书 / B站 / 视频号 / 抖音等创作平台的左侧栏经常有「发布笔记」「发布视频」「发布动态」这类**菜单项**——它是 router push 跳到上传起始页（URL 会出现 from=menu&target=… 这种参数），**不是提交按钮**。点了它你刚填的内容会被丢进草稿箱（草稿数 +1）。识别方式：
- 文字带「笔记」「视频」「动态」等内容类型后缀（"发布**笔记**"、"发布**视频**" → 侧栏）
- 真发布按钮的文字通常只是「发布」或「立即发布」，单独两/四个字，**不带类型后缀**
- 真发布按钮位置在表单**底部**（标题/正文/图片下面），侧栏菜单在页面**左边**

**✅ 真发布按钮在 elements 里找不到 ref 时**（很多站点的发布键是表单填完才渲染、或在视口下方还没挂载）：直接用 **web_click 的 text 参数按文字点**，**只用纯文字「发布」或「立即发布」**，例如 web_click(text="发布")。**不要传 text="发布笔记"**——前述侧栏陷阱就是这么踩的。text 会在实时页面里现找现点（含 shadow DOM / 同源 iframe），不依赖快照。

# 误点了侧栏导致内容回草稿箱 → 怎么恢复
症状：刚才 web_fill 都成功了，但点完"发布"后 URL 变成包含 ?from=menu&target=video 的参数，elements 又出现"上传视频"按钮，标题/正文不见了。这说明你点到的是侧栏菜单，内容已保存为草稿。**不要慌，按这套连续打**：
1. web_click(text="草稿箱") — 展开抽屉
2. web_click(text="图文笔记") — 进入图文草稿列表（如果发的是图文）
3. 在新 elements 里找第一条"编辑"按钮 → web_click(ref=该编辑按钮的 ref) — 恢复刚才的草稿
4. web_click(text="发布")（**注意是"发布"，不是"发布笔记"**）— 真按发布键

# 失败时何时放弃（防死循环）
- 同一个 ref 的 web_fill / web_click 失败 2 次：调 web_snapshot 看 DOM 变了没，找新的 ref；不要拿同样的 ref 第 3 次。
- "富文本编辑器未接受输入"错误：先 web_click 那个编辑器把它聚焦，再 web_fill 一次。还是不行就告诉用户该平台编辑器需要手动输入。
- 任何动作总共 4 次还做不到：停下来，把你做了什么、卡在哪一步、为什么如实告诉用户。不要无限重试，不要编造已发送/已发布。

# 验证码 / 滑块 / 短信
告诉用户在弹出的浏览器窗口里手动完成，用户说完成后你 web_snapshot 一次拿新 elements 再继续。

# 输出
中文。每步动作前最多一句话说明你要做什么，紧接着调用对应工具。全部做完后简短汇报结果。`,
    toolWhitelist: ['web_open', 'web_snapshot', 'web_click', 'web_fill', 'web_upload', 'web_search', 'image_generate'],
    starterPrompts: [
      { label: '小红书发帖', prompt: '帮我在小红书发一篇帖子，主题是：' },
      { label: '生成配图再发帖', prompt: '先帮我生成一张配图，然后打开小红书发帖页，把图传上去，标题和正文按这个主题填好并发布：' }
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
    id: 'image-generator',
    name: '生成图片',
    description: '用文字描述生成图片，调用「设置 → 全局 → 模型」里配置的生图模型',
    icon: '🖼️',
    version: '1.0.0',
    author: 'SuperStudio',
    systemPrompt: `你是一个专注于「文生图」的助手，能用 image_generate 工具根据文字描述生成图片。生成所用的模型就是用户在「设置 → 全局 → 模型」里配置的生图模型，你无需也无法在对话里切换模型。

如何使用 image_generate：
- prompt（图片描述）：用户的描述往往很短（如"一只猫"）。在不偏离用户意图的前提下，把它扩写成更利于出图的提示词——主体、场景、风格、光影、构图/镜头、画质等都可以补充。但如果用户已经给了详细 prompt，就尊重原意，不要过度改写。
- n（张数，1~4）：用户没说就生成 1 张；用户说"多来几张 / 给我 4 张"时再相应设置。
- size（尺寸）：如 1024x1024（默认 / 方图）、1792x1024（横版）、1024x1792（竖版）。按用户意图选，没特别要求就用默认。

注意：
- 生成的图片会由 SuperStudio 自动在对话里以缩略图展示并存入画廊。所以你最终回复里【不要】再贴 Markdown 图片链接或本地文件路径，简短说明你生成了什么即可。
- 如果生成失败且提示未配置生图模型 / 缺少 API Key，告诉用户去「设置 → 全局 → 模型」里配置生图提供商和模型后重试。
- 始终用中文回复。`,
    toolWhitelist: ['image_generate'],
    starterPrompts: [
      { label: '生成一张图', prompt: '帮我生成一张图片：' },
      { label: '生成 4 张', prompt: '帮我生成 4 张不同的图片：' }
    ],
    suggestedScenarios: ['chat']
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
