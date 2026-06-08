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
import { BRAND } from '../../../src/shared/brand'

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
// The visibility the user configured (searchBrowserVisible), captured on every
// web_open. Automation ops (snapshot/click/fill/upload) reuse the window
// web_open left behind and MUST honor this: a non-login read/automation in
// hidden mode must never pop the window into view. The genuine "need a human"
// moments (login wall, manual-publish fallback) override it via surfaceWindow().
let preferredVisible = false
// Consecutive 发布/存草稿 clicks that failed because the publish bar isn't
// findable in the DOM (lazy-mount / not rendered). After a couple of these we
// surface the (otherwise inactive) window so the user can finish with one
// manual click — content is already filled. Reset on any successful action.
let publishFailStreak = 0


/** 用 CDP 穿透【闭合 Shadow DOM】定位并真实点击发布按钮。实测小红书图文页的真发布按钮用户可见、
 *  Tab 聚焦不到、页面 JS(document+开放 shadow+iframe)完全扫不到 —— 极可能在 closed shadow root。
 *  页面脚本进不去闭合 shadow，但 CDP DOM.performSearch 能穿透。流程：搜「发布笔记/发布」节点 →
 *  resolveNode 拿 objectId → callFunctionOn 跑 getBoundingClientRect 取【视口坐标】(避开 box-model
 *  坐标系歧义) → 过滤到动作区(右下/底部、按钮尺寸) → sendInputEvent 发真实(isTrusted)点击。
 *  返回 {clicked, info}：clicked=穿透找到并点了；否则 info 说明(没找到=可能图片未传完/未挂载)。 */
