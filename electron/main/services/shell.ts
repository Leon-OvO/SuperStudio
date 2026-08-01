import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { killProcessTree } from '../worker/runtime/proc'
import { registerApproved } from './path-allow'
import { getSettings } from './store'

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  // ↓ 以下均为「只增不改」的追加字段：既有调用方（Vibe 的 code_bash、技能运行时的
  //   bash、engine 的 run_script/ssh_exec localhost、computer-use 的 bash）按名取值，
  //   删改上面四个字段会直接破坏它们。
  /** 终止信号（被杀时才有），如 SIGKILL / SIGTERM。 */
  signal?: string | null
  /** 谁终止了它：超时 / 用户中止 / 输出超上限；正常退出为 null。 */
  killedBy?: 'timeout' | 'abort' | 'output_limit' | null
  /** 真实产出字节数（截断前的单调计数），用于让模型知道自己看到的只是一部分。 */
  bytes?: { stdout: number; stderr: number }
  /** 是否发生过首尾截断。 */
  truncated?: boolean
  /** stdio 是否排干。false = 排水超时主动丢句柄（多半是孙进程仍持管道），尾部可能不全。 */
  drained?: boolean
  /** 本次命令的全量输出日志绝对路径（无任何输出时不生成）。 */
  logPath?: string
  /** 仅在超时或非 0 退出时给出的自带诊断，省掉模型再调一次工具查状态。 */
  diagnostics?: string
  /** 从 spawn 到 resolve 的耗时。 */
  durationMs?: number
}

export interface RunShellOptions {
  /** 内存里保留的头部字节数，默认 20KB。 */
  maxFrontBytes?: number
  /** 内存里保留的尾部字节数，默认 25KB。npm/pytest/traceback 的结论都在这里。 */
  maxTailBytes?: number
  /** 进程 'exit' 之后等 stdio 关闭的上限，默认 2s。超时丢句柄并标 drained:false。 */
  drainTimeoutMs?: number
  /** 第一阶段终止后等它自己退出的时间，默认 1s，然后强杀。 */
  killGraceMs?: number
  /** 输出硬上限，超过就主动终止，默认 512MB。 */
  hardOutputLimitBytes?: number
  /** Windows 下是否给命令加 `chcp 65001` 前缀；默认跟随设置（默认开）。 */
  forceUtf8?: boolean
  /** 全量日志目录，默认 userData/shell-logs。 */
  logDir?: string
}

const DEFAULT_FRONT_BYTES = 20 * 1024
const DEFAULT_TAIL_BYTES = 25 * 1024
const DEFAULT_DRAIN_MS = 2_000
const DEFAULT_KILL_GRACE_MS = 1_000
const DEFAULT_HARD_LIMIT_BYTES = 512 * 1024 * 1024
/** GBK 日志回写成 UTF-8 的大小上限；再大就保留原始字节，不值得整文件重编码。 */
const LOG_TRANSCODE_MAX_BYTES = 16 * 1024 * 1024
/** 日志保留天数，超期在下一次运行时顺手清掉。 */
const LOG_RETENTION_DAYS = 7

/**
 * 首尾双缓冲：头部攒满就冻结，尾部是滑动窗口。
 * 这样 npm install / pytest / traceback 的「开头是什么命令」和「结论是什么」都能留住——
 * 旧实现是无上限累积再 `slice(0, 50_000)`，结论永远在被丢掉的那一半。
 */
class HeadTailBuffer {
  private front: Buffer[] = []
  private frontBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  /** 单调字节计数：不受截断影响的真实产出量。 */
  total = 0
  /** 是否已经确认不是 UTF-8（中文 Windows 的 cmd.exe/老程序输出 GBK）。 */
  private nonUtf8 = false
  private probe: TextDecoder | null = new TextDecoder('utf-8', { fatal: true })

