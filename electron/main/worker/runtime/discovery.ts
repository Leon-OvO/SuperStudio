import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch } from 'node:os'
import type { RuntimeKind, DetectedRuntime } from '../../../../src/shared/ipc-types'

export type { RuntimeKind, DetectedRuntime }

/**
 * 本机 agent 运行时探测（OpenSpec change `pc-runtime-discovery` / PRD 第四部分 §9.6）。
 *
 * 参考 multica onboarding「Runtimes」：探测这台 PC 上装了哪些编码 CLI（claude/codex/opencode），
 * 供「选一个 agent 运行时」的引导/设置 UI 列出。本模块只做**探测**（定位 + 版本 + 可用性），
 * 不驱动执行（驱动见 {@link ./agent-runtime}）。
 *
 * 关键点：
 * - 按 PATH（which/where）定位；单个运行时探测失败不影响其它（各自 try/catch）。
 * - Windows 上 `opencode.cmd` 批处理 shim 的 `%*` 转发不保留换行，会截断多行 prompt——
 *   故 opencode 命中 shim 时把 `execPath` 指向 npm 包内的原生 `opencode.exe`（与驱动阶段一致，
 *   见 pc-agent-runtime opencode 适配器），避免选了之后驱动踩坑。
 * - 版本取不到不致命：能定位即视为可用（`available=true`）。
 */

const pExecFile = promisify(execFile)

interface RuntimeSpec {
  kind: RuntimeKind
  displayName: string
  /** PATH 上的命令名。 */
  bin: string
  versionArgs: string[]
}

/** 受支持的运行时清单（后续可扩 cursor/copilot 等）。 */
const SUPPORTED: RuntimeSpec[] = [
  { kind: 'claude', displayName: 'Claude Code', bin: 'claude', versionArgs: ['--version'] },
  { kind: 'codex', displayName: 'Codex', bin: 'codex', versionArgs: ['--version'] },
  { kind: 'opencode', displayName: 'OpenCode', bin: 'opencode', versionArgs: ['--version'] },
]

const isWin = process.platform === 'win32'

/** 解析版本输出里的第一个 semver（宽松：兼容 "1.2.3 (Claude Code)"、"opencode 0.4.1"、"v2.0.0-beta"）。 */
export function parseVersion(out: string): string | null {
  const m = out.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/)
  return m ? m[0] : null
}

/**
 * 从 Windows `opencode.cmd` shim 路径推导 npm 包内原生 exe 的候选路径（按 arch 优先级）。
 * 纯函数（无 IO），便于单测。arm64 主机优先 arm64；否则 x64 → x64-baseline（老 CPU 无 AVX2）→ arm64。
 */
export function opencodeNativeCandidates(shimPath: string, archName: string): string[] {
  const binDir = dirname(shimPath)
  // npm 全局 bin 目录里是 opencode.cmd；包体在 <prefix>/node_modules/opencode-ai/node_modules/...
  const roots = [
    join(binDir, 'node_modules', 'opencode-ai', 'node_modules'),
    join(dirname(binDir), 'node_modules', 'opencode-ai', 'node_modules'),
  ]
  const archOrder =
    archName === 'arm64'
      ? ['opencode-windows-arm64', 'opencode-windows-x64', 'opencode-windows-x64-baseline']
      : ['opencode-windows-x64', 'opencode-windows-x64-baseline', 'opencode-windows-arm64']
  const out: string[] = []
  for (const root of roots) for (const pkg of archOrder) out.push(join(root, pkg, 'bin', 'opencode.exe'))
  return out
}

/**
 * Windows opencode shim → npm 包内原生 exe（找不到返回 null，回退用 shim 路径）。
 * npm 全局装 opencode-ai 会同时生成 `opencode`(无扩展 #!/bin/sh 脚本) 与 `opencode.cmd`；
 * `where` 可能任一在前。两者都不能直接 spawn 出完整多行 prompt（.cmd 的 %* 截断换行、
 * 无扩展脚本 Windows 不认），故对任意 opencode shim 都尝试从同级 node_modules 派生原生 exe。
 */
export function deriveOpencodeNativeExe(shimPath: string): string | null {
  if (!isWin) return null
  for (const exe of opencodeNativeCandidates(shimPath, arch())) {
    if (existsSync(exe)) return exe
  }
  return null
}

/** 取首个非空行。 */
function firstLine(s: string): string | null {
  return (
    s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)[0] ?? null
  )
}

/** 用 where(win)/which(posix) 定位命令，返回首个命中路径；未找到/出错返回 null。 */
async function locateExecutable(bin: string): Promise<string | null> {
  const finder = isWin ? 'where' : 'which'
  try {
    const { stdout } = await pExecFile(finder, [bin], { timeout: 5000, windowsHide: true })
    return firstLine(stdout)
  } catch {
    return null
  }
}

