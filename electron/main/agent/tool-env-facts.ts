/**
 * 运行环境事实（供工具描述使用）。
 *
 * 为什么需要：`run_script` 在 Windows 上跑的是 `cmd.exe /c`（见
 * services/shell.ts），而工具描述以前只说"走系统 shell"、还举 `bash x.sh` 为例。
 * 模型照着写 `grep` / `sed` / `head` 必然 exit 1，连错几次之后就退化成"我给你脚本
 * 你自己跑"——本质上是我们没告诉它这台机器长什么样。
 *
 * 铁律：这里只放【会话之间也不变】的事实（平台、shell、是否有 POSIX 工具、Git Bash
 * 路径）。它们会被拼进工具描述，也就是提示词缓存前缀的一部分——逐轮变化的量（比如
 * 某个可执行文件此刻在不在）绝不能放进来，否则前缀逐轮变字节、缓存断点全 miss。
 *
 * 探测策略：进程内惰性探测一次并持久化到 userData（带版本号 + App 版本号，任一变化
 * 就重探）。探测本身只查 PATH 上的文件是否存在，不 spawn 任何进程。
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface ToolEnvFacts {
  /** 本机是否 Windows。 */
  isWindows: boolean
  /** `run_script` / `ssh_exec(localhost)` 实际使用的 shell。 */
  shellName: string
  /** PATH 上是否有 grep/sed 这类 POSIX 文本工具（非 Windows 恒为 true）。 */
  hasUnixUtils: boolean
  /** 检测到的 Git Bash 绝对路径；没有则为空串。 */
  gitBashPath: string
}

/** 事实结构或探测口径变化时 +1，让旧缓存失效。 */
export const TOOL_ENV_FACTS_VERSION = 1

const CACHE_FILE = 'tool-env-facts.json'

interface CachedFacts {
  version: number
  appVersion: string
  facts: ToolEnvFacts
}

let memo: ToolEnvFacts | null = null

function appVersion(): string {
  try { return app.getVersion() } catch { return 'unknown' }
}

function cachePath(): string | null {
  try { return path.join(app.getPath('userData'), CACHE_FILE) } catch { return null }
}

/** PATH 上是否存在某个可执行文件（Windows 按 PATHEXT 逐个后缀试）。 */
function existsOnPath(bin: string, isWindows: boolean): boolean {
  const raw = process.env.PATH || process.env.Path || ''
  if (!raw) return false
  const dirs = raw.split(isWindows ? ';' : ':').filter(Boolean)
  const exts = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(d, bin + ext))) return true
      } catch { /* 目录不可读 → 跳过 */ }
    }
  }
  return false
}

/**
 * 找 Git Bash。刻意【排除】System32 下的 bash.exe —— 那是 WSL 的入口，它看到的
 * 是 Linux 文件系统，把 Windows 路径喂给它只会得到"找不到文件"。
 */
function findGitBash(): string {
  const candidates: string[] = []
  const pf = process.env.ProgramFiles
  const pf86 = process.env['ProgramFiles(x86)']
  const local = process.env.LOCALAPPDATA
  if (pf) candidates.push(path.join(pf, 'Git', 'bin', 'bash.exe'))
  if (pf86) candidates.push(path.join(pf86, 'Git', 'bin', 'bash.exe'))
  if (local) candidates.push(path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ }
  }
  // 再扫一遍 PATH，但跳过 System32（WSL 陷阱）。
  const raw = process.env.PATH || process.env.Path || ''
  const sysRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
  for (const d of raw.split(';').filter(Boolean)) {
    if (d.toLowerCase().startsWith(path.join(sysRoot, 'system32').toLowerCase())) continue
    const p = path.join(d, 'bash.exe')
    try { if (fs.existsSync(p)) return p } catch { /* 忽略 */ }
  }
  return ''
}

/** 真正的探测（不读缓存）。导出供测试与缓存失效路径使用。 */
export function detectToolEnvFacts(): ToolEnvFacts {
  const isWindows = process.platform === 'win32'
  if (!isWindows) {
    return { isWindows: false, shellName: '/bin/sh', hasUnixUtils: true, gitBashPath: '' }
  }
  // grep 与 sed 都在才算"有"：只有其一时模型照样会写出跑不通的管道。
  const hasUnixUtils = existsOnPath('grep', true) && existsOnPath('sed', true)
  return { isWindows: true, shellName: 'cmd.exe', hasUnixUtils, gitBashPath: findGitBash() }
}

/**
 * 取运行环境事实。进程内只探测一次；跨进程走 userData 里的持久缓存，
 * 版本号或 App 版本变化时重探（App 升级后用户环境可能已经变了）。
 */
export function getToolEnvFacts(): ToolEnvFacts {
  if (memo) return memo
  const file = cachePath()
  if (file) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedFacts
      if (cached
        && cached.version === TOOL_ENV_FACTS_VERSION
        && cached.appVersion === appVersion()
        && cached.facts
        && typeof cached.facts.isWindows === 'boolean'
        && typeof cached.facts.shellName === 'string'
        && typeof cached.facts.hasUnixUtils === 'boolean'
        && typeof cached.facts.gitBashPath === 'string') {
        memo = cached.facts
        return memo
      }
    } catch { /* 无缓存 / 损坏 → 重探 */ }
  }
  const facts = detectToolEnvFacts()
  memo = facts
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ version: TOOL_ENV_FACTS_VERSION, appVersion: appVersion(), facts } satisfies CachedFacts), 'utf8')
    } catch (e) {
      console.warn('[tool-env] 环境事实缓存写入失败（不影响本次运行）：', (e as Error).message)
    }
  }
  return facts
}

/** 仅供测试：清掉进程内缓存。 */
export function resetToolEnvFactsCache(): void { memo = null }

/**
 * 把环境事实翻译成给模型看的一段话，拼进本机执行类工具的描述里。
 * 纯函数（只依赖入参），可直接单测。
 */
export function describeShellEnv(facts: ToolEnvFacts): string {
  if (!facts.isWindows) {
    return `本机 shell 是 ${facts.shellName}（POSIX）：grep / sed / awk / head / tail 等常用命令可直接使用；` +
      '多条命令用 `&&` 串联，末尾 `&` 表示后台运行。'
  }
  const posix = facts.gitBashPath
    ? `需要 POSIX 工具时【显式走 Git Bash】：\`"${facts.gitBashPath}" -lc "命令"\`（注意路径要用 Git Bash 认得的写法）；`
    : '本机未检测到 Git Bash，'
  const utils = facts.hasUnixUtils
    ? 'PATH 上检测到 grep / sed，可以直接用；其余 POSIX 工具（awk / head / tail 等）不保证存在。'
    : '【没有】grep / sed / awk / head / tail 等 POSIX 工具，写了必然 exit 1。'
  return `本机 shell 是 ${facts.shellName}（Windows 命令处理器，不是 bash）：${utils}` +
    '`&` 是【顺序分隔符】不是后台运行（后台用 `start /b`）；路径分隔符是 `\\`，多条命令用 `&&` 串联；' +
    '变量写 `%VAR%` 不是 `$VAR`。' +
    posix +
    '更稳妥的做法是直接写一段 node / python 脚本来完成同样的事，而不是拼 shell 管道。'
}
