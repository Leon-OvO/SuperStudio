/**
 * General-purpose webpage opener backed by a single BrowserWindow.
 *
 * Distinct from [search-headless.ts](search-headless.ts), which only loads
 * search-engine SERPs in a NON-persistent in-memory partition (no cookies, no
 * fingerprint linkage). This service opens ARBITRARY URLs and uses a
 * PERSISTENT partition so a login the user performs once survives both the
 * idle teardown and an app restart.
 *
 * Resource model mirrors the scraper: ONE window, lazily created, reused
 * across calls, serialized by a mutex, and torn down after an idle window once
 * browsing stops. The window's default visibility follows the user's
 * `searchBrowserVisible` setting — BUT when a login wall is detected we force
 * it visible regardless, because the user has to interact with it to log in.
 */

import { BrowserWindow, session, Session, WebContents } from 'electron'

const NAV_TIMEOUT_MS = 20_000
/** Max time to wait for a client-rendered page (SPA) to paint its content
 *  after the initial load resolves. */
const SETTLE_TIMEOUT_MS = 8_000
/** Auto-scroll budget to trigger lazy-loaded content (comment sections,
 *  infinite feeds). Many sites (e.g. bilibili 评论区) only fetch this content
 *  once it scrolls into view, so we nudge the page down a few times before
 *  extracting. Cheap on static pages: scrollHeight stabilizes fast and we bail. */
const SCROLL_MAX_STEPS = 10
const SCROLL_STEP_WAIT_MS = 400
const SCROLL_BUDGET_MS = 5_000
/** Hard ceiling for the final extract round-trip. The extract JS has no internal
 *  timer (it's a one-shot DOM walk), so if executeJavaScript itself stalls (page
 *  mid-redirect, wedged renderer) only this outer race can free the agent. */
const EXTRACT_TIMEOUT_MS = 8_000
/** Destroy the shared window this long after the last call finishes. Longer
 *  than the scraper's because a browsing session is more likely to be followed
 *  by a "now look at this other page" within the same chat turn. */
const IDLE_CLOSE_MS = 30_000

export interface BrowseLink {
  text: string
  url: string
}

export interface BrowseResult {
  /** URL after any redirects. */
  finalUrl: string
  title: string
  /** Cleaned, truncated visible text of the page. */
  text: string
  links: BrowseLink[]
  /** True when the page appears to require login. The window has been forced
   *  visible so the user can sign in; the caller should ask the user to log in
   *  then retry. */
  needsLogin: boolean
  /** Human-readable hint shown when needsLogin is true. */
  loginHint?: string
}

// Singletons. Session is allocated once per run; window is lazy (constructing
// one before app.ready() throws).
let win: BrowserWindow | null = null
let browseSession: Session | null = null
let mutex: Promise<unknown> = Promise.resolve()
let idleTimer: NodeJS.Timeout | null = null

/** (Re)arm the idle timer that tears the window down once browsing stops. */
function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; closeBrowse() }, IDLE_CLOSE_MS)
  // Don't let the pending timer hold the event loop open at quit time.
  idleTimer.unref?.()
}

function getSession(): Session {
  if (!browseSession) {
    // PERSISTENT partition: cookies / localStorage survive across calls and
    // app restarts so a one-time login sticks. This is the deliberate
    // difference from the search scraper's in-memory partition.
    browseSession = session.fromPartition('persist:web-browse')
    browseSession.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    )
  }
  return browseSession
}

