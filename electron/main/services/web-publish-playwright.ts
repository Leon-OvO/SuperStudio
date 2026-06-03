/**
 * Playwright-driven publishing to creator platforms (小红书 first).
 *
 * WHY a separate browser from web-browse.ts: 小红书/抖音 的发布按钮在 closed shadow +
 * 反自动化,Electron BrowserWindow + CDP/sendInputEvent 点了不发布(实测只生成草稿)。
 * 成熟开源方案(dreammis/social-auto-upload)用 Playwright 驱动【真实系统浏览器】+ 真实点击
 * `button:has-text("发布")` + `waitForURL(publish/success)`,能全自动发出去。
 *
 * 设计:独立 persistent context(登录态自持久,不碰 web-browse 的 persist:web-browse 分区),
 * 用系统 Chrome(channel=chrome)→ 回退 Edge(channel=msedge,Win10/11 必装),不下载浏览器。
 * 懒加载 playwright-core(参考 node-pty 懒加载),没装/启动失败给清晰报错。
 */
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { BrowserContext, Page } from 'playwright-core'
import { getSettings } from './store'

export interface XhsPublishParams {
  imagePaths: string[]
  title: string
  body: string
  topics?: string[]
}

export interface PublishResult {
  ok: boolean
  finalUrl?: string
  error?: string
  hint?: string
}

type Playwright = typeof import('playwright-core')
let _pw: Playwright | null = null
function loadPlaywright(): Playwright {
  if (_pw) return _pw
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _pw = require('playwright-core') as Playwright
    return _pw
  } catch (e) {
    throw new Error(`playwright-core 加载失败(发布功能需要):${(e as Error).message}。请确认已 npm install playwright-core。`)
  }
}

// One persistent context per platform (profile dir locks ⇒ singleton). Serialize all ops.
const contexts = new Map<string, BrowserContext>()
let mutex: Promise<unknown> = Promise.resolve()
async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutex
  let release: () => void = () => {}
  mutex = new Promise<void>(r => { release = r })
  try { await prev } catch { /* prior failure shouldn't block */ }
  try { return await fn() } finally { release() }
}

async function launchContext(platform: string, visible: boolean): Promise<BrowserContext> {
  const existing = contexts.get(platform)
  if (existing) {
    // 已有 context 但可见性不符(要扫码却是 headless)→ 关掉重开。
    const wantHeadless = !visible
    if ((existing as BrowserContext & { _ssHeadless?: boolean })._ssHeadless === wantHeadless) {
      try { if (existing.browser()?.isConnected()) return existing } catch { /* fallthrough */ }
    }
    try { await existing.close() } catch { /* ignore */ }
    contexts.delete(platform)
  }
  const pw = loadPlaywright()
  const profileDir = path.join(app.getPath('userData'), 'playwright-profiles', platform)
  fs.mkdirSync(profileDir, { recursive: true })
  // 真实系统浏览器,不下载 chromium:chrome 优先,回退 msedge(Win10/11 必装)。
  const channels = ['chrome', 'msedge']
  let lastErr: Error | null = null
  for (const channel of channels) {
    try {
      const ctx = await pw.chromium.launchPersistentContext(profileDir, {
        channel,
        headless: !visible,
        viewport: visible ? null : { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled']
      })
      ;(ctx as BrowserContext & { _ssHeadless?: boolean })._ssHeadless = !visible
      ctx.on('close', () => { if (contexts.get(platform) === ctx) contexts.delete(platform) })
      contexts.set(platform, ctx)
      console.log(`[pw-publish] launched ${platform} via channel=${channel} headless=${!visible}`)
      return ctx
    } catch (e) {
      lastErr = e as Error
      console.warn(`[pw-publish] channel=${channel} 启动失败:`, (e as Error).message)
    }
  }
  throw new Error(`无法启动浏览器(发布需要系统已安装 Chrome 或 Edge):${lastErr?.message || '未知错误'}`)
}

const XHS_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image'
const TITLE_SEL = 'input[placeholder*="标题"], input[placeholder*="填写标题"]'

const isLoginUrl = (u: string): boolean => /login|passport|sign[-_]?in/i.test(u)
const isPublishUrl = (u: string): boolean => /\/publish\/publish/.test(u)
// 登录就绪判据:**上传区的 input[type=file] 已挂载**(登录后的发布页一进去就有;未登录时是登录页没有它)。
// 不能用标题框——小红书图文标题框是【上传图片后】才挂载的,没传图时不在,会把"已登录"误判成"没登录"。
const pageReady = async (page: Page, ms: number): Promise<boolean> => {
  try { await page.locator("input[type='file'], " + TITLE_SEL).first().waitFor({ state: 'attached', timeout: ms }); return true }
  catch { return false }
}

/** 进入发布页;若未登录(上传区不出现),窗口本就可见,等用户扫码登录(最多 ~3min)。
 *  【关键:登录页/发布页【绝不重新导航/reload】——否则二维码会被反复刷掉,用户没法扫。
 *  只有"已登录但跳到了别的页"(非登录页且非发布页)时,才回发布页一次。】 */
async function ensureEditorReady(page: Page): Promise<{ ok: boolean; error?: string }> {
  if (await pageReady(page, 8000)) return { ok: true }
  try { await page.bringToFront() } catch { /* ignore */ }
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (await pageReady(page, 2500)) return { ok: true }
    const url = page.url()
    if (isLoginUrl(url) || isPublishUrl(url)) {
      // 登录页(用户正在扫码)或发布页(登录 modal / 还在加载):静等,绝不刷新。
      await page.waitForTimeout(1500)
    } else {
      // 已登录但被重定向到首页/别处 → 回发布页一次(这是唯一允许的导航)。
      try { await page.goto(XHS_PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }) } catch { /* keep polling */ }
    }
  }
  return { ok: false, error: '登录超时:请在弹出的浏览器里扫码登录小红书后,再让我重试发布。' }
}

