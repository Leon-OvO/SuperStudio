import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import type { RuntimeKind } from '../../../src/shared/ipc-types'
import { RUNTIME_ADAPTERS_READY } from '../../../src/shared/ipc-types'
import { getSettings, saveSettings } from '../services/store'
import { detectRuntimes, supportedRuntimes, clearRuntimeExecPathCache } from '../worker/runtime/discovery'

/**
 * Agent 运行时探测/选择 IPC（pc-runtime-discovery / PRD §9.6）。
 * 渲染层「选一个 agent 运行时」引导步骤 + 设置页面板用。
 *
 * 探测结果缓存一份（首屏 RUNTIME_LIST 直接返回缓存，RUNTIME_REFRESH 强制重探），
 * 避免每次进页面都 spawn where/which + --version。
 *
 * **默认 = 内置自研引擎**：`defaultRuntime` 缺省为 null，此时对话走自研 runAgent（技能/记忆/MCP 全在）。
 * 本地 CLI 运行时是**显式 opt-in**——绝不 flavor 兜底自动激活某个 CLI（那会静默绕过内置技能系统）。
 */

let cache: Awaited<ReturnType<typeof detectRuntimes>> | null = null

export function runtimeHandlers(): void {
  // 首屏：有缓存直接返回，否则探一次
  ipcMain.handle(IPC.RUNTIME_LIST, async () => {
    try {
      if (!cache) cache = await detectRuntimes()
      return { ok: true, runtimes: cache, supported: supportedRuntimes() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, supported: supportedRuntimes() }
    }
  })

  // 用户点「刷新」：强制重探（同时清可执行路径缓存，使装好运行时后无需重启即生效）
  ipcMain.handle(IPC.RUNTIME_REFRESH, async () => {
    try {
      clearRuntimeExecPathCache()
      cache = await detectRuntimes()
      return { ok: true, runtimes: cache, supported: supportedRuntimes() }
    } catch (e) {
      return { ok: false, error: (e as Error).message, supported: supportedRuntimes() }
    }
  })

  // 取默认运行时：null = 内置自研引擎（不做 CLI 兜底）。
  ipcMain.handle(IPC.RUNTIME_GET_DEFAULT, async () => {
    const chosen = getSettings().defaultRuntime ?? null
    return { ok: true, chosen }
  })

  // 设默认运行时（null = 切回内置自研引擎）。
  ipcMain.handle(IPC.RUNTIME_SET_DEFAULT, async (_e, kind: RuntimeKind | null) => {
    try {
      // 只接受有可执行适配器的运行时；其余（含 codex 暂未支持、或显式传 null）→ null = 内置自研引擎。
      const next = kind && RUNTIME_ADAPTERS_READY.includes(kind) ? kind : null
      saveSettings({ defaultRuntime: next })
      return { ok: true, chosen: next }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}
