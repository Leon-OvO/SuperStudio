import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'

/**
 * Safety gate for agent-driven SSH command execution.
 *
 * Model: "trust on first use, per connection, per app run". The first time the
 * agent runs a command on a given connection it must be confirmed by the user
 * (a styled dialog showing host + command); approving trusts that connection for
 * the rest of this app run so multi-step workflows don't nag. Restarting the app
 * clears the trust set. Reuses the same IPC-round-trip + 60s-timeout-declines
 * pattern as computer-use-guard.askPermission, but keeps NONE of its session
 * arming/overlay/Esc state — SSH gating is purely per-command/per-connection.
 */

const trusted = new Set<string>()

/** Ask the renderer to show the styled confirm dialog and await the answer.
 *  Resolve the main window dynamically to avoid a static import cycle with
 *  ../index (same approach as memory.ts). */
async function askConfirm(host: string, command: string): Promise<boolean> {
  let win: BrowserWindow | null = null
  try { win = (await import('../index')).getMainWindow() } catch { win = null }
  if (!win) return false // no UI to confirm with → deny
  return new Promise((resolve) => {
    const id = randomUUID()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(IPC.SSH_EXEC_CONFIRM_REPLY, onReply)
      clearTimeout(timer)
      resolve(ok)
    }
    const onReply = (_e: unknown, payload: { id: string; ok: boolean }): void => {
      if (payload?.id === id) finish(!!payload.ok)
    }
    ipcMain.on(IPC.SSH_EXEC_CONFIRM_REPLY, onReply)
    const timer = setTimeout(() => finish(false), 60_000) // no answer in 60s → decline
    win.webContents.send(IPC.SSH_EXEC_CONFIRM, { id, host, command })
  })
}

/** Returns true if the agent may run `command` on this connection. Trusted
 *  connections pass immediately; otherwise prompt, and cache on approval. */
export async function confirmSshExec(connId: string, host: string, command: string): Promise<boolean> {
  if (trusted.has(connId)) return true
  const ok = await askConfirm(host, command)
  if (ok) trusted.add(connId)
  return ok
}

/** Drop trust for a connection (e.g. when it's deleted/edited). */
export function revokeSshTrust(connId: string): void {
  trusted.delete(connId)
}
