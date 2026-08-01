import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface KillTreeOptions {
  /** posix：首选信号，默认 SIGTERM（第二阶段传 SIGKILL）。Windows 忽略。 */
  signal?: NodeJS.Signals
  /**
   * posix：先按进程组收尸（`kill(-pid)`）。只有 spawn 时带了 `detached: true`
   * （子进程自成进程组组长）才有意义；失败自动回退到只杀直接子进程。
   */
  processGroup?: boolean
  /** Windows：taskkill 是否带 `/F` 强杀，默认 true。 */
  force?: boolean
}

/**
 * 跨平台「杀整棵进程树」（运行时子进程取消/断线兜底、以及 runShell 超时终止用）。
 *
 * Windows：`child.kill()` 只对直接子进程发 TerminateProcess、不级联子孙。当运行时经 cmd.exe/shim
 * 起(npm 装的 CLI 都是 .cmd shim)或原生 exe 又自派生工具子进程时，只杀父会留下孤儿继续烧 token/操控电脑，
 * 且孙进程仍持 stdout 管道会让父侧读端收不到 EOF → run() 的 close 迟迟不触发、执行槽不释放。
 * 故 Windows 用 `taskkill /pid <pid> /T /F` 递归杀树；posix 用 SIGTERM(进程可自行清理子进程)。
 *
 * 已知漏网 & 为什么不上 Job Object（别再重复调研）：
 *   - `taskkill /T` 是按「当前父子关系」现场遍历的。若孙进程已被 re-parent（父进程先退出、
 *     或用 `start`/服务/计划任务/DETACHED_PROCESS 另起门户），它就不在这棵树上，杀不到。
 *   - 权威解是 Windows Job Object（`AssignProcessToJobObject` + `KILL_ON_JOB_CLOSE`），
 *     但那要 native 模块。本项目已经在 node-pty 上吃过 Electron ABI/重编译的亏（见记忆
 *     node-pty-electron33），为一个边缘漏网场景再引一个 native 依赖不划算，**明确不做**。
 *   - 兜底策略是：先杀树，父进程侧再按超时排水丢句柄（见 services/shell.ts），
 *     保证漏网的孙进程最多是继续在后台跑，不会把我们这边吊死。
 */
export function killProcessTree(child: ChildProcess, opts: KillTreeOptions = {}): void {
  const pid = child.pid
  if (!pid) return
  // 已经退出就别再杀：taskkill 一个已回收的 pid 无意义，更糟的是 pid 复用后
  // 可能误杀无关进程（Windows pid 复用很快）。
  if (child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T']
    if (opts.force !== false) args.push('/F')
    try {
      // /T 连同子孙、/F 强杀；detached + unref 让它独立跑完，不阻塞父进程退出。
      const killer = spawn('taskkill', args, { windowsHide: true, detached: true })
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
    const sig = opts.signal ?? 'SIGTERM'
    if (opts.processGroup) {
      try {
        // 负 pid = 整个进程组（子进程 detached 后自成组长），能带走它派生的子孙。
        process.kill(-pid, sig)
        return
      } catch {
        /* 组不存在/无权限 → 退回只杀直接子进程 */
      }
    }
    try {
      child.kill(sig)
    } catch {
      /* ignore */
    }
  }
}
