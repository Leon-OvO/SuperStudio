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

import { BrowserWindow, session, Session, WebContents, shell } from 'electron'
import fs from 'fs'

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
/** Snapshot does far more than a one-shot extract — it getComputedStyle's its way
 *  across every interactive element in light + shadow DOM, in multiple phases.
 *  On heavy creator SPAs (小红书 / 掘金 / 语雀) 8s was occasionally too tight and
 *  the whole snapshot timed out, returning zero elements and stalling the agent.
 *  Give it a wider ceiling; the inner work still finishes well under this. */
const SNAPSHOT_TIMEOUT_MS = 15_000
/** Destroy the shared window this long after the last call finishes. Longer
 *  than the scraper's because a browsing session is more likely to be followed
 *  by a "now look at this other page" within the same chat turn. */
const IDLE_CLOSE_MS = 30_000
/** Longer idle window kept alive between automation ops (snapshot / click /
 *  fill / upload). These calls happen across LLM thinking turns, so the 30s
 *  read-idle would tear the window down mid-task; 3 min spans a normal
 *  multi-step fill/submit flow without pinning the window forever. */
const OP_IDLE_CLOSE_MS = 3 * 60_000

// --- Login-wait cadence (used when a login wall is hit in interactive mode) ---
/** How often we poll the in-page flags (button click / overlay state). Cheap
 *  in-process DOM reads — costs ZERO LLM tokens (the whole wait is one tool
 *  call; the model only sees the final result). Kept tight so the injected
 *  「我已登录完成」button feels near-instant. */
const LOGIN_BTN_POLL_MS = 1_000
/** Silent fallback for users who finish logging in but never click the button:
 *  re-run the (heavier) login-wall detection on the CURRENT page this often. */
const LOGIN_AUTO_POLL_MS = 30_000
/** Max silent auto-detects before we give up and nag the user with an overlay. */
const LOGIN_AUTO_POLL_MAX = 3
/** Hard ceiling on the whole wait so a walked-away user can't pin the window
 *  (and the mutex) open forever — past this we fall back to needsLogin:true. */
const LOGIN_TOTAL_BUDGET_MS = 10 * 60_000

const delay = (ms: number): Promise<void> =>
  new Promise(r => { const t = setTimeout(r, ms); t.unref?.() })

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
function armIdleClose(ms: number = IDLE_CLOSE_MS): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idleTimer = null; closeBrowse() }, ms)
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
  // Re-inject the SuperStudio chrome bar after every navigation (dom-ready wipes
  // the previous page's DOM). Best-effort: a failed inject must never block load.
  win.webContents.on('dom-ready', () => {
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(CHROME_JS).catch(() => {})
  })
  // Page→main channel for the chrome bar's open-external / close buttons. The
  // window has no preload, so the injected handlers signal via console.log with
  // a `__ss_chrome::` prefix; everything else is ignored.
  win.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message !== 'string') return
    const PFX = '__ss_chrome::open_external::'
    if (message.startsWith(PFX)) {
      const u = message.slice(PFX.length)
      if (/^https?:\/\//i.test(u)) shell.openExternal(u).catch(() => {})
    } else if (message === '__ss_chrome::close') {
      closeBrowse()
    }
  })
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
      // Skip SuperStudio-injected chrome so the bar's text / hostname don't
      // bleed into the scraped page content.
      if (el.id && el.id.indexOf('__ss') === 0) continue
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

type ExtractResult = {
  isLogin: boolean
  finalUrl: string
  title: string
  text: string
  links: BrowseLink[]
}

// Injected into the login-wall page. Idempotently installs a floating
// 「我已登录完成，继续」button (the PRIMARY, instant path: the user clicks it the
// moment they finish signing in) plus a hidden full-screen reminder overlay we
// only reveal after silent auto-detection gives up. Returns the live flags so
// the main-process loop can react. Re-installs itself after a navigation wipes
// the page (full-redirect logins), self-healing the flags across page loads.
const LOGIN_POLL_JS = `(() => {
  function install() {
    if (window.__ssLoginHelperInstalled) return
    window.__ssLoginHelperInstalled = true
    window.__ssLogin = { done: false }
    const root = document.documentElement
    const btn = document.createElement('button')
    btn.id = '__ss_login_btn'
    btn.innerHTML = '<span style="display:inline-flex;width:20px;height:20px;border-radius:6px;'
      + 'background:rgba(255,255,255,.22);align-items:center;justify-content:center;font-size:12px;">\\u2726</span>'
      + '<span>我已登录完成，继续</span>'
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', gap: '9px',
      padding: '12px 18px', background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
      color: '#fff', border: 'none', borderRadius: '12px', fontSize: '15px',
      fontWeight: '600', cursor: 'pointer', boxShadow: '0 8px 24px rgba(79,70,229,.45)',
      fontFamily: 'system-ui,-apple-system,"Segoe UI",sans-serif'
    })
    btn.onclick = () => {
      window.__ssLogin.done = true
      btn.innerHTML = '<span>正在继续…</span>'
      btn.disabled = true
      btn.style.opacity = '.7'
    }
    root.appendChild(btn)
    const ov = document.createElement('div')
    ov.id = '__ss_login_overlay'
    Object.assign(ov.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', display: 'none',
      alignItems: 'center', justifyContent: 'center',
      background: 'rgba(17,17,30,.55)', backdropFilter: 'blur(2px)',
      fontFamily: 'system-ui,-apple-system,"Segoe UI",sans-serif'
    })
    const card = document.createElement('div')
    Object.assign(card.style, {
      background: '#fff', color: '#111', padding: '26px 30px', borderRadius: '16px',
      maxWidth: '420px', textAlign: 'center', fontSize: '15px', lineHeight: '1.6',
      boxShadow: '0 20px 60px rgba(17,17,30,.4)', border: '1px solid rgba(0,0,0,.05)'
    })
    card.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:12px;">'
      + '<span style="display:inline-flex;width:30px;height:30px;border-radius:9px;'
      + 'background:linear-gradient(135deg,#6366f1,#4f46e5);align-items:center;justify-content:center;'
      + 'color:#fff;font-size:16px;box-shadow:0 3px 10px rgba(79,70,229,.4);">\\u2726</span>'
      + '<span style="font-size:18px;font-weight:700;">请尽快完成登录</span></div>'
      + '<div style="color:#4b5563;">检测到此页面仍需登录。请在本窗口完成登录后，点击右下角「我已登录完成，继续」按钮。</div>'
    const close = document.createElement('button')
    close.textContent = '我知道了，继续等待'
    Object.assign(close.style, {
      marginTop: '20px', padding: '10px 20px',
      background: 'linear-gradient(135deg,#6366f1,#4f46e5)', color: '#fff',
      border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600',
      cursor: 'pointer', boxShadow: '0 6px 18px rgba(79,70,229,.4)'
    })
    close.onclick = () => { ov.style.display = 'none' }
    card.appendChild(close)
    ov.appendChild(card)
    root.appendChild(ov)
    window.__ssShowOverlay = () => {
      const o = document.getElementById('__ss_login_overlay')
      if (o) o.style.display = 'flex'
    }
  }
  install()
  const o = document.getElementById('__ss_login_overlay')
  return JSON.stringify({
    done: !!(window.__ssLogin && window.__ssLogin.done),
    overlayVisible: !!(o && o.style.display !== 'none')
  })
})()`

const SHOW_OVERLAY_JS = `(() => { if (window.__ssShowOverlay) window.__ssShowOverlay() })()`

