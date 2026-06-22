/**
 * IPC handlers for the Vibe / Build page.
 *
 * Two-phase OpenSpec-style workflow:
 *   1. PROPOSE — user describes a need → AI returns structured tasks (Zod schema)
 *      → persisted in DB + mirrored to openspec/changes/<slug>/{proposal,tasks}.md
 *   2. APPLY  — user clicks execute → AI works through tasks one at a time
 *      with code_read/write/edit/grep/glob/bash tools
 *
 * Models come from the user's supercode providers (or any chat provider).
 * Each project remembers its preferred model in DB.
 */

import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { streamText, generateText, tool, type Tool, type CoreMessage } from 'ai'
import { z } from 'zod'
import { IPC } from '../../../src/shared/ipc-types'
import { repairUnescapedQuotes } from '../../../src/shared/json-repair'
import type {
  FileTreeNode,
  VibeProgressEvent,
  VibeRequestInfo,
  VibeTaskInfo,
  VibeMessageInfo,
  VibeProjectInfo,
  VibeIntent
} from '../../../src/shared/ipc-types'
import { getMainWindow } from '../index'
import { getProviders, getSettings } from '../services/store'
import { createLLMClient, thinkingStreamOpts, effectiveProtocol, anthropicSystemCacheMessage, type ThinkingMode } from '../services/llm'
import { recallForProject, captureFromTranscript } from '../services/memory'
import {
  getVibeProjectsRoot,
  addRecentProject,
  removeRecentProject,
  getRecentProjects,
  isAllowedProjectPath,
} from '../services/vibe-projects'
import { registerApprovedRoot } from '../services/path-allow'
import {
  upsertProject, setProjectModel,
  createRequest, listRequests, listAllRequests, taskRollupByRequest, getRequest, updateRequestStatus, updateRequestSummary,
  deleteRequest, deleteTasksForRequest, slugify, setRequestAssignee,
  createTask, listTasks, updateTaskStatus, setTaskAssignee, getTask,
  setTaskDeps, markTaskBlocked, parseTaskDeps,
  setTaskRevertInfo, clearTaskRevertInfo, getTaskRevertInfo,
  appendMessage, listMessages,
  type VibeRequestRow, type VibeTaskRow, type VibeMessageRow, type VibeProjectRow
} from '../services/vibe-db'
import { getEmployee, listEmployees, setEmployeeStatus, bumpEmployeeStats } from '../services/employees-db'
import type { EmployeeInfo } from '../../../src/shared/ipc-types'
import { getSoul } from '../services/talent-pool'
import { dbRun } from '../db/sqlite'
import { writeProposalMd, writeTasksMd } from '../services/vibe-spec'
import { getActiveSkillsForScenario, type InstalledSkill } from '../services/skills-db'
import { scanWorkdirSkills } from '../services/workdir-extensions'
import { buildSkillTools } from '../agent/skill-tools'
import { classifyVibeIntent } from '../agent/classify'
import { agentRunSemaphore } from '../agent/semaphore'
import { topologicalLevels } from '../agent/pure'
import { runShell } from '../services/shell'
import * as gitSvc from '../services/git-service'
import { parseTestOutput, type TestFramework } from '../agent/test-parse'
import { getSshConnections } from '../services/store'
import { sshExec, resolveSshConnection } from '../services/ssh-service'
import { confirmSshExec } from '../services/ssh-guard'
import { computeCost } from '../services/model-pricing'

/**
 * Build a system-prompt fragment from the skills the user enabled for the
 * "vibe" (build) scenario. Returns '' when no skills apply.
 */
function buildVibeSkillsSection(projectPath?: string): { section: string; skills: InstalledSkill[] } {
  let skills: InstalledSkill[] = []
  try { skills = getActiveSkillsForScenario('vibe') }
  catch (e) { console.warn('[vibe] failed to load active skills:', (e as Error).message) }
  // 工作目录扩展（随项目临时生效）：<project>/.claude/skills 里的技能仅为本次运行加载，
  // 不写 DB、不进全局「技能中心」。按 name 去重，已启用的同名技能优先。
  if (projectPath) {
    try {
      const have = new Set(skills.map(s => s.name.toLowerCase()))
      const wd = scanWorkdirSkills(projectPath, 'vibe').filter(s => !have.has(s.name.toLowerCase()))
      if (wd.length) skills = [...skills, ...wd]
    } catch (e) { console.warn('[vibe] 工作目录技能加载失败：', (e as Error).message) }
  }
  if (!skills.length) return { section: '', skills: [] }

  // Legacy skills inject their full prompt; runtime skills only list name +
  // description and load their body on demand via load_skill.
  const legacy = skills.filter(s => !s.runtime)
  const runtime = skills.filter(s => s.runtime)
  const parts: string[] = []

  if (legacy.length) {
    const blocks = legacy.map(s => {
      const header = `### ${s.name}${s.version ? ` (v${s.version})` : ''}`
      const body = (s.systemPrompt || '').trim() || `(${s.description || 'no prompt provided'})`
      return `${header}\n${body}`
    }).join('\n\n')
    parts.push(
      `## Active Skills (user-enabled)\n` +
      `The user has enabled the following skills for this workspace. Follow each skill's guidance ` +
      `where it applies; they are additive on top of your base behavior.\n\n${blocks}`
    )
  }

  if (runtime.length) {
    const lines = runtime.map(s => `- ${s.name}: ${s.description || '(no description)'}`)
    parts.push(
      `## Available Skills\n` +
      `The user has enabled the following Agent Skills — each is a self-contained bundle of ` +
      `instructions + resources on disk. Only the name + a one-line description is shown here.\n` +
      `When a request matches one of these skills, FIRST call \`load_skill(name)\` to load its ` +
      `full instructions, then follow them. Use \`read_skill_file\` to read bundled reference files; ` +
      `run any bundled scripts through \`code_bash\`.\n\n${lines.join('\n')}`
    )
  }

  return { section: parts.length ? '\n\n' + parts.join('\n\n') : '', skills }
}

/**
 * Progressive-disclosure tools (load_skill / read_skill_file) for the runtime
 * skills enabled in the vibe scenario. No `bash` — vibe already exposes
 * `code_bash`, through which bundled scripts run. Returns {} when none apply.
 */
function buildVibeSkillTools(
  projectRoot: string,
  runtimeSkills: InstalledSkill[],
  emit: (e: Omit<VibeProgressEvent, 'projectPath'>) => void,
  abortSignal: AbortSignal
): Record<string, Tool> {
  if (!runtimeSkills.length) return {}
  return buildSkillTools({
    activeSkills: runtimeSkills,
    cwd: projectRoot,
    abortSignal,
    includeBash: false,
    hooks: {
      onUse: (toolName, args) => {
        const label = typeof args.name === 'string' ? args.name
          : typeof args.path === 'string' ? args.path : ''
        emit({ type: 'tool_use', toolName, toolArgsPreview: label })
      },
      onResult: (toolName, _args, _result, isError) => {
        emit({ type: 'tool_result', toolName, toolResultPreview: isError ? '失败' : '完成', isError })
      }
    }
  })
}

/**
 * Filter a tools dict by the union of skill whitelists. If any skill has a
 * null/undefined whitelist, returns the dict unchanged (unrestricted).
 */
function applyVibeSkillsFilter<T extends Record<string, unknown>>(
  tools: T,
  skills: InstalledSkill[]
): T {
  if (!skills.length) return tools
  if (skills.some(s => !s.toolWhitelist)) return tools
  const allowed = new Set<string>()
  for (const s of skills) for (const n of s.toolWhitelist || []) allowed.add(n)
  const filtered = Object.fromEntries(
    Object.entries(tools).filter(([name]) => allowed.has(name))
  ) as T
  const dropped = Object.keys(tools).filter(n => !allowed.has(n))
  if (dropped.length) console.log(`[vibe] skills filtered tools, dropped: ${dropped.join(', ')}`)
  return filtered
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo', 'out', 'build',
  '.cache', '.parcel-cache', '.vite', '.svelte-kit', '.nuxt'
])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])
const MAX_DEPTH = 8
const MAX_FILE_SIZE = 1024 * 1024  // 1 MB cap
const MAX_WRITE_SIZE = 2 * 1024 * 1024  // 2 MB cap for writes

function walkTree(dir: string, depth: number): FileTreeNode[] {
  if (depth > MAX_DEPTH) return []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return [] }
  const out: FileTreeNode[] = []
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue
    if (!ent.isDirectory() && SKIP_FILES.has(ent.name)) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push({ name: ent.name, path: full, isDir: true, children: walkTree(full, depth + 1) })
    } else if (ent.isFile()) {
      out.push({ name: ent.name, path: full, isDir: false })
    }
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

