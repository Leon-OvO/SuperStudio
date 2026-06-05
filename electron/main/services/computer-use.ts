import { desktopCapturer, screen as eScreen, clipboard } from 'electron'
import fs from 'fs'
import os from 'os'
import type * as NutType from '@nut-tree-fork/nut-js'
import { runShell } from './shell'
import { isApproved, registerApproved } from './path-allow'

/**
 * Computer Use execution kernel — the OS-acting side of Anthropic's computer/
 * bash/text_editor tools. Screenshot via Electron's built-in desktopCapturer;
 * mouse/keyboard via the native nut.js module (lazy-required like node-pty).
 *
 * Coordinate model: we screenshot the PRIMARY display at its real pixel size,
 * downscale to a target (width ≤ 1280, what the model "sees" — Anthropic
 * recommends keeping it small), tell the model that target size, and scale the
 * model's coordinates back up to real pixels before driving nut.js.
 *
 * SAFETY: this module only ACTS. Arming/confirmation/overlay/kill-switch live in
 * the engine + IPC layer (P3); every action here also re-checks the AbortSignal.
 */

// nut.js is CJS native — lazy require so a load failure doesn't kill startup and
// typecheck stays happy (mirrors terminals.ts loadPty).
let _nut: typeof NutType | null = null
function loadNut(): typeof NutType {
  if (_nut) return _nut
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _nut = require('@nut-tree-fork/nut-js') as typeof NutType
  // Drive instantly; we use setPosition (teleport) rather than animated moves.
  _nut.mouse.config.autoDelayMs = 0
  _nut.keyboard.config.autoDelayMs = 0
  return _nut
}

const TARGET_MAX_W = 1280

/** Set on every screenshot so action coordinates map target→absolute px.
 *  offX/offY = the captured display's origin in the OS virtual-desktop space
 *  (so clicks land on the right monitor in a multi-display setup). */
let scale = { x: 1, y: 1, offX: 0, offY: 0, targetW: 0, targetH: 0 }

export interface ScreenshotResult { image: string; width: number; height: number; displayIndex: number; displayCount: number }

// --- multi-display selection -------------------------------------------------
// The model can control ALL monitors. We keep a STABLE "current display" per run
// rather than following the cursor (cursor-following made the captured monitor
// flip around as the agent moved the mouse, so it could never reach a monitor it
// wasn't already on). The model switches monitors explicitly via `switch_display`.
// Displays are ordered + numbered left-to-right, top-to-bottom, 1-based.

type Display = ReturnType<typeof eScreen.getPrimaryDisplay>

let currentDisplayId: number | null = null

function orderedDisplays(): Display[] {
  return eScreen.getAllDisplays().slice().sort((a, b) => (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y))
}

function currentDisplay(): Display {
  const all = orderedDisplays()
  if (currentDisplayId != null) {
    const found = all.find(d => d.id === currentDisplayId)
    if (found) return found
  }
  try { return eScreen.getPrimaryDisplay() } catch { return all[0] }
}

/** Reset to the primary display at the start of a computer-use run. */
export function resetComputerDisplay(): void {
  try { currentDisplayId = eScreen.getPrimaryDisplay().id } catch { currentDisplayId = null }
}

export interface DisplayInfo { index: number; label: string; primary: boolean }

export function listComputerDisplays(): DisplayInfo[] {
  let primaryId: number | null = null
  try { primaryId = eScreen.getPrimaryDisplay().id } catch { /* noop */ }
  return orderedDisplays().map((d, i) => ({
    index: i + 1,
    label: `显示器${i + 1}${d.id === primaryId ? '(主)' : ''} ${d.bounds.width}×${d.bounds.height}`,
    primary: d.id === primaryId,
  }))
}

/** Switch the active display by 1-based index (clamped). Returns the new index. */
export function setComputerDisplayByIndex(index: number): number {
  const all = orderedDisplays()
  const i = Math.max(1, Math.min(all.length, Math.round(index || 1)))
  currentDisplayId = all[i - 1].id
  return i
}

function currentDisplayPos(): { index: number; count: number } {
  const all = orderedDisplays()
  const id = currentDisplay().id
  const idx = all.findIndex(d => d.id === id)
  return { index: (idx < 0 ? 0 : idx) + 1, count: all.length }
}