// SuperStudio-branded chrome injected on every page load (dom-ready) so the
// shared browse window stops looking like a bare Chromium frame. A fixed 44px
// top bar carries the brand mark, a click-to-copy URL pill, and refresh /
// open-in-system-browser / close actions. Built inside a Shadow root attached to
// an `all:initial` host so page CSS can't bleed into it (or vice-versa), and the
// host id is `__ss_chrome_host` so SNAPSHOT_JS / EXTRACT_JS skip it (otherwise
// the automation snapshot would surface our own buttons as click candidates and
// the scraper would fold the bar text into page content).
//
// Page→main actions ride the console channel (open_external / close) because the
// window has no preload to expose IPC; ensureWindow() listens for the
// `__ss_chrome::` sentinels. Refresh + copy are pure in-page, no round-trip.
const CHROME_BAR_H = 44
const CHROME_JS = `(() => {
  try {
    var HOST_ID = '__ss_chrome_host'
    var BAR_H = ${CHROME_BAR_H}
    // Deliberately a pure fixed OVERLAY — we do NOT push page content down. A
    // margin/padding offset clips the bottom BAR_H px of full-height
    // (100vh + overflow:hidden) creator SPAs, which is exactly where the publish
    // button lives — that would break web automation. Covering the top BAR_H px
    // of a page's own header is purely cosmetic and never blocks interaction.
    // Fresh DOM on every dom-ready, so the host normally won't exist. If it does
    // (redundant call on the same page) just bail.
    if (document.getElementById(HOST_ID)) return

    var host = document.createElement('div')
    host.id = HOST_ID
    Object.assign(host.style, {
      all: 'initial', position: 'fixed', top: '0', left: '0', right: '0',
      height: BAR_H + 'px', zIndex: '2147483600'
    })
    var sr = host.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = '.btn{transition:background .15s,color .15s}.btn:hover{background:#eef0f3;color:#111827}.btn.close:hover{background:#fee2e2;color:#dc2626}.url:hover{background:#e9ebef !important}.toast{opacity:0;transition:opacity .2s}.toast.show{opacity:1}'
    sr.appendChild(style)

    var bar = document.createElement('div')
    Object.assign(bar.style, {
      position: 'fixed', top: '0', left: '0', right: '0', height: BAR_H + 'px',
      display: 'flex', alignItems: 'center', gap: '10px', padding: '0 12px',
      boxSizing: 'border-box', background: '#ffffff',
      borderBottom: '1px solid rgba(0,0,0,.08)', boxShadow: '0 1px 3px rgba(0,0,0,.06)',
      fontFamily: 'system-ui,-apple-system,"Segoe UI",sans-serif'
    })

    var brand = document.createElement('div')
    Object.assign(brand.style, { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: '0' })
    var logo = document.createElement('div')
    Object.assign(logo.style, {
      width: '24px', height: '24px', borderRadius: '7px',
      background: 'linear-gradient(135deg,#6366f1,#4f46e5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '14px',
      boxShadow: '0 2px 6px rgba(79,70,229,.4)'
    })
    logo.textContent = '\\u2726'
    var name = document.createElement('div')
    Object.assign(name.style, { fontSize: '13px', fontWeight: '600', color: '#1e1e2e', letterSpacing: '.2px', whiteSpace: 'nowrap' })
    name.textContent = 'SuperStudio'
    brand.appendChild(logo); brand.appendChild(name)

    var urlEl = document.createElement('div')
    urlEl.className = 'url'
    Object.assign(urlEl.style, {
      flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '6px',
      height: '28px', padding: '0 12px', background: '#f3f4f6',
      border: '1px solid rgba(0,0,0,.05)', borderRadius: '8px', cursor: 'pointer'
    })
    var lock = document.createElement('span')
    Object.assign(lock.style, { fontSize: '11px', flexShrink: '0', lineHeight: '1' })
    var hostText = document.createElement('span')
    Object.assign(hostText.style, {
      fontSize: '12.5px', color: '#374151', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis'
    })
    urlEl.appendChild(lock); urlEl.appendChild(hostText)

    var ICON_RELOAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>'
    var ICON_EXT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>'
    var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

    var actions = document.createElement('div')
    Object.assign(actions.style, { display: 'flex', alignItems: 'center', gap: '2px', flexShrink: '0' })
    function mkBtn(cls, html, title, onClick) {
      var b = document.createElement('button')
      b.className = 'btn' + (cls ? ' ' + cls : '')
      b.innerHTML = html
      b.title = title
      Object.assign(b.style, {
        width: '30px', height: '30px', border: 'none', background: 'transparent',
        borderRadius: '7px', color: '#4b5563', cursor: 'pointer', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '0'
      })
      b.onclick = onClick
      return b
    }
    actions.appendChild(mkBtn('', ICON_RELOAD, '刷新', function () { try { location.reload() } catch (e) {} }))
    actions.appendChild(mkBtn('', ICON_EXT, '在系统浏览器中打开', function () { try { console.log('__ss_chrome::open_external::' + location.href) } catch (e) {} }))
    actions.appendChild(mkBtn('close', ICON_CLOSE, '关闭浏览器', function () { try { console.log('__ss_chrome::close') } catch (e) {} }))

    bar.appendChild(brand); bar.appendChild(urlEl); bar.appendChild(actions)
    sr.appendChild(bar)

    var toast = document.createElement('div')
    toast.className = 'toast'
    Object.assign(toast.style, {
      position: 'fixed', top: '50px', left: '50%', transform: 'translateX(-50%)',
      background: '#1e1e2e', color: '#fff', fontSize: '12px', padding: '6px 12px',
      borderRadius: '8px', pointerEvents: 'none', zIndex: '2147483601'
    })
    sr.appendChild(toast)
    var toastTimer = null
    function showToast(msg) {
      toast.textContent = msg
      toast.classList.add('show')
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(function () { toast.classList.remove('show') }, 1400)
    }
    urlEl.onclick = function () {
      try { navigator.clipboard.writeText(location.href) } catch (e) {}
      showToast('已复制网址')
    }

    function updateUrl() {
      try {
        var isHttps = location.protocol === 'https:'
        lock.textContent = isHttps ? '\\uD83D\\uDD12' : '\\u26A0\\uFE0F'
        lock.style.color = isHttps ? '#16a34a' : '#d97706'
        hostText.textContent = location.host + (location.pathname && location.pathname !== '/' ? location.pathname : '')
        urlEl.title = location.href + '（点击复制）'
      } catch (e) {}
    }
    updateUrl()

    document.documentElement.appendChild(host)

    // SPA route changes don't fire dom-ready — keep the URL text fresh and
    // re-attach the bar if a client-side render swapped out documentElement.
    if (window.__ssChromeTimer) clearInterval(window.__ssChromeTimer)
    var lastHref = location.href
    window.__ssChromeTimer = setInterval(function () {
      if (location.href !== lastHref) { lastHref = location.href; updateUrl() }
      if (!document.getElementById(HOST_ID)) document.documentElement.appendChild(host)
    }, 1000)
  } catch (e) { /* never let chrome injection break the page */ }
})()`

/** Navigate to a URL, wait for it to settle, nudge lazy content, then extract.
 *  Shared by the first open and the post-login re-fetch. */
async function loadAndExtract(wc: WebContents, url: string): Promise<ExtractResult> {
  // 1. Navigate with a hard timeout. A client redirect aborts the first load
  //    with ERR_ABORTED — expected, not a failure.
  let navTimer: NodeJS.Timeout | undefined
  const navTimeout = new Promise<never>((_, reject) => {
    navTimer = setTimeout(() => reject(new Error(`页面加载超时 (${NAV_TIMEOUT_MS}ms)`)), NAV_TIMEOUT_MS)
  })
  try {
    await Promise.race([wc.loadURL(url), navTimeout])
  } catch (e) {
    const msg = (e as Error).message || String(e)
    if (!/ERR_ABORTED|\(-3\)/i.test(msg)) {
      if (navTimer) clearTimeout(navTimer)
      throw new Error(`打开网页失败：${msg}`)
    }
  } finally {
    if (navTimer) clearTimeout(navTimer)
  }

  // 2. Wait for a client-rendered page to paint.
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
  try { await execJs(wc, settleJs, SETTLE_TIMEOUT_MS + 4_000) } catch { /* best-effort */ }

  // 2b. Nudge lazy-loaded content into existence by scrolling.
  try { await execJs(wc, SCROLL_JS, SCROLL_BUDGET_MS + 4_000) } catch { /* best-effort */ }

  // 3. Detect login + extract in one round-trip.
  try {
    return await execJs<ExtractResult>(wc, EXTRACT_JS, EXTRACT_TIMEOUT_MS)
  } catch {
    throw new Error(`读取页面内容超时，该页面可能在持续跳转或触发了反爬拦截：${url.slice(0, 120)}`)
  }
}

function toResult(raw: ExtractResult, url: string, needsLogin: boolean): BrowseResult {
  return {
    finalUrl: raw.finalUrl || url,
    title: raw.title || '',
    text: raw.text || '',
    links: raw.links || [],
    needsLogin,
    ...(needsLogin
      ? { loginHint: '该页面需要登录。浏览器窗口已弹出，请在其中完成登录后点击右下角「我已登录完成，继续」按钮（若未点击，我也会自动检测）。' }
      : {})
  }
}

/** Bring the (possibly hidden) shared window to the foreground so the user can
 *  actually see + interact with the login form. On Windows show()+focus() alone
 *  often fails to steal foreground; a brief always-on-top pin reliably surfaces
 *  it, then we drop the pin. */
function surfaceWindow(w: BrowserWindow): void {
  try {
    if (w.isMinimized()) w.restore()
    w.show()
    w.moveTop()
    w.setAlwaysOnTop(true)
    w.focus()
    setTimeout(() => { try { if (!w.isDestroyed()) w.setAlwaysOnTop(false) } catch { /* gone */ } }, 1500)
  } catch { /* window may have been torn down concurrently */ }
}

/**
 * Block (in-process, zero LLM tokens) until the user finishes logging in, then
 * re-fetch the intended page and return its content. Cadence:
 *   - Poll the injected button flag every ~1s → a click continues near-instantly.
 *   - If they log in WITHOUT clicking, silently re-detect the login wall every
 *     30s, up to 3 times.
 *   - Still walled after that → reveal a full-screen reminder overlay and PAUSE
 *     auto-detection (the button still works). When the user closes the overlay
 *     we resume the 30s×3 cycle fresh.
 *   - Window closed by user, or total budget exceeded → fall back to
 *     needsLogin:true (caller asks the user to log in then retry).
 *
 * Auto-detection inspects the CURRENT page in place (never re-navigates) so it
 * can't wipe a half-typed password / regenerate a QR code mid-login. We only
 * re-navigate once login is confirmed, to fetch the actually-intended content.
 */