function listTopLevel(projectPath: string): string {
  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true })
      .filter(e => !SKIP_DIRS.has(e.name) && !SKIP_FILES.has(e.name))
      .slice(0, 50)
      .map(e => e.isDirectory() ? `${e.name}/` : e.name)
    return entries.join(', ')
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function resolveInRoot(projectRoot: string, relOrAbs: string): string {
  const candidate = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(projectRoot, relOrAbs)
  const abs = path.resolve(candidate)
  const root = path.resolve(projectRoot)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${relOrAbs} 不在项目目录内`)
  }
  return abs
}

// ---------------------------------------------------------------------------
// Active runs
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, AbortController>()
// Apply runs are tracked per-REQUEST (not per-project) so multiple sub-tasks of
// one requirement can run in parallel under a single AbortController.
const activeApplyRuns = new Map<string, AbortController>()

// Per-absolute-path async mutex — different files run in parallel, the same file
// serializes. Makes parallel code_write/code_edit safe (writeFileSync + the
// read→replace→write of code_edit are not atomic across concurrent tasks).
const fileLocks = new Map<string, Promise<unknown>>()
function withFileLock<T>(abs: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = fileLocks.get(abs) ?? Promise.resolve()
  const run = prev.then(() => fn())
  // Keep the chain alive even if fn throws, so the next waiter still proceeds.
  fileLocks.set(abs, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Coerce a possibly-NaN-or-undefined usage value to a finite number or null.
 * Some upstream providers resolve `result.usage` with NaN when they don't
 * track tokens — NaN slips past `??` and would otherwise be written to the DB,
 * surfacing later as "— → — tok · —" chips with NaN in the tooltip.
 */
function finiteUsage(n: number | undefined | null): number | null {
  return n != null && Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Tools (reused by APPLY phase)
// ---------------------------------------------------------------------------

function buildVibeTools(
  projectRoot: string,
  emit: (e: Omit<VibeProgressEvent, 'projectPath'>) => void,
  abortSignal: AbortSignal
) {
  const truncate = (s: string, n = 200) => s.length > n ? s.slice(0, n) + '…' : s
  // Configurable shell timeout (default 5 min) so install/build/test commands
  // fit — the old hard-coded 30s truncated them.
  const bashTimeout = getSettings().vibeBashTimeoutMs ?? 300_000

  return {
    code_read: tool({
      description: 'Read a text file from the project. Use this before editing.',
      parameters: z.object({ path: z.string().describe('Path inside the project') }),
      execute: async ({ path: p }) => {
        const abs = resolveInRoot(projectRoot, p)
        const rel = path.relative(projectRoot, abs) || path.basename(abs)
        emit({ type: 'tool_use', toolName: 'code_read', toolArgsPreview: rel })
        try {
          const stat = fs.statSync(abs)
          if (!stat.isFile()) throw new Error('不是文件')
          if (stat.size > MAX_FILE_SIZE) throw new Error(`文件过大 (${(stat.size/1024).toFixed(0)} KB)`)
          const content = fs.readFileSync(abs, 'utf8')
          emit({ type: 'tool_result', toolName: 'code_read', toolResultPreview: `${stat.size} bytes` })
          return { content }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_read', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_write: tool({
      description: 'Create or overwrite a file in the project. Creates parent dirs as needed. Use for new files; prefer code_edit for changes to existing files.',
      parameters: z.object({
        path: z.string().describe('Path inside the project'),
        content: z.string().describe('Full file content')
      }),
      execute: async ({ path: p, content }) => {
        const abs = resolveInRoot(projectRoot, p)
        const rel = path.relative(projectRoot, abs) || path.basename(abs)
        emit({ type: 'tool_use', toolName: 'code_write', toolArgsPreview: `${rel} (${content.length}B)` })
        try {
          if (content.length > MAX_WRITE_SIZE) throw new Error('内容过大')
          await withFileLock(abs, () => {
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, content, 'utf8')
          })
          emit({ type: 'tool_result', toolName: 'code_write', toolResultPreview: `已写入 ${rel}`, filePath: abs })
          return { ok: true, bytes: content.length }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_write', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_edit: tool({
      description: 'Edit an existing file by replacing an exact string. oldString must match exactly once.',
      parameters: z.object({
        path: z.string(),
        oldString: z.string().describe('Exact substring to find (must occur exactly once)'),
        newString: z.string().describe('Replacement string')
      }),
      execute: async ({ path: p, oldString, newString }) => {
        const abs = resolveInRoot(projectRoot, p)
        const rel = path.relative(projectRoot, abs) || path.basename(abs)
        emit({ type: 'tool_use', toolName: 'code_edit', toolArgsPreview: rel })
        try {
          // read→replace→write inside the per-file lock so it's atomic vs other
          // concurrent tasks editing the same file.
          await withFileLock(abs, () => {
            const original = fs.readFileSync(abs, 'utf8')
            const occ = original.split(oldString).length - 1
            if (occ === 0) throw new Error('oldString 未在文件中找到')
            if (occ > 1) throw new Error(`oldString 在文件中匹配了 ${occ} 次，需要更精确的上下文`)
            fs.writeFileSync(abs, original.replace(oldString, newString), 'utf8')
          })
          emit({ type: 'tool_result', toolName: 'code_edit', toolResultPreview: `已修改 ${rel}`, filePath: abs })
          return { ok: true }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_edit', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_glob: tool({
      description: 'List files matching a glob pattern. Returns relative paths.',
      parameters: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        emit({ type: 'tool_use', toolName: 'code_glob', toolArgsPreview: pattern })
        try {
          const regex = globToRegex(pattern)
          const matches: string[] = []
          function walk(dir: string, depth: number) {
            if (depth > MAX_DEPTH || matches.length > 500) return
            const ents = fs.readdirSync(dir, { withFileTypes: true })
            for (const e of ents) {
              if (e.isSymbolicLink()) continue
              if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
              const full = path.join(dir, e.name)
              if (e.isDirectory()) walk(full, depth + 1)
              else if (e.isFile()) {
                const rel = path.relative(projectRoot, full).replace(/\\/g, '/')
                if (regex.test(rel)) matches.push(rel)
              }
            }
          }
          walk(projectRoot, 0)
          emit({ type: 'tool_result', toolName: 'code_glob', toolResultPreview: `${matches.length} matches` })
          return { files: matches }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_glob', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_grep: tool({
      description: 'Regex search across project files. Returns matching file:line snippets.',
      parameters: z.object({
        pattern: z.string(),
        glob: z.string().nullable().optional().describe('Optional file filter; omit or null for all files')
      }),
      execute: async ({ pattern, glob }) => {
        emit({ type: 'tool_use', toolName: 'code_grep', toolArgsPreview: pattern })
        try {
          const re = new RegExp(pattern)
          const fileFilter = glob ? globToRegex(glob) : null
          const out: { file: string; line: number; text: string }[] = []
          function walk(dir: string, depth: number) {
            if (depth > MAX_DEPTH || out.length > 200) return
            const ents = fs.readdirSync(dir, { withFileTypes: true })
            for (const e of ents) {
              if (e.isSymbolicLink()) continue
              if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
              const full = path.join(dir, e.name)
              if (e.isDirectory()) walk(full, depth + 1)
              else if (e.isFile()) {
                const rel = path.relative(projectRoot, full).replace(/\\/g, '/')
                if (fileFilter && !fileFilter.test(rel)) continue
                try {
                  const stat = fs.statSync(full)
                  if (stat.size > MAX_FILE_SIZE) continue
                  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
                  lines.forEach((line, i) => {
                    if (re.test(line)) out.push({ file: rel, line: i + 1, text: truncate(line, 200) })
                  })
                } catch { /* binary or unreadable */ }
              }
            }
          }
          walk(projectRoot, 0)
          emit({ type: 'tool_result', toolName: 'code_grep', toolResultPreview: `${out.length} matches` })
          return { matches: out.slice(0, 200) }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_grep', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_bash: tool({
      description: `Run shell command in project root. Captures stdout+stderr. Timeout ${Math.round(bashTimeout / 1000)}s (configurable). Use for install / build / run; for tests prefer code_test.`,
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        emit({ type: 'tool_use', toolName: 'code_bash', toolArgsPreview: truncate(command, 80) })
        try {
          const result = await runShell(command, projectRoot, abortSignal, bashTimeout)
          const summary = `exit ${result.code}${result.timedOut ? ' (timed out)' : ''}, ${result.stdout.length + result.stderr.length} bytes`
          emit({ type: 'tool_result', toolName: 'code_bash', toolResultPreview: summary, isError: result.code !== 0 })
          return result
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_bash', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    code_test: tool({
      description: 'Run the project test suite and get a STRUCTURED result (parses jest / vitest / pytest). Prefer this over code_bash for tests/自测/验收: on failure it returns the failing test names + messages so you can fix the code and call code_test again to verify. Auto-detects the command from package.json "test" / installed runner / pytest when `command` is omitted.',
      parameters: z.object({
        command: z.string().nullable().optional().describe('Test command, e.g. "npm test" or "pytest -q". Omit to auto-detect.'),
        framework: z.enum(['jest', 'vitest', 'pytest', 'auto']).nullable().optional().describe('Force the output parser; default auto-detect.'),
      }),
      execute: async ({ command, framework }) => {
        const cmd = (command && command.trim()) || detectTestCommand(projectRoot)
        if (!cmd) {
          const msg = '未找到测试命令（package.json 无 test 脚本、未装 vitest/jest、也无 pytest）。请显式传 command。'
          emit({ type: 'tool_result', toolName: 'code_test', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
        emit({ type: 'tool_use', toolName: 'code_test', toolArgsPreview: truncate(cmd, 80) })
        try {
          const result = await runShell(cmd, projectRoot, abortSignal, bashTimeout)
          const combined = `${result.stdout}\n${result.stderr}`
          const parsed = parseTestOutput(combined, (framework ?? 'auto') as TestFramework | 'auto')
          // Trust the parsed failure count when we have it; otherwise fall back
          // to the process exit code (a runner we couldn't parse).
          const ok = parsed.ok != null ? (parsed.ok && result.code === 0) : result.code === 0
          const summary = parsed.total != null
            ? `${ok ? '通过' : '失败'} · ${parsed.passed ?? '?'}/${parsed.total}${parsed.failed ? ` (${parsed.failed} failed)` : ''}`
            : `exit ${result.code}${result.timedOut ? ' (timed out)' : ''}`
          emit({ type: 'tool_result', toolName: 'code_test', toolResultPreview: summary, isError: !ok })
          return {
            ok,
            command: cmd,
            framework: parsed.framework,
            passed: parsed.passed, failed: parsed.failed, total: parsed.total,
            failures: parsed.failures.slice(0, 20),
            exitCode: result.code,
            timedOut: result.timedOut,
            // Tail of raw output so the model can read context the parser missed.
            output: tailLines(combined, 120),
          }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_test', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    }),
    ssh_exec: tool({
      description: (() => {
        const conns = getSshConnections()
        const list = conns.length ? conns.map(c => `${c.name}(${c.username}@${c.host})`).join('、') : '（无，请先在「设置 → SSH 连接」添加）'
        return '在【预配置的 SSH 连接】上的远程服务器执行一条 shell 命令，返回 {host,exitCode,stdout,stderr}。' +
          `可用连接：${list}。connection 传连接名（或 id）。凭据本机加密保管,不进上下文;命令独立执行(不留 cwd,需切目录用 cd x && cmd);某连接首次执行会弹窗请用户确认。`
      })(),
      parameters: z.object({
        connection: z.string().describe('已配置的 SSH 连接名称或 id'),
        command: z.string().describe('要在远程服务器上执行的 shell 命令'),
      }),
      execute: async ({ connection, command }) => {
        const { conn, error: resolveErr } = resolveSshConnection(connection, getSshConnections())
        if (!conn) {
          emit({ type: 'tool_result', toolName: 'ssh_exec', toolResultPreview: '无此连接', isError: true })
          return { error: resolveErr }
        }
        emit({ type: 'tool_use', toolName: 'ssh_exec', toolArgsPreview: `${conn.name}: ${truncate(command, 80)}` })
        const allowed = await confirmSshExec(conn.id, conn.host, command)
        if (!allowed) {
          emit({ type: 'tool_result', toolName: 'ssh_exec', toolResultPreview: '用户未授权', isError: true })
          return { error: `已取消：用户未授权在「${conn.name}」上执行该命令。` }
        }
        try {
          const r = await sshExec(conn.id, command, abortSignal)
          emit({ type: 'tool_result', toolName: 'ssh_exec', toolResultPreview: `exit ${r.code}`, isError: r.code !== 0 })
          return { host: conn.host, exitCode: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'ssh_exec', toolResultPreview: msg, isError: true })
          return { error: msg }
        }
      }
    })
  }
}

/**
 * Read-only subset of vibe tools — for EXPLORE mode where the agent can
 * investigate the codebase but must NOT modify it. No code_write/edit/bash.
 */
function buildReadOnlyVibeTools(
  projectRoot: string,
  emit: (e: Omit<VibeProgressEvent, 'projectPath'>) => void,
  abortSignal: AbortSignal
) {
  const all = buildVibeTools(projectRoot, emit, abortSignal)
  return {
    code_read: all.code_read,
    code_glob: all.code_glob,
    code_grep: all.code_grep,
  }
}

/** Best-effort: figure out how to run a project's tests. Prefers an explicit
 *  package.json "test" script, else an installed runner, else pytest. */
function detectTestCommand(root: string): string | null {
  try {
    const pkgPath = path.join(root, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const test = pkg.scripts?.test
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
        return 'npm test --silent'
      }
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
      if (deps.vitest) return 'npx vitest run'
      if (deps.jest) return 'npx jest'
    }
  } catch { /* unreadable package.json */ }
  if (
    fs.existsSync(path.join(root, 'pytest.ini')) ||
    fs.existsSync(path.join(root, 'pyproject.toml')) ||
    fs.existsSync(path.join(root, 'tests')) ||
    fs.existsSync(path.join(root, 'conftest.py'))
  ) {
    return 'pytest -q'
  }
  return null
}

/** Keep only the last `n` lines of a (possibly huge) test log. */
function tailLines(s: string, n: number): string {
  const lines = s.split('\n')
  return lines.length <= n ? s : lines.slice(-n).join('\n')
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*' }
    else if (c === '?') re += '[^/]'
    else if (/[.+^${}()|[\]\\]/.test(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveProjectModel(project: VibeProjectRow): { providerId: string; modelId: string } {
  const providers = getProviders()
  // 1. Project-specific override
  if (project.provider_id && project.model_id) {
    const p = providers.find(pp => pp.id === project.provider_id)
    if (p && p.models.includes(project.model_id)) {
      return { providerId: project.provider_id, modelId: project.model_id }
    }
  }
  // 2. Global default
  const settings = getSettings()
  const def = providers.find(p => p.id === settings.defaultChatProviderId)
  if (def && def.models.length > 0) {
    const m = settings.defaultChatModel || def.models[0]
    if (def.models.includes(m)) return { providerId: def.id, modelId: m }
  }
  // 3. Prefer an Anthropic-native-capable provider with models
  const sc = providers.find(p => p.anthropicNative && p.models.length > 0)
  if (sc) return { providerId: sc.id, modelId: sc.models[0] }
  // 4. Any provider with models
  const any = providers.find(p => p.models.length > 0)
  if (any) return { providerId: any.id, modelId: any.models[0] }
  throw new Error('没有可用的模型。请在「设置」中配置一个提供商 Key 并选择默认对话模型。')
}

// ---------------------------------------------------------------------------
// Row → renderer info mapping
// ---------------------------------------------------------------------------

function toRequestInfo(r: VibeRequestRow): VibeRequestInfo {
  return {
    id: r.id, projectPath: r.project_path, slug: r.slug, title: r.title,
    summary: r.summary, status: r.status, kind: r.kind, createdAt: r.created_at,
    assigneeEmployeeId: r.assignee_employee_id ?? null
  }
}
function toTaskInfo(t: VibeTaskRow): VibeTaskInfo {
  let revertFileCount = 0
  try {
    if (t.revert_info) { const j = JSON.parse(t.revert_info); if (Array.isArray(j?.files)) revertFileCount = j.files.length }
  } catch { /* malformed */ }
  return {
    id: t.id, requestId: t.request_id, ord: t.ord, title: t.title,
    description: t.description, status: t.status, errorText: t.error_text,
    startedAt: t.started_at, finishedAt: t.finished_at,
    assigneeEmployeeId: t.assignee_employee_id ?? null,
    deps: parseTaskDeps(t.deps),
    revertFileCount
  }
}

/** Pick an employee for a task by its PM-tagged dept. Same-dept idle first, then
 *  round-robin within dept; no dept match → request fallback → all-employee
 *  round-robin; zero employees → null (apply falls back to default model). */
/** Pick an employee for a task by its PM-tagged dept. Same-dept idle first, then
 *  round-robin within that dept. If there's no dept match (or the PM didn't tag
 *  one), fall back to the request's default assignee, else leave UNASSIGNED
 *  (null) — we deliberately do NOT round-robin across unrelated departments,
 *  which looked random to users. */
function pickEmployeeForDept(
  employees: EmployeeInfo[],
  dept: string | null | undefined,
  rr: { i: number },
  fallbackId: string | null
): string | null {
  if (dept && employees.length) {
    const inDept = employees.filter(e => e.dept === dept)
    if (inDept.length) {
      const idle = inDept.filter(e => e.status === 'idle')
      const pool = idle.length ? idle : inDept
      return pool[rr.i++ % pool.length].id
    }
  }
  // No matching department → request default, else leave unassigned for the
  // user to pick manually (NOT a random unrelated employee).
  return fallbackId
}

function toMessageInfo(m: VibeMessageRow): VibeMessageInfo {
  let attachments: Array<{ name: string; path: string; mimeType: string }> | null = null
  if (m.attachments) {
    try { attachments = JSON.parse(m.attachments) } catch { /* malformed → ignore */ }
  }
  return {
    id: m.id, requestId: m.request_id, role: m.role, content: m.content,
    toolName: m.tool_name, toolArgs: m.tool_args, isError: m.is_error === 1,
    taskId: m.task_id, createdAt: m.created_at,
    inputTokens: m.input_tokens, outputTokens: m.output_tokens,
    costUsd: m.cost_usd, model: m.model, attachments
  }
}
/** A user-message content part for the AI SDK (text or inlined image). */
type VibeUserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Buffer; mimeType: string }

/**
 * Turn the current-turn prompt + its attachments into AI-SDK user content,
 * mirroring the 对话 page (engine.ts:2084). Images are inlined as `image` parts
 * so vision models see them; non-image files are referenced by absolute path in
 * a manifest so tools can read them. No attachments → returns the plain string.
 */
function buildVibeUserContent(
  message: string,
  attachments?: Array<{ name: string; path: string; mimeType: string }>
): string | VibeUserPart[] {
  if (!attachments?.length) return message
  // Absolute-path manifest — the model can't infer paths from thin air, and the
  // read/edit tools need the exact path (incl. drive letter on Windows).
  const manifest =
    `用户本次附加了 ${attachments.length} 个文件，绝对路径如下：\n` +
    attachments.map((a, i) => `  [${i + 1}] ${a.name}  (${a.mimeType})\n      绝对路径: ${a.path}`).join('\n') +
    `\n\n如需读取、修改或分析上述文件，请把"绝对路径"完整拷贝到工具调用的 filePath 等参数里（不要发明新路径，也不要省略盘符）。\n\n`

  const parts: VibeUserPart[] = [{ type: 'text', text: manifest + message }]
  for (const att of attachments) {
    const mt = att.mimeType ?? ''
    if (!mt.startsWith('image/')) continue  // non-image: manifest reference only
    if (!fs.existsSync(att.path)) {
      const first = parts[0]
      if (first.type === 'text') first.text += `\n\n[警告：附件 ${att.name} 的文件不存在 (${att.path})，AI 无法看到该图。]`
      continue
    }
    try {
      parts.push({ type: 'image', image: fs.readFileSync(att.path), mimeType: mt })
    } catch (e) {
      const first = parts[0]
      if (first.type === 'text') first.text += `\n\n[警告：附件 ${att.name} 读取失败：${(e as Error).message}]`
    }
  }
  return parts
}

function toProjectInfo(p: VibeProjectRow): VibeProjectInfo {
  return {
    path: p.path, name: p.name,
    providerId: p.provider_id, modelId: p.model_id,
    createdAt: p.created_at, lastOpenedAt: p.last_opened_at
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CHAT_SYSTEM = `You are a helpful assistant working inside the user's project. Conversational by default, capable when needed.

You have FULL tools available — use them when the user's question would benefit from looking at or changing real code:
- code_read(path) — read a text file
- code_glob(pattern) — list files matching glob
- code_grep(pattern, glob?) — search file contents
- code_write(path, content) — create / overwrite a file
- code_edit(path, oldString, newString) — surgical replace (exact-match once)
- code_bash(command) — shell command (configurable timeout, default 5 min)
- code_test(command?, framework?) — run tests; returns a structured pass/fail summary

When to use tools:
- User asks about code/structure/files → read or grep before answering
- User asks to make a small change → just do it (prefer code_edit)
- Pure chitchat or general question → just answer, don't poke at files for no reason

Style:
- Concise, friendly. Use Chinese if the user does.
- For larger multi-step work, suggest "新需求" (decompose then implement) or "修复 BUG" (autonomous fix) modes — but small reads/edits are fine here.`

const EXPLORE_SYSTEM = `You are a senior software engineer in EXPLORE mode — a thinking partner.

Goals: help the user understand the codebase, explore design ideas, debug, or answer questions.

You have READ-ONLY tools:
- code_read(path) — read a file
- code_glob(pattern) — list files matching glob
- code_grep(pattern, glob?) — search file contents

You CANNOT write, edit, or run commands. If the user's intent is clearly a change request that needs implementation:
- Briefly summarize what you'd do
- Suggest they switch to "新需求" (decompose into tasks) or "修复 BUG" (autonomous fix) mode

Style:
- Read files / search the project to ground your answer in actual code
- Be concise but thorough; show file:line references when relevant
- Use Chinese if the user does, English if they do
- Don't speculate when you can just read the file to find out`

const BUGFIX_SYSTEM = `You are a senior software engineer in BUG-FIX mode — autonomous repair agent.

The user has reported a bug or issue. Your job: investigate, identify the root cause, AND apply the fix in one go. No separate planning step — diagnose and patch.

You have FULL tools:
- code_read / code_glob / code_grep — investigate
- code_write — create new files (rarely needed for bug fix)
- code_edit — surgical patch (preferred — exact string replacement)
- code_bash — run shell commands when needed (e.g. reproduce the bug, check logs)
- code_test — run the test suite to confirm the fix (returns failing tests on failure)

Workflow:
1. Read the user's report carefully — what's broken, what's expected
2. Investigate (grep/read) to find the relevant code
3. Identify the root cause — explain in 1-2 sentences
4. Apply the fix (prefer code_edit; create new files only if truly necessary)
5. Confirm the fix in 1-2 sentences

Constraints:
- ONE bug per turn — stay focused. Don't refactor surrounding code.
- DON'T add features, improvements, error handling for hypothetical cases.
- Use Chinese if the user does.
- If the bug report is too vague to act on, ASK for clarification instead of guessing.`

const PROPOSE_SYSTEM = `You are a senior software engineer breaking down a coding request into concrete tasks.

You will receive:
- A user request in natural language (Chinese or English)
- The top-level structure of the project

Your job: produce a JSON object matching the schema you are asked for. The schema requires:
- slug: kebab-case identifier (English-only, max 40 chars)
- title: short Chinese title preserving the user's intent
- summary: 1-2 sentences in Chinese on what will change and why
- tasks: an ordered array of 1–10 actionable implementation tasks. Each task must have:
   - key: 该任务的短 id（t1, t2, t3 …），供其它任务在 deps 里引用
   - title: imperative phrase in Chinese, like "添加登录表单组件" (NOT abstract/vague)
   - description: 1–3 sentences in Chinese on what specifically to do
   - dept: 该任务最合适的部门，从 engineering/design/product/marketing/qa/data/game 中选一个（写代码=engineering，UI/视觉=design，需求规划=product，文案营销=marketing，测试=qa，数据/AI=data，游戏=game）
   - deps: 必须【先完成】才能开始本任务的前置任务 key 数组（因为本任务依赖它们的产出）

依赖（deps）原则 —— 决定哪些任务并行、哪些排队，非常重要：
- **默认并行**：deps 默认留空。多个任务会被并发执行，所以只有当任务 B 真正需要任务 A 的产出/结果才能开始时，才在 B.deps 里写上 A 的 key。
- **不要把无关任务强行串成一条线**：营销文案和后端接口通常互不依赖，就不要让它们互相 deps（否则白白丧失并行、拖慢交付）。
- 典型真实依赖：数据模型/接口契约 → 用其的前端；设计稿/组件 → 引用它的页面；功能实现 → 针对它的自测/验收。
- 最后的自测/验收任务（dept: qa）通常 deps 上前面所有实现类任务；验收时优先用 code_test 跑测试（失败会返回具体失败用例，便于修复后重跑）。
- 严禁循环依赖（A 依赖 B、B 又依赖 A）。

Guidelines:
- Tasks should be small and verifiable (one tool-able outcome each)
- 用 deps 表达先后顺序，而不是靠数组排列顺序
- 贴近真实研发流程：拆解 → 实现 → 自测/验收。除非是纯咨询/不涉及代码改动的请求，**最后一步必须是一个自测/验收任务**（dept: qa）——运行或检查本次改动是否符合预期、是否破坏现有功能，description 写清具体怎么验证（跑哪个命令 / 手测哪条路径）。
- 不要额外加「文档」任务，除非用户明确要求
- Keep the scope minimal — do exactly what was asked (实现层面不膨胀)，但保留上面要求的自测/验收收尾步骤

JSON format rules — VERY IMPORTANT:
- "tasks" MUST be a JSON ARRAY of objects: [{"title": "...", "description": "..."}, ...]
- DO NOT wrap "tasks" as a JSON-encoded string — it must be a real array literal in your tool call arguments
- Each task object's "title" and "description" are plain strings, not stringified JSON
- 若 title/description 文本里出现双引号（如中文引号场景用了 ASCII "），必须转义为 \\"，否则 JSON 非法

If the user's request is too vague to plan (e.g., just "开始" or "帮我做点东西"), produce a single clarifying task asking for more detail — don't fabricate work.`

function buildApplySystem(request: VibeRequestRow, currentTask: VibeTaskRow, otherTasks: VibeTaskRow[]): string {
  const otherSummary = otherTasks
    .map(t => `${t.status === 'done' ? '✓' : '☐'} ${t.ord}. ${t.title}`)
    .join('\n  ')
  // Long-term memory about this project + the user (Hermes-style recall). Lets
  // the company "remember" past decisions/conventions across requests.
  let memoryBlock = ''
  try {
    const mem = recallForProject(`${currentTask.title}\n${currentTask.description || ''}`, request.project_path)
    if (mem) memoryBlock = `\n已知的长期记忆（关于该项目/用户，主动遵循，勿复述）：\n<untrusted_content source="memory">\n${mem}\n</untrusted_content>\n`
  } catch { /* recall is best-effort */ }
  return `You are implementing a single task within a larger coding change. Stay focused on THIS task only.

Change: ${request.title}
${request.summary ? `Summary: ${request.summary}\n` : ''}${memoryBlock}

All tasks (for context — do NOT execute others):
  ${otherSummary}

YOUR CURRENT TASK (#${currentTask.ord}):
  ${currentTask.title}
${currentTask.description ? `\n  ${currentTask.description}` : ''}

Tools available (paths must stay inside the project root):
- code_read(path) — read a text file
- code_write(path, content) — create/overwrite
- code_edit(path, oldString, newString) — replace exact string (must match exactly once)
- code_glob(pattern) — list files matching glob
- code_grep(pattern, glob?) — search file contents
- code_bash(command) — run shell command (configurable timeout, default 5 min)
- code_test(command?, framework?) — run tests; returns failing test names+messages on failure

Workflow:
1. Use code_glob/code_grep/code_read to explore relevant files first
2. Make the change (prefer code_edit for surgical edits; code_write only for new files)
3. If this task is 自测/验收 (or you changed testable code), run code_test — if it
   fails, fix the code and run code_test again until it passes
4. Briefly confirm what you did

Do NOT:
- Add unrequested features or "improvements"
- Touch files unrelated to this specific task
- Write comments unless they explain non-obvious WHY
- Execute other tasks in the list`
}

/** After a request is delivered, distill project-level long-term memories from
 *  its transcript (best-effort, background) so the company "remembers" this
 *  project's decisions/conventions next time. Honors the auto-capture setting. */
async function captureRequestMemory(request: VibeRequestRow): Promise<void> {
  try {
    if (getSettings().memoryAutoCapture === false) return
    const msgs = listMessages(request.id)
    const transcript = [
      `需求：${request.title}`,
      request.summary ? `摘要：${request.summary}` : '',
      ...msgs.filter(m => m.content && m.content.trim()).map(m => `${m.role}: ${m.content}`),
    ].filter(Boolean).join('\n\n')
    const inserted = await captureFromTranscript({
      transcript,
      source: `request:${request.id}`,
      allowedKinds: ['project', 'skill'],
      scopeKey: request.project_path,
    })
    if (inserted.length) {
      getMainWindow()?.webContents.send(IPC.MEMORY_CAPTURED, { count: inserted.length, memories: inserted })
    }
  } catch (e) {
    console.warn('[memory] request capture failed:', (e as Error).message)
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Some models (Claude via OpenAI-compat proxies in particular) return nested
// arrays as JSON-encoded strings instead of actual arrays. Worse, when they
// stringify they often escape quotes for only ONE level of nesting, so inner
// content quotes arrive unescaped and a plain JSON.parse chokes. We decode
// transparently, and on failure run repairUnescapedQuotes before retrying — so a
// botched-but-recoverable proposal doesn't lose the whole turn.
const decodeIfStringArray = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { /* fall through to repair */ }
  try { return JSON.parse(repairUnescapedQuotes(v)) } catch { /* leave as-is — schema will reject */ }
  return v
}

const ProposalSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).max(40)
    .describe('kebab-case identifier, English only, max 40 chars'),
  title: z.string().min(2).max(100)
    .describe('Short title preserving the user\'s intent (Chinese OK)'),
  summary: z.string().min(2).max(500)
    .describe('1-2 sentences on what will change and why (Chinese OK)'),
  tasks: z.preprocess(
    decodeIfStringArray,
    z.array(z.object({
      key: z.string().max(12).optional()
        .describe('该任务的短 id，如 t1/t2/t3，供其它任务在 deps 里引用'),
      title: z.string().min(2).max(100).describe('Imperative title like "添加登录表单组件"'),
      description: z.string().min(2).max(500).describe('Specific implementation guidance in 1-3 sentences'),
      dept: z.enum(['engineering', 'design', 'product', 'marketing', 'qa', 'data', 'game']).nullable().optional()
        .describe('该任务最合适的部门：写代码/接口/架构=engineering，UI/视觉/品牌=design，需求/规划=product，文案/营销/增长=marketing，测试/质量=qa，数据/AI/算法=data，游戏逻辑/数值=game'),
      deps: z.preprocess(decodeIfStringArray, z.array(z.string()).optional())
        .describe('必须先完成才能开始本任务的前置任务 key 列表（因为本任务要用到它们的产出）。能并行就【留空】；默认不填，只有真有先后依赖才填。')
    })).min(1).max(10)
  )
})

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BLANK_HTML = (name: string) => `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei UI', sans-serif; padding: 2rem; max-width: 720px; margin: 0 auto; }
    h1 { color: #111; }
    p { color: #555; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>开始用 AI 改造这个页面吧 — 描述你的需求，AI 会自动拆解并实施。</p>
</body>
</html>
`

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function vibeHandlers(): void {

  // ----- File tree --------------------------------------------------------
  ipcMain.handle(IPC.VIBE_LIST_TREE, async (_e, projectPath: string): Promise<FileTreeNode | null> => {
    const abs = path.resolve(projectPath)
    if (!isAllowedProjectPath(abs)) throw new Error('Project path not allowed')
    if (!fs.existsSync(abs)) throw new Error('Project folder does not exist')
    return { name: path.basename(abs), path: abs, isDir: true, children: walkTree(abs, 0) }
  })

  // ----- Read file --------------------------------------------------------
  ipcMain.handle(IPC.VIBE_READ_FILE, async (_e, filePath: string): Promise<string> => {
    const abs = path.resolve(filePath)
    const recent = getRecentProjects().map(r => path.resolve(r.path))
    const projectsRoot = getVibeProjectsRoot()
    const inAllowed =
      abs.startsWith(projectsRoot + path.sep) ||
      recent.some(r => abs === r || abs.startsWith(r + path.sep))
    if (!inAllowed) {
      console.warn(`[vibe] readFile BLOCKED: ${abs}\n  projectsRoot=${projectsRoot}\n  recent=${JSON.stringify(recent)}`)
      throw new Error('File path not allowed')
    }
    const stat = fs.statSync(abs)
    if (!stat.isFile()) throw new Error('Not a file')
    if (stat.size > MAX_FILE_SIZE) throw new Error(`文件过大 (>${(MAX_FILE_SIZE/1024).toFixed(0)} KB)`)
    return fs.readFileSync(abs, 'utf8')
  })

  // ----- Save file (Monaco Ctrl+S or save button) ------------------------
  ipcMain.handle(IPC.VIBE_FILE_SAVE, async (_e, args: { path: string; content: string }) => {
    const abs = path.resolve(args.path)
    const recent = getRecentProjects().map(r => path.resolve(r.path))
    const projectsRoot = getVibeProjectsRoot()
    const inAllowed =
      abs.startsWith(projectsRoot + path.sep) ||
      recent.some(r => abs === r || abs.startsWith(r + path.sep))
    if (!inAllowed) {
      console.warn(`[vibe] file-save BLOCKED: ${abs}`)
      throw new Error('File path not allowed')
    }
    if (args.content.length > MAX_WRITE_SIZE) throw new Error('内容过大')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, args.content, 'utf8')
    console.log(`[vibe] file-save ✓ ${abs} (${args.content.length} bytes)`)
    return { ok: true, bytes: args.content.length }
  })

  // ----- Project management ----------------------------------------------
  ipcMain.handle(IPC.VIBE_NEW_PROJECT, async (_e, args: { name: string; location?: string }) => {
    const name = (args.name || '').trim()
    if (!name) throw new Error('项目名称不能为空')
    if (/[\\/:*?"<>|]/.test(name)) throw new Error('项目名称包含非法字符')
    const base = args.location ? path.resolve(args.location) : getVibeProjectsRoot()
    const full = path.join(base, name)
    if (fs.existsSync(full)) throw new Error(`已存在同名文件夹：${full}`)
    fs.mkdirSync(full, { recursive: true })
    fs.writeFileSync(path.join(full, 'index.html'), BLANK_HTML(name), 'utf8')
    fs.writeFileSync(path.join(full, '.gitignore'), 'node_modules/\ndist/\n.DS_Store\n', 'utf8')
    addRecentProject(full)
    registerApprovedRoot(full)
    upsertProject(full)
    // Init a repo so the change-review / checkpoint features work out of the box.
    try { await gitSvc.gitInit(full) } catch { /* best-effort; non-fatal */ }
    return { path: full }
  })

  ipcMain.handle(IPC.VIBE_LIST_RECENT, async () => getRecentProjects())

  ipcMain.handle(IPC.VIBE_REMOVE_RECENT, async (_e, p: string) => {
    removeRecentProject(p)
    return { ok: true }
  })

  ipcMain.handle(IPC.VIBE_OPEN_EXISTING, async (_e, p: string) => {
    const abs = path.resolve(p)
    if (!fs.existsSync(abs)) throw new Error('文件夹不存在')
    const stat = fs.statSync(abs)
    if (!stat.isDirectory()) throw new Error('不是文件夹')
    addRecentProject(abs)
    registerApprovedRoot(abs)
    upsertProject(abs)
    return { path: abs }
  })

  ipcMain.handle(IPC.VIBE_PROJECT_GET, async (_e, projectPath: string): Promise<VibeProjectInfo | null> => {
    const abs = path.resolve(projectPath)
    if (!isAllowedProjectPath(abs)) throw new Error('Project path not allowed')
    // Re-register as approved root every time the project becomes active —
    // path-allow's sessionApprovedRoots is in-memory only and gets wiped on
    // restart, so we top it up whenever the user opens/switches to a project.
    registerApprovedRoot(abs)
    const row = upsertProject(abs)
    return toProjectInfo(row)
  })

  ipcMain.handle(IPC.VIBE_PROJECT_SET_MODEL, async (_e, args: { projectPath: string; providerId: string; modelId: string }) => {
    const abs = path.resolve(args.projectPath)
    if (!isAllowedProjectPath(abs)) throw new Error('Project path not allowed')
    upsertProject(abs)
    setProjectModel(abs, args.providerId, args.modelId)
    return { ok: true }
  })

  // ----- Requests / tasks / messages list --------------------------------
  ipcMain.handle(IPC.VIBE_REQUEST_LIST, async (_e, projectPath: string): Promise<VibeRequestInfo[]> => {
    return listRequests(path.resolve(projectPath)).map(toRequestInfo)
  })

  ipcMain.handle(IPC.VIBE_REQUEST_LIST_ALL, async (): Promise<VibeRequestInfo[]> => {
    const rollup = taskRollupByRequest()
    return listAllRequests().map(r => ({ ...toRequestInfo(r), taskRollup: rollup[r.id] }))
  })

  ipcMain.handle(IPC.VIBE_REQUEST_SET_ASSIGNEE, async (_e, args: { requestId: string; employeeId: string | null }) => {
    setRequestAssignee(args.requestId, args.employeeId)
    // Count the承接 on the employee's tally when newly assigned.
    if (args.employeeId) bumpEmployeeStats(args.employeeId, { assigned: 1 })
    return { ok: true }
  })

  // 子任务级手动重派：把单个子任务指给某员工（其模型+人格在 apply 时驱动该任务）。
  ipcMain.handle(IPC.VIBE_TASK_SET_ASSIGNEE, async (_e, args: { taskId: string; employeeId: string | null }) => {
    const before = getTask(args.taskId)
    setTaskAssignee(args.taskId, args.employeeId)
    // Only +1 when it's a NEW assignment (not re-confirming the same employee).
    if (args.employeeId && before?.assignee_employee_id !== args.employeeId) bumpEmployeeStats(args.employeeId, { assigned: 1 })
    return { ok: true }
  })

  // 子任务依赖编辑（开工前在看板手动增删）：deps = 必须先完成的前置任务 id 列表。
  // 自引用与不同需求的 id 会被过滤掉；环留到 apply 阶段兜底（回退全并行）。
  ipcMain.handle(IPC.VIBE_TASK_SET_DEPS, async (_e, args: { taskId: string; deps: string[] }) => {
    const task = getTask(args.taskId)
    if (!task) return { error: 'Task not found' }
    const siblingIds = new Set(listTasks(task.request_id).map(t => t.id))
    const clean = [...new Set((args.deps ?? []).filter(d => d !== args.taskId && siblingIds.has(d)))]
    setTaskDeps(args.taskId, clean)
    return { ok: true, deps: clean }
  })

  ipcMain.handle(IPC.VIBE_REQUEST_DELETE, async (_e, id: string) => {
    const req = getRequest(id)
    if (req) {
      // Also remove the disk artifacts
      try {
        const dir = path.join(req.project_path, 'openspec', 'changes', req.slug)
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      } catch { /* best-effort */ }
    }
    deleteRequest(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.VIBE_TASK_LIST, async (_e, requestId: string): Promise<VibeTaskInfo[]> => {
    return listTasks(requestId).map(toTaskInfo)
  })

  ipcMain.handle(IPC.VIBE_TASK_TOGGLE, async (_e, args: { taskId: string; status: 'pending' | 'done' | 'skipped' }) => {
    updateTaskStatus(args.taskId, args.status)
    // Refresh tasks.md
    const tasks = listTasks(args.taskId)  // wrong — need requestId; refetch via the task itself
    // (We don't have a getTask helper; query directly)
    const all = listTasks(/* placeholder */ '')  // not used — replaced below
    void tasks; void all
    // Instead, look up the task's request and rewrite tasks.md
    // Minimal approach: use dbGet
    const { dbGet } = await import('../db/sqlite')
    const taskRow = dbGet<VibeTaskRow>('SELECT * FROM vibe_tasks WHERE id = ?', [args.taskId])
    if (taskRow) {
      const req = getRequest(taskRow.request_id)
      if (req) {
        writeTasksMd({ projectPath: req.project_path, slug: req.slug, tasks: listTasks(taskRow.request_id) })
      }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.VIBE_MESSAGE_LIST, async (_e, requestId: string): Promise<VibeMessageInfo[]> => {
    return listMessages(requestId).map(toMessageInfo)
  })

  // ----- Git review layer -------------------------------------------------
  // All operate on a project ROOT and reuse the project allow-list. They
  // delegate to git-service (which itself degrades gracefully when git is
  // missing or the folder isn't a repo).
  function assertGitRoot(projectPath: string): string {
    const abs = path.resolve(projectPath)
    if (!isAllowedProjectPath(abs)) throw new Error('Project path not allowed')
    return abs
  }
  ipcMain.handle(IPC.VIBE_GIT_STATUS, async (_e, projectPath: string) =>
    gitSvc.gitStatus(assertGitRoot(projectPath)))
  ipcMain.handle(IPC.VIBE_GIT_DIFF, async (_e, a: { projectPath: string; path: string }) =>
    gitSvc.gitDiffFile(assertGitRoot(a.projectPath), a.path))
  ipcMain.handle(IPC.VIBE_GIT_STAGE, async (_e, a: { projectPath: string; path: string }) =>
    gitSvc.stageFile(assertGitRoot(a.projectPath), a.path))
  ipcMain.handle(IPC.VIBE_GIT_UNSTAGE, async (_e, a: { projectPath: string; path: string }) =>
    gitSvc.unstageFile(assertGitRoot(a.projectPath), a.path))
  ipcMain.handle(IPC.VIBE_GIT_REVERT_FILE, async (_e, a: { projectPath: string; path: string }) =>
    gitSvc.revertFile(assertGitRoot(a.projectPath), a.path))
  ipcMain.handle(IPC.VIBE_GIT_REVERT_HUNK, async (_e, a: { projectPath: string; path: string; hunkIndex: number }) =>
    gitSvc.revertHunk(assertGitRoot(a.projectPath), a.path, a.hunkIndex))
  ipcMain.handle(IPC.VIBE_GIT_STAGE_HUNK, async (_e, a: { projectPath: string; path: string; hunkIndex: number }) =>
    gitSvc.stageHunk(assertGitRoot(a.projectPath), a.path, a.hunkIndex))
  ipcMain.handle(IPC.VIBE_GIT_COMMIT, async (_e, a: { projectPath: string; message: string; paths?: string[] }) =>
    gitSvc.commit(assertGitRoot(a.projectPath), a.message, a.paths))
  ipcMain.handle(IPC.VIBE_GIT_LOG, async (_e, a: { projectPath: string; limit?: number }) =>
    gitSvc.gitLog(assertGitRoot(a.projectPath), a.limit ?? 20))
  ipcMain.handle(IPC.VIBE_GIT_INIT, async (_e, projectPath: string) =>
    gitSvc.gitInit(assertGitRoot(projectPath)))
  ipcMain.handle(IPC.VIBE_GIT_ROLLBACK, async (_e, a: { projectPath: string; checkpointId?: string }) =>
    gitSvc.rollbackToCheckpoint(assertGitRoot(a.projectPath), a.checkpointId))

  // Per-task revert: restore ONLY the files this task touched to the pre-apply
  // checkpoint, leaving the parallel tasks' work intact. Returns the affected
  // ABSOLUTE paths so the renderer can refresh any open editor tabs.
  ipcMain.handle(IPC.VIBE_TASK_REVERT, async (_e, a: { taskId: string; projectPath: string }) => {
    const root = assertGitRoot(a.projectPath)
    const info = getTaskRevertInfo(a.taskId)
    if (!info || !info.files.length) return { ok: false, error: '该任务没有可单独回滚的改动（可能未改动文件，或改动前未能创建快照）。' }
    const r = await gitSvc.restoreFilesToCheckpoint(root, info.files, info.cp)
    const files = info.files.map(f => path.join(root, f))
    if (r.ok) {
      clearTaskRevertInfo(a.taskId)
      updateTaskStatus(a.taskId, 'pending')
      const task = getTask(a.taskId)
      const req = task ? getRequest(task.request_id) : null
      if (req) {
        // Keep tasks.md in sync; the renderer reloads tasks after this resolves.
        await withFileLock('tasksmd:' + req.id, () => writeTasksMd({ projectPath: root, slug: req.slug, tasks: listTasks(req.id) })).catch(() => {})
      }
    }
    return { ...r, files }
  })

  // ----- CHAT / EXPLORE / BUGFIX (free-form agent loops) -----------------
  // All three follow the same shape: one request per conversation, optional
  // resume via requestId, streamed text + tool events persisted to vibe_messages.
  // They differ only in:
  //   - tools available (none / read-only / full)
  //   - system prompt
  //   - request kind label
  type ToolBuilder = (
    projectRoot: string,
    emit: (e: Omit<VibeProgressEvent, 'projectPath'>) => void,
    abortSignal: AbortSignal
  ) => ReturnType<typeof buildVibeTools> | ReturnType<typeof buildReadOnlyVibeTools>

  function runStreamMode(
    args: { projectPath: string; prompt: string; requestId?: string; attachments?: Array<{ name: string; path: string; mimeType: string }>; thinkingMode?: ThinkingMode },
    opts: {
      kind: 'chat' | 'explore' | 'bugfix'
      label: string                                  // for system event text
      systemPrompt: string
      buildTools?: ToolBuilder
      maxSteps?: number
    }
  ): { started: boolean; requestId?: string } {
    const win = getMainWindow()
    if (!win) return { started: false }
    const projectPath = path.resolve(args.projectPath)
    if (!isAllowedProjectPath(projectPath)) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: 'Project path not allowed' })
      return { started: false }
    }

    const project = upsertProject(projectPath)
    let modelInfo
    try { modelInfo = resolveProjectModel(project) }
    catch (e) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: (e as Error).message })
      return { started: false }
    }

    // Resolve or create the request
    let request: VibeRequestRow | null = args.requestId ? getRequest(args.requestId) : null
    if (!request) {
      const title = args.prompt.trim().slice(0, 60).replace(/\s+/g, ' ') || opts.label
      request = createRequest({
        projectPath, slug: slugify(title), title, summary: '',
        kind: opts.kind
      })
    }

    activeRuns.get(projectPath)?.abort()
    const ctl = new AbortController()
    activeRuns.set(projectPath, ctl)

    const requestId = request.id
    const emit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      win.webContents.send(IPC.VIBE_PROGRESS, { ...e, projectPath, requestId })
    }

    appendMessage({ requestId, role: 'user', content: args.prompt, attachments: args.attachments })
    emit({ type: 'request_ready', requestId, text: `${opts.label}中…` })

    ;(async () => {
      try {
        // Snapshot the worktree before a writing run so "roll back to before this
        // run" can undo everything (read-only explore skips it). Surface the result
        // so the user knows whether rollback is available — and, crucially, when it
        // is NOT (no git / not a repo), so a bad AI edit isn't silently irreversible.
        if (opts.kind !== 'explore') {
          const cp = await gitSvc.createCheckpoint(projectPath).catch(() => null)
          emit(cp
            ? { type: 'system', text: '已创建改动前快照，可在「更改」面板一键回滚本次改动。' }
            : { type: 'system', text: '⚠️ 未能创建改动前快照，本次改动将无法一键回滚（项目可能不是 git 仓库，或本机未安装 git——可在「更改」面板「启用版本快照」后再让 AI 改动）。' })
        }
        const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
        // 扩展思考（之前这里漏了：runStreamMode 的 streamText 从不注入 thinkOpts，导致
        // 工作台 chat/explore/bugfix 完全吃不到「思考模式」）。按有效协议注入，并优先用
        // 输入框每轮显式选择，未选则回退全局设置。
        const swProvCfg = getProviders().find(p => p.id === modelInfo.providerId)
        const swProvType = swProvCfg ? effectiveProtocol(swProvCfg, modelInfo.modelId) : undefined
        const swThinkMode: ThinkingMode = args.thinkingMode ?? getSettings().chatThinkingMode ?? 'auto'
        const thinkOpts = thinkingStreamOpts(swProvType, swThinkMode, modelInfo.modelId)
        const toolEmit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
          emit(e)
          if (e.type === 'tool_use') {
            appendMessage({
              requestId, role: 'tool',
              content: e.toolArgsPreview ?? '',
              toolName: e.toolName, isError: false
            })
          } else if (e.type === 'tool_result') {
            appendMessage({
              requestId, role: 'tool',
              content: e.toolResultPreview ?? '',
              toolName: e.toolName, isError: !!e.isError
            })
          }
        }
        const rawTools = opts.buildTools
          ? opts.buildTools(projectPath, toolEmit, ctl.signal)
          : undefined

        const { section: skillsSection, skills: activeSkills } = buildVibeSkillsSection(projectPath)
        let tools: Record<string, Tool> | undefined =
          rawTools ? applyVibeSkillsFilter(rawTools, activeSkills) : undefined
        // Merge progressive-disclosure skill tools when this mode has tools.
        const runtimeSkills = activeSkills.filter(s => s.runtime)
        if (tools && runtimeSkills.length) {
          tools = { ...tools, ...buildVibeSkillTools(projectPath, runtimeSkills, toolEmit, ctl.signal) }
        }

        const history: CoreMessage[] = listMessages(requestId)
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => (m.role === 'assistant'
            ? { role: 'assistant', content: m.content }
            : { role: 'user', content: m.content }) as CoreMessage)
        // Inline THIS turn's attachments into the last user message (images as
        // vision parts + a path manifest). History rows stay plain text — the
        // images were only needed when first sent; re-reading is via the manifest.
        if (args.attachments?.length) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'user') {
              history[i] = { role: 'user', content: buildVibeUserContent(args.prompt, args.attachments) } as CoreMessage
              break
            }
          }
        }

        let accumulated = ''
        let runError: Error | null = null
        let usage: { promptTokens?: number; completionTokens?: number } | null = null
        // 看门狗：若窗口内没有任何新输出（典型「一直加载、不吐字、也不报错」），
        // 主动中断并报错——否则前端会无限期干等，既无内容也无任何错误体现。每来一段
        // 输出就续期；用户主动停止与“卡死”用 stalled 区分。
        let stalled = false
        let stallTimer: ReturnType<typeof setTimeout> | null = null
        // 两档静默窗口：
        //  STREAM_GAP_MS  —— 文本正在流式输出、token 间的最长静默（真在吐字却突然卡住才该快停）。
        //  SILENT_WORK_MS —— 模型「在干活但不吐字」时的最长静默：首 token(TTFT)、思考、工具执行、
        //                    以及工具结果后的下一轮推理（上下文越滚越大、经代理更慢）。这些阶段本就没有
        //                    可见输出，给足窗口，否则慢模型/大上下文/缓冲型代理会频繁被误判为「无响应」。
        const STREAM_GAP_MS = 120000
        const SILENT_WORK_MS = 240000
        const armStall = (ms = SILENT_WORK_MS) => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => { if (!ctl.signal.aborted) { stalled = true; ctl.abort() } }, ms)
        }
        try {
          const swSystem = opts.systemPrompt + skillsSection
          // Cache the (large, reused) Vibe system prompt on Anthropic via a marked
          // leading message; other providers keep `system:` (auto-caches the head).
          const swSysMsg = anthropicSystemCacheMessage(swSystem, swProvType, swProvCfg?.relayCompat)
          const result = streamText({
            model,
            ...(swSysMsg ? { messages: [swSysMsg, ...history] } : { system: swSystem, messages: history }),
            ...(tools ? { tools } : {}),
            maxSteps: opts.maxSteps ?? (tools ? 20 : 5),
            maxRetries: 2,
            abortSignal: ctl.signal,
            ...thinkOpts,
            onError: ({ error }) => {
              console.error(`[vibe] ${opts.kind} streamText error:`, error)
              runError = error as Error
            }
          })
          armStall()
          // 看门狗盯【整条事件流】(文本/思考/工具调用/工具结果/步骤),而非只盯可见文本——
          // 模型在生成工具调用、思考、等工具执行时本就没有文本输出,只盯文本会把正常的多步
          // 工具流误判成「无响应」。任何事件都续期；tool-call 后的工具执行期给更长窗口。
          // 实时展示 reasoning(思考)：推理模型会把一长串思维链作为 `reasoning`
          // 事件流出、却没有任何可见文本，导致工作台只剩「AI 正在回复…」卡好几分钟。
          // 把连续的 reasoning 包进 <think>…</think>(渲染层会折叠成「思考过程」)。
          // 仅实时 emit、不计入 accumulated —— 落库的消息保持只有最终答案，避免存巨量思考。
          let inReasoning = false
          const closeThink = (): void => {
            if (inReasoning) { inReasoning = false; emit({ type: 'text', text: '</think>\n\n' }) }
          }
          for await (const part of result.fullStream) {
            if (ctl.signal.aborted) break
            // 只有「正在吐字时的 token 间隙」用紧窗口；其余（思考/工具调用/工具执行/
            // 工具结果后的下一轮推理）都属「干活不吐字」，给宽窗口。
            armStall(part.type === 'text-delta' ? STREAM_GAP_MS : SILENT_WORK_MS)
            if (part.type === 'reasoning' && part.textDelta) {
              if (!inReasoning) { inReasoning = true; emit({ type: 'text', text: '<think>' }) }
              emit({ type: 'text', text: part.textDelta })
            } else if (part.type === 'text-delta' && part.textDelta) {
              closeThink()
              accumulated += part.textDelta
              emit({ type: 'text', text: part.textDelta })
            } else if (part.type === 'tool-call') {
              closeThink()
            } else if (part.type === 'error') {
              runError = part.error as Error
            }
          }
          closeThink()
          await result.finishReason.catch(() => null)
          usage = await result.usage.catch(() => null)
        } catch (err) {
          runError = err as Error
        } finally {
          if (stallTimer) clearTimeout(stallTimer)
        }

        if (stalled) {
          win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId, error: 'AI 长时间无响应（可能是模型、网络或代理异常）。已自动停止，请重试，或到「设置 → 模型 / 网络代理」检查配置。' })
          return
        }
        if (ctl.signal.aborted) {
          win.webContents.send(IPC.VIBE_DONE, { projectPath, requestId, cancelled: true })
          return
        }
        if (runError) {
          win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId, error: runError.message })
          return
        }
        if (accumulated.trim()) {
          const inTok = finiteUsage(usage?.promptTokens)
          const outTok = finiteUsage(usage?.completionTokens)
          const cost = inTok != null && outTok != null && (inTok > 0 || outTok > 0)
            ? computeCost(modelInfo.modelId, inTok, outTok)
            : null
          appendMessage({
            requestId, role: 'assistant', content: accumulated.trim(),
            inputTokens: inTok, outputTokens: outTok, costUsd: cost, model: modelInfo.modelId
          })
        }
        win.webContents.send(IPC.VIBE_DONE, { projectPath, requestId })
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error(`[vibe] ${opts.kind} failed:`, err)
        win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId, error: msg })
      } finally {
        if (activeRuns.get(projectPath) === ctl) activeRuns.delete(projectPath)
      }
    })()

    return { started: true, requestId }
  }

  // ----- CHAT (conversation with full project tools available on demand) --
  ipcMain.handle(IPC.VIBE_CHAT, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => {
    return runStreamMode(args, {
      kind: 'chat', label: '对话',
      systemPrompt: CHAT_SYSTEM,
      buildTools: buildVibeTools,
      maxSteps: 15
    })
  })

  // ----- BUGFIX (autonomous fix agent, full tools) ------------------------
  ipcMain.handle(IPC.VIBE_BUGFIX, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => {
    return runStreamMode(args, {
      kind: 'bugfix', label: '修复',
      systemPrompt: BUGFIX_SYSTEM,
      buildTools: buildVibeTools,
      maxSteps: 20
    })
  })

  // ----- EXPLORE (read-only investigation) --------------------------------
  // Same engine as chat/bugfix (runStreamMode handles history/skills/usage),
  // just with read-only tools. Previously a 130-line duplicate of runStreamMode.
  ipcMain.handle(IPC.VIBE_EXPLORE, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => {
    return runStreamMode(args, {
      kind: 'explore', label: '探索',
      systemPrompt: EXPLORE_SYSTEM,
      buildTools: buildReadOnlyVibeTools,
      maxSteps: 15
    })
  })

  // Extracted as a named function so VIBE_RUN can dispatch to it after auto-
  // classifying the intent as 'change'. Behavior unchanged.
  function runPropose(args: { projectPath: string; prompt: string; requestId?: string; attachments?: Array<{ name: string; path: string; mimeType: string }> }) {
    const win = getMainWindow()
    if (!win) return { error: 'No window' }
    const projectPath = path.resolve(args.projectPath)
    if (!isAllowedProjectPath(projectPath)) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: 'Project path not allowed' })
      return { started: false }
    }

    const project = upsertProject(projectPath)
    let modelInfo
    try { modelInfo = resolveProjectModel(project) }
    catch (e) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: (e as Error).message })
      return { started: false }
    }

    activeRuns.get(projectPath)?.abort()
    const ctl = new AbortController()
    activeRuns.set(projectPath, ctl)

    // Determine: promote existing request, or create new one
    const existing = args.requestId ? getRequest(args.requestId) : null
    const isPromotion = !!existing

    const emit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      win.webContents.send(IPC.VIBE_PROGRESS, {
        ...e, projectPath,
        requestId: existing?.id ?? e.requestId
      })
    }

    ;(async () => {
      try {
        emit({ type: 'system', text: isPromotion ? `基于已有对话拆解任务（${modelInfo.modelId}）…` : `提议中（${modelInfo.modelId}）…` })
        const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
        const topLevel = listTopLevel(projectPath)

        // If promoting an explore session, pull its full conversation history
        // so the model has context. Otherwise treat the prompt as the standalone request.
        const history: CoreMessage[] = isPromotion
          ? listMessages(existing!.id)
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => (m.role === 'assistant'
                ? { role: 'assistant', content: m.content }
                : { role: 'user', content: m.content }) as CoreMessage)
          : []

        const userPrompt = isPromotion
          ? `[基于以上对话上下文，将我们讨论的改动拆解成可执行任务列表]\n\n附加说明：${args.prompt || '（无）'}`
          : `项目根目录：${projectPath}\n顶层文件：${topLevel || '(空)'}\n\n用户需求：\n${args.prompt}`

        // For promotion, persist the user's "promote" prompt so it shows in convo
        if (isPromotion && args.prompt.trim()) {
          appendMessage({ requestId: existing!.id, role: 'user', content: args.prompt, attachments: args.attachments })
        }

        // Inline attachments (e.g. a design mockup to build from) into the user
        // message so the model sees them while decomposing into tasks.
        const userContent = buildVibeUserContent(userPrompt, args.attachments)

        let captured: z.infer<typeof ProposalSchema> | null = null
        const { section: proposeSkillsSection } = buildVibeSkillsSection(projectPath)
        const propProvCfg = getProviders().find(p => p.id === modelInfo.providerId)
        const propProvType = propProvCfg ? effectiveProtocol(propProvCfg, modelInfo.modelId) : undefined
        const proposeSystem = PROPOSE_SYSTEM + (isPromotion
            ? '\n\n你正在基于已有的对话上下文做拆解 — 请保留 slug/title 跟之前对话主题一致，并参考前面的讨论内容设计任务。你 MUST 调用 submit_proposal 工具且只调一次。'
            : '\n\nIMPORTANT: You MUST call the `submit_proposal` tool exactly once with the structured plan. Do not output free-form JSON.') + proposeSkillsSection
        // Anthropic: cache the static PROPOSE_SYSTEM via a marked leading message;
        // others keep `system:`. (Forced toolChoice is fine with caching.)
        const propSysMsg = anthropicSystemCacheMessage(proposeSystem, propProvType, propProvCfg?.relayCompat)
        const proposeUserMsgs: CoreMessage[] = [
          ...history,
          { role: 'user', content: userContent } as CoreMessage
        ]
        const result = streamText({
          model,
          ...(propSysMsg ? { messages: [propSysMsg, ...proposeUserMsgs] } : { system: proposeSystem, messages: proposeUserMsgs }),
          tools: {
            submit_proposal: tool({
              description: 'Submit the final structured proposal for the user to review',
              parameters: ProposalSchema,
              execute: async (input) => {
                captured = input
                return { ok: true }
              }
            })
          },
          toolChoice: { type: 'tool', toolName: 'submit_proposal' },
          maxSteps: 2,
          maxRetries: 3,
          abortSignal: ctl.signal,
          // 自我修复：模型常把 tasks 误转成 JSON 字符串（甚至内层引号没转义，
          // 导致连 preprocess 的 JSON.parse 都失败）。参数校验失败时，带着错误把
          // 上一轮工具调用回灌给模型，让它按 schema 重新调用一次。覆盖各种畸形输出。
          experimental_repairToolCall: async ({ toolCall, tools: t, error, messages: m, system: sys }) => {
            if (toolCall.toolName !== 'submit_proposal') return null
            try {
              const { toolCalls } = await generateText({
                model,
                system: sys ?? proposeSystem,
                messages: [
                  ...m,
                  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, args: toolCall.args }] },
                  { role: 'tool', content: [{ type: 'tool-result', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, result: `工具参数校验失败：${error.message}\n请重新调用 submit_proposal 修正：tasks 必须是 JSON 数组本身（不要再转成字符串），每个字符串值内部的双引号要用 \\" 正确转义。` }] }
                ],
                tools: t,
                toolChoice: { type: 'tool', toolName: 'submit_proposal' },
                maxRetries: 1,
                abortSignal: ctl.signal
              })
              const fixed = toolCalls.find(c => c.toolName === 'submit_proposal')
              return fixed ? { toolCallType: 'function', toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, args: JSON.stringify(fixed.args) } : null
            } catch {
              return null
            }
          },
          onError: ({ error }) => {
            console.error('[vibe] propose streamText error:', error)
          }
        })

        for await (const chunk of result.textStream) {
          if (ctl.signal.aborted) break
          if (chunk) emit({ type: 'text', text: chunk })
        }
        await result.finishReason.catch(() => null)
        const proposeUsage = await result.usage.catch(() => null)

        if (ctl.signal.aborted) {
          win.webContents.send(IPC.VIBE_DONE, { projectPath, cancelled: true })
          return
        }
        if (!captured) {
          throw new Error('AI 未返回结构化方案。可能是模型不支持工具调用，请到「设置 → 模型」换一个支持 tool calling 的模型（GPT-4o / Claude-3.5+ 等）。')
        }
        const object = captured as z.infer<typeof ProposalSchema>

        let targetRequest: VibeRequestRow
        if (isPromotion) {
          // Update existing request's title/summary, replace its tasks
          updateRequestSummary(existing!.id, object.title, object.summary)
          deleteTasksForRequest(existing!.id)
          targetRequest = { ...existing!, title: object.title, summary: object.summary, kind: 'change' }
          // Bump kind from explore → change in DB
          try { dbRun(`UPDATE vibe_requests SET kind = 'change' WHERE id = ?`, [existing!.id]) }
          catch (e) { console.warn('[vibe] kind update failed:', e) }
        } else {
          targetRequest = createRequest({
            projectPath,
            slug: slugify(object.slug),
            title: object.title,
            summary: object.summary,
            kind: 'change'
          })
        }

        // PM 自动派活：按 PM 标注的 dept，把每个子任务分给对口在职员工。
        // 零员工 → empId=null（apply 阶段回退 request.assignee / 默认模型，行为不变）。
        const employees = listEmployees()
        const rr = { i: 0 }
        const fallbackEmp = targetRequest.assignee_employee_id ?? null
        const taskRows: VibeTaskRow[] = []
        object.tasks.forEach((t, i) => {
          const empId = pickEmployeeForDept(employees, t.dept ?? null, rr, fallbackEmp)
          taskRows.push(createTask({
            requestId: targetRequest.id, ord: i + 1,
            title: t.title, description: t.description,
            assigneeEmployeeId: empId
          }))
          if (empId) bumpEmployeeStats(empId, { assigned: 1 })
        })

        // Resolve declared deps (key references) → real task ids, now that every
        // row exists. We accept the model's own key plus index-style fallbacks
        // (t2 / 2) so a slightly-off key still maps. Self-refs and unknowns drop;
        // cycles are caught later at apply time (fallback to flat parallel).
        const keyToId = new Map<string, string>()
        object.tasks.forEach((t, i) => {
          if (t.key) keyToId.set(String(t.key), taskRows[i].id)
          keyToId.set(`t${i + 1}`, taskRows[i].id)
          keyToId.set(String(i + 1), taskRows[i].id)
        })
        object.tasks.forEach((t, i) => {
          const depIds = (t.deps ?? [])
            .map(k => keyToId.get(String(k)))
            .filter((x): x is string => !!x && x !== taskRows[i].id)
          const uniq = [...new Set(depIds)]
          if (uniq.length) setTaskDeps(taskRows[i].id, uniq)
        })

        writeProposalMd({ projectPath, slug: targetRequest.slug, title: object.title, summary: object.summary })
        writeTasksMd({ projectPath, slug: targetRequest.slug, tasks: taskRows })

        if (!isPromotion) {
          appendMessage({ requestId: targetRequest.id, role: 'user', content: args.prompt })
        }
        const inTok = proposeUsage?.promptTokens ?? null
        const outTok = proposeUsage?.completionTokens ?? null
        const cost = inTok != null && outTok != null ? computeCost(modelInfo.modelId, inTok, outTok) : null
        appendMessage({
          requestId: targetRequest.id, role: 'assistant',
          content: isPromotion
            ? `已根据上面的对话拆解为 ${object.tasks.length} 个任务，请审查后点「执行剩余任务」开始实施。`
            : `已生成提议「${object.title}」，包含 ${object.tasks.length} 个任务`,
          inputTokens: inTok, outputTokens: outTok, costUsd: cost, model: modelInfo.modelId
        })

        emit({
          type: 'request_ready',
          requestId: targetRequest.id,
          text: isPromotion ? `已拆解为 ${object.tasks.length} 个任务` : `已生成 ${object.tasks.length} 个任务`
        })

        // Auto-apply: if user opted in via global settings, kick off apply on the
        // newly-proposed request right after sending DONE. The renderer keys off
        // `autoApplyStarting` on the DONE payload to flip the running indicator
        // from 'propose' → 'apply' instead of resetting to idle.
        const shouldAutoApply = getSettings().vibeAutoApply && object.tasks.length > 0
        win.webContents.send(IPC.VIBE_DONE, {
          projectPath,
          requestId: targetRequest.id,
          autoApplyStarting: shouldAutoApply
        })
        if (shouldAutoApply) {
          // Re-fetch fresh from DB to pick up the new status / kind columns.
          const fresh = getRequest(targetRequest.id)
          if (fresh) runApplyLoop(fresh)
        }
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        if (ctl.signal.aborted) {
          win.webContents.send(IPC.VIBE_DONE, { projectPath, cancelled: true })
        } else {
          console.error('[vibe] propose failed:', err)
          win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: msg })
        }
      } finally {
        if (activeRuns.get(projectPath) === ctl) activeRuns.delete(projectPath)
      }
    })()

    return { started: true }
  }

  ipcMain.handle(IPC.VIBE_PROPOSE, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => runPropose(args))

  // ----- VIBE_RUN — unified entry: auto-classify intent then dispatch --------
  // The user no longer manually picks chat/explore/bugfix/change. Pass
  // forceIntent to override (manual lock). Returns the resolved intent so the
  // renderer can show the right running banner.
  ipcMain.handle(IPC.VIBE_RUN, async (_e, args: { projectPath: string; prompt: string; requestId?: string; forceIntent?: VibeIntent; attachments?: Array<{ name: string; path: string; mimeType: string }>; thinkingMode?: ThinkingMode }) => {
    const win = getMainWindow()
    if (!win) return { error: 'No window' }
    const projectPath = path.resolve(args.projectPath)
    if (!isAllowedProjectPath(projectPath)) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, error: 'Project path not allowed' })
      return { started: false }
    }

    let intent: VibeIntent
    if (args.forceIntent) {
      intent = args.forceIntent
    } else {
      // Classify with the project's model (falls back to 'chat' on any failure).
      try {
        const mi = resolveProjectModel(upsertProject(projectPath))
        intent = await classifyVibeIntent(args.prompt, mi.providerId, mi.modelId)
      } catch { intent = 'chat' }
    }

    const passthrough = { projectPath: args.projectPath, prompt: args.prompt, requestId: args.requestId, attachments: args.attachments, thinkingMode: args.thinkingMode }
    let res: { started?: boolean; requestId?: string; error?: string }
    switch (intent) {
      case 'explore':
        res = runStreamMode(passthrough, { kind: 'explore', label: '探索', systemPrompt: EXPLORE_SYSTEM, buildTools: buildReadOnlyVibeTools, maxSteps: 15 }); break
      case 'bugfix':
        res = runStreamMode(passthrough, { kind: 'bugfix', label: '修复', systemPrompt: BUGFIX_SYSTEM, buildTools: buildVibeTools, maxSteps: 20 }); break
      case 'change':
        res = runPropose(passthrough); break
      case 'chat':
      default:
        res = runStreamMode(passthrough, { kind: 'chat', label: '对话', systemPrompt: CHAT_SYSTEM, buildTools: buildVibeTools, maxSteps: 15 }); break
    }
    return { ...res, intent }
  })

  // ----- APPLY ------------------------------------------------------------
  // Extracted into a reusable function so VIBE_PROPOSE can auto-trigger it
  // when settings.vibeAutoApply is true.
  /** True if the employee has another running/pending task in this request
   *  (excluding `exceptTaskId`) — so we don't flip them to idle prematurely. */
  function hasOtherActiveTask(requestId: string, employeeId: string, exceptTaskId: string): boolean {
    return listTasks(requestId).some(t =>
      t.id !== exceptTaskId &&
      t.assignee_employee_id === employeeId &&
      (t.status === 'running' || t.status === 'pending'))
  }

  /** Execute ONE sub-task with ITS OWN assignee's model + soul persona.
   *  Returns the terminal status. Never throws (errors are recorded on the task). */
  async function runOneTask(
    request: VibeRequestRow,
    task: VibeTaskRow,
    projectPath: string,
    snapshot: VibeTaskRow[],
    signal: AbortSignal,
    emit: (e: Omit<VibeProgressEvent, 'projectPath'>) => void,
    upstreamContext = '',
    checkpointId: string | null = null
  ): Promise<{ status: 'done' | 'error' | 'cancelled'; summary: string }> {
    if (signal.aborted) return { status: 'cancelled', summary: '' }

    // Resolve this task's employee → model + soul (fallback chain:
    // task.assignee → request.assignee → project default).
    const taskEmp = task.assignee_employee_id ? getEmployee(task.assignee_employee_id)
                  : request.assignee_employee_id ? getEmployee(request.assignee_employee_id)
                  : null
    let modelInfo = resolveProjectModel(upsertProject(projectPath))
    if (taskEmp?.providerId && taskEmp?.modelId) modelInfo = { providerId: taskEmp.providerId, modelId: taskEmp.modelId }
    const soulPrompt = taskEmp ? (getSoul(taskEmp.soulId)?.systemPrompt ?? '') : ''

    updateTaskStatus(task.id, 'running')
    await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
    emit({ type: 'task_status', taskId: task.id, taskStatus: 'running' })
    appendMessage({ requestId: request.id, role: 'system', taskId: task.id, content: `${taskEmp ? taskEmp.name + ' ' : ''}开始任务：${task.title}` })
    if (taskEmp) setEmployeeStatus(taskEmp.id, 'busy')

    // Files this task wrote (repo-relative) — so just this task can be reverted
    // without touching the parallel tasks' work. Captured from the same filePath
    // the code_write/code_edit tools now emit (drives the editor-tab refresh too).
    const touchedFiles = new Set<string>()
    const taskToolEmit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      emit({ ...e, taskId: task.id })
      if (e.type === 'tool_result' && !e.isError && e.filePath && (e.toolName === 'code_write' || e.toolName === 'code_edit')) {
        touchedFiles.add(path.relative(projectPath, e.filePath).replace(/\\/g, '/'))
      }
      if (e.type === 'tool_use') {
        appendMessage({ requestId: request.id, role: 'tool', taskId: task.id, content: e.toolArgsPreview ?? '', toolName: e.toolName, isError: false })
      } else if (e.type === 'tool_result') {
        appendMessage({ requestId: request.id, role: 'tool', taskId: task.id, content: e.toolResultPreview ?? '', toolName: e.toolName, isError: !!e.isError })
      }
    }
    const rawTools = buildVibeTools(projectPath, taskToolEmit, signal)
    const { section: applySkillsSection, skills: applySkills } = buildVibeSkillsSection(projectPath)
    let tools: Record<string, Tool> = applyVibeSkillsFilter(rawTools, applySkills)
    const applyRuntimeSkills = applySkills.filter(s => s.runtime)
    if (applyRuntimeSkills.length) {
      tools = { ...tools, ...buildVibeSkillTools(projectPath, applyRuntimeSkills, taskToolEmit, signal) }
    }
    const otherTasks = snapshot.filter(t => t.id !== task.id)

    let accumulated = ''
    let runError: Error | null = null
    let usage: { promptTokens?: number; completionTokens?: number } | null = null
    // 看门狗：盯【整条事件流】(文本/思考/工具调用/工具结果/步骤)的活性,窗口内毫无任何事件
    // 才算真卡死。只中断【本任务】——绝不动共享的 request signal,否则会误杀并行的其他任务。
    // 没有它,一条挂死的流会永远占着 agentRunSemaphore 槽位,槽位耗尽后对话+工作台全卡。
    // 注意：绝不能只盯文本 token——模型在生成工具调用、思考、或等工具执行时本就没有文本输出,
    // 那样会把正常的多步工具流误判成「无响应」。tool-call 后的工具执行期给更长容忍窗口。
    let stalled = false
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    // 两档静默窗口（语义同 runStreamMode）：STREAM_GAP_MS 只用于「文本已在流式输出却突然
    // 静默」；SILENT_WORK_MS 覆盖「模型在干活但不吐字」的所有阶段——首 token、思考、工具执行、
    // 以及工具结果后的下一轮推理。apply 多步任务上下文越滚越大，工具结果后那轮推理最易超时，
    // 之前只给 75s 是「经常误判无响应」的主因。
    const STREAM_GAP_MS = 120000
    const SILENT_WORK_MS = 240000
    const taskCtl = new AbortController()
    const taskSignal = AbortSignal.any([signal, taskCtl.signal])
    const armStall = (ms: number = SILENT_WORK_MS): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => { if (!taskSignal.aborted) { stalled = true; taskCtl.abort() } }, ms)
    }
    // 扩展思考策略(B)：按全局设置注入 Anthropic thinking providerOptions（auto=不动）。
    // 用「有效协议」而非原始 type —— supercode 上自动改走原生协议的 claude 也能吃到。
    const provCfg = getProviders().find(p => p.id === modelInfo.providerId)
    const provType = provCfg ? effectiveProtocol(provCfg, modelInfo.modelId) : undefined
    const thinkOpts = thinkingStreamOpts(provType, getSettings().chatThinkingMode)
    let inReasoning = false
    const closeThink = (): void => {
      if (inReasoning) { inReasoning = false; emit({ type: 'text', text: '</think>\n\n', taskId: task.id }) }
    }
    try {
      const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
      const applySystem = (soulPrompt ? soulPrompt + '\n\n---\n\n' : '') + buildApplySystem(request, task, otherTasks)
        + (upstreamContext ? '\n\n---\n\n' + upstreamContext : '') + applySkillsSection
      // Anthropic: cache the (soul + apply) system via a marked leading message.
      const applySysMsg = anthropicSystemCacheMessage(applySystem, provType, provCfg?.relayCompat)
      const result = streamText({
        model,
        ...(applySysMsg
          ? { messages: [applySysMsg, { role: 'user', content: task.description || task.title } as CoreMessage] }
          : { system: applySystem, messages: [{ role: 'user', content: task.description || task.title }] }),
        tools,
        maxSteps: 25,
        maxRetries: 2,
        abortSignal: taskSignal,
        onError: ({ error }) => { console.error('[vibe] task streamText error:', error); runError = error as Error },
        ...thinkOpts
      })
      armStall()
      for await (const part of result.fullStream) {
        if (taskSignal.aborted) break
        // 只有「正在吐字时的 token 间隙」用紧窗口；思考/工具调用/工具执行/工具结果后的
        // 下一轮推理都属「干活不吐字」，给宽窗口（否则大上下文重推理会被误判）。
        armStall(part.type === 'text-delta' ? STREAM_GAP_MS : SILENT_WORK_MS)
        if (part.type === 'reasoning' && part.textDelta) {
          // 实时显示思考：把连续 reasoning 包进 <think>…</think>（渲染层折叠成「思考过程」）。
          // 仅 emit、不计入 accumulated —— 落库消息与下游上下文摘要保持只有最终答案。
          if (!inReasoning) { inReasoning = true; emit({ type: 'text', text: '<think>', taskId: task.id }) }
          emit({ type: 'text', text: part.textDelta, taskId: task.id })
        } else if (part.type === 'text-delta' && part.textDelta) {
          closeThink()
          accumulated += part.textDelta
          emit({ type: 'text', text: part.textDelta, taskId: task.id })
        } else if (part.type === 'tool-call') {
          closeThink()
        } else if (part.type === 'error') {
          runError = part.error as Error
        }
      }
      closeThink()
      await result.finishReason.catch(() => null)
      usage = await result.usage.catch(() => null)
    } catch (err) {
      runError = err as Error
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
    }

    // Release busy state only if this employee has no other active task here.
    const releaseEmp = () => { if (taskEmp && !hasOtherActiveTask(request.id, taskEmp.id, task.id)) setEmployeeStatus(taskEmp.id, 'idle') }

    // Stall watchdog tripped → mark this task as failed (not cancelled) so the
    // slot is released and the run surfaces a clear error instead of hanging.
    if (stalled) {
      const msg = 'AI 长时间无响应（可能是模型、网络或代理异常），已自动停止该任务。请重试，或到「设置 → 模型 / 网络代理」检查配置。'
      updateTaskStatus(task.id, 'error', msg)
      await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
      emit({ type: 'task_status', taskId: task.id, taskStatus: 'error', text: msg })
      appendMessage({ requestId: request.id, role: 'system', taskId: task.id, content: `任务失败：${msg}`, isError: true })
      releaseEmp()
      return { status: 'error', summary: '' }
    }
    if (signal.aborted) {
      updateTaskStatus(task.id, 'pending')
      await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
      releaseEmp()
      return { status: 'cancelled', summary: '' }
    }
    if (runError) {
      updateTaskStatus(task.id, 'error', (runError as Error).message)
      await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
      emit({ type: 'task_status', taskId: task.id, taskStatus: 'error', text: (runError as Error).message })
      appendMessage({ requestId: request.id, role: 'system', taskId: task.id, content: `任务失败：${(runError as Error).message}`, isError: true })
      releaseEmp()
      return { status: 'error', summary: '' }  // 不牵连其他任务 —— 其余照跑
    }

    updateTaskStatus(task.id, 'done')
    // Record this task's touched files + the pre-apply checkpoint so it can be
    // reverted on its own later (no checkpoint → not revertable).
    setTaskRevertInfo(task.id, { cp: checkpointId, files: [...touchedFiles] })
    await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
    emit({ type: 'task_status', taskId: task.id, taskStatus: 'done' })
    if (taskEmp) bumpEmployeeStats(taskEmp.id, { out: 1 })
    if (accumulated.trim()) {
      const inTok = finiteUsage(usage?.promptTokens)
      const outTok = finiteUsage(usage?.completionTokens)
      const cost = inTok != null && outTok != null && (inTok > 0 || outTok > 0) ? computeCost(modelInfo.modelId, inTok, outTok) : null
      appendMessage({ requestId: request.id, role: 'assistant', taskId: task.id, content: accumulated.trim(), inputTokens: inTok, outputTokens: outTok, costUsd: cost, model: modelInfo.modelId })
    }
    releaseEmp()
    // Return a short summary of what this task produced so dependent tasks can
    // be given it as context (so a dep gates ordering AND passes information).
    return { status: 'done', summary: accumulated.trim().slice(0, 600) }
  }

  function runApplyLoop(request: VibeRequestRow): { started: boolean } {
    const win = getMainWindow()
    if (!win) return { started: false }

    const projectPath = request.project_path
    if (!isAllowedProjectPath(projectPath)) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: 'Project path not allowed' })
      return { started: false }
    }
    try { resolveProjectModel(upsertProject(projectPath)) }
    catch (e) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: (e as Error).message })
      return { started: false }
    }

    // Per-REQUEST controller so parallel sub-tasks share one signal (and so two
    // requests in the same project don't abort each other).
    activeApplyRuns.get(request.id)?.abort()
    const ctl = new AbortController()
    activeApplyRuns.set(request.id, ctl)

    const emit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      win.webContents.send(IPC.VIBE_PROGRESS, { ...e, projectPath, requestId: request.id })
    }

    ;(async () => {
      try {
        // Snapshot the worktree before the (parallel, autonomous) apply run so
        // the whole batch can be rolled back from the 「更改」 panel.
        const cp = await gitSvc.createCheckpoint(projectPath).catch(() => null)
        emit(cp
          ? { type: 'system', text: '已创建改动前快照，可在「更改」面板一键回滚本次改动。' }
          : { type: 'system', text: '⚠️ 未能创建改动前快照，本次改动将无法一键回滚（项目可能不是 git 仓库，或本机未安装 git——可在「更改」面板「启用版本快照」）。' })
        updateRequestStatus(request.id, 'applying')

        // Re-apply semantics: retry the whole unfinished branch as a unit. Reset
        // both errored tasks AND auto-skipped ones (blocked by a failed prereq) to
        // pending, so a re-run waits for its prerequisite again via the DAG instead
        // of charging ahead without it. Auto-skips carry a reason in error_text;
        // user-manual skips (error_text null) and done tasks are left untouched.
        for (const t of listTasks(request.id)) {
          if (t.status === 'error' || (t.status === 'skipped' && t.error_text)) updateTaskStatus(t.id, 'pending')
        }

        const snapshot = listTasks(request.id)
        const pending = snapshot.filter(t => t.status === 'pending')
        const pendingIds = new Set(pending.map(t => t.id))
        const byId = new Map(pending.map(t => [t.id, t]))

        // Build the dependency DAG. Only edges BETWEEN still-pending tasks gate
        // execution (a prereq that's already done is satisfied). No edges anywhere
        // → every task lands in level 0 = the old full-parallel fan-out, so this is
        // strictly backward compatible.
        const edges: { source: string; target: string }[] = []
        for (const t of pending) {
          for (const dep of parseTaskDeps(t.deps)) {
            if (pendingIds.has(dep) && dep !== t.id) edges.push({ source: dep, target: t.id })
          }
        }
        const levels = topologicalLevels(pending, edges)
        // Kahn drops nodes trapped in a cycle → flat.length < pending.length means
        // a cycle. Rather than deadlock, fall back to flat parallel with a warning.
        const hasCycle = levels.flat().length !== pending.length
        const useLevels = !hasCycle && edges.length > 0

        // Track each task's final status + a short summary of its output, so we can
        // (a) skip a task whose prerequisite didn't finish cleanly, and (b) feed a
        // dependent task its prerequisites' results as context.
        const statusById = new Map<string, 'done' | 'error' | 'cancelled' | 'skipped'>()
        const outputById = new Map<string, string>()

        const upstreamContextFor = (task: VibeTaskRow): string => {
          const deps = parseTaskDeps(task.deps).filter(d => pendingIds.has(d))
          const parts = deps.map(d => {
            const dt = byId.get(d); if (!dt) return null
            const out = outputById.get(d)
            return `• 前置任务「${dt.title}」${out ? '：' + out : '（已完成）'}`
          }).filter(Boolean)
          return parts.length
            ? `已完成的前置任务及其产出（供你参考，在此基础上继续，不要重复实现）：\n${parts.join('\n')}`
            : ''
        }

        const runTask = (task: VibeTaskRow, ctx: string) => agentRunSemaphore.run(async () => {
          const r = await runOneTask(request, task, projectPath, snapshot, ctl.signal, emit, ctx, cp?.id ?? null)
          statusById.set(task.id, r.status)
          if (r.summary) outputById.set(task.id, r.summary)
        })

        if (!useLevels) {
          if (hasCycle) emit({ type: 'system', text: '⚠️ 任务依赖存在循环，已回退为全并行执行' })
          emit({ type: 'system', text: '开始执行（多员工并行）' })
          await Promise.allSettled(pending.map(task => runTask(task, '')))
        } else {
          emit({ type: 'system', text: `开始执行（按依赖分 ${levels.length} 批，批内并行）` })
          for (const level of levels) {
            if (ctl.signal.aborted) break
            const levelTasks = level.map(id => byId.get(id)).filter(Boolean) as VibeTaskRow[]
            await Promise.allSettled(levelTasks.map(task => {
              // Block this task if any prerequisite didn't complete cleanly — running
              // it on a broken/half-done foundation would produce garbage.
              const deps = parseTaskDeps(task.deps).filter(d => pendingIds.has(d))
              const blocker = deps.find(d => { const s = statusById.get(d); return s && s !== 'done' })
              if (blocker) {
                const reason = `前置任务「${byId.get(blocker)?.title ?? blocker}」未完成，已跳过`
                markTaskBlocked(task.id, reason)
                statusById.set(task.id, 'skipped')
                emit({ type: 'task_status', taskId: task.id, taskStatus: 'skipped', text: reason })
                appendMessage({ requestId: request.id, role: 'system', taskId: task.id, content: reason, isError: true })
                return Promise.resolve()
              }
              return runTask(task, upstreamContextFor(task))
            }))
            // Keep tasks.md in sync after each batch (covers blocked/skipped rows
            // that runOneTask never touched).
            await withFileLock('tasksmd:' + request.id, () => writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) }))
          }
        }

        const finalTasks = listTasks(request.id)
        const stillPending = finalTasks.some(t => t.status === 'pending' || t.status === 'error')
        updateRequestStatus(request.id, stillPending ? 'proposed' : 'done')
        // 整需求交付 → 参与的每个员工各 done +1
        if (!stillPending) {
          const empIds = new Set(finalTasks.map(t => t.assignee_employee_id).filter(Boolean) as string[])
          for (const id of empIds) bumpEmployeeStats(id, { done: 1 })
          // 公司越用越聪明：交付后从本需求记录提炼项目记忆（后台、不阻塞）
          void captureRequestMemory(request)
        }

        win.webContents.send(IPC.VIBE_DONE, { projectPath, requestId: request.id, cancelled: ctl.signal.aborted })
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error('[vibe] apply failed:', err)
        updateRequestStatus(request.id, 'proposed')
        win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: msg })
      } finally {
        if (activeApplyRuns.get(request.id) === ctl) activeApplyRuns.delete(request.id)
        // 兜底：把本需求涉及的所有员工置 idle（防遗漏）
        const ids = new Set(listTasks(request.id).map(t => t.assignee_employee_id).filter(Boolean) as string[])
        for (const id of ids) setEmployeeStatus(id, 'idle')
      }
    })()

    return { started: true }
  }

  ipcMain.handle(IPC.VIBE_APPLY, async (_e, args: { requestId: string }) => {
    const request = getRequest(args.requestId)
    if (!request) return { error: 'Request not found' }
    return runApplyLoop(request)
  })

  // ----- STOP -------------------------------------------------------------
  ipcMain.handle(IPC.VIBE_STOP, async (_e, args: { projectPath: string }) => {
    const abs = path.resolve(args.projectPath)
    let stopped = false
    // Stop the stream-mode run (chat/explore/bugfix/propose) for this project.
    const ctl = activeRuns.get(abs)
    if (ctl) { ctl.abort(); activeRuns.delete(abs); stopped = true }
    // Stop every apply run whose request belongs to this project (parallel
    // sub-tasks share one per-request controller).
    for (const [reqId, applyCtl] of activeApplyRuns) {
      const r = getRequest(reqId)
      if (r && path.resolve(r.project_path) === abs) {
        applyCtl.abort(); activeApplyRuns.delete(reqId); stopped = true
      }
    }
    return stopped ? { ok: true } : { ok: false, reason: 'No active run' }
  })
}
