/**
 * Headless search-engine scraper backed by a single hidden BrowserWindow.
 *
 * Why a real Chromium window instead of bare HTTP fetches?
 *  - Engines now return JS-rendered shells (Bing in particular). A static
 *    fetch sees an empty page; a Chromium window runs the rendering JS.
 *  - Engines also gate scrapers behind UA / cookie / referer / TLS fingerprint
 *    checks. Going through Chromium's network stack means we look identical
 *    to a normal browser session.
 *  - Bonus: respects the user's system proxy automatically — same reason we
 *    switched the HTTP path to electron.net.fetch.
 *
 * Resource model: ONE window, lazily created on first call, reused across
 * queries (a fresh Chromium process is ~150ms + ~30 MB; we don't want that
 * per search). A mutex serializes queries on the shared window so two callers
 * don't trample each other's page state. The window is destroyed on app quit
 * via closeScraper().
 *
 * Session isolation: the scraper uses its own in-memory partition so cookies
 * and localStorage from search engines don't leak into the user's main
 * session (no profile pollution, no fingerprint linkage).
 */

import { BrowserWindow, session, Session } from 'electron'
import type { SearchResult } from './search'

const NAV_TIMEOUT_MS = 12_000
const SELECTOR_TIMEOUT_MS = 8_000
/** Destroy the shared scraper window this long after the last query finishes.
 *  Keeps it warm during a burst of searches (a chat turn or a scheduled task
 *  doing several lookups) but stops it lingering as a stray window once work is
 *  done — otherwise a scheduled run leaves a (sometimes visible) "调试窗口"
 *  open and the live window entangles with window-all-closed → app.quit(). */
const IDLE_CLOSE_MS = 15_000

export type HeadlessEngine = 'bing' | 'baidu' | 'sogou' | 'ddg' | 'google'

interface EngineConfig {
  url: (q: string) => string
  /** CSS selector polled to know "results have rendered". */
  waitFor: string
  /** JS run inside the page; MUST evaluate to Array<{title,url,snippet}>. */
  extract: string
}

/**
 * Per-engine config. The extractors are intentionally tolerant: search engines
 * A/B-test layout regularly, so each one looks at a small union of selectors
 * that have been stable across recent revisions. If an engine breaks, only its
 * stanza here needs updating.
 */
