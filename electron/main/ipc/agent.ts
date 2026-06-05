import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { runAgent, stopAgent } from '../agent/engine'
import { classifyIntent } from '../agent/classify'
import { getMainWindow } from '../index'

export function agentHandlers(): void {
  ipcMain.handle(IPC.AGENT_RUN, async (_e, sessionId, message, attachments, overrides) => {
    console.log('[IPC] AGENT_RUN received', { sessionId, msgLen: message?.length, overrides })
    const win = getMainWindow()
    if (!win) return { error: 'No window' }
    runAgent({
      sessionId,
      message,
      attachments,
      overrideProviderId: overrides?.providerId,
      overrideModel: overrides?.model,
      mountedSpaceIds: overrides?.mountedSpaceIds,
      imageSize: overrides?.imageSize,
      imageQuality: overrides?.imageQuality,
      imageCount: overrides?.imageCount,
      computerMode: overrides?.computerMode
    }, win).catch(err => {
      console.error('[IPC] runAgent crashed', err)
      win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: (err as Error)?.message || String(err) })
    })
    return { started: true }
  })

  ipcMain.handle(IPC.AGENT_STOP, (_e, sessionId) => {
    stopAgent(sessionId)
    return { ok: true }
  })

  ipcMain.handle(IPC.AGENT_CLASSIFY_INTENT, async (_e, args: { message: string; providerId: string; model: string }) => {
    return classifyIntent(args.message, args.providerId, args.model)
  })
}