/**
 * 登录 shell 兜底定位（仅 posix）。GUI 启动的 Electron 应用 PATH 被截断——拿不到用户 shell
 * （.zshrc/.bashrc/nvm/homebrew）里配的路径，直接 which 会漏检明明装了的 CLI。用交互登录 shell
 * 解析一次 `command -v <bin>`。win 无此问题（返回 null）。
 */
async function locateViaLoginShell(bin: string): Promise<string | null> {
  if (isWin) return null
  const shell = process.env.SHELL || '/bin/bash'
  try {
    const { stdout } = await pExecFile(shell, ['-lic', `command -v ${bin} 2>/dev/null`], { timeout: 6000 })
    const p = firstLine(stdout)
    return p && p.startsWith('/') ? p : null // 只认绝对路径（command -v 对 shell 内建/别名会回非路径）
  } catch {
    return null
  }
}

/** 探测单个运行时——永不抛（单项失败降级为 available:false + reason）。 */
async function detectOne(spec: RuntimeSpec): Promise<DetectedRuntime> {
  const base: DetectedRuntime = {
    kind: spec.kind,
    displayName: spec.displayName,
    execPath: null,
    version: null,
    available: false,
  }
  try {
    // 先直接 which/where；posix 上找不到再用登录 shell 兜底（GUI 应用 PATH 截断）。
    const located = (await locateExecutable(spec.bin)) ?? (await locateViaLoginShell(spec.bin))
    if (!located) return { ...base, reason: '未在 PATH 上找到，可能尚未安装' }

    let execPath = located
    if (spec.kind === 'opencode') {
      const native = deriveOpencodeNativeExe(located)
      if (native) execPath = native // 用原生 exe，绕过 .cmd shim 的多行 prompt 截断
      // Windows 上派生不到原生 .exe(只有 .cmd/无扩展 shim)时，OpenCodeRuntime.run 会硬拒绝执行；此处必须同门槛
      // 置 available:false，否则「探测说可用、每个任务却必失败」——UI 还会把它列为可选/默认运行时。
      else if (isWin) return { ...base, reason: 'Windows 上未找到 OpenCode 原生 .exe（.cmd shim 无法安全运行），请重装 opencode 后刷新' }
    }

    // 取版本：win 走 shell 解析 .cmd/PATHEXT（整条命令串 + 空 args，避免 DEP0190）；
    // posix 直接 execFile(bin, args)。失败不致命（能定位即可用）。
    let version: string | null = null
    try {
      // posix 用已解析的绝对 execPath(而非裸 spec.bin):经登录 shell 兜底定位到的运行时(nvm/homebrew,
      // 不在 GUI Electron 的精简 PATH 里)若用裸名走 process.env.PATH 会 ENOENT→版本恒 null。shell:false 下绝对路径含空格也安全。
      const cmd = isWin ? `${spec.bin} ${spec.versionArgs.join(' ')}` : execPath
      const cmdArgs = isWin ? [] : spec.versionArgs
      const { stdout } = await pExecFile(cmd, cmdArgs, {
        timeout: 8000,
        windowsHide: true,
        shell: isWin,
      })
      version = parseVersion(stdout)
    } catch {
      // 版本探测失败：仍视为可用
    }

    return { ...base, execPath, version, available: true }
  } catch (e) {
    return { ...base, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 探测本机所有受支持的 agent 运行时（并行、异步、互不影响）。
 * 供 IPC `runtime:list` / `runtime:refresh` 调用。
 */
export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  return Promise.all(SUPPORTED.map(detectOne))
}

/** 受支持运行时的静态元信息（UI 在零探测结果时也能展示「可安装哪些」）。 */
export function supportedRuntimes(): { kind: RuntimeKind; displayName: string }[] {
  return SUPPORTED.map((s) => ({ kind: s.kind, displayName: s.displayName }))
}

const execPathCache = new Map<RuntimeKind, string | null>()

/**
 * 解析某运行时**用于 spawn 的真实可执行文件路径**（定位 + 登录 shell 兜底 + opencode 原生 exe 派生），
 * 缓存。供适配器起进程用——尤其 opencode 必须拿原生 exe(而非 shim)才不截断多行 prompt。
 * 返回 null 表示未找到（调用方回退 bare 命令名 + PATH）。
 */
export async function resolveRuntimeExecPath(kind: RuntimeKind): Promise<string | null> {
  const cached = execPathCache.get(kind)
  if (cached) return cached // 只缓存成功解析；null 不缓存，避免装前/瞬时超时把失败永久钉死
  const spec = SUPPORTED.find((s) => s.kind === kind)
  if (!spec) return null
  let located = (await locateExecutable(spec.bin)) ?? (await locateViaLoginShell(spec.bin))
  if (located && kind === 'opencode') {
    const native = deriveOpencodeNativeExe(located)
    if (native) located = native
  }
  if (located) execPathCache.set(kind, located)
  return located ?? null
}

/** 清运行时可执行路径缓存（RUNTIME_REFRESH 用——装好运行时后刷新即可重探，不必重启应用）。 */
export function clearRuntimeExecPathCache(): void {
  execPathCache.clear()
}