/** "显示器 2/2" for the screenshot caption — empty when there's only one. */
export function currentDisplayBadge(): string {
  const { index, count } = currentDisplayPos()
  return count > 1 ? `显示器 ${index}/${count}` : ''
}

/** Capture the current display, downscaled to the model's target resolution. */
export async function captureScreenshot(): Promise<ScreenshotResult> {
  const d = currentDisplay()
  const sf = d.scaleFactor || 1
  const physW = Math.max(1, Math.round(d.bounds.width * sf))
  const physH = Math.max(1, Math.round(d.bounds.height * sf))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } })
  // Match the capture source to the chosen display by id (reliable on Win/Mac).
  // If the id can't be matched (some platforms leave display_id empty), warn so
  // it's diagnosable rather than silently grabbing the wrong monitor.
  let src = sources.find(s => s.display_id === String(d.id))
  if (!src) {
    if (sources.length > 1) console.warn(`[computer-use] 未能按 display_id=${d.id} 匹配截屏源（共 ${sources.length} 个），回退到第一个`)
    src = sources[0]
  }
  if (!src) throw new Error('无法获取屏幕画面（desktopCapturer 返回空）')
  let img = src.thumbnail
  const sz = img.getSize()
  const srcW = sz.width || physW
  const srcH = sz.height || physH
  const targetW = Math.min(srcW, TARGET_MAX_W)
  const targetH = Math.max(1, Math.round(srcH * (targetW / srcW)))
  if (targetW !== srcW) img = img.resize({ width: targetW, height: targetH })
  scale = {
    x: srcW / targetW,
    y: srcH / targetH,
    offX: Math.round(d.bounds.x * sf),
    offY: Math.round(d.bounds.y * sf),
    targetW,
    targetH,
  }
  const pos = currentDisplayPos()
  return { image: img.toPNG().toString('base64'), width: targetW, height: targetH, displayIndex: pos.index, displayCount: pos.count }
}

/** Target display size for the model (computed on first screenshot; falls back
 *  to a probe). Used to set the computer tool's displayWidthPx/Px. */
export async function getTargetDisplaySize(): Promise<{ width: number; height: number }> {
  if (scale.targetW) return { width: scale.targetW, height: scale.targetH }
  const d = currentDisplay()
  const sf = d.scaleFactor || 1
  const physW = Math.max(1, Math.round(d.bounds.width * sf))
  const physH = Math.max(1, Math.round(d.bounds.height * sf))
  const targetW = Math.min(physW, TARGET_MAX_W)
  return { width: targetW, height: Math.max(1, Math.round(physH * (targetW / physW))) }
}

/** Map a model coordinate (target space) → absolute OS pixel for nut.js. */
function toReal(coord: readonly [number, number]): { x: number; y: number } {
  return { x: scale.offX + Math.round(coord[0] * scale.x), y: scale.offY + Math.round(coord[1] * scale.y) }
}

// --- key name mapping (Anthropic/xdotool-style → nut.js Key) --------------

// Map a key token to a nut.js Key *name*, then resolve by string index so we
// never depend on a specific enum member existing at compile time.
const KEY_NAME: Record<string, string> = {
  ctrl: 'LeftControl', control: 'LeftControl', alt: 'LeftAlt', option: 'LeftAlt', shift: 'LeftShift',
  super: 'LeftSuper', cmd: 'LeftSuper', win: 'LeftSuper', meta: 'LeftSuper', command: 'LeftSuper',
  enter: 'Return', return: 'Return', tab: 'Tab', space: 'Space', escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', page_up: 'PageUp', pageup: 'PageUp', prior: 'PageUp',
  page_down: 'PageDown', pagedown: 'PageDown', next: 'PageDown',
  minus: 'Minus', equal: 'Equal', comma: 'Comma', period: 'Period', slash: 'Slash',
}
function keyToken(tok: string): NutType.Key | null {
  const K = loadNut().Key as unknown as Record<string, NutType.Key>
  const t = tok.trim().toLowerCase()
  let name: string | undefined = KEY_NAME[t]
  if (!name) {
    if (/^f([1-9]|1[0-2])$/.test(t)) name = 'F' + t.slice(1)
    else if (/^[a-z]$/.test(t)) name = t.toUpperCase()
    else if (/^[0-9]$/.test(t)) name = 'Num' + t
  }
  if (!name) return null
  const k = K[name]
  return k == null ? null : k
}