const ENGINES: Record<HeadlessEngine, EngineConfig> = {
  bing: {
    url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`,
    waitFor: '#b_results',
    extract: `(() => {
      const out = []
      document.querySelectorAll('#b_results > li.b_algo').forEach(li => {
        const a = li.querySelector('h2 > a')
        if (!a) return
        const title = (a.textContent || '').trim()
        const href = a.getAttribute('href') || ''
        const snipEl = li.querySelector('.b_caption p, .b_lineclamp4, .b_lineclamp3, .b_lineclamp2, .b_lineclamp1, .b_paractl')
        const snippet = snipEl ? (snipEl.textContent || '').trim() : ''
        if (title && href && /^https?:/.test(href)) out.push({ title, url: href, snippet })
      })
      return out
    })()`
  },
  baidu: {
    url: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&ie=utf-8`,
    waitFor: '#content_left',
    extract: `(() => {
      const out = []
      document.querySelectorAll('#content_left > div.result, #content_left > div.result-op, #content_left > div.c-container').forEach(div => {
        const titleEl = div.querySelector('h3 a, .t a')
        if (!titleEl) return
        const title = (titleEl.textContent || '').trim()
        // Baidu wraps the real URL but exposes it via the 'mu' attribute on
        // the result container; fall back to the redirect href if absent.
        const url = div.getAttribute('mu') || titleEl.getAttribute('href') || ''
        const snipEl = div.querySelector('[class*="content-right_"], .c-abstract, [class*="abs_"], .c-row, .c-span-last')
        const snippet = snipEl ? (snipEl.textContent || '').trim() : ''
        if (title && url) out.push({ title, url, snippet })
      })
      return out
    })()`
  },
  sogou: {
    url: q => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    waitFor: '.results, #main',
    extract: `(() => {
      const out = []
      document.querySelectorAll('.results .vrwrap, .results .rb, .results > div').forEach(div => {
        const titleEl = div.querySelector('h3 a, .vr-title a, .vrTitle a')
        if (!titleEl) return
        const title = (titleEl.textContent || '').trim()
        const url = titleEl.getAttribute('data-url') || titleEl.getAttribute('href') || ''
        const snipEl = div.querySelector('.fz-mid, .star-wiki, .text-layout, .ft, .str-info, .str-text-info')
        const snippet = snipEl ? (snipEl.textContent || '').trim() : ''
        if (title && url) out.push({ title, url, snippet })
      })
      return out
    })()`
  },
  google: {
    url: q => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=zh-CN&num=10`,
    // #search appears once the SERP renders; a CAPTCHA / consent interstitial
    // never produces it, so we time out and the caller cascades to a free engine.
    waitFor: '#search, #rso',
    extract: `(() => {
      const out = []
      const seen = new Set()
      document.querySelectorAll('#search a h3, #rso a h3').forEach(h3 => {
        const a = h3.closest('a')
        if (!a) return
        const url = a.getAttribute('href') || ''
        if (!/^https?:/.test(url) || seen.has(url)) return
        const title = (h3.textContent || '').trim()
        const container = a.closest('div.g, div[data-hveid]') || a.parentElement
        let snippet = ''
        if (container) {
          const s = container.querySelector('.VwiC3b, div[data-sncf], [data-snf], .lEBKkf')
          snippet = s ? (s.textContent || '').trim() : ''
        }
        if (title) { seen.add(url); out.push({ title, url, snippet }) }
      })
      return out
    })()`
  },
  ddg: {
    url: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&kl=wt-wt&kp=-2`,
    waitFor: '[data-testid="result"], #links, .results',
    extract: `(() => {
      const out = []
      const blocks = document.querySelectorAll('[data-testid="result"], article[data-testid="result"], .results .result, #links .result')
      blocks.forEach(div => {
        const titleEl = div.querySelector('[data-testid="result-title-a"], h2 a, .result__a')
        if (!titleEl) return
        const title = (titleEl.textContent || '').trim()
        const url = titleEl.getAttribute('href') || ''
        const snipEl = div.querySelector('[data-result="snippet"], [data-testid="result-snippet"], .result__snippet')
        const snippet = snipEl ? (snipEl.textContent || '').trim() : ''
        if (title && url && /^https?:/.test(url)) out.push({ title, url, snippet })
      })
      return out
    })()`
  }
}

// Singletons. The session is allocated once per app run; the window is lazy
// because constructing one before app.ready() throws.
let win: BrowserWindow | null = null
let scrapeSession: Session | null = null
let mutex: Promise<unknown> = Promise.resolve()
let idleTimer: NodeJS.Timeout | null = null

/** (Re)arm the idle timer that tears the window down once searches stop. */
function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; closeScraper() }, IDLE_CLOSE_MS)
  // Don't let the pending timer hold the event loop open at quit time.
  idleTimer.unref?.()
}

function getSession(): Session {
  if (!scrapeSession) {
    // Non-persist partition: cookies live only in-memory for this process,
    // so search activity doesn't leak across app launches.
    scrapeSession = session.fromPartition('search-scraper')
    scrapeSession.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    )
  }
  return scrapeSession
}