async function waitForLoginThenExtract(
  w: BrowserWindow, wc: WebContents, url: string, lastRaw: ExtractResult
): Promise<BrowseResult> {
  // Inject the button immediately so it's visible the instant the window surfaces.
  try { await execJs(wc, LOGIN_POLL_JS, EXTRACT_TIMEOUT_MS) } catch { /* best-effort */ }

  const start = Date.now()
  let autoPolls = 0
  let lastAutoAt = Date.now()
  let prevOverlay = false

  while (true) {
    if (w.isDestroyed() || Date.now() - start > LOGIN_TOTAL_BUDGET_MS) {
      return toResult(lastRaw, url, true)
    }
    await delay(LOGIN_BTN_POLL_MS)
    if (w.isDestroyed()) return toResult(lastRaw, url, true)

    let flags: { done: boolean; overlayVisible: boolean }
    try { flags = JSON.parse(await execJs<string>(wc, LOGIN_POLL_JS, EXTRACT_TIMEOUT_MS)) }
    catch { continue }

    // Primary path: user clicked the button → trust it, fetch real content.
    if (flags.done) {
      const raw2 = await loadAndExtract(wc, url)
      return toResult(raw2, url, raw2.isLogin)
    }

    // Overlay just dismissed → resume the 30s×3 cycle from scratch.
    if (prevOverlay && !flags.overlayVisible) { autoPolls = 0; lastAutoAt = Date.now() }
    prevOverlay = flags.overlayVisible
    if (flags.overlayVisible) continue // paused while the reminder is up

    if (Date.now() - lastAutoAt >= LOGIN_AUTO_POLL_MS) {
      lastAutoAt = Date.now()
      autoPolls++
      let detected: ExtractResult | null = null
      try { detected = await execJs<ExtractResult>(wc, EXTRACT_JS, EXTRACT_TIMEOUT_MS) } catch { /* keep waiting */ }
      if (detected && !detected.isLogin) {
        const raw2 = await loadAndExtract(wc, url)
        return toResult(raw2, url, raw2.isLogin)
      }
      if (autoPolls >= LOGIN_AUTO_POLL_MAX) {
        try { await execJs(wc, SHOW_OVERLAY_JS, EXTRACT_TIMEOUT_MS) } catch { /* best-effort */ }
        prevOverlay = true
      }
    }
  }
}

/**
 * Open a URL in the shared browser window and read its rendered content.
 * Detects login walls; on detection forces the window visible so the user can
 * sign in. In interactive mode (waitForLogin) it then BLOCKS until the user
 * finishes — clicking the injected「我已登录完成」button or via silent
 * auto-detection — and returns the real content, so the agent continues in the
 * SAME tool call (no "reply to me when done" round-trip). Only on timeout /
 * window-close / headless mode does it return needsLogin=true.
 */
export async function openPage(
  url: string,
  opts: { browserVisible: boolean; waitForLogin?: boolean }
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

      const raw = await loadAndExtract(wc, url)
      if (!raw.isLogin) return toResult(raw, url, false)

      // Login wall — surface the window so the user can sign in.
      surfaceWindow(w)
      // Headless / scheduled runs have nobody to log in: don't block, just
      // report needsLogin so the agent can give a partial answer.
      if (opts.waitForLogin === false) return toResult(raw, url, true)

      // Interactive: block (zero LLM tokens) until login completes, then
      // re-fetch the real content and continue in this same tool call.
      return waitForLoginThenExtract(w, wc, url, raw)
    })
  }
}

export function closeBrowse(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  try { if (win && !win.isDestroyed()) win.destroy() } catch { /* swallow */ }
  win = null
}

// ============================================================================
// Webpage automation — act on the SAME shared window web_open left behind, so
// the login state and already-rendered page carry over. Every op runs through
// withMutex (serialized with web_open's own work), NEVER navigates (navigation
// would lose typed input / login), and re-arms a LONGER idle timer
// (OP_IDLE_CLOSE_MS) on the way out because automation steps are separated by
// LLM thinking turns that would blow the 30s read-idle.
// ============================================================================

export interface SnapshotElement {
  /** Stable handle the act/upload ops reference. Valid until the DOM changes. */
  ref: string
  tag: string
  type: string
  /** name / id / aria-label — whatever best identifies the field. */
  name: string
  /** Visible text / value / placeholder, truncated. */
  text: string
}

export interface SnapshotResult {
  title: string
  url: string
  /** Visible page text (truncated) so the model knows the page context. */
  text: string
  elements: SnapshotElement[]
  /** Set when SNAPSHOT_JS caught an internal exception. Lets snapshotPage()
   *  treat in-script throws like outer-script throws (same hint path) while
   *  carrying the real message — without this we just saw Electron's generic
   *  "Script failed to execute, this normally means an error was thrown". */
  _snapshotError?: string
}

/** Guard shared by every automation op: the window must already be open (via
 *  web_open). We never auto-open here because we'd have no URL and would lose
 *  the point of acting on the user's already-prepared, logged-in page. */
function requireWindow(): { w: BrowserWindow; wc: WebContents } {
  if (!win || win.isDestroyed()) {
    throw new Error('请先用 web_open 打开目标页面')
  }
  // Keep it visible so the user can handle captcha / 2FA / sliders.
  if (!win.isVisible()) { try { win.showInactive() } catch { /* gone */ } }
  return { w: win, wc: win.webContents }
}

