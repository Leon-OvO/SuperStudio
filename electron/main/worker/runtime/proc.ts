import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * 跨平台「杀整棵进程树」（运行时子进程取消/断线兜底用）。
 *
 * Windows：`child.kill()` 只对直接子进程发 TerminateProcess、不级联子孙。当运行时经 cmd.exe/shim
 * 起(claude 是 npm .cmd shim)或原生 exe 又自派生工具子进程时，只杀父会留下孤儿继续烧 token/操控电脑，
 * 且孙进程仍持 stdout 管道会让父侧读端收不到 EOF → run() 的 close 迟迟不触发、执行槽不释放。
 * 故 Windows 用 `taskkill /pid <pid> /T /F` 递归杀树；posix 用 SIGTERM(进程可自行清理子进程)。
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      // /T 连同子孙、/F 强杀；detached + unref 让它独立跑完，不阻塞父进程退出。
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, detached: true })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      })
      killer.unref()
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}
