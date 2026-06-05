import { BrowserWindow, globalShortcut, ipcMain, screen as eScreen } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'

/**
 * Safety layer for Computer Use. The execution kernel (computer-use.ts) only
 * acts; this gates it:
 *   - arm: a native, un-spoofable confirm dialog before the FIRST action of a run
 *   - overlay: a transparent, click-through, always-on-top banner while armed
 *   - kill switch: a global Esc that aborts the run and disarms
 * Per-run (not per-session) by design — re-confirm each agent run that wants to
 * drive the machine. Engine calls disarmComputerUse() in its finally block.
 */

let armed = false
let aborted = false
let overlay: BrowserWindow | null = null
let curtains: BrowserWindow[] = [] // one black curtain per display (multi-monitor)

export function isComputerUseAborted(): boolean { return aborted }

/** Ask the renderer to show the app's styled confirm dialog and await the answer. */
function askPermission(parent: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(IPC.COMPUTER_USE_CONFIRM_REPLY, onReply)
      clearTimeout(timer)
      resolve(ok)
    }
    const onReply = (_e: unknown, payload: { id: string; ok: boolean }): void => {
      if (payload?.id === id) finish(!!payload.ok)
    }
    ipcMain.on(IPC.COMPUTER_USE_CONFIRM_REPLY, onReply)
    const timer = setTimeout(() => finish(false), 60_000) // no answer in 60s → decline
    parent.webContents.send(IPC.COMPUTER_USE_CONFIRM, { id })
  })
}

/** Confirm + arm before the first computer action of a run. Returns false if the
 *  user declines (or already aborted). Idempotent within an armed run. */
export async function armComputerUse(opts: { parent?: BrowserWindow | null; onKill: () => void; auto?: boolean; privacy?: boolean }): Promise<boolean> {
  if (armed) return true
  // Fresh arm = a NEW run. Clear any leftover Esc-kill flag so a previous run's
  // stop never blocks this one (the old bug: aborted stayed true → "未授权").
  aborted = false
  const parent = opts.parent && !opts.parent.isDestroyed() ? opts.parent : null
  // Scheduled / unattended runs auto-arm: no user is present to answer the
  // confirm dialog (it would just time out → decline). The overlay + global Esc
  // kill switch still apply. Gated upstream by the global computerUseEnabled
  // switch + the task's own computer_mode flag, so this isn't a silent escalation.
  if (!opts.auto) {
    if (!parent) return false
    const ok = await askPermission(parent)
    if (!ok) return false
  }
  armed = true
  // Privacy curtain ("伪锁屏") covers every screen with a black, capture-excluded
  // window — onlookers see black, but screenshots (the AI) see through it, so the
  // session stays unlocked and control keeps working. It already carries the
  // banner + live status, so we skip the small overlay in that mode.
  if (opts.privacy) showPrivacyCurtain()
  else showOverlay()
  try {
    globalShortcut.register('Escape', () => {
      aborted = true
      try { opts.onKill() } catch { /* noop */ }
      disarmComputerUse()
    })
  } catch { /* shortcut may be unavailable — overlay + per-step abort still apply */ }
  return true
}

/** Tear down arming: close overlay, release Esc. Called by engine on run end / kill.
 *  Also clears the kill flag so the NEXT run starts clean. */
export function disarmComputerUse(): void {
  armed = false
  aborted = false
  try { globalShortcut.unregister('Escape') } catch { /* noop */ }
  if (overlay && !overlay.isDestroyed()) { try { overlay.close() } catch { /* noop */ } }
  overlay = null
  for (const c of curtains) { if (c && !c.isDestroyed()) { try { c.close() } catch { /* noop */ } } }
  curtains = []
}

const OVERLAY_W = 520
const OVERLAY_H = 72