// Walk light + shadow DOM and tag interactive elements with a stable
// data-ss-ref. Reuses the recursive shadow-root traversal from EXTRACT_JS.
//
// Collected in THREE phases with separate quotas, so a feed of <a> tags can't
// starve out the action buttons (the original bug: B站 publish toolbar lived
// past element #150 because pass 1 hit the cap on <a> from the feed first):
//   Phase A — form controls + explicit buttons (input/textarea/select/contenteditable/<button>/[role=button])
//   Phase B — div/span/li styled as buttons (CN sites use these instead of <button>; e.g. B站 <div class="bili-pub-button">发布</div>)
//   Phase C — <a href> and link-role items (lowest priority — feeds love them)
// Plus a catch-net for visible leaf elements whose entire text is a publish/submit keyword,
// in case both the class-name and cursor:pointer heuristics miss them.
// File inputs (incl. hidden ones — sites style a fake button and hide the real input)
// are always captured so web_upload has a target.
const SNAPSHOT_JS = `new Promise((__ssResolve) => { setTimeout(() => { __ssResolve((() => {
  // The outer 'new Promise + setTimeout' wrapper is CRITICAL: executeJavaScript's
  // synchronous evaluate phase gets reject-bombed by SPA navigation race (the
  // 小红书 creator page does router.push tab_switch right after web_open). By
  // returning a Promise immediately, evaluate phase only parses 'new Promise(...)'
  // — a few microseconds — then the real DOM walk runs from the task queue
  // AFTER navigation settles. Without this we used to see "Script failed to
  // execute, this normally means an error was thrown" with no recoverable info.
  //
  // The inner try-catch handles a separate failure mode: heavy SPA pages
  // hook Element.prototype getters, register synchronous DOM event listeners
  // that throw, or freeze prototypes — any of which can blow up our element-
  // probing loops. With it, we ALWAYS return a SnapshotResult; if something
  // threw, _snapshotError carries the actual message + stack.
  try {
  // Walk light + shadow DOM only. We deliberately DON'T descend into iframes
  // here: this snapshot calls getComputedStyle on hundreds/thousands of elements
  // (Phase A/B visibility checks), and folding same-origin iframe DOM into the
  // root set multiplied that work past the exec timeout on heavy SPAs (the
  // 小红书 creator regression — the whole snapshot threw and returned no
  // elements at all). web_click(text=...) still reaches iframes when needed; the
  // snapshot stays cheap and reliable.
  function allShadowRoots(root, acc) {
    let els
    try { els = root.querySelectorAll('*') } catch (e) { return acc }
    for (const el of els) {
      // Skip SuperStudio-injected chrome (the branded top bar) so its buttons
      // never surface as click candidates.
      if (el.id && el.id.indexOf('__ss') === 0) continue
      if (el.shadowRoot) { acc.push(el.shadowRoot); allShadowRoots(el.shadowRoot, acc) }
    }
    return acc
  }
  const shadowRoots = allShadowRoots(document, [])
  const roots = [document, ...shadowRoots]

  const formSel = 'button,input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="button"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="tab"]'
  const linkSel = 'a[href],[role="link"],[role="menuitem"]'
  const styleOf = (el) => { try { return (el.ownerDocument.defaultView || window).getComputedStyle(el) } catch (e) { return null } }
  // EVERY per-element predicate is try-caught: heavy SPAs ship custom elements
  // with hostile getters (anti-bot probes, Proxy traps) that throw when our
  // loops touch a property — without a wrapper one bad element fails the whole
  // snapshot (the 小红书 throw we couldn't see). Defaults err on the safe side
  // (treat a throwing element as not-visible / not-mounted / not-clickable).
  const isVisible = (el) => {
    try {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const st = styleOf(el)
      if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0)) return false
      return true
    } catch (e) { return false }
  }
  const isFileInput = (el) => { try { return el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file' } catch (e) { return false } }
  // display:none → truly absent in layout, never collect. visibility:hidden / opacity:0
  // are different — the element occupies space and may become visible after a state
  // change (disabled→enabled, fade-in). For action buttons we treat those as collectible.
  const isMounted = (el) => {
    try {
      const st = styleOf(el)
      if (st && st.display === 'none') return false
      return true
    } catch (e) { return false }
  }
  // Class names that strongly imply "this div IS a button" — catches custom controls
  // that have no role=button and may even have cursor:not-allowed when disabled.
  const BTN_CLASS_RE = /\\b(btn|button|publish|submit|send|primary|action|pub[-_]btn|pub[-_]button)\\b/i
  // Whole-text keywords that should ALWAYS be captured if mounted — last-resort
  // catch-net for action buttons that escape every other heuristic, INCLUDING when
  // they're temporarily disabled / visibility:hidden waiting for form completion.
  //
  // NOTE: "发布笔记" is deliberately EXCLUDED — on 小红书 creator pages it's the
  // SIDEBAR NAV menu label (router push to ?from=menu&target=video), NOT the
  // form-bottom publish action. The real button is just "发布" or "立即发布".
  // Including "发布笔记" previously caused the snapshot to capture 3-4 sidebar
  // wrappers as "action elements" and made web_click(text="发布笔记") land on
  // the sidebar instead of submitting the form.
  const ACTION_TEXT_RE = /^(发布|立即发布|提交|确认|发送|确定|完成|保存|取消|删除|关注|订阅|登录|注册|下一步|上一步|Submit|Send|Post|Publish|Save|OK|Continue|Next|Back|Login|Sign[- ]?in|Sign[- ]?up)$/i
  // Two-tier check: cheap attribute signals first (onclick / tabindex / btn-class).
  // ONLY fall through to the expensive getComputedStyle (cursor:pointer) when those
  // miss — and only within a global budget (CURSOR_CHECK_BUDGET below), because
  // calling it on every div/span/li on a heavy SPA used to blow past our snapshot
  // timeout. cursor:pointer is the only reliable signal for React-style sites
  // (小红书 included) where clickable divs have no onclick attr / no btn-class.
  const looksClickable = (el) => {
    try {
      const t = (el.textContent || '').trim()
      if (t.length === 0 || t.length > 40) return false  // wrappers and giant containers
      if (el.getAttribute('onclick')) return true
      if (el.getAttribute('tabindex') !== null) return true
      if (BTN_CLASS_RE.test(el.getAttribute('class') || '')) return true
      if (cursorChecks >= CURSOR_CHECK_BUDGET) return false
      cursorChecks++
      const st = styleOf(el)
      return !!(st && st.cursor === 'pointer')
    } catch (e) { return false }
  }
  // Global ceiling on getComputedStyle calls inside looksClickable. ~800 ≈ a few
  // hundred ms on heavy SPAs; well under SNAPSHOT_TIMEOUT_MS. Tune up if action
  // buttons start getting missed; tune down if snapshots start timing out.
  let cursorChecks = 0
  const CURSOR_CHECK_BUDGET = 800
  // Whitespace-collapsed match: "发  布" / "发\\n布" / "  发布  " all normalize to "发布".
  // Many editors space-pad button text via internal text nodes; raw .trim() preserves
  // internal whitespace and misses these.
  const normalizeWord = (s) => (s || '').replace(/\\s+/g, '').trim()
  const isActionKeyword = (el) => {
    if (el.childElementCount > 0) return false  // leaf only — wrapper's whole text is just the inner button's
    return ACTION_TEXT_RE.test(normalizeWord(el.textContent || ''))
  }
  // Strong class-name signals that a div IS the publish/submit button (a fallback
  // even if it has no text yet because i18n loaded lazily). Tighter than BTN_CLASS_RE
  // so we don't sweep up every "btn" / "button" wrapper on the page.
  // ce-btn/red-btn — 小红书创作平台发布按钮 (<button class="ce-btn bg-red">发布</button>)
  // d-button-content — Discourse; red-button — 通用; bg-red 是 utility 不写进，避免误伤
  const PUBLISH_CLASS_RE = /\\b(publish[-_]?btn|publish[-_]?button|publish[-_]?action|submit[-_]?btn|submit[-_]?button|post[-_]?btn|post[-_]?button|d-button-content|red-button|red-btn|ce-btn)\\b/i
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s }

  const elements = []
  const seen = new Set()
  let i = 0
  const CAP_FORMS = 80
  const CAP_BUTTONS = 80
  const CAP_LINKS = 120
  const CAP_TOTAL = 260
  const add = (el) => {
    if (elements.length >= CAP_TOTAL || seen.has(el)) return false
    // Never collect SuperStudio-injected chrome (top-bar buttons, login helper
    // button) — they live under an id starting with __ss.
    try { if (el.closest && el.closest('[id^="__ss"]')) return false } catch (e) {}
    seen.add(el)
    const ref = 'e' + i
    i++
    try { el.setAttribute('data-ss-ref', ref) } catch (e) { return false }
    const tag = (el.tagName || '').toLowerCase()
    const type = el.getAttribute('type') || el.getAttribute('role') || (el.isContentEditable ? 'contenteditable' : '')
    const name = clip(el.getAttribute('name') || el.id || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', 60)
    const raw = el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''
    elements.push({ ref, tag, type, name, text: clip(raw, 80) })
    return true
  }

  // Phase A — form controls + <button> + [role=button]. Highest priority.
  // BUTTONS get extra leniency: a <button>/[role=button] whose text matches an
  // action keyword (发布/提交/...) is collected even when visibility:hidden /
  // opacity:0 / 0×0 rect — sites like 小红书 keep the publish button mounted but
  // "soft-disabled" until the form is complete. Skipping it here means the agent
  // has no ref to click once the form IS complete.
  let formsN = 0
  for (const r of roots) {
    if (formsN >= CAP_FORMS) break
    let found
    try { found = r.querySelectorAll(formSel) } catch (e) { found = [] }
    for (const el of found) {
      if (formsN >= CAP_FORMS) break
      if (isFileInput(el)) { if (add(el)) formsN++; continue }
      if (isVisible(el)) { if (add(el)) formsN++; continue }
      // Mounted but currently hidden — keep iff it's a button-shaped element with
      // an action-keyword text OR a publish-class. This is the "发布按钮初始 disabled/
      // hidden" escape hatch.
      const tag = (el.tagName || '').toLowerCase()
      const role = (el.getAttribute('role') || '').toLowerCase()
      const isBtnShape = tag === 'button' || role === 'button' || tag === 'input'
      if (isBtnShape && isMounted(el)) {
        const t = normalizeWord(el.textContent || el.value || '')
        const cls = el.getAttribute('class') || ''
        if (ACTION_TEXT_RE.test(t) || PUBLISH_CLASS_RE.test(cls)) {
          if (add(el)) formsN++
        }
      }
    }
  }
  // Phase B-priority — div/span/li whose entire text matches an action keyword
  // (发布/提交/...). These get an UNLIMITED slot allotment (capped only by
  // CAP_TOTAL) and run BEFORE the general button scan, so navigation menus and
  // settings panels can't starve out the publish button (the 小红书 bug:
  // 91 elements were collected, CAP_BUTTONS=80 was full of sidebar items, and
  // the publish button at the right of the page never got a ref).
  for (const r of roots) {
    let cands
    try { cands = r.querySelectorAll('div,span,li') } catch (e) { cands = [] }
    for (const el of cands) {
      if (!isActionKeyword(el)) continue
      if (isVisible(el) || isMounted(el)) add(el)
    }
  }
  // Phase B-class — fallback for action-class elements that escaped both Phase A
  // (no button/role) and Phase B-priority (text wrapped in a non-leaf shape, eg
  // <div class="publish-btn"><i icon/><span>发布</span></div>). Class-name signals
  // are deliberate; PUBLISH_CLASS_RE is tight enough not to scoop random "btn"s.
  // Mounted-only so we don't surface v-if branches that haven't rendered yet.
  for (const r of roots) {
    let cands
    try { cands = r.querySelectorAll('[class]') } catch (e) { cands = [] }
    for (const el of cands) {
      if (!PUBLISH_CLASS_RE.test(el.getAttribute('class') || '')) continue
      if (el.childElementCount > 6) continue  // skip huge containers that merely include a btn class somewhere
      if (isVisible(el) || isMounted(el)) add(el)
    }
  }
  // Phase B — div/span/li that behave like buttons (everything else, capped).
  // ORDER MATTERS: looksClickable (cheap attribute checks) runs BEFORE isVisible
  // (getComputedStyle), so we only pay the style-recalc cost on the small handful
  // of elements that actually have a clickable signal — not on every div on the
  // page. Reversing this order is what caused the 小红书 snapshot to time out.
  let btnsN = 0
  for (const r of roots) {
    if (btnsN >= CAP_BUTTONS) break
    let cands
    try { cands = r.querySelectorAll('div,span,li') } catch (e) { cands = [] }
    for (const el of cands) {
      if (btnsN >= CAP_BUTTONS) break
      if (!looksClickable(el)) continue
      if (!isVisible(el)) continue
      if (add(el)) btnsN++
    }
  }
  // Phase C — anchors / link-role. Lowest priority (feeds dominate these).
  let linksN = 0
  for (const r of roots) {
    if (linksN >= CAP_LINKS) break
    let found
    try { found = r.querySelectorAll(linkSel) } catch (e) { found = [] }
    for (const el of found) {
      if (linksN >= CAP_LINKS) break
      if (isVisible(el)) { if (add(el)) linksN++ }
    }
  }

  const lightText = (document.body && document.body.innerText) ? document.body.innerText : ''
  const text = lightText.replace(/[\\t\\f\\r ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2000)
  return { title: document.title || '', url: location.href || '', text, elements }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    const stk = (e && e.stack) ? String(e.stack).slice(0, 400) : ''
    return {
      title: (typeof document !== 'undefined' && document.title) || '',
      url: (typeof location !== 'undefined' && location.href) || '',
      text: '', elements: [], _snapshotError: msg + (stk ? ' || ' + stk : '')
    }
  }
})()); }, 0); })`