/** Execute an xdotool-style key combo, e.g. "ctrl+s", "Return", "alt+Tab". */
async function pressCombo(text: string): Promise<void> {
  const nut = loadNut()
  const tokens = text.split('+').map(s => s.trim()).filter(Boolean)
  const keys = tokens.map(keyToken)
  if (keys.some(k => k == null)) {
    // Unknown combo with a single printable token → type it literally.
    if (tokens.length === 1 && tokens[0].length === 1) { await nut.keyboard.type(tokens[0]); return }
    throw new Error(`无法识别的按键：${text}`)
  }
  const list = keys as NutType.Key[]
  await nut.keyboard.pressKey(...list)
  await nut.keyboard.releaseKey(...list.slice().reverse())
}

// --- the computer action dispatcher ---------------------------------------

export interface ComputerActionInput {
  action: string
  coordinate?: readonly [number, number]
  start_coordinate?: readonly [number, number]
  text?: string
  duration?: number
  scroll_amount?: number
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  /** 1-based display index for `switch_display` (or to switch+capture on `screenshot`). */
  display?: number
}

export interface ComputerActionResult { image?: string; text?: string }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Run one Anthropic `computer` action. Re-checks abort before acting. After a
 *  screen-changing action it returns a fresh screenshot so the model sees the
 *  result; cursor_position returns text. */
export async function runComputerAction(input: ComputerActionInput, signal?: AbortSignal): Promise<ComputerActionResult> {
  if (signal?.aborted) return { text: '操作已被用户中止' }
  const nut = loadNut()
  const { Point, Button } = nut
  const a = input.action

  const moveTo = async (c: readonly [number, number]): Promise<void> => {
    const p = toReal(c)
    await nut.mouse.setPosition(new Point(p.x, p.y))
  }

  switch (a) {
    case 'screenshot':
      if (input.display != null) setComputerDisplayByIndex(Number(input.display))
      return { image: (await captureScreenshot()).image }
    case 'switch_display': {
      // The model is told to pass the 1-based monitor number in `display`.
      const idx = setComputerDisplayByIndex(Number(input.display ?? 1))
      return { image: (await captureScreenshot()).image, text: `已切换到显示器 ${idx}` }
    }
    case 'cursor_position': {
      const p = await nut.mouse.getPosition()
      return { text: `X=${Math.round((p.x - scale.offX) / scale.x)},Y=${Math.round((p.y - scale.offY) / scale.y)}` }
    }
    case 'mouse_move':
      if (input.coordinate) await moveTo(input.coordinate)
      break
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      if (input.coordinate) await moveTo(input.coordinate)
      const btn = a === 'right_click' ? Button.RIGHT : a === 'middle_click' ? Button.MIDDLE : Button.LEFT
      if (a === 'double_click') await nut.mouse.doubleClick(btn)
      else if (a === 'triple_click') { await nut.mouse.click(btn); await nut.mouse.click(btn); await nut.mouse.click(btn) }
      else await nut.mouse.click(btn)
      break
    }
    case 'left_mouse_down':
      if (input.coordinate) await moveTo(input.coordinate)
      await nut.mouse.pressButton(Button.LEFT)
      break
    case 'left_mouse_up':
      if (input.coordinate) await moveTo(input.coordinate)
      await nut.mouse.releaseButton(Button.LEFT)
      break
    case 'left_click_drag': {
      const from = input.start_coordinate
      const to = input.coordinate
      if (from) await moveTo(from)
      await nut.mouse.pressButton(Button.LEFT)
      if (to) await moveTo(to)
      await nut.mouse.releaseButton(Button.LEFT)
      break
    }
    case 'scroll': {
      if (input.coordinate) await moveTo(input.coordinate)
      const amt = input.scroll_amount ?? 3
      const dir = input.scroll_direction ?? 'down'
      if (dir === 'down') await nut.mouse.scrollDown(amt)
      else if (dir === 'up') await nut.mouse.scrollUp(amt)
      else if (dir === 'left') await nut.mouse.scrollLeft(amt)
      else await nut.mouse.scrollRight(amt)
      break
    }
    case 'type':
      if (input.text) {
        // nut.js keystroke simulation is unreliable for CJK / IME text. For any
        // non-ASCII, paste via the clipboard (save+restore) so Chinese etc. type
        // correctly regardless of the active input method.
        if (/[^\x00-\x7F]/.test(input.text)) {
          const prev = clipboard.readText()
          clipboard.writeText(input.text)
          await sleep(40)
          await nut.keyboard.pressKey(nut.Key.LeftControl, nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.V, nut.Key.LeftControl)
          await sleep(60)
          clipboard.writeText(prev)
        } else {
          await nut.keyboard.type(input.text)
        }
      }
      break
    case 'key':
      if (input.text) await pressCombo(input.text)
      break
    case 'hold_key': {
      if (input.text) {
        const k = keyToken(input.text)
        if (k != null) { await nut.keyboard.pressKey(k); await sleep(input.duration ?? 500); await nut.keyboard.releaseKey(k) }
      }
      break
    }
    case 'wait':
      await sleep(Math.min(input.duration ?? 1000, 10_000))
      break
    default:
      return { text: `不支持的动作：${a}` }
  }

  // Settle, then return a fresh screenshot so the model sees the effect.
  await sleep(120)
  if (signal?.aborted) return { text: '操作已被用户中止' }
  return { image: (await captureScreenshot()).image }
}

