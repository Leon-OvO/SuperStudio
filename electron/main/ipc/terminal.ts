import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { createTerminal, writeTerminal, resizeTerminal, disposeTerminal } from '../services/terminals'

export function terminalHandlers(): void {
  ipcMain.handle(IPC.TERMINAL_CREATE, (event, args: { cwd: string; cols: number; rows: number }) => {
    try {
      const id = createTerminal({
        cwd: args.cwd,
        cols: args.cols,
        rows: args.rows,
        webContents: event.sender
      })
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // fire-and-forget for keystroke latency
  ipcMain.on(IPC.TERMINAL_WRITE, (_event, args: { id: string; data: string }) => {
    writeTerminal(args.id, args.data)
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, (_event, args: { id: string; cols: number; rows: number }) => {
    resizeTerminal(args.id, args.cols, args.rows)
    return { ok: true }
  })

  ipcMain.handle(IPC.TERMINAL_DISPOSE, (_event, args: { id: string }) => {
    disposeTerminal(args.id)
    return { ok: true }
  })
}