/** Evaluate SNAPSHOT_JS via Chrome DevTools Protocol — bypasses
 *  webContents.executeJavaScript's main-frame-availability check, which on
 *  heavy SPAs (小红书 publish was the canary) rejects with
 *  "Script failed to execute, this normally means an error was thrown" at
 *  evaluate time without ever running the script. CDP's Runtime.evaluate
 *  doesn't have that issue: it queues the eval onto the page's main world
 *  regardless of frame churn. `awaitPromise: true` makes it wait for our
 *  `new Promise(setTimeout(...))`-wrapped result. */
async function snapshotViaCDP(wc: WebContents): Promise<SnapshotResult> {
  let attached = false
  try {
    try { wc.debugger.attach('1.3') } catch (e) {
      const msg = (e as Error).message || String(e)
      // Already attached (we re-entered, or devtools is open) — fine, proceed.
      if (!/already attached/i.test(msg)) throw new Error(`CDP attach failed: ${msg}`)
    }
    attached = true
    await wc.debugger.sendCommand('Runtime.enable')
    const res = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: SNAPSHOT_JS,
      awaitPromise: true,
      returnByValue: true,
      timeout: SNAPSHOT_TIMEOUT_MS
    }) as { result?: { value?: SnapshotResult }; exceptionDetails?: { exception?: { description?: string } } }
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails)
      throw new Error(`CDP snapshot threw: ${desc.slice(0, 300)}`)
    }
    const value = res.result?.value
    if (!value) throw new Error('CDP snapshot returned no value')
    if (value._snapshotError) throw new Error(`snapshot script threw inside page: ${value._snapshotError}`)
    return value
  } finally {
    if (attached) { try { wc.debugger.detach() } catch { /* already detached */ } }
  }
}

/** Evaluate SNAPSHOT_JS — fast path (executeJavaScript) first, immediate CDP
 *  fallback on failure. On normal pages the fast path always wins (no attach
 *  cost). On SPA-mid-navigation pages where executeJavaScript synchronously
 *  rejects with "Script failed to execute", we fall straight to CDP without
 *  burning retry budget. */
async function evalSnapshot(wc: WebContents): Promise<SnapshotResult> {
  try {
    return await execJs<SnapshotResult>(wc, SNAPSHOT_JS, SNAPSHOT_TIMEOUT_MS)
  } catch (fastErr) {
    const msg = (fastErr as Error).message || String(fastErr)
    console.log(`[web-automation] fast-path snapshot failed (${msg.slice(0, 80)}…), falling back to CDP`)
    return await snapshotViaCDP(wc)
  }
}

/** Snapshot the current page: tag + list visible interactive elements. The
 *  model calls this before acting (to get refs) and after any DOM-mutating
 *  action (refs go stale once the DOM changes). */
export async function snapshotPage(): Promise<SnapshotResult> {
  return withMutex(async () => {
    const { wc } = requireWindow()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    try {
      // Pre-snapshot scroll-to-bottom on creator/publish URLs: 小红书/B站/视频号 等
      // 创作页用 IntersectionObserver 惰性挂载发布工具栏，光在视窗顶部 snapshot 永远
      // 抓不到底部的发布按钮。隐藏窗口里滚动无 UX 影响；只对发布类 URL 做，避免给普通
      // 阅读类页面加无谓延迟。
      try {
        const url = wc.getURL() || ''
        if (/(publish|create|create-?center|creator|editor|new[-_/]?post|compose|draft)/i.test(url)) {
          await execJs<number>(
            wc,
            `(() => {
              try {
                window.scrollTo(0, document.body.scrollHeight)
                const sel = 'button.ce-btn,button.red-btn,[class*="publish-btn"],[class*="publish-button"],[class*="submit-btn"]'
                const list = document.querySelectorAll(sel)
                for (const e of list) { try { e.scrollIntoView({ block: 'end' }) } catch (x) {} }
                return list.length
              } catch (e) { return -1 }
            })()`,
            1500
          )
          // 给 IntersectionObserver 留 commit 时间。
          await new Promise(r => setTimeout(r, 200))
        }
      } catch { /* pre-scroll failure isn't fatal */ }
      // Retry: a SPA route push or anti-bot interstitial right after web_open can
      // make executeJavaScript reject with the generic "Script failed to execute"
      // (no active frame to evaluate against). The script itself is now wrapped
      // in `new Promise(setTimeout(...))` so the evaluate phase is microseconds
      // long — but if a navigation lands EXACTLY during that window, retry is
      // still needed. Burst the first few attempts so we catch sub-second SPA
      // tab_switch races (小红书 publish page does this), then back off normally.
      const backoffs = [0, 150, 350, 700, 1500, 3000]
      let lastErr: Error | undefined
      // Per-attempt log: every retry's wait, exec duration, and failure reason
      // — surfaced on success-after-retry (result._snapshotAttempts) AND on
      // final failure (thrown Error.attempts). Lets exported session JSON show
      // exactly which attempt failed and why, without needing console access.
      const attempts: Array<{ idx: number; waitMs: number; execMs: number; ok: boolean; error?: string }> = []
      for (let i = 0; i < backoffs.length; i++) {
        const wait = backoffs[i]
        if (wait) await new Promise(r => setTimeout(r, wait))
        const start = Date.now()
        try {
          const result = await evalSnapshot(wc)
          const execMs = Date.now() - start
          if (result._snapshotError) {
            attempts.push({ idx: i + 1, waitMs: wait, execMs, ok: false, error: `inner-throw: ${result._snapshotError.slice(0, 300)}` })
            throw new Error(`snapshot script threw inside page: ${result._snapshotError}`)
          }
          attempts.push({ idx: i + 1, waitMs: wait, execMs, ok: true })
          console.log('[web-automation] snapshot', result.url, '→', result.elements.length, 'elements', 'attempts=' + attempts.length)
          // Surface retry log only when we actually needed to retry (>1 attempt).
          // Empty on first-try success keeps the happy-path JSON clean.
          if (attempts.length > 1) (result as SnapshotResult & { _snapshotAttempts?: typeof attempts })._snapshotAttempts = attempts
          return result
        } catch (e) {
          const execMs = Date.now() - start
          const msg = (e as Error).message || String(e)
          // Push only if we didn't already push the inner-throw record above.
          if (attempts.length <= i) attempts.push({ idx: i + 1, waitMs: wait, execMs, ok: false, error: msg.slice(0, 300) })
          lastErr = e as Error
          console.warn(`[web-automation] snapshot attempt #${i + 1} (after ${wait}ms, exec=${execMs}ms) failed:`, lastErr.message)
        }
      }
      // Aggregate ALL attempt errors into the thrown message + a structured
      // `.attempts` property so callers (web_open auto-snapshot, web_snapshot)
      // can serialize them into the tool result for the exported JSON.
      const summary = attempts.map(a => `#${a.idx}(wait=${a.waitMs}ms,exec=${a.execMs}ms): ${a.error || 'ok'}`).join(' | ')
      const err = new Error(`snapshot failed after ${attempts.length} attempts: ${summary}`)
      ;(err as Error & { attempts?: typeof attempts }).attempts = attempts
      throw err
    } finally {
      armIdleClose(OP_IDLE_CLOSE_MS)
    }
  })
}

export type PageAction =
  | { type: 'click'; ref?: string; text?: string }
  | { type: 'fill'; ref: string; value: string }
  | { type: 'select'; ref: string; value: string }

export interface ActResult {
  ok: boolean
  finalUrl: string
  error?: string
  /** Fresh snapshot after the action settled. Always populated on success so the
   *  agent doesn't need to chain web_snapshot just to find the next ref — that
   *  intermediate "let me snapshot" reasoning is what makes models stop mid-flow. */
  elements?: SnapshotElement[]
  title?: string
  /** Set only when the action succeeded but the follow-up snapshot couldn't be
   *  captured — tells the model how to recover instead of stalling. */
  hint?: string
}

