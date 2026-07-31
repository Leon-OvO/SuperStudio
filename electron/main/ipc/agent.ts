import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { runAgent, stopAgent } from '../agent/engine'
import { runViaRuntime, stopRuntimeRun, runtimeForSession } from '../agent/runtime-run'
import { classifyIntent } from '../agent/classify'
import { getMainWindow } from '../index'

export function agentHandlers(): void {
  ipcMain.handle(IPC.AGENT_RUN, async (_e, sessionId, message, attachments, overrides) => {
    console.log('[IPC] AGENT_RUN received', { sessionId, msgLen: message?.length, overrides })
    const win = getMainWindow()
    if (!win) return { error: 'No window' }

    // 本机运行时接管：该会话选了一款 code CLI 当引擎时（会话覆盖优先于全局默认），把这轮派给它执行。
    // 显式媒体/整机操控轮（forceImage / computerMode）仍走自研直连——那两条链路运行时不接管。
    const runtimeKind = runtimeForSession(sessionId)
    if (runtimeKind && !overrides?.forceImage && !overrides?.computerMode) {
      runViaRuntime(
        { sessionId, message, providerId: overrides?.providerId, modelId: overrides?.model, kind: runtimeKind },
        win
      ).catch((err) => {
        console.error('[IPC] runViaRuntime crashed', err)
        win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: (err as Error)?.message || String(err) })
      })
      return { started: true }
    }

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
      computerMode: overrides?.computerMode,
      forceImage: overrides?.forceImage,
      thinkingMode: overrides?.thinkingMode,
      sshDefaultConnIds: overrides?.sshDefaultConnIds,
      contextRefs: overrides?.contextRefs,
      forceSkillIds: overrides?.forceSkillIds
    }, win).catch(err => {
      console.error('[IPC] runAgent crashed', err)
      win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: (err as Error)?.message || String(err) })
    })
    return { started: true }
  })

  ipcMain.handle(IPC.AGENT_STOP, (_e, sessionId) => {
    // 扇出到两条引擎：各自对非自己拥有的会话是 no-op。
    stopAgent(sessionId)
    stopRuntimeRun(sessionId)
    return { ok: true }
  })

  ipcMain.handle(IPC.AGENT_CLASSIFY_INTENT, async (_e, args: { message: string; providerId: string; model: string }) => {
    return classifyIntent(args.message, args.providerId, args.model)
  })
}