function showOverlay(): void {
  if (overlay && !overlay.isDestroyed()) return
  overlay = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false, movable: false, hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden;background:transparent;font-family:system-ui,'Microsoft YaHei',sans-serif">
  <div style="margin:6px;background:rgba(220,38,38,.95);color:#fff;border-radius:12px;padding:6px 14px;box-shadow:0 6px 18px rgba(0,0,0,.35)">
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:12.5px;font-weight:600">🖱 AI 正在操控你的电脑 · 按 <b style="background:#fff;color:#dc2626;border-radius:4px;padding:0 6px">Esc</b> 急停</div>
    <div id="s" style="margin-top:5px;font-size:11.5px;line-height:1.3;opacity:.95;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">准备中…</div>
  </div></body>`
  overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  try {
    const wa = eScreen.getPrimaryDisplay().workArea
    overlay.setBounds({ x: Math.round(wa.x + wa.width / 2 - OVERLAY_W / 2), y: wa.y + 10, width: OVERLAY_W, height: OVERLAY_H })
  } catch { /* keep default position */ }
  overlay.showInactive()
}

/**
 * Fullscreen black "privacy curtain" (伪锁屏) spanning every monitor. It is
 * marked content-protected (Windows WDA_EXCLUDEFROMCAPTURE via setContentProtection),
 * so it is INVISIBLE to screen capture — the AI's screenshots see straight through
 * it to the real desktop, while a human onlooker sees only black. Click-through +
 * non-focusable so the agent's synthetic input still reaches the apps below and the
 * target keeps focus. NOTE: this does NOT block a physical mouse/keyboard (an
 * onlooker could still interfere) and is NOT a real OS lock — it only hides the
 * screen and keeps the session active so automation can run.
 */
function curtainHtml(): string {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;overflow:hidden;background:#000;color:#e5e7eb;font-family:system-ui,'Microsoft YaHei',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;user-select:none">
    <div style="font-size:30px">🔒</div>
    <div style="font-size:17px;font-weight:600;letter-spacing:.04em">隐私模式 · AI 正在操控你的电脑</div>
    <div id="s" style="font-size:13px;opacity:.7;max-width:80vw;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">准备中…</div>
    <div style="font-size:12px;opacity:.45;margin-top:6px">按 <b style="color:#fca5a5">Esc</b> 立即急停并退出隐私模式</div>
  </body>`
}

function showPrivacyCurtain(): void {
  if (curtains.length) return
  // One curtain window PER display: a single window spanning the virtual desktop
  // gets clamped to one monitor on Windows, so multi-monitor setups would leave
  // the other screens uncovered. Per-display windows cover every monitor exactly.
  let displays = eScreen.getAllDisplays()
  if (!displays.length) { try { displays = [eScreen.getPrimaryDisplay()] } catch { return } }
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(curtainHtml())
  for (const d of displays) {
    const b = d.bounds
    const c = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, transparent: false, alwaysOnTop: true, skipTaskbar: true,
      focusable: false, resizable: false, movable: false, hasShadow: false,
      backgroundColor: '#000000', fullscreenable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    // The crucial bit: visible on the physical screen, excluded from screen capture.
    try { c.setContentProtection(true) } catch { /* older OS — curtain may show in captures */ }
    c.setIgnoreMouseEvents(true) // pass synthetic input through to apps below
    c.setAlwaysOnTop(true, 'screen-saver')
    try { c.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) } catch { /* keep ctor bounds */ }
    c.loadURL(url)
    c.showInactive()
    curtains.push(c)
  }
}

/** Update the live status line on every active surface (curtains, or the banner). */
export function setComputerUseStatus(text: string): void {
  const targets = curtains.length ? curtains : (overlay ? [overlay] : [])
  if (!targets.length) return
  const t = (text || '').replace(/\s+/g, ' ').trim().slice(0, 90)
  const js = `(()=>{const e=document.getElementById('s');if(e)e.textContent=${JSON.stringify(t)};})()`
  for (const w of targets) {
    if (w && !w.isDestroyed()) w.webContents.executeJavaScript(js).catch(() => { /* loading/closing */ })
  }
}
