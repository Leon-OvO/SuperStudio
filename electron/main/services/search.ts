import { net } from 'electron'
import { scrapeEngine, HeadlessEngine } from './search-headless'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
  /** Which backend actually answered. Useful when a fallback kicked in so the
   *  caller (and the LLM in tool output) can tell where the results came from. */
  source: SearchProvider | 'none'
  /** Set when the configured provider failed and we silently fell back. */
  fallbackReason?: string
}

export type SearchProvider =
  | 'tavily' | 'serper' | 'searxng'  // hosted / self-hosted, need config
  | 'bing' | 'baidu' | 'sogou' | 'ddg' | 'google'  // headless scraped, zero-config

/**
 * Proxy-aware fetch. Node's global `fetch` (undici) ignores the system proxy,
 * so Windows users behind Clash/V2Ray/corporate proxies see bare "fetch failed"
 * even though the browser works fine. Electron's `net.fetch` delegates to
 * Chromium's URL loader, which honours system proxy / PAC / Electron session
 * proxy out of the box.
 *
 * We also unwrap the inner `cause` so callers can show ENOTFOUND / ETIMEDOUT /
 * ECONNRESET instead of the useless top-level "fetch failed".
 */
async function httpFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, init as never)
  } catch (e) {
    throw new Error(explainFetchError(e))
  }
}

const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: 'DNS 解析失败，可能未联网或目标域名被屏蔽（试着开启系统代理）',
  ECONNREFUSED: '目标拒绝连接',
  ECONNRESET: '连接被重置（可能被代理或防火墙拦截）',
  ETIMEDOUT: '连接超时（可能需要配置系统代理）',
  UND_ERR_SOCKET: '连接被对端关闭',
  CERT_HAS_EXPIRED: '目标证书已过期',
  ERR_PROXY_CONNECTION_FAILED: '代理连接失败',
  ERR_NAME_NOT_RESOLVED: 'DNS 解析失败（试着开启系统代理）',
  ERR_INTERNET_DISCONNECTED: '当前未联网',
  ERR_TIMED_OUT: '连接超时（可能需要配置系统代理）',
  ERR_CONNECTION_RESET: '连接被重置（可能被代理或防火墙拦截）'
}

function explainFetchError(e: unknown): string {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } }
  const code = err.cause?.code || err.code
  const innerMsg = err.cause?.message || err.message || ''
  if (code) {
    const hint = NETWORK_HINTS[code]
    return hint ? `${code}（${hint}）` : `${code}${innerMsg ? ' ' + innerMsg : ''}`
  }
  return innerMsg || String(e)
}

/**
 * Run a web search across the supported providers.
 *
 * Provider matrix:
 *  - tavily / serper: hosted, need an API key.
 *  - searxng: self-hosted JSON endpoint at `${searxngUrl}/search?format=json`.
 *  - bing / baidu / sogou / ddg: scraped via a hidden Chromium window
 *    ([search-headless.ts](search-headless.ts)). Zero config, but slower
 *    (~1–3s) and subject to per-engine layout drift / anti-bot.
 *
 * Cascade: try the chosen provider; if it fails or returns nothing, fall
 * through the zero-config scrapers in order `bing → baidu → ddg → sogou`,
 * skipping the one we just tried. Each attempt's failure reason is collected
 * into `fallbackReason` so the LLM (and the user) can see why we ended up
 * where we did.
 */
export async function searchWeb(
  query: string,
  apiKey: string,
  provider: SearchProvider,
  maxResults: number = 5,
  opts?: { searxngUrl?: string; browserVisible?: boolean }
): Promise<SearchResponse> {
  const n = Math.max(1, Math.min(20, Math.floor(maxResults) || 5))
  const reasons: string[] = []
  const tried = new Set<SearchProvider>()

  // Primary: the user's chosen provider.
  const primary = await tryProvider(provider, query, apiKey, n, opts)
  tried.add(provider)
  if (primary.ok) return primary.response
  reasons.push(`${provider}: ${primary.reason}`)

  // Cascade through zero-config scrapers in priority order.
  const cascade: HeadlessEngine[] = ['bing', 'baidu', 'ddg', 'sogou']
  for (const eng of cascade) {
    if (tried.has(eng)) continue
    tried.add(eng)
    const r = await tryScrape(eng, query, n, opts)
    if (r.ok && r.response.results.length > 0) {
      return { ...r.response, fallbackReason: reasons.join('; ') }
    }
    reasons.push(r.ok ? `${eng}: 返回 0 条结果` : `${eng}: ${r.reason}`)
  }

  return {
    query, source: 'none', results: [],
    fallbackReason: reasons.join('; ') || '所有搜索引擎都不可用'
  }
}