function ensureWindow(visible: boolean): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (visible && !win.isVisible()) win.showInactive()
    else if (!visible && win.isVisible()) win.hide()
    return win
  }
  win = new BrowserWindow({
    show: visible,
    width: 1280,
    height: 860,
    title: '网页浏览',
    webPreferences: {
      session: getSession(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // Deny popups: many pages fire window.open() for ads / sign-in; an
  // uncontrolled native window under our partition is undesirable. Most modern
  // login flows (incl. bilibili h5) happen in-page or via full redirect, so
  // this doesn't block the common case.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A renderer crash must not leave a zombie window that later trips
  // window-all-closed → app.quit().
  win.webContents.on('render-process-gone', () => { closeBrowse() })
  win.on('closed', () => { win = null })
  return win
}

/** Serialize page work on the shared window so two callers don't trample each
 *  other's navigation / DOM reads. */
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

/**
 * Run page JS but never let it hang the agent. Electron's executeJavaScript can
 * stall indefinitely when the page navigates/reloads mid-eval or the renderer
 * wedges (anti-bot interstitials, endless redirects — e.g. some 京东/电商 pages).
 * Because web_open runs as a tool the model is awaiting, such a stall freezes
 * the whole chat turn with no AGENT_DONE/ERROR ("一直加载中"). Racing against a
 * wall-clock timeout guarantees we always move on; the abandoned executeJavaScript
 * is harmless (the window is torn down on error / idle).
 */
function execJs<T>(wc: WebContents, js: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page script timed out (${timeoutMs}ms)`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([wc.executeJavaScript(js) as Promise<T>, timeout])
    .finally(() => { if (timer) clearTimeout(timer) })
}

// Injected AFTER navigation + settle to trigger lazy-loaded content (comment
// sections, infinite feeds). Scrolls to the bottom repeatedly until the page
// stops growing (2 stable polls), or the step/time budget is hit, then returns
// to the top so extracted text reads in natural order and the login-wall check
// sees the top of the page.
const SCROLL_JS = `
  new Promise(resolve => {
    const start = Date.now()
    let lastH = -1, stable = 0, i = 0
    const step = () => {
      try { window.scrollTo(0, document.documentElement.scrollHeight) } catch (e) {}
      const h = document.documentElement.scrollHeight
      if (h === lastH) { stable++ } else { stable = 0 }
      lastH = h
      i++
      if (stable >= 2 || i >= ${SCROLL_MAX_STEPS} || Date.now() - start > ${SCROLL_BUDGET_MS}) {
        try { window.scrollTo(0, 0) } catch (e) {}
        return setTimeout(() => resolve(true), 150)
      }
      setTimeout(step, ${SCROLL_STEP_WAIT_MS})
    }
    step()
  })
`

// Heuristics injected into the page to detect a login wall + scrape
// title/text/links in one round-trip. Pierces Shadow DOM: many Web Components
// (e.g. bilibili 评论区 <bili-comments>) render their content into a shadow
// root, which document.body.innerText and querySelectorAll do NOT traverse —
// so without this, that content is invisible to us.
const EXTRACT_JS = `(() => {
  const loginHostRe = /passport\\.|account[s]?\\.|\\blogin\\b|\\bsignin\\b|\\bsign-in\\b|\\/sso\\//i
  const href = location.href || ''

  // Every shadow root in the document, found recursively (a shadow root can
  // host further Web Components inside it).
  function allShadowRoots(root, acc) {
    let els
    try { els = root.querySelectorAll('*') } catch (e) { return acc }
    for (const el of els) {
      if (el.shadowRoot) { acc.push(el.shadowRoot); allShadowRoots(el.shadowRoot, acc) }
    }
    return acc
  }
  const shadowRoots = allShadowRoots(document, [])
  const roots = [document, ...shadowRoots]

  // A visible password field (anywhere, incl. shadow DOM) is the strongest
  // "you must log in" signal.
  let hasVisiblePassword = false
  for (const r of roots) {
    for (const el of r.querySelectorAll('input[type="password"]')) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) { hasVisiblePassword = true; break }
    }
    if (hasVisiblePassword) break
  }
  const urlLooksLogin = loginHostRe.test(href)

  // Text-node walker for shadow roots (innerText doesn't reach into them).
  // Skips non-rendered tags; <template> content lives in .content so its
  // childNodes are empty and it's naturally skipped.
  function shadowText(sr) {
    let out = ''
    const walk = (node) => {
      const nt = node.nodeType
      if (nt === 3) { out += node.nodeValue; return }
      if (nt !== 1) return
      const tag = node.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return
      if (node.shadowRoot) { for (const c of node.shadowRoot.childNodes) walk(c) }
      for (const c of node.childNodes) walk(c)
    }
    for (const c of sr.childNodes) walk(c)
    return out
  }
  const lightText = (document.body && document.body.innerText) ? document.body.innerText : ''
  const shadowTextStr = shadowRoots.map(shadowText).join('\\n')
  const rawText = lightText + (shadowTextStr ? '\\n' + shadowTextStr : '')

  // Login-WALL interstitial phrases. Deliberately NOT the bare word 登录 / login:
  // a nav-bar "登录" link is normal on pages that DON'T require login (e.g. a
  // public 热门/排行 page). These phrases ("登录后你可以…", "请先登录",
  // "需要登录", "sign in to view") only appear on an actual login wall — which
  // is how we catch sites (e.g. bilibili 个人动态) that gate content behind a
  // QR/popup login: no visible password field AND a non-login URL, so the two
  // signals above both miss them.
  const loginWallRe = /登录后(你|您)?可?以|请先?登录|请登录后|需要登录|登录后查看|登录以(继续|查看)|(log ?in|sign ?in) to (continue|view|see|read)|you (must|need to) (be )?(logged|signed) ?in|please (log|sign) ?in to/i
  const hasLoginWallPhrase = loginWallRe.test(rawText)

  const isLogin = hasVisiblePassword || urlLooksLogin || hasLoginWallPhrase

  const title = document.title || ''
  const text = rawText
    .replace(/[\\t\\f\\r ]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim()
    .slice(0, 6000)

  // Links across light + shadow trees.
  const seen = new Set()
  const links = []
  for (const r of roots) {
    for (const a of r.querySelectorAll('a[href]')) {
      const url = a.href || ''
      if (!/^https?:/i.test(url) || seen.has(url)) continue
      const t = (a.textContent || '').replace(/\\s+/g, ' ').trim()
      if (!t) continue
      seen.add(url)
      links.push({ text: t.slice(0, 120), url })
      if (links.length >= 60) break
    }
    if (links.length >= 60) break
  }
  return { isLogin, hasVisiblePassword, urlLooksLogin, hasLoginWallPhrase, finalUrl: href, title, text, links }
})()`

/**
 * Open a URL in the shared browser window and read its rendered content.
 * Detects login walls; on detection forces the window visible so the user can
 * sign in, and returns needsLogin=true (the caller should ask the user to log
 * in then call again).
 */
export async function openPage(
  url: string,
  opts: { browserVisible: boolean }
): Promise<BrowseResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`web_open 仅支持 http(s) 网址，收到：${url.slice(0, 120)}`)
  }

  // A call is starting — cancel any pending idle teardown.
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try {
    const result = await openOnce()
    // When the page needs login we deliberately do NOT arm the idle close:
    // the user has been asked to sign in inside this very window, and the
    // 30s timer would otherwise destroy it out from under them before they
    // finish (the reported "AI says it opened but I never saw the browser"
    // bug). The window stays up until the retry call reuses it, or app quit.
    if (!result.needsLogin) armIdleClose()
    return result
  } catch (e) {
    // On failure (esp. a timeout) the window may be wedged mid-redirect — tear
    // it down now so the next web_open gets a clean one instead of reusing a
    // stuck renderer and hanging again.
    closeBrowse()
    throw e
  }

  async function openOnce(): Promise<BrowseResult> {
    return withMutex(async () => {
      const w = ensureWindow(!!opts.browserVisible)
      const wc = w.webContents

      // 1. Navigate with a hard timeout. A client redirect aborts the first
      //    load with ERR_ABORTED — that's expected, not a failure.
      let navTimer: NodeJS.Timeout | undefined
      const navTimeout = new Promise<never>((_, reject) => {
        navTimer = setTimeout(
          () => reject(new Error(`页面加载超时 (${NAV_TIMEOUT_MS}ms)`)),
          NAV_TIMEOUT_MS
        )
      })
      try {
        await Promise.race([wc.loadURL(url), navTimeout])
      } catch (e) {
        const msg = (e as Error).message || String(e)
        // Redirects / user-driven nav cancel the in-flight load; keep going and
        // read whatever the window settled on.
        if (!/ERR_ABORTED|\(-3\)/i.test(msg)) {
          if (navTimer) clearTimeout(navTimer)
          throw new Error(`打开网页失败：${msg}`)
        }
      } finally {
        if (navTimer) clearTimeout(navTimer)
      }

      // 2. Wait for a client-rendered page to paint. Resolve once innerText
      //    stops growing for two consecutive polls, or on a hard timeout.
      const settleJs = `
        new Promise(resolve => {
          const done = () => resolve(true)
          const start = Date.now()
          let last = -1, stable = 0
          const tick = () => {
            const ready = document.readyState === 'complete'
            const len = document.body ? document.body.innerText.length : 0
            if (ready && len > 0 && len === last) {
              if (++stable >= 2) return done()
            } else {
              stable = 0
            }
            last = len
            if (Date.now() - start > ${SETTLE_TIMEOUT_MS}) return done()
            setTimeout(tick, 250)
          }
          tick()
        })
      `
      // Best-effort + bounded: settle has an internal 8s timer, but the outer
      // race protects against executeJavaScript itself never resolving.
      try { await execJs(wc, settleJs, SETTLE_TIMEOUT_MS + 4_000) } catch { /* best-effort */ }

      // 2b. Nudge lazy-loaded content (comment sections, infinite feeds) into
      //     existence by scrolling, then the shadow-DOM-aware extract below can
      //     read content rendered into Web Components (e.g. bilibili 评论区).
      try { await execJs(wc, SCROLL_JS, SCROLL_BUDGET_MS + 4_000) } catch { /* best-effort */ }

      // 3. Detect login + extract in one round-trip. If even this times out we
      //    have no content to return, so surface a clear, actionable error
      //    instead of hanging the agent forever.
      type ExtractResult = {
        isLogin: boolean
        finalUrl: string
        title: string
        text: string
        links: BrowseLink[]
      }
      let raw: ExtractResult
      try {
        raw = await execJs<ExtractResult>(wc, EXTRACT_JS, EXTRACT_TIMEOUT_MS)
      } catch {
        throw new Error(`读取页面内容超时，该页面可能在持续跳转或触发了反爬拦截：${url.slice(0, 120)}`)
      }

      if (raw.isLogin) {
        // Force the window to the FOREGROUND regardless of the hidden setting —
        // the user must see it to log in. On Windows show()+focus() alone often
        // fails to steal foreground from the main app window, leaving the login
        // window buried behind it (looks like "nothing opened"). Briefly pinning
        // always-on-top reliably surfaces it; we drop the pin shortly after.
        try {
          if (w.isMinimized()) w.restore()
          w.show()
          w.moveTop()
          w.setAlwaysOnTop(true)
          w.focus()
          setTimeout(() => { try { if (!w.isDestroyed()) w.setAlwaysOnTop(false) } catch { /* gone */ } }, 1500)
        } catch { /* window may have been torn down concurrently */ }
        return {
          finalUrl: raw.finalUrl || url,
          title: raw.title || '',
          text: raw.text || '',
          links: raw.links || [],
          needsLogin: true,
          loginHint: '该页面需要登录。浏览器窗口已弹出，请在其中完成登录后重试。'
        }
      }

      return {
        finalUrl: raw.finalUrl || url,
        title: raw.title || '',
        text: raw.text || '',
        links: raw.links || [],
        needsLogin: false
      }
    })
  }
}

export function closeBrowse(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try { if (win && !win.isDestroyed()) win.destroy() } catch { /* swallow */ }
  win = null
}