function ensureWindow(visible: boolean): BrowserWindow {
  if (win && !win.isDestroyed()) {
    // Visibility can be toggled at runtime via the setting — keep the live
    // window in sync without rebuilding it.
    if (visible && !win.isVisible()) win.showInactive()
    else if (!visible && win.isVisible()) win.hide()
    return win
  }
  win = new BrowserWindow({
    show: visible,
    width: 1280,
    height: 800,
    title: '搜索引擎抓取（调试窗口）',
    webPreferences: {
      session: getSession(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Default behaviour is fine; we intentionally don't disable images,
      // because some engines key result-rendering off image-load events.
      backgroundThrottling: false
    }
  })
  // Scrapers never legitimately open popups; Google in particular fires
  // window.open() for sign-in / consent flows. Without this the popup would
  // spawn an uncontrolled native window under the scraper's partition.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A renderer crash on a hostile page (heavy JS, consent walls) must not leave
  // a zombie window behind that later trips window-all-closed → app.quit().
  win.webContents.on('render-process-gone', () => { closeScraper() })
  win.on('closed', () => { win = null })
  return win
}

/**
 * Serialize page work on the shared window. Without this, a second concurrent
 * search would call loadURL() before the first finished extracting and trash
 * the first caller's DOM read.
 */
async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutex
  let release: (v?: unknown) => void = () => {}
  mutex = new Promise(r => { release = r })
  try { await prev } catch { /* prior failure shouldn't block us */ }
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function scrapeEngine(
  engineId: HeadlessEngine,
  query: string,
  maxResults: number,
  opts?: { visible?: boolean }
): Promise<SearchResult[]> {
  const cfg = ENGINES[engineId]
  if (!cfg) throw new Error(`Unknown engine: ${engineId}`)

  // A query is starting — cancel any pending idle teardown so the window stays
  // alive for it, and re-arm once we're done (success or failure).
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try {
    return await scrapeOnce()
  } finally {
    armIdleClose()
  }

  async function scrapeOnce(): Promise<SearchResult[]> {
   return withMutex(async () => {
    const w = ensureWindow(!!opts?.visible)
    const wc = w.webContents

    // 1. Navigate, with hard timeout. loadURL resolves on did-finish-load,
    //    which is "DOM + initial subresources" — usually before JS-rendered
    //    result blocks land, which is why we still wait for the selector.
    const targetUrl = cfg.url(query)
    let navTimer: NodeJS.Timeout | undefined
    const navTimeout = new Promise<never>((_, reject) => {
      navTimer = setTimeout(
        () => reject(new Error(`页面加载超时 (${NAV_TIMEOUT_MS}ms)`)),
        NAV_TIMEOUT_MS
      )
    })
    try {
      await Promise.race([wc.loadURL(targetUrl), navTimeout])
    } finally {
      if (navTimer) clearTimeout(navTimer)
    }

    // 2. Wait until results render. Polling in-page is cheaper than racing
    //    multiple did-* events and works uniformly across engines.
    const waitJs = `
      new Promise(resolve => {
        const sel = ${JSON.stringify(cfg.waitFor)}
        const has = () => sel.split(',').some(s => document.querySelector(s.trim()))
        if (has()) { resolve(true); return }
        const start = Date.now()
        const iv = setInterval(() => {
          if (has()) { clearInterval(iv); resolve(true) }
          else if (Date.now() - start > ${SELECTOR_TIMEOUT_MS}) { clearInterval(iv); resolve(false) }
        }, 120)
      })
    `
    const found = await wc.executeJavaScript(waitJs)
    if (!found) {
      throw new Error(
        `结果元素 ${cfg.waitFor} ${SELECTOR_TIMEOUT_MS}ms 内未出现（可能被引擎拦截或网络受限）`
      )
    }

    // 3. Extract.
    const raw = await wc.executeJavaScript(cfg.extract) as Array<{
      title: string; url: string; snippet: string
    }>

    // 4. Clean + dedupe + cap. Truncate strings so a malicious page can't
    //    blow up the message we hand back to the LLM.
    const seen = new Set<string>()
    const out: SearchResult[] = []
    for (const r of raw) {
      if (!r?.title || !r?.url) continue
      const url = r.url.trim()
      if (seen.has(url)) continue
      seen.add(url)
      out.push({
        title: r.title.replace(/\s+/g, ' ').trim().slice(0, 200),
        url,
        snippet: (r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      })
      if (out.length >= maxResults) break
    }
    return out
   })
  }
}

export function closeScraper(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try { if (win && !win.isDestroyed()) win.destroy() } catch { /* swallow */ }
  win = null
}