// Find the [data-ss-ref] element across light + shadow trees, then perform the
// action. Returns { ok, error? }. Built per-call with the action JSON inlined.
function buildActJs(action: PageAction): string {
  const payload = JSON.stringify(action)
  return `(async () => {
  const action = ${payload}
  function allShadowRoots(root, acc) {
    let els
    try { els = root.querySelectorAll('*') } catch (e) { return acc }
    for (const el of els) {
      if (el.shadowRoot) { acc.push(el.shadowRoot); allShadowRoots(el.shadowRoot, acc) }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = el.contentDocument
          if (doc && doc !== root) { acc.push(doc); allShadowRoots(doc, acc) }
        } catch (e) { /* cross-origin: skip */ }
      }
    }
    return acc
  }
  const roots = [document, ...allShadowRoots(document, [])]
  let el = null
  if (action.ref) {
    for (const r of roots) {
      let hit
      try { hit = r.querySelector('[data-ss-ref="' + action.ref + '"]') } catch (e) { continue }
      if (hit) { el = hit; break }
    }
  }
  // Text fallback (click only): resolve a clickable element by its visible text
  // at click-time, on the LIVE DOM. Bypasses the snapshot entirely, so it still
  // works when the target (e.g. the 发布 button) was lazy-rendered or capped out
  // of the snapshot and therefore never got a data-ss-ref.
  if (!el && action.type === 'click' && action.text) {
    const norm = (s) => (s || '').replace(/\\s+/g, '').trim()
    const want = norm(action.text)
    const styleOf = (e) => { try { return (e.ownerDocument.defaultView || window).getComputedStyle(e) } catch (x) { return null } }
    const sel = 'button,a[href],[role="button"],[role="menuitem"],[role="tab"],input[type="button"],input[type="submit"],div,span,li'
    const exact = []
    const partial = []
    for (const r of roots) {
      let cands
      try { cands = r.querySelectorAll(sel) } catch (e) { continue }
      for (const c of cands) {
        if (c.childElementCount > 8) continue  // skip big containers; we want the leaf control
        const t = norm(c.textContent || c.value || c.getAttribute('aria-label') || '')
        if (!t || !want) continue
        if (t === want) exact.push(c)
        else if (t.indexOf(want) !== -1 && t.length <= want.length + 6) partial.push(c)
      }
    }
    // Navigation containers — when multiple candidates share the same text
    // (e.g. "发布笔记" appears on both the sidebar nav AND the in-page button),
    // we want the in-form button to win. Walk up to ~8 ancestors looking for
    // nav-shape signals. NAV_CLASS_RE is intentionally tight so we don't penalize
    // genuine button wrappers that happen to contain "side" in their class.
    const NAV_TAG_RE = /^(nav|aside|header)$/i
    const NAV_ROLE_RE = /^(navigation|menu|menubar|menuitem|tab|tablist)$/i
    const NAV_CLASS_RE = /(^|[ _-])(sidebar|side-bar|side[_-]?nav|side[_-]?menu|left[_-]?nav|left[_-]?menu|nav[_-]?bar|nav[_-]?menu|menu[_-]?bar|main[_-]?menu|app[_-]?menu)([ _-]|$)/i
    const inNavLike = (e) => {
      try {
        let cur = e
        for (let hops = 0; hops < 8 && cur && cur !== document.documentElement; hops++) {
          const tag = (cur.tagName || '').toLowerCase()
          if (NAV_TAG_RE.test(tag)) return true
          const role = (cur.getAttribute && cur.getAttribute('role')) || ''
          if (NAV_ROLE_RE.test(role)) return true
          const cls = (cur.getAttribute && cur.getAttribute('class')) || ''
          if (NAV_CLASS_RE.test(cls)) return true
          cur = cur.parentElement
        }
      } catch (x) { /* hostile ancestor — treat as not-nav */ }
      return false
    }
    // A *real* control: a genuine <button>/submit-input/[role=button] that is
    // visible (occupies layout). 小红书 的发布按钮就是 <button class="ce-btn
    // bg-red">发布</button> —— 这种元素几乎一定是表单提交，不该被 nav 启发式误杀。
    const isRealButton = (e) => {
      try {
        const tag = (e.tagName || '').toLowerCase()
        const role = (e.getAttribute('role') || '').toLowerCase()
        const type = (e.getAttribute('type') || '').toLowerCase()
        const isBtn = tag === 'button' || role === 'button' || (tag === 'input' && (type === 'submit' || type === 'button'))
        if (!isBtn) return false
        const rect = e.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      } catch (x) { return false }
    }
    const scoreOf = (e) => {
      let s = 0
      const tag = (e.tagName || '').toLowerCase()
      const role = (e.getAttribute('role') || '').toLowerCase()
      if (tag === 'button' || role === 'button' || tag === 'input') s += 4
      const rect = e.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) s += 3
      const st = styleOf(e)
      if (st && st.cursor === 'pointer') s += 1
      const cls = e.getAttribute('class') || ''
      if (/\\b(publish|submit|post|btn|button)\\b/i.test(cls)) s += 1
      // 红色/主色 CTA 是「主提交」的强信号（小红书发布按钮 class 含 bg-red）。
      if (/\\b(bg-red|btn-danger|btn-primary|is-primary|primary|danger|cta)\\b/i.test(cls)) s += 2
      // Sidebar/nav ancestor penalty. BUT a real visible <button>/submit with this
      // text is the form submit even if some ancestor's class regex-matches "menu/
      // side" — so penalize it only lightly; only kill non-button nav items hard.
      if (inNavLike(e)) s -= isRealButton(e) ? 2 : 6
      return s
    }
    const pool = exact.length ? exact : partial
    pool.sort((a, b) => scoreOf(b) - scoreOf(a))
    el = pool[0] || null
    if (!el) return { ok: false, finalUrl: location.href, error: '页面上找不到文字为「' + action.text + '」的可点击元素，请先 web_snapshot 看看现在有哪些元素' }
    // 硬拒绝：若 pool 里所有候选都在 nav/sidebar 里，且用户找的是「发布/提交/确定/...」这类
    // 表单动作关键词，几乎可以确定它们都不是真按钮（真按钮还没挂出来）。直接报错让 LLM 滚到底
    // 部再 snapshot，而不是把侧栏 navItem 当成发布按钮误点（小红书草稿箱回流的根因）。
    const ACTION_WORDS_RE = /^(发布|立即发布|提交|确认|发送|确定|完成|保存|Submit|Send|Post|Publish|Save)$/i
    // 只有当所有候选「既像导航、又不是真按钮」时才硬拒绝——一个可见的真 <button>/submit
    // 足以说明发布按钮已挂出（即便祖先 class 被 nav 正则误命中），不该再拦。
    if (ACTION_WORDS_RE.test(want) && pool.every(c => inNavLike(c) && !isRealButton(c))) {
      return { ok: false, finalUrl: location.href, error: '找到的「' + action.text + '」候选全部位于侧栏/导航容器中，可能是「发布笔记」等导航入口而非表单提交按钮。请先把页面滚到底部（document.body.scrollHeight）再重新 web_snapshot；真发布按钮通常在表单底部，惰性挂载（IntersectionObserver）。' }
    }
  }
  if (!el) return { ok: false, finalUrl: location.href, error: '元素已失效，请重新 web_snapshot' }

  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}

  if (action.type === 'click') {
    try {
      const opts = { bubbles: true, cancelable: true, view: window }
      el.dispatchEvent(new MouseEvent('pointerdown', opts))
      el.dispatchEvent(new MouseEvent('mousedown', opts))
      el.dispatchEvent(new MouseEvent('mouseup', opts))
      el.click()
    } catch (e) { return { ok: false, finalUrl: location.href, error: '点击失败：' + (e && e.message) } }
    return { ok: true, finalUrl: location.href }
  }

  if (action.type === 'fill') {
    const v = String(action.value == null ? '' : action.value)
    try {
      const tag = (el.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        el.focus()
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        if (el.value !== v) return { ok: false, finalUrl: location.href, error: '写入后回读不一致，可能被组件拦截' }
      } else if (el.isContentEditable) {
        // Rich-text editors (Quill/Slate/Lexical/Draft/ProseMirror/小红书自研) all maintain
        // their own internal model. Three strategies in descending preference:
        //   1. paste event — every serious editor handles paste (browser feature parity);
        //      passes \\n as real newlines and avoids execCommand's per-char buggy path.
        //   2. execCommand('insertText') — legacy but widely supported; chokes on long
        //      strings + newlines + emoji on some editors (this was the 小红书 failure).
        //   3. beforeinput + raw textContent — last-resort; some editors will sync.
        el.focus()
        // Select all existing content so the new value replaces it.
        const selectAll = () => {
          try {
            const range = document.createRange()
            range.selectNodeContents(el)
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
          } catch (e) {}
        }
        selectAll()

        const want = v.replace(/\\s+/g, ' ').trim()
        const checkOk = () => {
          const got = (el.textContent || '').replace(/\\s+/g, ' ').trim()
          if (want.length === 0) return { ok: true, got }
          // Accept if we wrote ≥70% of the intended length AND the first 8 chars match.
          // Editors normalize whitespace, drop trailing newlines, replace emoji with
          // shortcodes etc., so byte-for-byte equality is too strict.
          // Use Array.from for code-point-correct slicing (emoji safety).
          const wantArr = Array.from(want)
          const gotArr = Array.from(got)
          const head = wantArr.slice(0, Math.min(8, wantArr.length)).join('')
          const ratio = wantArr.length > 0 ? gotArr.length / wantArr.length : 1
          return { ok: !!head && got.includes(head) && ratio >= 0.7, got }
        }

        // 1. Paste strategy.
        let pasted = false
        try {
          const dt = new DataTransfer()
          dt.setData('text/plain', v)
          dt.setData('text', v)  // some editors check the older 'text' key
          const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
          // dispatchEvent returns false iff a handler called preventDefault — for paste
          // that actually means the editor TOOK the data (it cancels default to insert via its own model).
          el.dispatchEvent(evt)
          pasted = true
        } catch (e) {}

        await new Promise(r => setTimeout(r, 100))
        let res = checkOk()

        // 2. execCommand fallback.
        if (!res.ok) {
          selectAll()
          try { document.execCommand('insertText', false, v) } catch (e) {}
          await new Promise(r => setTimeout(r, 100))
          res = checkOk()
        }

        // 3. beforeinput + raw mutation fallback.
        if (!res.ok) {
          selectAll()
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: v
            }))
          } catch (e) {}
          try { el.textContent = v } catch (e) {}
          try {
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true, inputType: 'insertFromPaste', data: v
            }))
          } catch (e) {}
          await new Promise(r => setTimeout(r, 100))
          res = checkOk()
        }

        if (!res.ok) {
          return {
            ok: false, finalUrl: location.href,
            error: '富文本编辑器未接受输入（回读："' + res.got.slice(0, 60) + '"）。请先 web_click 这个编辑器把它聚焦，再重试 web_fill；如果仍失败，告诉用户该编辑器要求手动填写，把内容贴到聊天里让用户自己粘。'
          }
        }
      } else {
        return { ok: false, finalUrl: location.href, error: '该元素不是可填写的输入框（' + tag + '）' }
      }
    } catch (e) { return { ok: false, finalUrl: location.href, error: '填写失败：' + (e && e.message) } }
    return { ok: true, finalUrl: location.href }
  }

  if (action.type === 'select') {
    try {
      if ((el.tagName || '').toLowerCase() !== 'select') {
        return { ok: false, finalUrl: location.href, error: '该元素不是 <select>' }
      }
      const want = String(action.value == null ? '' : action.value)
      let matched = false
      for (const opt of el.options) {
        if (opt.value === want || (opt.textContent || '').trim() === want) {
          el.value = opt.value
          matched = true
          break
        }
      }
      if (!matched) return { ok: false, finalUrl: location.href, error: '未找到匹配的选项：' + want }
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } catch (e) { return { ok: false, finalUrl: location.href, error: '选择失败：' + (e && e.message) } }
    return { ok: true, finalUrl: location.href }
  }

  return { ok: false, finalUrl: location.href, error: '未知动作：' + action.type }
})()`
}