  constructor(private maxFront: number, private maxTail: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    // 编码探测：流式 fatal 解码能正确处理跨 chunk 断开的多字节序列，
    // 一旦抛错就说明这条流不是 UTF-8，后面统一按 GBK 解。
    if (this.probe) {
      try {
        this.probe.decode(chunk, { stream: true })
      } catch {
        this.nonUtf8 = true
        this.probe = null
      }
    }
    if (this.frontBytes < this.maxFront) {
      const take = Math.min(this.maxFront - this.frontBytes, chunk.length)
      this.front.push(chunk.subarray(0, take))
      this.frontBytes += take
    }
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= this.maxTail) {
      this.tailBytes -= this.tail.shift()!.length
    }
    if (this.tailBytes > this.maxTail) {
      const first = this.tail[0]
      const drop = this.tailBytes - this.maxTail
      this.tail[0] = first.subarray(drop)
      this.tailBytes -= drop
    }
  }

  get isGbk(): boolean {
    return this.nonUtf8
  }

  /** 返回 { text, truncated }：未超限时是完整原文，超限时是 头 + 省略标记 + 尾。 */
  render(): { text: string; truncated: boolean } {
    const front = Buffer.concat(this.front, this.frontBytes)
    const tail = Buffer.concat(this.tail, this.tailBytes)
    // 头尾各自独立保留，两段可能重叠（总量不大时）。重叠量 >= 0 就能拼出完整原文。
    const overlap = front.length + tail.length - this.total
    if (overlap >= 0) {
      return { text: this.decode(Buffer.concat([front, tail.subarray(overlap)])), truncated: false }
    }
    const omitted = -overlap
    const head = this.decode(front)
    const rest = this.decode(this.trimPartialLeadingChar(tail))
    return { text: `${head}\n…[中间已省略 ${omitted} 字节，全量见 logPath]…\n${rest}`, truncated: true }
  }

  private decode(buf: Buffer): string {
    if (!buf.length) return ''
    if (this.nonUtf8) {
      // Electron 自带完整 ICU，TextDecoder('gbk') 可用；万一不可用退回 UTF-8。
      try {
        return new TextDecoder('gbk', { fatal: false }).decode(buf)
      } catch {
        return buf.toString('utf8')
      }
    }
    return buf.toString('utf8')
  }

  /** 尾部窗口的起点可能切在多字节字符中间，掐掉开头的 UTF-8 续接字节免得出现替换符。 */
  private trimPartialLeadingChar(buf: Buffer): Buffer {
    if (this.nonUtf8) return buf
    let i = 0
    while (i < buf.length && i < 4 && (buf[i] & 0xc0) === 0x80) i++
    return buf.subarray(i)
  }
}

/** 只在进程内节流一次的日志清理（超期即删）。 */
let lastPruneAt = 0
function pruneOldLogs(dir: string): void {
  const now = Date.now()
  if (now - lastPruneAt < 10 * 60_000) return
  lastPruneAt = now
  try {
    const cutoff = now - LOG_RETENTION_DAYS * 24 * 3600_000
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.log')) continue
      const p = path.join(dir, name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      } catch { /* 忽略单个文件失败 */ }
    }
  } catch { /* 目录不存在等，忽略 */ }
}

function resolveLogDir(opts: RunShellOptions): string | null {
  try {
    const dir = opts.logDir ?? path.join(app.getPath('userData'), 'shell-logs')
    fs.mkdirSync(dir, { recursive: true })
    pruneOldLogs(dir)
    return dir
  } catch {
    return null
  }
}