type Attempt =
  | { ok: true; response: SearchResponse }
  | { ok: false; reason: string }

async function tryProvider(
  provider: SearchProvider,
  query: string, apiKey: string, n: number,
  opts?: { searxngUrl?: string; browserVisible?: boolean }
): Promise<Attempt> {
  try {
    if (provider === 'tavily') {
      if (!apiKey) return { ok: false, reason: 'Tavily key 未配置' }
      const r = await searchTavily(query, apiKey, n)
      return r.results.length > 0
        ? { ok: true, response: r }
        : { ok: false, reason: '返回 0 条结果' }
    }
    if (provider === 'serper') {
      if (!apiKey) return { ok: false, reason: 'Serper key 未配置' }
      const r = await searchSerper(query, apiKey, n)
      return r.results.length > 0
        ? { ok: true, response: r }
        : { ok: false, reason: '返回 0 条结果' }
    }
    if (provider === 'searxng') {
      const url = (opts?.searxngUrl || '').trim()
      if (!url) return { ok: false, reason: 'SearXNG 实例地址未配置' }
      const r = await searchSearxng(query, url, n)
      return r.results.length > 0
        ? { ok: true, response: r }
        : { ok: false, reason: '返回 0 条结果' }
    }
    // Headless engines
    return await tryScrape(provider as HeadlessEngine, query, n, opts)
  } catch (e) {
    return { ok: false, reason: (e as Error).message || String(e) }
  }
}

async function tryScrape(
  engine: HeadlessEngine, query: string, n: number,
  opts?: { browserVisible?: boolean }
): Promise<Attempt> {
  try {
    const results = await scrapeEngine(engine, query, n, { visible: opts?.browserVisible })
    return { ok: true, response: { query, source: engine, results } }
  } catch (e) {
    return { ok: false, reason: (e as Error).message || String(e) }
  }
}

// --- Hosted providers (HTTP only) --------------------------------------

async function searchTavily(query: string, apiKey: string, maxResults: number): Promise<SearchResponse> {
  const res = await httpFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults })
  })
  if (!res.ok) throw new Error(`Tavily ${res.status} ${res.statusText}`)
  const data = await res.json() as { results?: Array<{ title: string; url: string; content: string }> }
  return {
    query,
    source: 'tavily',
    results: (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 300) || ''
    }))
  }
}

async function searchSerper(query: string, apiKey: string, maxResults: number): Promise<SearchResponse> {
  const res = await httpFetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: maxResults })
  })
  if (!res.ok) throw new Error(`Serper ${res.status} ${res.statusText}`)
  const data = await res.json() as { organic?: Array<{ title: string; link: string; snippet: string }> }
  return {
    query,
    source: 'serper',
    results: (data.organic || []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet || ''
    }))
  }
}

/**
 * SearXNG JSON API. Many public instances disable `format=json`; if the user
 * picks this provider, point them at their own instance or a known-permissive
 * one. Returns whatever the instance gives us.
 */
async function searchSearxng(query: string, baseUrl: string, maxResults: number): Promise<SearchResponse> {
  const url = baseUrl.replace(/\/+$/, '') + '/search?format=json&q=' + encodeURIComponent(query)
  const res = await httpFetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      // Some instances 403 generic UAs.
      'User-Agent': 'Mozilla/5.0 SuperStudio'
    }
  })
  if (!res.ok) throw new Error(`SearXNG ${res.status} ${res.statusText}`)
  const data = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> }
  return {
    query,
    source: 'searxng',
    results: (data.results || []).slice(0, maxResults).map(r => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.content?.slice(0, 300) || ''
    }))
  }
}

export { closeScraper } from './search-headless'