// --- bash tool (reuse runShell) -------------------------------------------

export async function runBashTool(command: string, signal?: AbortSignal): Promise<string> {
  const ctl = new AbortController()
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true })
  const r = await runShell(command, os.homedir(), ctl.signal, 60_000)
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
  if (r.timedOut) return (out ? out + '\n' : '') + '[命令超时已终止]'
  return out || `[exit ${r.code}]`
}

// --- text_editor tool (fs + path-allow) -----------------------------------

const undoStack = new Map<string, string[]>()
function pushUndo(p: string, content: string): void {
  const s = undoStack.get(p) ?? []
  s.push(content); if (s.length > 20) s.shift()
  undoStack.set(p, s)
}

export interface TextEditorInput {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit'
  path: string
  file_text?: string
  insert_line?: number
  new_str?: string
  old_str?: string
  view_range?: number[]
}

export async function runTextEditorTool(input: TextEditorInput): Promise<string> {
  const p = input.path
  if (input.command === 'create') {
    registerApproved(p)
  } else if (!isApproved(p)) {
    return `[拒绝] 路径未授权：${p}`
  }
  switch (input.command) {
    case 'view': {
      if (!fs.existsSync(p)) return `[不存在] ${p}`
      const content = fs.readFileSync(p, 'utf8')
      const lines = content.split('\n')
      const [from, to] = input.view_range ?? [1, lines.length]
      return lines.slice(Math.max(0, from - 1), to).map((l, i) => `${from + i}\t${l}`).join('\n')
    }
    case 'create': {
      if (fs.existsSync(p)) pushUndo(p, fs.readFileSync(p, 'utf8'))
      fs.writeFileSync(p, input.file_text ?? '', 'utf8')
      return `已写入 ${p}`
    }
    case 'str_replace': {
      const content = fs.readFileSync(p, 'utf8')
      const old = input.old_str ?? ''
      const count = old ? content.split(old).length - 1 : 0
      if (count === 0) return `[未找到要替换的文本] old_str 不匹配`
      if (count > 1) return `[匹配到 ${count} 处] old_str 必须唯一，请提供更多上下文`
      pushUndo(p, content)
      fs.writeFileSync(p, content.replace(old, input.new_str ?? ''), 'utf8')
      return `已替换 ${p}`
    }
    case 'insert': {
      const content = fs.readFileSync(p, 'utf8')
      const lines = content.split('\n')
      const at = Math.max(0, Math.min(input.insert_line ?? lines.length, lines.length))
      pushUndo(p, content)
      lines.splice(at, 0, input.new_str ?? '')
      fs.writeFileSync(p, lines.join('\n'), 'utf8')
      return `已在第 ${at} 行后插入`
    }
    case 'undo_edit': {
      const s = undoStack.get(p)
      if (!s || !s.length) return `[无可撤销的修改] ${p}`
      fs.writeFileSync(p, s.pop()!, 'utf8')
      return `已撤销上次修改 ${p}`
    }
    default:
      return `[不支持的命令] ${(input as { command: string }).command}`
  }
}