/** Windows 的 chcp 开关：设置里可关（个别老 .bat 依赖本地代码页），也支持环境变量应急关闭。 */
function shouldForceUtf8(opts: RunShellOptions): boolean {
  if (typeof opts.forceUtf8 === 'boolean') return opts.forceUtf8
  if (process.env.SS_SHELL_NO_CHCP === '1') return false
  try {
    const s = getSettings() as unknown as Record<string, unknown>
    return s.shellForceUtf8 !== false
  } catch {
    return true
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** cwd 顶层快照：失败时一并给出，省掉模型再调一次 list_dir。 */
function cwdSnapshot(dir: string): string {
  try {
    const names = fs.readdirSync(dir).slice(0, 40)
    if (!names.length) return '(空目录)'
    return names.join('  ')
  } catch (e) {
    return `(无法读取：${(e as Error).message})`
  }
}

/**
 * 在本机跑一条 shell 命令并收集 stdout+stderr。Vibe 的 `code_bash`、技能运行时的
 * `bash`、engine 的 `run_script` 共用这一个出口。
 *
 * 关键行为（都是踩过坑之后定下来的，改之前先看注释）：
 * - Windows 走 `cmd.exe /c`，其余走 `/bin/sh -c`；继承 `process.env` 以复用用户的 PATH/代理。
 * - 输出**首尾双缓冲**：头 20KB + 尾 25KB，中间省略。绝不能改回「只留头」——
 *   npm/pytest/构建/traceback 的结论全在尾部。
 * - 全量输出落盘到 userData/shell-logs/，结果里回绝对路径，并 `registerApproved` 过 path-allow，
 *   否则模型拿到路径也读不了。
 * - resolve 等 `'close'`（stdio 真的关完）而不是 `'exit'`；但必须有排水超时，
 *   否则 `npm run dev` 这类孙进程持管道的命令会把 promise 永久吊住。
 * - 终止分两阶段，且**用 killProcessTree**（Windows 上 `taskkill /T /F`）而不是裸 kill，
 *   否则 npm/python 起的孙进程杀不掉。
 * - 编码：Windows 默认加 `chcp 65001` 前缀 + 注入 PYTHONUTF8/PYTHONIOENCODING；
 *   仍然收到非 UTF-8 字节就整条流按 GBK 重解（中文 Windows 的 cmd.exe 是 GBK）。
 */
export function runShell(
  command: string,
  cwd: string,
  abortSignal: AbortSignal,
  timeoutMs = 30_000,
  opts: RunShellOptions = {}
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const isWin = process.platform === 'win32'
    const maxFront = opts.maxFrontBytes ?? DEFAULT_FRONT_BYTES
    const maxTail = opts.maxTailBytes ?? DEFAULT_TAIL_BYTES
    const drainMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_MS
    const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    const hardLimit = opts.hardOutputLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES
    const forceUtf8 = isWin && shouldForceUtf8(opts)

    // `chcp 65001>nul & <cmd>`：cmd.exe /c 的退出码取最后一条命令，errorlevel 不受影响。
    // 个别老 .bat 依赖 936 代码页（框线字符/中文提示会花），所以这一条可以关。
    const winCommand = forceUtf8 ? `chcp 65001>nul & ${command}` : command
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Python 默认按本地代码页输出，中文路径/报错到模型眼里就是乱码；这两个变量强制 UTF-8，
      // surrogateescape 保证遇到非法字节也不会直接抛 UnicodeDecodeError 把脚本搞崩。
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8:surrogateescape',
    }

    const outBuf = new HeadTailBuffer(maxFront, maxTail)
    const errBuf = new HeadTailBuffer(maxFront, maxTail)
    let logPath: string | null = null
    let logStream: fs.WriteStream | null = null
    const logDir = resolveLogDir(opts)

    const openLog = (): void => {
      if (logStream || !logDir) return
      try {
        const name = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.log`
        logPath = path.join(logDir, name)
        logStream = fs.createWriteStream(logPath, { flags: 'a' })
        logStream.on('error', () => { /* 落盘失败不能影响命令本身 */ })
        // 走 path-allow，否则模型拿到 logPath 也读不了（file_read 会被拒）。
        registerApproved(logPath)
      } catch {
        logStream = null
        logPath = null
      }
    }

    let proc: ChildProcess
    try {
      // Windows 必须走 verbatim：默认 spawn 会按 CRT 规则给参数转义，把命令里的 `"` 改成 `\"`，
      // 而 cmd.exe 不认反斜杠转义——`python "C:\含空格 路径\x.py"` 这类命令会直接报
      //「不是内部或外部命令」。`/d` 跳过 AutoRun 注册表脚本（用户装的 doskey/proxy 脚本会污染输出），
      // `/s` 让 cmd 只剥掉最外层那对引号、其余原样。
      proc = spawn(
        isWin ? 'cmd.exe' : '/bin/sh',
        isWin ? ['/d', '/s', '/c', `"${winCommand}"`] : ['-c', command],
        {
          cwd,
          env,
          windowsHide: true,
          windowsVerbatimArguments: isWin,
          // posix：自成进程组，取消时能按组收尸把孙进程一起带走（Windows 无此概念，靠 taskkill /T）。
          detached: !isWin,
        }
      )
    } catch (e) {
      resolve({
        code: -1, stdout: '', stderr: (e as Error).message, timedOut: false,
        killedBy: null, drained: true, durationMs: Date.now() - startedAt,
        diagnostics: `[诊断] 无法启动命令：${(e as Error).message}\ncwd=${cwd}`,
      })
      return
    }

    let timedOut = false
    let killedBy: ShellResult['killedBy'] = null
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let finished = false
    let killTimer: NodeJS.Timeout | null = null
    let drainTimer: NodeJS.Timeout | null = null

    /**
     * 两阶段终止。**Windows 上没有真 SIGTERM**（`child.kill()` 直接 TerminateProcess，
     * 而且只打到 cmd.exe 自己），所以那边第一阶段就得用 taskkill /T /F 整棵树杀——
     * 先温柔杀父只会把孙进程 re-parent 成孤儿、反而更难收。两阶段在 Windows 上实际退化成
     * 「杀树 + 补一刀」，别把这里的注释写成跨平台等价。
     */
    const terminate = (reason: NonNullable<ShellResult['killedBy']>): void => {
      if (killedBy) return
      killedBy = reason
      if (reason === 'timeout') timedOut = true
      if (isWin) killProcessTree(proc)
      else killProcessTree(proc, { signal: 'SIGTERM', processGroup: true })
      killTimer = setTimeout(() => {
        if (isWin) killProcessTree(proc)
        else killProcessTree(proc, { signal: 'SIGKILL', processGroup: true })
      }, graceMs)
    }

    const timeout = setTimeout(() => terminate('timeout'), timeoutMs)
    const onAbort = (): void => terminate('abort')
    abortSignal.addEventListener('abort', onAbort, { once: true })
    // 已经 abort 的 signal 不会再触发事件（上一轮刚被用户停止就又调进来时会遇到）。
    if (abortSignal.aborted) terminate('abort')

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (drainTimer) clearTimeout(drainTimer)
      abortSignal.removeEventListener('abort', onAbort)
    }

    const closeLog = async (): Promise<void> => {
      const ws = logStream
      logStream = null
      if (!ws) return
      await new Promise<void>((r) => ws.end(() => r()))
      // 日志是原样落的字节；若判定为 GBK，回写成 UTF-8，否则模型 file_read 出来还是乱码。
      if (!logPath || (!outBuf.isGbk && !errBuf.isGbk)) return
      try {
        if (fs.statSync(logPath).size > LOG_TRANSCODE_MAX_BYTES) return
        const raw = fs.readFileSync(logPath)
        fs.writeFileSync(logPath, new TextDecoder('gbk', { fatal: false }).decode(raw), 'utf8')
      } catch { /* 转码失败就留原始字节 */ }
    }

    const finish = (drained: boolean): void => {
      if (finished) return
      finished = true
      cleanup()
      try { proc.stdout?.destroy() } catch { /* ignore */ }
      try { proc.stderr?.destroy() } catch { /* ignore */ }
      const out = outBuf.render()
      const err = errBuf.render()
      const code = exitCode ?? (killedBy ? -1 : 0)
      void closeLog().then(() => {
        const result: ShellResult = {
          code,
          stdout: out.text,
          stderr: err.text,
          timedOut,
          signal: exitSignal,
          killedBy,
          bytes: { stdout: outBuf.total, stderr: errBuf.total },
          truncated: out.truncated || err.truncated,
          drained,
          durationMs: Date.now() - startedAt,
        }
        if (logPath) result.logPath = logPath
        // 诊断包只在失败/超时/被我们杀掉/排水不全时挂，成功路径不给模型多余噪音。
        // （被杀但恰好退出码为 0 的竞态也要挂：模型必须知道命令没跑完、输出不完整。）
        if (timedOut || code !== 0 || killedBy || !drained) {
          const lines = [
            `[诊断] 本次命令的完整状态（已一并给出，不必再调工具查）：`,
            `- 退出码 exitCode=${exitCode ?? '(未退出)'}${exitSignal ? ` signal=${exitSignal}` : ''}`,
            killedBy ? `- 终止原因：${killedBy === 'timeout' ? `超时（${timeoutMs}ms）被终止（已连同子孙进程一起杀）` : killedBy === 'abort' ? '用户中止本轮' : `输出超过上限 ${fmtBytes(hardLimit)} 被终止`}` : '- 进程自行退出',
            `- 已收输出：stdout ${fmtBytes(outBuf.total)} / stderr ${fmtBytes(errBuf.total)}${result.truncated ? '（上面是首尾片段，中间已省略）' : ''}`,
            drained ? '' : '- 注意：stdio 排水超时，仍有子孙进程持有管道，尾部输出可能不完整（命令可能仍在后台运行）',
            logPath ? `- 全量输出日志：${logPath}（用 file_read / code_read 读）` : '',
            `- 工作目录 ${cwd} 顶层：${cwdSnapshot(cwd)}`,
          ].filter(Boolean)
          result.diagnostics = lines.join('\n')
        }
        resolve(result)
      })
    }

    const wire = (stream: NodeJS.ReadableStream | null, buf: HeadTailBuffer): void => {
      stream?.on('data', (d: Buffer) => {
        if (finished) return // 已收工（排水超时丢句柄）之后的迟到数据一律丢弃，别再开新日志
        buf.push(d)
        openLog()
        logStream?.write(d)
        if (outBuf.total + errBuf.total > hardLimit) terminate('output_limit')
      })
      // 管道错误（强杀时的 ECONNRESET 等）不能让主进程崩。
      stream?.on('error', () => { /* ignore */ })
    }
    wire(proc.stdout, outBuf)
    wire(proc.stderr, errBuf)

    proc.on('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
      // 'exit' 只代表进程没了，stdio 可能还没 flush（跑得快输出大的命令稳定丢尾部）。
      // 等 'close'，但最多等 drainMs：孙进程继承了管道时 'close' 可能永远不来。
      drainTimer = setTimeout(() => finish(false), drainMs)
    })
    proc.on('close', () => finish(true))
    proc.on('error', (err) => {
      // 旧实现这里漏了 removeEventListener('abort')，abort 监听器会一直挂在
      // 上层的长生命周期 signal 上（一次对话可能跑几十条命令）。
      exitCode = exitCode ?? -1
      if (!finished) {
        finished = true
        cleanup()
        void closeLog().then(() => {
          resolve({
            code: -1,
            stdout: outBuf.render().text,
            stderr: err.message,
            timedOut,
            signal: exitSignal,
            killedBy,
            bytes: { stdout: outBuf.total, stderr: errBuf.total },
            truncated: false,
            drained: true,
            durationMs: Date.now() - startedAt,
            ...(logPath ? { logPath } : {}),
            diagnostics: `[诊断] 命令无法执行：${err.message}\n- 工作目录 ${cwd} 顶层：${cwdSnapshot(cwd)}\n- 提示：cwd 不存在 / 可执行文件不在 PATH 都会走到这里。`,
          })
        })
      }
    })
  })
}