/** Click / fill / select on a previously-snapshotted element (by ref). Never
 *  navigates by itself, but the page's own handlers may. */
export async function actOnPage(action: PageAction): Promise<ActResult> {
  return withMutex(async () => {
    const { wc } = requireWindow()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    try {
      const result = await execJs<ActResult>(wc, buildActJs(action), EXTRACT_TIMEOUT_MS)
      const targetLabel = action.type === 'click' ? (action.ref || `text:${action.text ?? ''}`) : action.ref
      console.log('[web-automation]', action.type, targetLabel, '→', result.ok ? 'ok' : `fail: ${result.error}`)
      if (result.ok) {
        // Auto-snapshot so the agent gets fresh refs without a second tool round-trip.
        // Click can trigger navigation or DOM mutation — give the page a moment to settle.
        // Fill needs longer than it intuitively should: heavy editors (小红书/掘金/语雀)
        // re-render their action toolbar (发布/暂存) based on form-validation state, and
        // the re-render kicks off AFTER React processes the input event. 120ms was too
        // tight and we'd snapshot before the publish button reappeared.
        const settleMs = action.type === 'click' ? 400 : 500
        await new Promise(r => setTimeout(r, settleMs))
        // Pre-snapshot scroll-to-bottom + bottom-up scrollIntoView walk: 小红书 publish /
        // B站 dynamic / 视频号 等创作页通过 IntersectionObserver 惰性挂载表单底部的
        // 发布工具栏。表单比视窗高，<button class="ce-btn bg-red">发布</button> 一直没
        // render，snapshot 自然抓不到。每次 action 后无脑滚到底——这是隐藏 BrowserWindow，
        // 用户看不见，零 UX 风险；同时再 scrollIntoView 触发一下任何 [data-publish]/
        // .publish-btn 类元素，把 IntersectionObserver 强制击发。
        try {
          await execJs<number>(
            wc,
            `(() => {
              try {
                window.scrollTo(0, document.body.scrollHeight)
                // 兜底：找 publish 类候选 + 表单底部，scrollIntoView 一次，IntersectionObserver
                // 即便没被滚动事件触发，这步也能挂上来（小红书发布按钮的实测路径）。
                const sel = 'button.ce-btn,button.red-btn,[class*="publish-btn"],[class*="publish-button"],[class*="submit-btn"]'
                const list = document.querySelectorAll(sel)
                for (const e of list) { try { e.scrollIntoView({ block: 'end' }) } catch (x) {} }
                return list.length
              } catch (e) { return -1 }
            })()`,
            1500
          )
        } catch { /* scroll injection failure isn't fatal */ }
        // 滚动后给 IntersectionObserver + 组件挂载留时间。比无脑等更紧——但比单纯
        // settleMs 又多一点点。
        await new Promise(r => setTimeout(r, 200))
        // 重试逻辑保持：tab switch / submit 触发的大 re-render 可能让首次 snapshot
        // 仍 race timeout，第二次再滚一遍兜底。额外一次「内容质量」重试：creator URL
        // 上若 snapshot 里完全没有「发布/提交/确定/Save/Submit」类按钮，几乎确定还没
        // 挂载完，再 rescroll + 等更久。
        const PUBLISH_URL_RE = /(publish|create|create-?center|creator|editor|new[-_/]?post|compose|draft)/i
        const ACTION_KW_RE = /^(发布|立即发布|提交|确认|发送|确定|完成|保存|Submit|Send|Post|Publish|Save)$/i
        let snapped = false
        let lastSnapErr = ''
        const MAX_ATTEMPTS = 3
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            try {
              await execJs<number>(
                wc,
                `(() => {
                  try {
                    window.scrollTo(0, document.body.scrollHeight)
                    const sel = 'button.ce-btn,button.red-btn,[class*="publish-btn"],[class*="publish-button"],[class*="submit-btn"]'
                    const list = document.querySelectorAll(sel)
                    for (const e of list) { try { e.scrollIntoView({ block: 'end' }) } catch (x) {} }
                    return list.length
                  } catch (e) { return -1 }
                })()`,
                1500
              )
            } catch { /* scroll injection failure isn't fatal — keep retrying */ }
            // 第二次等更久：IntersectionObserver 触发后 React 的 commit 还需要一拍。
            await new Promise(r => setTimeout(r, attempt === 1 ? 900 : 1500))
          }
          try {
            const snap = await evalSnapshot(wc)
            if (snap._snapshotError) {
              throw new Error(`snapshot script threw inside page: ${snap._snapshotError}`)
            }
            // 内容质量检查：发布类 URL 必须能看到一个动作关键词按钮，否则视为本轮失败、
            // 强制重试。注意不能用 finalUrl 去 match（可能还没拿到），用 snap.url。
            const onPublishLike = PUBLISH_URL_RE.test(snap.url || '')
            const hasActionBtn = (snap.elements || []).some(el => {
              const tx = (el.text || '').replace(/\s+/g, '').trim()
              return ACTION_KW_RE.test(tx)
            })
            if (onPublishLike && !hasActionBtn && attempt < MAX_ATTEMPTS - 1) {
              lastSnapErr = `snapshot 在发布页 ${snap.url} 抓到 ${snap.elements?.length || 0} 元素，但其中无动作关键词按钮（发布/提交/确定/...）；可能还没挂载完，rescroll 重试中`
              console.warn(`[web-automation] post-action snapshot attempt #${attempt + 1} content-incomplete:`, lastSnapErr)
              continue
            }
            result.elements = snap.elements
            result.title = snap.title
            result.finalUrl = snap.url
            snapped = true
            break
          } catch (snapErr) {
            lastSnapErr = (snapErr as Error).message || String(snapErr)
            console.warn(`[web-automation] post-action snapshot attempt #${attempt + 1} failed:`, lastSnapErr)
          }
        }
        if (!snapped) {
          // Include the underlying snapshot error so it surfaces in the chat
          // transcript — without this we're guessing whether it timed out or threw.
          result.hint = `操作已成功，但抓取最新元素清单失败（${lastSnapErr || '未知原因'}）。请立刻调用 web_snapshot 重新获取 elements——不要在这里停下来回复用户；若 web_snapshot 仍失败，就改用 web_click 的 text 参数按按钮文字（如"发布"）直接操作。`
        }
      }
      return result
    } catch (e) {
      const msg = (e as Error).message || '操作失败'
      const lbl = action.type === 'click' ? (action.ref ?? action.text ?? '') : action.ref
      console.warn('[web-automation]', action.type, lbl, '→ threw:', msg)
      return { ok: false, finalUrl: '', error: msg }
    } finally {
      armIdleClose(OP_IDLE_CLOSE_MS)
    }
  })
}

