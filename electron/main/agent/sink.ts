import type { BrowserWindow } from 'electron'

/**
 * Agent 事件出口抽象（M2 接缝）。
 *
 * runAgent 的所有流式事件（progress/phase/delta/done/error）原本直接写
 * `win.webContents.send(...)`，与「必须有一个本地窗口」强耦合。把出口收敛到
 * AgentSink 后，本地模式仍发给窗口；后续（step 2）远程执行机可注入一个把事件
 * 经长连回传云端的 sink，让 runAgent 能在无窗口的 worker 进程里跑。
 *
 * 本步（step 1）仅引入抽象 + 集中出口，行为与之前一致（只多了 isDestroyed 守卫，
 * 防止向已销毁窗口发送时抛错）。
 */
export interface AgentSink {
  send(channel: string, payload: unknown): void
  /** 本地窗口（worker/云端 sink 为 undefined）；窗口耦合特性据此判断 */
  readonly win?: BrowserWindow
}

/** 本地窗口 sink：把事件发给渲染进程（带 isDestroyed 守卫） */
export function makeWindowSink(win: BrowserWindow): AgentSink {
  return {
    send(channel, payload) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    },
    win
  }
}

/** 把「窗口或 sink」归一成 sink（step 2 runAgent 改成接受 BrowserWindow | AgentSink 时用） */
export function toSink(host: BrowserWindow | AgentSink): AgentSink {
  return 'webContents' in host ? makeWindowSink(host) : host
}