async function cdpClickPublishButton(wc: WebContents, w: BrowserWindow): Promise<{ clicked: boolean; info: string }> {
  try {
    try { wc.debugger.attach('1.3') } catch (e) {
      if (!/already attached/i.test((e as Error).message || '')) return { clicked: false, info: 'CDP attach 失败' }
    }
    await wc.debugger.sendCommand('DOM.enable')
    await wc.debugger.sendCommand('Runtime.enable')
    // 取视口矩形 + tag/文本 + 【是否禁用】。小红书发布按钮在图片/封面上传到 CDN 完成前是 disabled 灰态,
    // 点了无反应(实测真因)。禁用判据:pointer-events:none / opacity<0.5 / 类名含 disab|gray|loading / aria-disabled。
    const RECT_FN = 'function(){var r=this.getBoundingClientRect();var cs=null;try{cs=getComputedStyle(this)}catch(e){}var cls="";try{cls=(typeof this.className==="string"?this.className:(this.className&&this.className.baseVal)||"")}catch(e){}var dis=false;try{dis=(!!cs&&(cs.pointerEvents==="none"||parseFloat(cs.opacity||"1")<0.5))||/disab|gray|grey|loading|uploading|不可/i.test(cls)||(this.getAttribute&&this.getAttribute("aria-disabled")==="true")||this.disabled===true}catch(e){}return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height,tag:(this.tagName||"").toLowerCase(),txt:(this.textContent||"").replace(/\\s+/g,"").slice(0,8),dis:dis,cls:String(cls).slice(0,30)});}'
    type Cand = { cx: number; cy: number; w: number; h: number; tag: string; txt: string; dis: boolean; cls: string }
    // 单次扫描：穿透闭合 shadow 找发布节点,返回动作区候选(按最靠下右排序)+ 概览/诊断。
    const scan = async (): Promise<{ inZone: Cand[]; overview: string; diag: string[] }> => {
      await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
      const all: Cand[] = []
      const diag: string[] = []
      for (const q of ['发布笔记', '发布', '立即发布', '提交', '存草稿']) {
        let searchId = '', count = 0
        try {
          const r = await wc.debugger.sendCommand('DOM.performSearch', { query: q, includeUserAgentShadowDOM: true }) as { searchId: string; resultCount: number }
          searchId = r.searchId; count = r.resultCount || 0
        } catch { diag.push(q + ':搜索异常'); continue }
        let got = 0
        if (count > 0) {
          let ids: number[] = []
          try {
            const rr = await wc.debugger.sendCommand('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: Math.min(count, 50) }) as { nodeIds: number[] }
            ids = rr.nodeIds || []
          } catch {}
          for (const nodeId of ids) {
            try {
              const rn = await wc.debugger.sendCommand('DOM.resolveNode', { nodeId }) as { object?: { objectId?: string } }
              const objectId = rn.object && rn.object.objectId
              if (!objectId) continue
              const cf = await wc.debugger.sendCommand('Runtime.callFunctionOn', { objectId, functionDeclaration: RECT_FN, returnByValue: true }) as { result?: { value?: string } }
              const v = cf.result && cf.result.value
              if (!v) continue
              const o = JSON.parse(v) as { l: number; t: number; w: number; h: number; tag: string; txt: string; dis: boolean; cls: string }
              if (!(o.w > 0 && o.h > 0)) continue
              got++
              all.push({ cx: Math.round(o.l + o.w / 2), cy: Math.round(o.t + o.h / 2), w: Math.round(o.w), h: Math.round(o.h), tag: o.tag, txt: o.txt, dis: !!o.dis, cls: o.cls })
            } catch {}
          }
        }
        diag.push(`${q}:${count}/${got}`)
        try { await wc.debugger.sendCommand('DOM.discardSearchResults', { searchId }) } catch {}
      }
      let vw = 1280, vh = 800
      try {
        const m = await wc.debugger.sendCommand('Page.getLayoutMetrics') as { cssVisualViewport?: { clientWidth: number; clientHeight: number }; visualViewport?: { clientWidth: number; clientHeight: number } }
        const vp = m.cssVisualViewport || m.visualViewport
        if (vp) { vw = vp.clientWidth || vw; vh = vp.clientHeight || vh }
      } catch {}
      const seen = new Set<string>()
      const overview = all.filter(c => { const k = c.tag + c.txt + c.w + c.h + c.cx; if (seen.has(k)) return false; seen.add(k); return true })
        .slice(0, 8).map(c => `${c.tag}·${c.txt}·${c.w}x${c.h}@${c.cx},${c.cy}${c.dis ? '·禁用' : ''}`).join(' ; ')
      // 动作区:按钮尺寸 + 非左侧栏(x>220) + 视口下半(y>40%) + 视口内。宽度上限 760(全宽发布栏 xhs-publish-btn 680x90)。
      const inZone = all.filter(c => c.w >= 40 && c.w <= 760 && c.h >= 20 && c.h <= 140
        && c.cx > Math.min(220, vw * 0.18) && c.cy > vh * 0.4 && c.cy < vh + 40 && c.cx < vw + 40)
      inZone.sort((a, b) => (b.cy - a.cy) || (b.cx - a.cx))  // 真提交按钮在右下:最靠下、再靠右
      return { inZone, overview, diag }
    }
    // 轮询等【启用】再点:发布按钮在图片/封面传完前禁用,点了无效。最多 ~30s 覆盖 CDN 上传。
    let lastInfo = ''
    for (let round = 0; round < 15; round++) {
      const { inZone, overview, diag } = await scan()
      if (!inZone.length) {
        lastInfo = `穿透[${diag.join(',')}] 候选[${overview || '无'}]→动作区无发布按钮`
      } else {
        const pick = inZone[0]
        lastInfo = `${pick.tag}·${pick.cls}·${pick.w}x${pick.h}@${pick.cx},${pick.cy}${pick.dis ? '·禁用(等上传)' : '·可点'} [${diag.join(',')}]`
        if (!pick.dis) {
          // 点击前把窗口聚焦置顶(真人成功时窗口在前台有焦点)
          try {
            if (w.isMinimized()) w.restore()
            w.show(); w.moveTop(); w.focus(); wc.focus()
          } catch { /* window torn down */ }
          await new Promise(r => setTimeout(r, 250))
          // 诊断:用 getNodeForLocation 报告点击点(cx,cy)【实际命中的节点】(含闭合 shadow),验证坐标是否
          // 真落在发布按钮上——若命中的不是 xhs-publish-btn/其子节点,说明 680 宽栏中心是空档,要换点位。
          let hit = ''
          try {
            const loc = await wc.debugger.sendCommand('DOM.getNodeForLocation', { x: pick.cx, y: pick.cy, includeUserAgentShadowDOM: true }) as { backendNodeId?: number }
            if (loc.backendNodeId) {
              const rn = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: loc.backendNodeId }) as { object?: { objectId?: string } }
              const oid = rn.object && rn.object.objectId
              if (oid) {
                const d = await wc.debugger.sendCommand('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: 'function(){var c=(typeof this.className==="string"?this.className:(this.className&&this.className.baseVal)||"");return (this.tagName||"").toLowerCase()+"."+String(c).slice(0,24);}', returnByValue: true }) as { result?: { value?: string } }
                hit = (d.result && d.result.value) || ''
              }
            }
          } catch { /* 诊断失败不影响点击 */ }
          // 真实点击:优先 CDP Input.dispatchMouseEvent(Playwright 发小红书成功用的就是这个,比
          // webContents.sendInputEvent 更底层、更接近真实输入);失败再退回 sendInputEvent。
          try {
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pick.cx, y: pick.cy, buttons: 0 })
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pick.cx, y: pick.cy, button: 'left', buttons: 1, clickCount: 1 })
            await new Promise(r => setTimeout(r, 50))
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pick.cx, y: pick.cy, button: 'left', buttons: 0, clickCount: 1 })
          } catch {
            wc.sendInputEvent({ type: 'mouseMove', x: pick.cx, y: pick.cy })
            wc.sendInputEvent({ type: 'mouseDown', x: pick.cx, y: pick.cy, button: 'left', clickCount: 1 })
            await new Promise(r => setTimeout(r, 40))
            wc.sendInputEvent({ type: 'mouseUp', x: pick.cx, y: pick.cy, button: 'left', clickCount: 1 })
          }
          // 二次确认:点发布后可能弹【确认弹窗】(同样可能在闭合 shadow,我们快照看不到→没点确认→没真发)。
          // 等一下,穿透搜【明确的发布确认词】(不用裸"确认/确定"以免误点)并真实点击。没有就跳过。
          let confirmInfo = '无确认弹窗'
          await new Promise(r => setTimeout(r, 1300))
          try {
            for (const cq of ['确认发布', '确定发布', '确认并发布', '立即发布']) {
              let sid = ''
              try {
                const sr = await wc.debugger.sendCommand('DOM.performSearch', { query: cq, includeUserAgentShadowDOM: true }) as { searchId: string; resultCount: number }
                sid = sr.searchId
                if (sr.resultCount > 0) {
                  const gr = await wc.debugger.sendCommand('DOM.getSearchResults', { searchId: sid, fromIndex: 0, toIndex: Math.min(sr.resultCount, 20) }) as { nodeIds: number[] }
                  for (const nid of (gr.nodeIds || [])) {
                    try {
                      const rn = await wc.debugger.sendCommand('DOM.resolveNode', { nodeId: nid }) as { object?: { objectId?: string } }
                      const oid = rn.object && rn.object.objectId; if (!oid) continue
                      const cf = await wc.debugger.sendCommand('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: RECT_FN, returnByValue: true }) as { result?: { value?: string } }
                      const cv = cf.result && cf.result.value; if (!cv) continue
                      const co = JSON.parse(cv) as { l: number; t: number; w: number; h: number; dis: boolean }
                      if (co.w >= 40 && co.w <= 420 && co.h >= 20 && co.h <= 110 && !co.dis) {
                        const ccx = Math.round(co.l + co.w / 2), ccy = Math.round(co.t + co.h / 2)
                        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ccx, y: ccy, buttons: 0 })
                        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: ccx, y: ccy, button: 'left', buttons: 1, clickCount: 1 })
                        await new Promise(r => setTimeout(r, 50))
                        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ccx, y: ccy, button: 'left', buttons: 0, clickCount: 1 })
                        confirmInfo = `点了确认「${cq}」@${ccx},${ccy}`
                        break
                      }
                    } catch { /* skip node */ }
                  }
                }
              } finally { if (sid) { try { await wc.debugger.sendCommand('DOM.discardSearchResults', { searchId: sid }) } catch {} } }
              if (confirmInfo.startsWith('点了')) break
            }
          } catch { /* 确认步骤 best-effort */ }
          return { clicked: true, info: `CDP-Input点击@${pick.cx},${pick.cy} 命中[${hit || '未知'}] | ${confirmInfo}(已聚焦,等${round * 2}s启用) ${lastInfo}` }
        }
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    return { clicked: false, info: `等待~30s 发布按钮仍禁用/未出现——图片或封面可能尚未上传完成。${lastInfo}` }
  } catch (e) {
    return { clicked: false, info: 'CDP点击异常:' + ((e as Error).message || String(e)) }
  } finally {
    // 用完必须 detach：debugger 常驻会干扰后续页面的 executeJavaScript(通用登录检测/快照就走 execJs),
    // 之前文件框拦截把它挂着不放,导致「通用页面登录检测失效」。这里恢复"只临时附加"的原状。
    try { wc.debugger.detach() } catch { /* already detached */ }
  }
}

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
  // Block page-initiated navigations to non-web schemes. Pages often deep-link to
  // native apps via custom protocols (bitbrowser://, weixin://, tg://, mailto:…);
  // Chromium hands an unknown scheme to the OS, which on Win11 pops a "选择要打开
  // 此链接的应用" dialog mid-automation. This surface only ever wants the web, so
  // we drop anything outside http/https/about/data/blob. Our own programmatic
  // loadURL() does NOT emit will-navigate, so normal browsing is unaffected.
  const blockNonWebNav = (e: Electron.Event, url: string): void => {
    if (!/^(https?|about|data|blob):/i.test(url)) {
      e.preventDefault()
      console.warn('[web-browse] blocked non-web navigation:', url.slice(0, 80))
    }
  }
  win.webContents.on('will-navigate', blockNonWebNav)
  win.webContents.on('will-redirect', blockNonWebNav)
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

