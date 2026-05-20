/**
 * PTY-backed terminal session manager for the Vibe (Build) page.
 *
 * node-pty is loaded lazily on first createTerminal() so this module typechecks
 * even when the native dep isn't installed yet — useful while building UI
 * scaffolding before the user has compiled node-pty for the local Electron ABI.
 */

import type { WebContents } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'

// Minimal IPty surface we use — defined locally to avoid importing node-pty
// types at module-eval time. The real shape is in @types/node-pty.
interface IPty {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

interface PtyModule {
  spawn: (file: string, args: string[] | string, opts: {
    name?: string
    cols?: number
    rows?: number
    cwd?: string
    env?: NodeJS.ProcessEnv
    encoding?: string | null
    useConpty?: boolean
  }) => IPty
}

let _pty: PtyModule | null = null
function loadPty(): PtyModule {
  if (_pty) return _pty
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _pty = require('node-pty') as PtyModule
    return _pty
  } catch (e) {
    throw new Error(
      `node-pty is not installed or failed to load. ` +
      `Run: npm install node-pty && npx @electron/rebuild -f -w node-pty. ` +
      `Original error: ${(e as Error).message}`
    )
  }
}

interface Session {
  id: string
  pty: IPty
  projectPath: string
  webContents: WebContents
}

const sessions = new Map<string, Session>()
let nextId = 1

function pickShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: [] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'] }
}

export function createTerminal(opts: {
  cwd: string
  cols: number
  rows: number
  webContents: WebContents
}): string {
  const pty = loadPty()
  const { file, args } = pickShell()
  const cols = Math.max(1, Math.floor(opts.cols || 80))
  const rows = Math.max(1, Math.floor(opts.rows || 24))

  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd,
    env: process.env,
    useConpty: process.platform === 'win32'
  })

  const id = `t${nextId++}`
  const session: Session = { id, pty: child, projectPath: opts.cwd, webContents: opts.webContents }
  sessions.set(id, session)

  child.onData(data => {
    if (!session.webContents.isDestroyed()) {
      session.webContents.send(IPC.TERMINAL_DATA, { id, data })
    }
  })
  child.onExit(({ exitCode }) => {
    if (!session.webContents.isDestroyed()) {
      session.webContents.send(IPC.TERMINAL_EXIT, { id, exitCode })
    }
    sessions.delete(id)
  })

  return id
}

export function writeTerminal(id: string, data: string): void {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.write(data) } catch { /* dead session */ }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows))) } catch { /* ignore */ }
}

export function disposeTerminal(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.kill() } catch { /* ignore */ }
  sessions.delete(id)
}

/** Called on window close to prevent zombie PTY processes. */
export function disposeAllForWebContents(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.webContents === wc) {
      try { s.pty.kill() } catch { /* ignore */ }
      sessions.delete(id)
    }
  }
}