const codePointSlice = (s: string, n: number): string => Array.from(s).slice(0, n).join('')

export async function publishXiaohongshuNote(p: XhsPublishParams): Promise<PublishResult> {
  return withMutex(async () => {
    if (!p.imagePaths?.length) return { ok: false, error: '没有图片可发(imagePaths 为空)。' }
    for (const ip of p.imagePaths) {
      if (!ip || !fs.existsSync(ip)) return { ok: false, error: `图片不存在:${ip}` }
    }
    // 浏览器可见性:跟随「设置 → 全局 → 浏览器」(searchBrowserVisible)。隐藏=headless;
    // 但首次需要扫码登录时,headless 看不到二维码 → 自动改用可见窗口让用户登录一次(登录态持久化,之后可隐藏跑)。
    const wantVisible = !!getSettings().searchBrowserVisible
    let ctx: BrowserContext
    try { ctx = await launchContext('xiaohongshu', wantVisible) } catch (e) { return { ok: false, error: (e as Error).message } }
    let page = ctx.pages()[0] || (await ctx.newPage())
    try {
      await page.goto(XHS_PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      // headless 且未登录(编辑器不出现)→ 关掉换可见窗口扫码登录。
      if (!wantVisible && !(await pageReady(page, 8000))) {
        console.log('[pw-publish] headless 下未登录,改用可见窗口让用户扫码')
        ctx = await launchContext('xiaohongshu', true)
        page = ctx.pages()[0] || (await ctx.newPage())
        await page.goto(XHS_PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      }
      const ready = await ensureEditorReady(page)
      if (!ready.ok) return { ok: false, finalUrl: page.url(), error: ready.error }

      // 1. 上传图片(set_input_files,不触发原生文件框)
      const fileInput = page.locator("div[class^='upload-content'] input[type='file'], input.upload-input, input[type='file']").first()
      await fileInput.setInputFiles(p.imagePaths, { timeout: 30_000 })

      // 2. 等编辑器(标题输入框出现 = 图片处理完、表单挂载)
      const titleInput = page.locator(TITLE_SEL).first()
      await titleInput.waitFor({ state: 'visible', timeout: 60_000 })

      // 3. 填标题(小红书上限 20 字)+ 正文
      await titleInput.click()
      await titleInput.fill(codePointSlice(p.title || '', 20))
      const bodyEd = page.locator('.ql-editor, [contenteditable="true"]').first()
      await bodyEd.click()
      try {
        await bodyEd.fill(p.body || '')
      } catch {
        // 富文本 fill 偶尔不接受 → 退回键盘输入
        await page.keyboard.insertText(p.body || '')
      }

      // 4. 话题(best-effort:逐个输入 #tag 取首个候选;失败跳过不影响发布)
      for (const t of (p.topics || [])) {
        const tag = String(t).replace(/^#/, '').trim()
        if (!tag) continue
        try {
          await bodyEd.click()
          await page.keyboard.type(' #' + tag)
          await page.waitForTimeout(900)
          await page.keyboard.press('Enter')
        } catch { /* 话题可选,跳过 */ }
      }

      // 5. 诊断 + 循环重试点发布。【关键纠正】小红书真发布按钮是【无文本的 div.publish-page-publish-btn】,
      //    button:has-text("发布")/getByRole('button',name:'发布') 根本匹配不到!所以页面诊断里按
      //    class/aria 也找它,拿它的视口中心坐标用 page.mouse 真实点击(真实浏览器里=等同真人点)。
      //    图片传 CDN 完成前按钮禁用 → 循环重试直到跳成功页(~90s)。失败把页面真相报回来,不再瞎猜。
      await page.waitForTimeout(800)
      type Cand = { tag: string; cls: string; txt: string; aria: string; w: number; h: number; x: number; y: number; pe: string; op: string }
      type Diag = { imgs: number; uploading: boolean; vh: number; cands: Cand[] }
      const DIAG_JS = `(() => {
        const out = { imgs:0, uploading:false, vh: window.innerHeight||800, cands:[] };
        try {
          out.imgs = [...document.querySelectorAll('img')].filter(i=>{try{const r=i.getBoundingClientRect();return r.width>60&&r.height>60}catch(e){return false}}).length;
          out.uploading = /上传中|处理中|[0-9]+%/.test(document.body.innerText||'');
          const seen={};
          for (const e of document.querySelectorAll('button,[role="button"],div,span,a')) {
            if (out.cands.length>=12) break;
            let cls=''; try{cls=(typeof e.className==='string'?e.className:(e.className&&e.className.baseVal)||'')}catch(x){}
            const txt=((e.textContent||'').replace(/\\s+/g,'')).slice(0,10);
            const aria=(e.getAttribute&&e.getAttribute('aria-label'))||'';
            if (!(/发布/.test(txt)||/发布/.test(aria)||/publish-page-publish|xhs-publish|publish[-_]?btn/i.test(cls))) continue;
            if (/视频|图文|笔记/.test(txt)) continue;
            let r; try{r=e.getBoundingClientRect()}catch(x){continue}
            if (r.width<12||r.height<12) continue;
            const k=e.tagName+String(cls).slice(0,20)+Math.round(r.left); if(seen[k])continue; seen[k]=1;
            let cs={}; try{cs=getComputedStyle(e)}catch(x){}
            out.cands.push({tag:(e.tagName||'').toLowerCase(),cls:String(cls).slice(0,32),txt:txt,aria:String(aria).slice(0,8),w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),pe:(cs.pointerEvents||''),op:(cs.opacity||'')});
          }
        } catch(e){}
        return out;
      })()`
      const deadline = Date.now() + 90_000
      let published = false
      let lastDiag: Diag | null = null
      while (Date.now() < deadline) {
        const diag = await page.evaluate(DIAG_JS).catch(() => null) as Diag | null
        lastDiag = diag
        if (diag && diag.cands.length) {
          // 真提交按钮:动作区(视口下半)里面积最大的;点其中心(真实鼠标点击)。
          const zone = diag.cands.filter(c => c.y > diag.vh * 0.4)
          const pool = (zone.length ? zone : diag.cands).slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))
          const pick = pool[0]
          try { await page.mouse.move(pick.x, pick.y); await page.mouse.click(pick.x, pick.y) } catch { /* 下一轮重试 */ }
        } else {
          // 诊断没找到 → 退回选择器点击(尽力)
          try { await page.locator('[class*="publish-page-publish-btn"], .xhs-publish-btn, button:has-text("发布")').last().click({ timeout: 3000 }) } catch { /* ignore */ }
        }
        try {
          await page.waitForURL('**/publish/success**', { timeout: 3500 })
          published = true
          break
        } catch { /* 还没成功 → 再点 */ }
        await page.waitForTimeout(700)
      }
      if (published) {
        return { ok: true, finalUrl: page.url(), hint: '✅ 小红书图文已发布(Playwright 真实浏览器)。' }
      }
      const d = lastDiag
      const diagStr = d
        ? `图片数=${d.imgs} 上传中=${d.uploading} 发布候选${d.cands.length}[${d.cands.map(c => `${c.tag}.${c.cls}|"${c.txt}"/aria"${c.aria}"|${c.w}x${c.h}@${c.x},${c.y}|pe=${c.pe}|op=${c.op}`).join(' ; ') || '无'}]`
        : '页面诊断失败'
      return {
        ok: false,
        finalUrl: page.url(),
        error: `反复点发布 ~90s 未跳成功页。【诊断】${diagStr}。浏览器窗口已保留可手动点;请把这段诊断发给开发者。`
      }
    } catch (e) {
      return { ok: false, finalUrl: page.url(), error: `Playwright 发布异常:${(e as Error).message || String(e)}` }
    }
  })
}

/** App 退出 / 清理时关闭所有发布浏览器。 */
export async function closePublishBrowsers(): Promise<void> {
  for (const [k, ctx] of contexts) {
    try { await ctx.close() } catch { /* ignore */ }
    contexts.delete(k)
  }
}