/**
 * Run page JS inside a SPECIFIC frame's own context via WebFrameMain. Unlike
 * wc.executeJavaScript (main frame only, blind to cross-origin iframes), this
 * reaches into cross-origin sub-frames — needed because 小红书 creator 的发布
 * 按钮渲染在一个 iframe 里，主框架脚本 querySelectorAll 永远找不到它。
 */
function execJsInFrame<T>(frame: Electron.WebFrameMain, js: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`frame script timed out (${timeoutMs}ms)`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([frame.executeJavaScript(js) as Promise<T>, timeout])
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
    name.textContent = '${BRAND.displayName}'
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

  // Remember the user's 显示/不显示 choice so the automation ops that reuse this
  // window (web_snapshot/click/fill/upload) don't force it visible behind the
  // user's back when they opted into hidden mode.
  preferredVisible = !!opts.browserVisible

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
  // Honor the user's 不显示浏览器 setting: only auto-surface the window for
  // automation when web_open opened it visibly. In hidden mode a non-login
  // snapshot/click/fill/upload stays hidden — the genuine "need a human" moments
  // (login wall, manual-publish fallback) call surfaceWindow() to override this
  // regardless of the setting, so captcha / 2FA / sliders are still reachable
  // when they actually block the flow.
  if (preferredVisible && !win.isVisible()) { try { win.showInactive() } catch { /* gone */ } }
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
  /** Click only (coordsOnly mode): viewport-center coords of the resolved element,
   *  so the MAIN PROCESS can dispatch a TRUSTED (isTrusted=true) OS-level click via
   *  webContents.sendInputEvent. Synthetic in-page clicks have isTrusted=false and
   *  some強校验 SPA buttons (小红书「发布」) silently ignore them. */
  clickX?: number
  clickY?: number
}