export interface UploadResult {
  ok: boolean
  error?: string
  /** Same auto-snapshot story as ActResult — caller gets fresh refs without a second tool call. */
  elements?: SnapshotElement[]
  title?: string
  finalUrl?: string
  /** True when the file input was located by scanning the page (caller did not
   *  pass a ref or the ref was stale). Useful for the LLM to know: if false,
   *  the snapshot-driven path worked; if true, the LLM can keep using the
   *  no-ref form to bypass snapshot entirely. */
  autoLocated?: boolean
  /** Set only when upload succeeded but the follow-up snapshot couldn't be
   *  captured — tells the model how to recover (text-based clicks) instead of
   *  stalling and replying to the user. */
  hint?: string
}

/** Set files on a `<input type=file>` — by ref if provided, otherwise the
 *  function auto-locates the first usable file input on the page (across light
 *  + shadow + same-origin iframe DOM). Page JS can't write `input.files`
 *  (read-only), so this goes through the Chrome DevTools Protocol: resolve
 *  the element's objectId, then DOM.setFileInputFiles (which also fires
 *  the `change` event the site listens for). filePaths must be local absolute
 *  paths — e.g. an image_generate result's `images[].path`.
 *
 *  The ref-optional path exists because the snapshot pipeline can fail on
 *  heavy SPAs (小红书 publish was the canary): without it, the LLM has no
 *  way to upload at all. Auto-locate picks the first `<input type=file>` that
 *  is "mounted" (display!=none) — file inputs are usually opacity:0 / 0×0
 *  rect behind a styled label, so we deliberately do NOT require isVisible. */
export async function uploadToPage(ref: string | null | undefined, filePaths: string[]): Promise<UploadResult> {
  return withMutex(async () => {
    const { wc } = requireWindow()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }

    for (const p of filePaths) {
      if (!p || !fs.existsSync(p)) {
        armIdleClose(OP_IDLE_CLOSE_MS)
        return { ok: false, error: `文件不存在：${p}` }
      }
    }

    let attached = false
    try {
      try { wc.debugger.attach('1.3') } catch (e) {
        const msg = (e as Error).message || String(e)
        // Already attached (by us earlier or devtools) — proceed; otherwise fail.
        if (!/already attached/i.test(msg)) {
          return { ok: false, error: `无法附加调试器（上传需要）：${msg}` }
        }
      }
      attached = true
      await wc.debugger.sendCommand('DOM.enable')
      await wc.debugger.sendCommand('Runtime.enable')

      // Resolve the file input across light + shadow + same-origin iframe DOM.
      // Two strategies:
      //   - With ref: pinpoint by [data-ss-ref] (fastest, exact). Verifies the
      //     hit IS a file input — if the ref happens to point at a non-file
      //     element (e.g. the "上传图片" tab button), the LLM gets a clear
      //     error instead of a silently-broken upload.
      //   - Without ref: pick the first <input type=file> we can find.
      //     Mounted-only (display != 'none') — file inputs are usually
      //     opacity:0 / 0×0 sitting behind a styled label, so isVisible() is
      //     wrong here. Logs which strategy hit for diagnostic JSON.
      const refLiteral = ref ? JSON.stringify(ref) : 'null'
      const findJs = `(() => {
        const targetRef = ${refLiteral}
        function allRoots(root, acc) {
          let els
          try { els = root.querySelectorAll('*') } catch (e) { return acc }
          for (const el of els) {
            if (el.shadowRoot) { acc.push(el.shadowRoot); allRoots(el.shadowRoot, acc) }
            if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
              try {
                const doc = el.contentDocument
                if (doc && doc !== root) { acc.push(doc); allRoots(doc, acc) }
              } catch (e) {}
            }
          }
          return acc
        }
        const roots = [document, ...allRoots(document, [])]
        const isFileInput = (el) => {
          try { return el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file' }
          catch (e) { return false }
        }
        const isMounted = (el) => {
          try {
            const st = (el.ownerDocument.defaultView || window).getComputedStyle(el)
            return !st || st.display !== 'none'
          } catch (e) { return true }
        }
        // Strategy 1: by ref
        if (targetRef) {
          for (const r of roots) {
            let hit
            try { hit = r.querySelector('[data-ss-ref="' + targetRef + '"]') } catch (e) { continue }
            if (hit) {
              if (!isFileInput(hit)) {
                // Wrong target — surface a structured signal so the caller can
                // tell the LLM exactly why upload failed (vs generic "not found").
                throw new Error('__ss_not_file_input__:' + ((hit.tagName || '') + (hit.getAttribute && hit.getAttribute('class') ? '.' + hit.getAttribute('class') : '')))
              }
              return hit
            }
          }
          // Fall through to auto-locate when ref'd element is gone (page mutated)
        }
        // Strategy 2: auto-locate first mounted file input
        for (const r of roots) {
          let cands
          try { cands = r.querySelectorAll('input[type="file"]') } catch (e) { continue }
          for (const el of cands) {
            if (isFileInput(el) && isMounted(el)) return el
          }
        }
        return null
      })()`
      let evalRes: { result?: { objectId?: string; subtype?: string }; exceptionDetails?: { exception?: { description?: string } } }
      try {
        evalRes = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression: findJs
        }) as typeof evalRes
      } catch (e) {
        return { ok: false, error: `定位文件输入框失败：${(e as Error).message}` }
      }
      // Distinguish "ref pointed at wrong element" from "no file input on page"
      const excDesc = evalRes.exceptionDetails?.exception?.description || ''
      if (excDesc.includes('__ss_not_file_input__:')) {
        const tail = excDesc.split('__ss_not_file_input__:')[1]?.split(/[\s"]/)[0] || '?'
        return { ok: false, error: `给定 ref 不是 <input type=file>，而是 ${tail}。请省略 ref 参数让上传自动定位，或先 web_snapshot 找到 input[type=file] 的 ref。` }
      }
      const objectId = evalRes.result?.objectId
      if (!objectId) {
        return {
          ok: false,
          error: ref
            ? '指定 ref 的元素已失效，且页面上找不到任何 <input type=file>——请确认已进入图文模式（先 web_click 点"图文/图片"tab），然后调 web_upload(filePaths) 省略 ref 自动定位。'
            : '页面上找不到任何 <input type=file>——请先 web_click 点"图文/图片"tab 切到图片编辑模式，再调 web_upload(filePaths)。'
        }
      }
      const autoLocated = !ref
      if (autoLocated) console.log('[web-automation] web_upload auto-located file input (no ref provided)')

      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        files: filePaths,
        objectId
      })
      // Detach BEFORE snapshotting so executeJavaScript doesn't compete with CDP.
      try { wc.debugger.detach() } catch { /* already detached */ }
      attached = false
      // Upload triggers a previewer / preview-grid render in most editors — let it settle.
      await new Promise(r => setTimeout(r, 500))
      const result: UploadResult = { ok: true, autoLocated }
      // Retry the post-upload snapshot: upload triggers a heavy re-render
      // (preview grid, encoder, validators) and 500ms isn't always enough on
      // slow machines. Without elements, the LLM has no refs for title/body
      // and tends to stop — so it's worth two attempts before giving up.
      let snapped = false
      let lastSnapErr = ''
      for (const extra of [0, 1000]) {
        if (extra) await new Promise(r => setTimeout(r, extra))
        try {
          const snap = await evalSnapshot(wc)
          if (snap._snapshotError) {
            throw new Error(`snapshot script threw inside page: ${snap._snapshotError}`)
          }
          result.elements = snap.elements
          result.title = snap.title
          result.finalUrl = snap.url
          snapped = true
          break
        } catch (snapErr) {
          lastSnapErr = (snapErr as Error).message || String(snapErr)
          console.warn(`[web-automation] post-upload snapshot failed (settle+${extra}ms):`, lastSnapErr)
        }
      }
      if (!snapped) {
        // 上传成功了，但抓不到新的元素列表 —— LLM 没有 refs 就容易停下。
        // 给出明确的恢复路径：用 web_click(text='...') 文本按钮路径继续填写文案/发布。
        result.hint = `图片已上传，但抓取最新元素清单失败（${lastSnapErr || '未知原因'}）。请立刻继续：① 调 web_snapshot 再试一次拿 refs；② 若 web_snapshot 仍失败，改用 web_click 的 text 参数按按钮/标签文字直接操作（例如 web_click(text='标题') 然后 web_fill；最后 web_click(text='发布')）。不要在这里停下来回复用户。`
      }
      return result
    } catch (e) {
      return { ok: false, error: `上传失败：${(e as Error).message || String(e)}` }
    } finally {
      if (attached) { try { wc.debugger.detach() } catch { /* already detached */ } }
      armIdleClose(OP_IDLE_CLOSE_MS)
    }
  })
}