// Find the [data-ss-ref] element across light + shadow trees, then perform the
// action. Returns { ok, error? }. Built per-call with the action JSON inlined.
function buildActJs(action: PageAction, opts: { coordsOnly?: boolean } = {}): string {
  const payload = JSON.stringify(action)
  return `(async () => {
  const action = ${payload}
  const COORDS_ONLY = ${opts.coordsOnly ? 'true' : 'false'}
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
  try {
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
    // Navigation containers — when multiple candidates share the same text
    // (e.g. "发布笔记" appears on both the sidebar nav AND the in-page button),
    // we want the in-form button to win. Walk up to ~8 ancestors for nav signals.
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
    // visible. 小红书 发布按钮就是 <button class="ce-btn bg-red">发布</button>。
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
      if (/\\b(bg-red|btn-danger|btn-primary|is-primary|primary|danger|cta)\\b/i.test(cls)) s += 2
      if (inNavLike(e)) s -= 6
      return s
    }
    // “发布/提交类真按钮”：真 <button>/submit + 红色/主色/publish 类名。小红书真发布按钮是
    // <button class="ce-btn bg-red">发布</button>；侧栏「发布笔记」既非精确文本也无此类名。
    const isPublishStyled = (e) => {
      try { return isRealButton(e) && /\\b(bg-red|btn-danger|btn-primary|is-primary|primary|danger|publish|submit|ce-btn)\\b/i.test(e.getAttribute('class') || '') } catch (x) { return false }
    }
    // CTA-like 但非真 <button>：现代 SPA(小红书)把提交按钮做成 <div class="publish-video">→
    // <div class="btn-wrapper">→<span class="btn-text">发布笔记</span> 这种嵌套 div/span，无 button
    // 标签/role。实测小红书图文页真发布按钮就是这形态(文本是「发布笔记」不是「发布」)。放宽到
    // 「带 btn/button/publish/submit/cta 类名 + 可见 + 非 nav」也算候选，否则真按钮永远点不到。
    const areaOf = (e) => { try { const r = e.getBoundingClientRect(); return r.width * r.height } catch (x) { return 0 } }
    // 仅认【强提交类名】publish/submit/ce-btn/publishbtn——不要泛用 btn(菜单项也带 btn 会误中)。
    const SUBMIT_CLASS_RE = /\\b([\\w-]*(publish|submit|ce-btn|publishbtn)[\\w-]*)\\b/i
    // 排除【模式切换/菜单】项：「发布视频/发布图文/发布长文/直播」等——它们点了会跳去别的发布流、
    // 把当前图文编辑器内容丢光(实测 text=发布 误中「发布视频」→ target=video 全丢)。按文本判断。
    const MODE_SWITCH_RE = /(视频|图文笔记|图文|长文|直播|live|video)/i
    // 真提交按钮永远在表单【右下/底部动作区】——绝不在左侧栏(x 很小)或顶栏(y 很小)。那两处带「发布」
    // 字样的多是导航/「发布笔记」侧栏入口/「发布视频」模式切换菜单,点了会跳页或切视频把已填内容丢光
    // (实测 text=发布 误中左上(104,102)的侧栏项 → target=video 全丢)。inNavLike 抓不全小红书侧栏,故用位置兜底。
    const inActionZone = (e) => {
      try {
        const r = e.getBoundingClientRect()
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2
        const vw = window.innerWidth || 1280, vh = window.innerHeight || 800
        return cx > Math.min(220, vw * 0.18) && cy > vh * 0.4
      } catch (x) { return false }
    }
    const isSubmitBtn = (e) => {
      try {
        if (inNavLike(e)) return false
        const r = e.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) return false
        if (!SUBMIT_CLASS_RE.test(e.getAttribute('class') || '')) return false
        const t = norm(e.textContent || e.value || '')
        if (MODE_SWITCH_RE.test(t)) return false
        if (!inActionZone(e)) return false
        return true
      } catch (x) { return false }
    }
    // 真提交按钮醒目(小红书 div.publish-video 约 208x76),菜单/切换项小——挑【面积最大】的强提交元素。
    // 点击时再用 elementFromPoint 命中其中心的最上层节点、靠冒泡触达挂在容器上的 handler(见下方点击派发)。
    // 若动作区没有任何强提交元素 → 返回 null(上层报「未挂载」让 agent 等/兜底显形),绝不退而点顶栏/侧栏。
    const submitPick = (arr) => {
      const c = arr.filter(isSubmitBtn)
      if (!c.length) return null
      c.sort((a, b) => areaOf(b) - areaOf(a))
      return c[0]
    }
    // 收集文字匹配 want 的候选：精确(exact)与包含(partial)分开返回，各自按分排序。
    const collect = () => {
      const exact = [], partial = []
      for (const r of roots) {
        let cands
        try { cands = r.querySelectorAll(sel) } catch (e) { continue }
        for (const c of cands) {
          if (c.childElementCount > 8) continue  // 跳过大容器，只要叶子控件
          const t = norm(c.textContent || c.value || c.getAttribute('aria-label') || '')
          if (!t || !want) continue
          if (t === want) exact.push(c)
          else if (t.indexOf(want) !== -1 && t.length <= want.length + 6) partial.push(c)
        }
      }
      exact.sort((a, b) => scoreOf(b) - scoreOf(a))
      partial.sort((a, b) => scoreOf(b) - scoreOf(a))
      return { exact, partial }
    }
    const ACTION_WORDS_RE = /^(发布|立即发布|提交|确认|发送|确定|完成|保存|Submit|Send|Post|Publish|Save)$/i
    const isActionWord = ACTION_WORDS_RE.test(want)
    // 在精确(exact)+包含(partial)两组候选里挑「最像表单提交按钮」的：① 表单内(非导航)精确真按钮
    // → ② 精确的红/主色 CTA 按钮(即便祖先 class 被 nav 误命中) → ③ partial 里的红/主色非导航真按钮
    // (覆盖「发布(1/9)」这类带计数/图标、文本非纯「发布」的真按钮) → ④ 表单内任意精确元素。
    // 永远【不返回】导航/侧栏里的元素——侧栏「发布笔记」既无 CTA 类名又在 nav，必被排除。
    const pickAction = (exact, partial) =>
      exact.find(c => isRealButton(c) && !inNavLike(c))
      || exact.find(c => isPublishStyled(c))
      || partial.find(c => isPublishStyled(c) && !inNavLike(c))
      || submitPick(exact)               // 精确文本的强提交 div/span(排除菜单/模式切换)
      || submitPick(partial)             // partial 文本的强提交元素 —— 覆盖「发布笔记」这种 div 提交按钮
      || exact.find(c => !inNavLike(c))
      || null
    let { exact, partial } = collect()
    if (isActionWord) {
      // 真发布按钮常在表单底部惰性挂载、且要等图片处理完才挂载/启用。挑不到时把页面+所有内部
      // 可滚动容器滚到底、等一下再找，最多 4 轮(~3.2s) 覆盖图片处理延迟；仍无则带诊断报错，绝不误点侧栏。
      let best = pickAction(exact, partial)
      for (let attempt = 0; attempt < 4 && !best; attempt++) {
        try { window.scrollTo(0, document.body.scrollHeight) } catch (e) {}
        try { const se = document.scrollingElement || document.documentElement; se.scrollTop = se.scrollHeight } catch (e) {}
        try {
          let n = 0
          for (const sc of document.querySelectorAll('*')) {
            if (n > 60) break
            try { if (sc.scrollHeight - sc.clientHeight > 120) { sc.scrollTop = sc.scrollHeight; n++ } } catch (e) {}
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 800))
        ;({ exact, partial } = collect())
        best = pickAction(exact, partial)
      }
      el = best
      if (!el) {
        // 全景诊断：URL/标题 + 可见弹窗的 class + 页面上所有「下一步/确认/完成/发布/提交」类
        // 候选(任意标签|尺寸|是否可见) —— 判断 agent 卡在哪个视图、真正该点的是什么。
        let diag = ''
        try {
          const NEXT_RE = /^(发布|立即发布|提交|确认|确定|完成|保存|下一步|继续|next|continue|publish|submit|post|done|save)$/i
          const acts = [], modalCls = []
          for (const r of roots) {
            let all; try { all = r.querySelectorAll('*') } catch (e) { continue }
            for (const e of all) {
              try {
                const cls = (e.getAttribute && e.getAttribute('class')) || ''
                if (modalCls.length < 6 && !/hover/i.test(cls) && /\\b([\\w-]*(modal|dialog|popup|drawer|overlay|mask)[\\w-]*)\\b/i.test(cls)) {
                  let vis = false; try { const rr = e.getBoundingClientRect(); vis = rr.width > 30 && rr.height > 30 } catch (x) {}
                  if (vis) modalCls.push(cls.slice(0, 26))
                }
                if (acts.length < 16 && e.childElementCount <= 1) {
                  const t = norm(e.textContent || e.value || '')
                  if (t && NEXT_RE.test(t)) {
                    let rc = '?'; try { const r2 = e.getBoundingClientRect(); rc = Math.round(r2.width) + 'x' + Math.round(r2.height) } catch (x) {}
                    acts.push((e.tagName || '').toLowerCase() + '·' + t.slice(0, 6) + '·' + cls.slice(0, 16) + '|' + rc + (inNavLike(e) ? '|nav' : ''))
                  }
                }
              } catch (x) {}
            }
          }
          // 发布按钮专项搜寻：动作候选(NEXT_RE 精确 + childCount<=1)会漏掉「发布笔记」「发布(1/1)」、
          // 文本埋更深、或 class=submitBtn 的真按钮。这里放宽——任意标签、文本【包含】发布类词(≤12字)
          // 或 class 含 submit/publish 即报，带 tag·自身文本·class·尺寸·隐藏·nav。下次失败一看便知发布
          // 按钮到底是什么形态/在不在 DOM。
          const PUB_RE = /(发布|发表|存草稿|暂存|提交|publish|submit)/i
          const pubHits = []; const seenK = {}
          for (const r of roots) {
            let all2; try { all2 = r.querySelectorAll('button,[role="button"],a,div,span,li,[class*="submit"],[class*="publish"],[class*="footer"]') } catch (e) { continue }
            for (const e of all2) {
              if (pubHits.length >= 14) break
              try {
                const cls = (e.getAttribute && e.getAttribute('class')) || ''
                // 自身直接文本，避免父容器把整页文本算进来
                let own = ''
                try { for (const n of e.childNodes) { if (n.nodeType === 3) own += n.textContent } } catch (x) {}
                const t = norm(own) || norm(e.textContent || e.value || '')
                const clsHit = /submit|publish/i.test(cls)
                if (!((PUB_RE.test(t) && t.length <= 12) || clsHit)) continue
                let rc = '?', xy = '', vis = false; try { const rr = e.getBoundingClientRect(); rc = Math.round(rr.width) + 'x' + Math.round(rr.height); xy = '@' + Math.round(rr.left + rr.width / 2) + ',' + Math.round(rr.top + rr.height / 2); vis = rr.width > 0 && rr.height > 0 } catch (x) {}
                const key = (e.tagName || '') + '|' + t.slice(0, 10) + '|' + cls.slice(0, 20)
                if (seenK[key]) continue; seenK[key] = 1
                pubHits.push((e.tagName || '').toLowerCase() + '·' + (t.slice(0, 8) || '∅') + '·' + cls.slice(0, 22) + '|' + rc + xy + (vis ? '' : '|hidden') + (inNavLike(e) ? '|nav' : ''))
              } catch (x) {}
            }
          }
          let elCount = 0; try { elCount = document.querySelectorAll('*').length } catch (e) {}
          let ifr = 0; try { ifr = document.querySelectorAll('iframe').length } catch (e) {}
          let title = ''; try { title = (document.title || '').slice(0, 30) } catch (e) {}
          diag = ' || 全景 url=' + location.host + location.pathname.slice(0, 28) + ' 标题=' + title
               + ' 弹窗[' + (modalCls.join(' , ') || '无') + ']'
               + ' 动作候选' + acts.length + '：' + (acts.join(' ; ') || '无') + ' roots=' + roots.length
               + ' 发布搜寻' + pubHits.length + '：' + (pubHits.join(' ; ') || '无') + ' 元素数=' + elCount + ' iframe=' + ifr
        } catch (e) {}
        // 发布栏整组(发布/存草稿)都不在 DOM。关键：要先分清「还没进编辑器(残缺壳)」与「已在编辑器、
        // 只是发布栏暂未挂载」——后者若误判成前者、让 agent 重开 /new/home，会把已填的标题/正文/图片
        // 全部丢掉、陷入死循环。editorActive：标题/正文编辑器或已上传图片在场 = 确实在真编辑器里。
        let editorActive = false
        try {
          editorActive = !!(
            document.querySelector('input[placeholder*="标题"], textarea, [contenteditable="true"], .ql-editor, [class*="titleInput"], [class*="title-input"]')
            || document.querySelector('.hover-mask, [class*="img"] img, [class*="preview"] img, [class*="upload"] img')
          )
        } catch (e) {}
        const onPublish = /publish|create|compose|editor|new[-_/]?post/i.test(location.href)
        const guide = editorActive
          ? '已在编辑器内（标题/正文/图片在场），只是「发布/存草稿」栏暂未挂载——【不要重开页面、不要走草稿箱】，已填内容还在。最可能：① 图片仍在处理（等 2-3 秒后再 web_snapshot → web_click(text=「发布」) 重试）；② 见上方「弹窗[…]」有遮罩挡住发布区（先点遮罩里的关闭/完成按钮、或点遮罩外空白处把它关掉，再点发布）。继续在本页面等待+重试即可。'
          : onPublish
            ? '页面没有任何「发布/存草稿」控件——发布区未挂载。小红书最常见原因：① 直开了 /publish/publish（残缺壳，发布栏不挂载）——正确做法是 web_open https://creator.xiaohongshu.com/new/home 再 web_click(text=「发布笔记」) 进编辑器；② 图片还没上传完（标题/正文/发布都要等图片处理完才出现）。请按此重走，不要走草稿箱恢复。'
            : '页面上找不到「' + action.text + '」按钮。请 web_snapshot 看看当前有哪些元素。'
        return { ok: false, finalUrl: location.href, error: guide + diag }
      }
    } else {
      const pool = exact.length ? exact : partial
      el = pool[0] || null
      if (!el) return { ok: false, finalUrl: location.href, error: '页面上找不到文字为「' + action.text + '」的可点击元素，请先 web_snapshot 看看现在有哪些元素' }
    }
  }
  if (!el) return { ok: false, finalUrl: location.href, error: '元素已失效，请重新 web_snapshot' }

  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}

  if (action.type === 'click') {
    try {
      // 在元素中心用 elementFromPoint 命中【真实最上层节点】(可能是更深的子节点),再带坐标派发完整
      // pointer/mouse 序列——事件向上冒泡,能触达挂在任意祖先(如 div.publish-video)上的 click handler。
      // 比直接在容器上 el.click() 更接近真人点击,div 假按钮(无 button 标签/role,Tab 也聚焦不到)也能触发。
      let target = el, cx, cy
      try {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          cx = Math.floor(r.left + r.width / 2)
          cy = Math.floor(r.top + r.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          if (hit && (hit === el || el.contains(hit))) target = hit
        }
      } catch (e) {}
      // 主框架优先返回坐标，让主进程用 sendInputEvent 发【真实(isTrusted)】点击——小红书发布按钮
      // 等强校验控件忽略合成事件。坐标拿不到(无尺寸/异常)时退回页面内合成点击。
      if (COORDS_ONLY && cx != null && cy != null) {
        return { ok: true, finalUrl: location.href, clickX: cx, clickY: cy }
      }
      const opts = (cx != null && cy != null)
        ? { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }
        : { bubbles: true, cancelable: true, view: window }
      target.dispatchEvent(new MouseEvent('pointerdown', opts))
      target.dispatchEvent(new MouseEvent('mousedown', opts))
      target.dispatchEvent(new MouseEvent('mouseup', opts))
      target.click()
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
        // REPLACE, not append. 小红书自研编辑器对合成 paste 不会删除选区，导致第二次 fill
        // 把正文整段追加、出现重复。所以每次插入前【显式清空】：选中全部→execCommand('delete')
        // →仍未空则硬清 textContent。这样 fill 幂等(重填=覆盖)、且空字符串能真正清空。
        const clearAll = () => {
          selectAll()
          try { document.execCommand('delete', false) } catch (e) {}
          try {
            if ((el.textContent || '').length) {
              el.textContent = ''
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
            }
          } catch (e) {}
        }
        clearAll()

        const want = v.replace(/\\s+/g, ' ').trim()
        // 空值 = 只清空。clearAll 已执行，回读确认确实清空了。
        if (want.length === 0) {
          await new Promise(r => setTimeout(r, 50))
          const got0 = (el.textContent || '').replace(/\\s+/g, ' ').trim()
          if (got0.length === 0) return { ok: true, finalUrl: location.href }
          return { ok: false, finalUrl: location.href, error: '清空失败：富文本编辑器仍保留内容（回读："' + got0.slice(0, 40) + '"）。' }
        }
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

        // 2. execCommand fallback. 先 clearAll 抹掉上一策略可能插入的残片，避免叠加。
        if (!res.ok) {
          clearAll()
          try { document.execCommand('insertText', false, v) } catch (e) {}
          await new Promise(r => setTimeout(r, 100))
          res = checkOk()
        }

        // 3. beforeinput + raw mutation fallback.
        if (!res.ok) {
          clearAll()
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
  } catch (__e) {
    // 顶层兜底：任何未被内层 try 捕获的运行时异常都返回结构化错误，绝不让脚本 reject 成
    // "Script failed to execute"（那样既不可操作、也看不到真实原因）。
    return { ok: false, finalUrl: (typeof location !== 'undefined' ? location.href : ''), error: 'click 脚本运行时异常：' + (__e && __e.message ? __e.message : String(__e)) }
  }
})()`
}

/** Click / fill / select on a previously-snapshotted element (by ref). Never
 *  navigates by itself, but the page's own handlers may. */
export async function actOnPage(action: PageAction): Promise<ActResult> {
  return withMutex(async () => {
    const { w, wc } = requireWindow()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    try {
      // 主框架点击：让页面脚本只【解析坐标】，再由主进程用 sendInputEvent 发真实(isTrusted)点击。
      let result = await execJs<ActResult>(wc, buildActJs(action, { coordsOnly: action.type === 'click' }), EXTRACT_TIMEOUT_MS)
      if (action.type === 'click' && result.ok && typeof result.clickX === 'number' && typeof result.clickY === 'number') {
        const x = result.clickX, y = result.clickY
        try {
          // 真实鼠标点击：经 Chromium 输入管线，isTrusted=true，等同真人——合成 click 点不动的强校验
          // 按钮(小红书「发布」)这样才会响应。move→down→(短延时)→up 贴近真人节奏。
          wc.sendInputEvent({ type: 'mouseMove', x, y })
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          await new Promise(r => setTimeout(r, 30))
          wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        } catch (e) {
          // sendInputEvent 不可用 → 退回页面内合成点击，保证不比以前差。
          console.warn('[web-automation] sendInputEvent failed, fallback to synthetic click:', (e as Error).message)
          result = await execJs<ActResult>(wc, buildActJs(action, { coordsOnly: false }), EXTRACT_TIMEOUT_MS)
        }
      }
      // 跨框架兜底：主框架找不到目标时，元素可能在(跨域)子 iframe 里——小红书发布按钮就渲染在
      // 一个 iframe 中，主框架 querySelectorAll 永远抓不到。用 WebFrameMain 在每个子框架各自
      // 上下文里跑同一脚本（含按文本定位 + 滚动重试），取第一个成功的。
      // 触发条件必须涵盖动作词(发布/提交)找不到时的 guide 文案——它说的是「发布区未挂载/
      // 没有任何…控件」而非「找不到」。小红书的真发布按钮就在 about:blank iframe 里，主框架
      // 必然返回「未挂载」；若这里漏掉这些词，跨框架兜底永不触发 → 永远进不了那个 iframe。
      if (!result.ok && /找不到|失效|不存在|未挂载|没有任何/.test(result.error || '')) {
        const frameDiag: string[] = []
        try {
          const frames = wc.mainFrame.framesInSubtree
          for (const f of frames) {
            // 不跳过 about:blank！小红书把编辑器+发布按钮用 JS 注入到 about:blank iframe，
            // 页面脚本的 contentDocument 遍历常拿不到，但 WebFrameMain 能直接进它的真实上下文。
            if (f === wc.mainFrame) continue
            try {
              const r2 = await execJsInFrame<ActResult>(f, buildActJs(action), EXTRACT_TIMEOUT_MS)
              if (r2 && r2.ok) { result = r2; break }
            } catch { /* detached / dead frame — skip */ }
            // 还没成功 → 探测该框架：URL + 按钮数 + 是否有「发布/提交」类按钮，定位真按钮在哪个框架。
            if (!result.ok) {
              try {
                const probe = await execJsInFrame<string>(f, `(()=>{try{const bs=[...document.querySelectorAll('button,[role=\"button\"],input[type=\"submit\"],input[type=\"button\"]')];const all=[...document.querySelectorAll('button,[role=\"button\"],a,div,span,li,[class*=\"submit\"],[class*=\"publish\"],[class*=\"footer\"]')];const norm=s=>(s||'').replace(/\\s+/g,'');const pub=[];const seen={};for(const e of all){if(pub.length>=8)break;try{let own='';for(const n of e.childNodes){if(n.nodeType===3)own+=n.textContent}const t=norm(own)||norm(e.textContent||e.value||'');const cls=(e.getAttribute&&e.getAttribute('class'))||'';if(!((/(发布|发表|存草稿|暂存|提交|publish|submit)/i.test(t)&&t.length<=12)||/submit|publish/i.test(cls)))continue;const k=(e.tagName||'')+t.slice(0,8)+cls.slice(0,16);if(seen[k])continue;seen[k]=1;let rc='?';try{const r=e.getBoundingClientRect();rc=Math.round(r.width)+'x'+Math.round(r.height)}catch(x){}pub.push((e.tagName||'').toLowerCase()+'·'+(t.slice(0,8)||'∅')+'·'+cls.slice(0,18)+'|'+rc)}catch(x){}}return JSON.stringify({u:location.host+location.pathname.slice(0,24),n:bs.length,el:document.querySelectorAll('*').length,pub})}catch(e){return JSON.stringify({err:String(e&&e.message||e).slice(0,30)})}})()`, 4000)
                frameDiag.push(probe)
              } catch (e) { frameDiag.push('{probe-timeout:' + f.url.slice(0, 40) + '}') }
            }
          }
        } catch { /* framesInSubtree unavailable — keep main-frame result */ }
        if (!result.ok) {
          // [cf:N] 是构建标记——只要报错里看到它，就证明跑的是含跨框架兜底的最新代码。
          let nFrames = 0
          try { nFrames = wc.mainFrame.framesInSubtree.length - 1 } catch { /* ignore */ }
          result = { ...result, error: (result.error || '') + ' || [cf:' + nFrames + ']' + (frameDiag.length ? ' 子框架：' + frameDiag.join(' ;; ') : '（无可探测子框架）') }
        }
      }
      const targetLabel = action.type === 'click' ? (action.ref || `text:${action.text ?? ''}`) : action.ref
      console.log('[web-automation]', action.type, targetLabel, '→', result.ok ? 'ok' : `fail: ${result.error}`)
      // Graceful fallback: when a 发布/存草稿 click keeps failing because the publish
      // bar can't be found in the DOM (lazy-mount this version doesn't expose) but the
      // editor IS active (content filled), surface the window so the user finishes with
      // one manual click. The agent CAN'T do it and telling it to "wait" just loops.
      const isPublishClick = action.type === 'click' &&
        /^(发布|立即发布|存草稿|暂存离开|暂存|提交|发布笔记)$/.test((action.text || '').replace(/\s+/g, ''))
      // 闭合 Shadow 兜底：小红书(及抖音等创作平台)真发布按钮常在 closed shadow root,页面 JS/快照/text
      // 点击都扫不到(用户可见、Tab 聚焦不到)。失败时用 CDP 穿透闭合 shadow 定位发布按钮并发真实点击;
      // 仍发不出去则弹窗交人工(半自动)。仅对已知创作平台启用,避免普通站点误触发。
      if (!result.ok && isPublishClick && /xiaohongshu\.com|douyin\.com/i.test(result.finalUrl || '') && /已在编辑器内|未挂载|找不到/.test(result.error || '')) {
        const cdp = await cdpClickPublishButton(wc, w)
        console.log('[web-automation] cdp publish fallback →', cdp.info)
        if (cdp.clicked) {
          // 点了不代表发布成功：小红书发布按钮可能因「未设封面/图片未传完」而禁用,点了无反应;发布也
          // 可能是异步的。轮询校验:编辑器(标题输入框)消失 / URL 跳走 / 出现「发布成功」=真发布。最多 ~6s。
          let published = false, detail = ''
          for (let i = 0; i < 4 && !published; i++) {
            await new Promise(r => setTimeout(r, 1500))
            try {
              const chk = await execJs<string>(wc, `(()=>{try{
                const editorGone = !document.querySelector('input[placeholder*="标题"],[class*="titleInput"] input,[class*="title-input"] input');
                const okToast = /发布成功|笔记发布成功|已发布|发布完成/.test(document.body.innerText||'');
                const url = location.href;
                // 真实成功信号:跳到成功页/作品管理页(小红书 publish/success、抖音 content/manage)
                const urlOk = /publish\\/success|content\\/manage|\\/success(\\?|$)/i.test(url);
                return JSON.stringify({editorGone, okToast, urlOk, url: location.pathname});
              }catch(e){return '{}'}})()`, 2000).catch(() => '{}')
              const o = JSON.parse(chk || '{}')
              detail = `editorGone=${o.editorGone} toast=${o.okToast} urlOk=${o.urlOk} path=${o.url}`
              if (o.okToast || o.urlOk || (o.editorGone && !/\/publish\/publish/.test(o.url || '/publish/publish'))) published = true
            } catch { /* keep polling */ }
          }
          if (published) {
            result = { ok: true, finalUrl: result.finalUrl, hint: `✅ 发布成功(真实点击发布按钮后页面已离开编辑器/出现成功提示)。${detail}` }
          } else {
            // 实测确认:小红书发布按钮在 closed shadow + 反自动化,程序点(含 CDP trusted Input)不生效,
            // 只有真人 OS 点击能发(用户已核实自动点击没真发出去)。→ 半自动:全自动到此,最后一步弹窗交人工。
            // 【硬性交接,让 agent 立即停手,绝不再点/不去草稿箱/不重开】——历史上正是反复重试攒出几十篇草稿。
            surfaceWindow(w)
            publishFailStreak = 0
            result = {
              ok: false, finalUrl: result.finalUrl,
              error: `全自动已完成到发布前的最后一步(标题/正文/图片/话题都填好了)。【最后一下「发布」无法自动完成】——该创作平台对发布按钮做了反自动化(按钮在闭合 shadow、程序点击即使真实输入也不生效,只有真人鼠标点击能发,已用真实输入+精确坐标+聚焦窗口验证过)。已把浏览器窗口弹到最前。【agent 必须立即停止本轮:不要再点发布、不要去草稿箱、不要重开页面、不要重填】。请把这句原样转告用户:「内容已全部填好,请在弹出的浏览器窗口右下角手动点一下『发布』即可完成发布。」`
            }
          }
        } else {
          result = { ...result, error: (result.error || '') + ' || [cdp] ' + cdp.info }
        }
      }
      if (result.ok) {
        publishFailStreak = 0
      } else if (isPublishClick && /已在编辑器内|未挂载|找不到/.test(result.error || '')) {
        publishFailStreak++
        if (publishFailStreak >= 2) {
          surfaceWindow(w)
          publishFailStreak = 0
          result = {
            ...result,
            error: (result.error || '') +
              ' || ⚠️ 已把浏览器窗口弹到最前并置顶：内容(标题/正文/图片/话题)已全部填好，但自动定位「发布」按钮多次失败（该按钮未渲染进可访问 DOM）。请在窗口右下角手动点一下「发布」即可完成发布——不要重开页面、不要走草稿箱。【agent 请停止自动重试，把这句原样转告用户并结束本轮，等待用户手动点发布。】'
          }
        }
      }
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
      // [WB#10] 构建标记：看到它=跑的是最新代码。若仍报笼统 "Script failed to execute"，
      // 说明 buildActJs 是【解析错】(内层 try 接不住)，我据此从 out/main 精确定位语法点。
      return { ok: false, finalUrl: '', error: '[WB#10] ' + msg }
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
      // 等图片上传完成（关键）：小红书等创作平台在图片处理完之前，标题/正文/发布区都不渲染
      // ——agent 这时填标题、点发布必然扑空（实测「发布按钮不在 DOM」的真因）。参考 1980⭐
      // xhs_ai_publisher 的 wait_for_upload_ready：轮询直到「标题输入框」可见，最多 ~45s。
      // 仅对小红书类站点做长等待，避免拖慢普通上传。
      try {
        const host = await execJs<string>(wc, 'location.host', 1500).catch(() => '')
        if (/xiaohongshu|xhs/i.test(host || '')) {
          const READY_JS = `(() => { try {
            const vis = (e) => { try { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' } catch (x) { return false } }
            for (const e of document.querySelectorAll('input,textarea,[contenteditable]')) {
              const p = (e.getAttribute && (e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '')) || ''
              if (/标题/.test(p) && vis(e)) return true
            }
            return false
          } catch (e) { return false } })()`
          const deadline = Date.now() + 45000
          let ready = false
          while (Date.now() < deadline) {
            try { if (await execJs<boolean>(wc, READY_JS, 2000)) { ready = true; break } } catch { /* keep polling */ }
            await new Promise(r => setTimeout(r, 1000))
          }
          console.log('[web-automation] upload-ready wait →', ready ? 'ready' : 'timeout')
          if (ready) await new Promise(r => setTimeout(r, 600))  // 标题区出现后再稳一下
        }
      } catch { /* wait is best-effort; fall through to snapshot */ }
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
