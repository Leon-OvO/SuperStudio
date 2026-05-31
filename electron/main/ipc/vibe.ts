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
import { streamText, tool, type Tool } from 'ai'
import { z } from 'zod'
import { IPC } from '../../../src/shared/ipc-types'
import type {
  FileTreeNode,
  VibeProgressEvent,
  VibeRequestInfo,
  VibeTaskInfo,
  VibeMessageInfo,
  VibeProjectInfo
} from '../../../src/shared/ipc-types'
import { getMainWindow } from '../index'
import { getProviders, getSettings } from '../services/store'
import { createLLMClient } from '../services/llm'
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
  createRequest, listRequests, getRequest, updateRequestStatus, updateRequestSummary,
  deleteRequest, deleteTasksForRequest, slugify, setRequestAssignee,
  createTask, listTasks, updateTaskStatus,
  appendMessage, listMessages,
  type VibeRequestRow, type VibeTaskRow, type VibeMessageRow, type VibeProjectRow
} from '../services/vibe-db'
import { getEmployee, setEmployeeStatus, bumpEmployeeStats } from '../services/employees-db'
import { getSoul } from '../services/talent-pool'
import { dbRun } from '../db/sqlite'
import { writeProposalMd, writeTasksMd } from '../services/vibe-spec'
import { getActiveSkillsForScenario, type InstalledSkill } from '../services/skills-db'
import { buildSkillTools } from '../agent/skill-tools'
import { runShell } from '../services/shell'
import { computeCost } from '../services/model-pricing'

/**
 * Build a system-prompt fragment from the skills the user enabled for the
 * "vibe" (build) scenario. Returns '' when no skills apply.
 */
function buildVibeSkillsSection(): { section: string; skills: InstalledSkill[] } {
  let skills: InstalledSkill[] = []
  try { skills = getActiveSkillsForScenario('vibe') }
  catch (e) { console.warn('[vibe] failed to load active skills:', (e as Error).message) }
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
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, content, 'utf8')
          emit({ type: 'tool_result', toolName: 'code_write', toolResultPreview: `已写入 ${rel}` })
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
          const original = fs.readFileSync(abs, 'utf8')
          const occ = original.split(oldString).length - 1
          if (occ === 0) throw new Error('oldString 未在文件中找到')
          if (occ > 1) throw new Error(`oldString 在文件中匹配了 ${occ} 次，需要更精确的上下文`)
          fs.writeFileSync(abs, original.replace(oldString, newString), 'utf8')
          emit({ type: 'tool_result', toolName: 'code_edit', toolResultPreview: `已修改 ${rel}` })
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
        glob: z.string().nullable().describe('Optional file filter; null for all files')
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
      description: 'Run shell command in project root. Captures stdout+stderr. 30s timeout. Use sparingly.',
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        emit({ type: 'tool_use', toolName: 'code_bash', toolArgsPreview: truncate(command, 80) })
        try {
          const result = await runShell(command, projectRoot, abortSignal)
          const summary = `exit ${result.code}${result.timedOut ? ' (timed out)' : ''}, ${result.stdout.length + result.stderr.length} bytes`
          emit({ type: 'tool_result', toolName: 'code_bash', toolResultPreview: summary, isError: result.code !== 0 })
          return result
        } catch (e) {
          const msg = (e as Error).message
          emit({ type: 'tool_result', toolName: 'code_bash', toolResultPreview: msg, isError: true })
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
  // 3. First supercode provider with models
  const sc = providers.find(p => p.source === 'supercode' && p.models.length > 0)
  if (sc) return { providerId: sc.id, modelId: sc.models[0] }
  // 4. Any provider with models
  const any = providers.find(p => p.models.length > 0)
  if (any) return { providerId: any.id, modelId: any.models[0] }
  throw new Error('没有可用的模型。请到「账号 → API Keys」初始化，或在「设置 → 模型」配置一个 Key。')
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
  return {
    id: t.id, requestId: t.request_id, ord: t.ord, title: t.title,
    description: t.description, status: t.status, errorText: t.error_text,
    startedAt: t.started_at, finishedAt: t.finished_at
  }
}
function toMessageInfo(m: VibeMessageRow): VibeMessageInfo {
  return {
    id: m.id, requestId: m.request_id, role: m.role, content: m.content,
    toolName: m.tool_name, toolArgs: m.tool_args, isError: m.is_error === 1,
    taskId: m.task_id, createdAt: m.created_at,
    inputTokens: m.input_tokens, outputTokens: m.output_tokens,
    costUsd: m.cost_usd, model: m.model
  }
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
- code_bash(command) — shell command (30s timeout)

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
   - title: imperative phrase in Chinese, like "添加登录表单组件" (NOT abstract/vague)
   - description: 1–3 sentences in Chinese on what specifically to do

Guidelines:
- Tasks should be small and verifiable (one tool-able outcome each)
- Order tasks by execution: dependencies first
- Don't include "测试" or "文档" tasks unless explicitly asked
- Keep the scope minimal — do exactly what was asked, nothing more

JSON format rules — VERY IMPORTANT:
- "tasks" MUST be a JSON ARRAY of objects: [{"title": "...", "description": "..."}, ...]
- DO NOT wrap "tasks" as a JSON-encoded string — it must be a real array literal in your tool call arguments
- Each task object's "title" and "description" are plain strings, not stringified JSON

If the user's request is too vague to plan (e.g., just "开始" or "帮我做点东西"), produce a single clarifying task asking for more detail — don't fabricate work.`

function buildApplySystem(request: VibeRequestRow, currentTask: VibeTaskRow, otherTasks: VibeTaskRow[]): string {
  const otherSummary = otherTasks
    .map(t => `${t.status === 'done' ? '✓' : '☐'} ${t.ord}. ${t.title}`)
    .join('\n  ')
  return `You are implementing a single task within a larger coding change. Stay focused on THIS task only.

Change: ${request.title}
${request.summary ? `Summary: ${request.summary}\n` : ''}

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
- code_bash(command) — run shell command (30s timeout)

Workflow:
1. Use code_glob/code_grep/code_read to explore relevant files first
2. Make the change (prefer code_edit for surgical edits; code_write only for new files)
3. Briefly confirm what you did

Do NOT:
- Add unrequested features or "improvements"
- Touch files unrelated to this specific task
- Write comments unless they explain non-obvious WHY
- Execute other tasks in the list`
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Some models (Claude via OpenAI-compat proxies in particular) return nested
// arrays as JSON-encoded strings instead of actual arrays. z.preprocess
// transparently decodes those before validation so we don't lose the turn.
const decodeIfStringArray = (v: unknown): unknown => {
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { /* leave as-is — schema will reject */ }
  }
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
      title: z.string().min(2).max(100).describe('Imperative title like "添加登录表单组件"'),
      description: z.string().min(2).max(500).describe('Specific implementation guidance in 1-3 sentences')
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
    addRecentProject(full)
    registerApprovedRoot(full)
    upsertProject(full)
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

  ipcMain.handle(IPC.VIBE_REQUEST_SET_ASSIGNEE, async (_e, args: { requestId: string; employeeId: string | null }) => {
    setRequestAssignee(args.requestId, args.employeeId)
    // Count the承接 on the employee's tally when newly assigned.
    if (args.employeeId) bumpEmployeeStats(args.employeeId, { assigned: 1 })
    return { ok: true }
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
    args: { projectPath: string; prompt: string; requestId?: string },
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

    appendMessage({ requestId, role: 'user', content: args.prompt })
    emit({ type: 'request_ready', requestId, text: `${opts.label}中…` })

    ;(async () => {
      try {
        const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
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

        const { section: skillsSection, skills: activeSkills } = buildVibeSkillsSection()
        let tools: Record<string, Tool> | undefined =
          rawTools ? applyVibeSkillsFilter(rawTools, activeSkills) : undefined
        // Merge progressive-disclosure skill tools when this mode has tools.
        const runtimeSkills = activeSkills.filter(s => s.runtime)
        if (tools && runtimeSkills.length) {
          tools = { ...tools, ...buildVibeSkillTools(projectPath, runtimeSkills, toolEmit, ctl.signal) }
        }

        const history = listMessages(requestId)
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

        let accumulated = ''
        let runError: Error | null = null
        let usage: { promptTokens?: number; completionTokens?: number } | null = null
        try {
          const result = streamText({
            model,
            system: opts.systemPrompt + skillsSection,
            messages: history,
            ...(tools ? { tools } : {}),
            maxSteps: opts.maxSteps ?? (tools ? 20 : 5),
            maxRetries: 2,
            abortSignal: ctl.signal,
            onError: ({ error }) => {
              console.error(`[vibe] ${opts.kind} streamText error:`, error)
              runError = error as Error
            }
          })
          for await (const chunk of result.textStream) {
            if (ctl.signal.aborted) break
            if (chunk) {
              accumulated += chunk
              emit({ type: 'text', text: chunk })
            }
          }
          await result.finishReason.catch(() => null)
          usage = await result.usage.catch(() => null)
        } catch (err) {
          runError = err as Error
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

  // ----- PROPOSE ----------------------------------------------------------
  // ----- EXPLORE (chat mode, read-only) -----------------------------------
  // Simple Q&A with the codebase — no propose, no apply, no disk artifacts.
  // Reuses an existing 'explore' request to keep conversation history, or
  // creates a new one on first prompt.
  ipcMain.handle(IPC.VIBE_EXPLORE, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => {
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

    // Resolve or create the request that will hold this conversation
    let request: VibeRequestRow | null = args.requestId ? getRequest(args.requestId) : null
    if (!request) {
      const title = args.prompt.trim().slice(0, 60).replace(/\s+/g, ' ') || '探索'
      request = createRequest({
        projectPath,
        slug: slugify(title),
        title,
        summary: '',
        kind: 'explore'
      })
    }

    activeRuns.get(projectPath)?.abort()
    const ctl = new AbortController()
    activeRuns.set(projectPath, ctl)

    const requestId = request.id
    const emit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      win.webContents.send(IPC.VIBE_PROGRESS, { ...e, projectPath, requestId })
    }

    // Persist the user message
    appendMessage({ requestId, role: 'user', content: args.prompt })

    // Tell the renderer right away which request to display
    emit({ type: 'request_ready', requestId, text: '探索中…' })

    ;(async () => {
      try {
        const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
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
        const rawTools = buildReadOnlyVibeTools(projectPath, toolEmit, ctl.signal)

        const { section: skillsSection, skills: activeSkills } = buildVibeSkillsSection()
        let tools: Record<string, Tool> = applyVibeSkillsFilter(rawTools, activeSkills)
        const runtimeSkills = activeSkills.filter(s => s.runtime)
        if (runtimeSkills.length) {
          tools = { ...tools, ...buildVibeSkillTools(projectPath, runtimeSkills, toolEmit, ctl.signal) }
        }

        // Reuse existing conversation history as context
        const history = listMessages(requestId)
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

        let accumulated = ''
        let runError: Error | null = null
        let usage: { promptTokens?: number; completionTokens?: number } | null = null
        try {
          const result = streamText({
            model,
            system: EXPLORE_SYSTEM + skillsSection,
            messages: history,
            tools,
            maxSteps: 15,
            maxRetries: 2,
            abortSignal: ctl.signal,
            onError: ({ error }) => {
              console.error('[vibe] explore streamText error:', error)
              runError = error as Error
            }
          })
          for await (const chunk of result.textStream) {
            if (ctl.signal.aborted) break
            if (chunk) {
              accumulated += chunk
              emit({ type: 'text', text: chunk })
            }
          }
          await result.finishReason.catch(() => null)
          usage = await result.usage.catch(() => null)
        } catch (err) {
          runError = err as Error
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
        console.error('[vibe] explore failed:', err)
        win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId, error: msg })
      } finally {
        if (activeRuns.get(projectPath) === ctl) activeRuns.delete(projectPath)
      }
    })()

    return { started: true, requestId }
  })

  ipcMain.handle(IPC.VIBE_PROPOSE, async (_e, args: { projectPath: string; prompt: string; requestId?: string }) => {
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
        const history: { role: 'user' | 'assistant'; content: string }[] = isPromotion
          ? listMessages(existing!.id)
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          : []

        const userPrompt = isPromotion
          ? `[基于以上对话上下文，将我们讨论的改动拆解成可执行任务列表]\n\n附加说明：${args.prompt || '（无）'}`
          : `项目根目录：${projectPath}\n顶层文件：${topLevel || '(空)'}\n\n用户需求：\n${args.prompt}`

        // For promotion, persist the user's "promote" prompt so it shows in convo
        if (isPromotion && args.prompt.trim()) {
          appendMessage({ requestId: existing!.id, role: 'user', content: args.prompt })
        }

        let captured: z.infer<typeof ProposalSchema> | null = null
        const { section: proposeSkillsSection } = buildVibeSkillsSection()
        const result = streamText({
          model,
          system: PROPOSE_SYSTEM + (isPromotion
            ? '\n\n你正在基于已有的对话上下文做拆解 — 请保留 slug/title 跟之前对话主题一致，并参考前面的讨论内容设计任务。你 MUST 调用 submit_proposal 工具且只调一次。'
            : '\n\nIMPORTANT: You MUST call the `submit_proposal` tool exactly once with the structured plan. Do not output free-form JSON.') + proposeSkillsSection,
          messages: [
            ...history,
            { role: 'user', content: userPrompt }
          ],
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

        const taskRows: VibeTaskRow[] = []
        object.tasks.forEach((t, i) => {
          taskRows.push(createTask({
            requestId: targetRequest.id, ord: i + 1,
            title: t.title, description: t.description
          }))
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
  })

  // ----- APPLY ------------------------------------------------------------
  // Extracted into a reusable function so VIBE_PROPOSE can auto-trigger it
  // when settings.vibeAutoApply is true.
  function runApplyLoop(request: VibeRequestRow): { started: boolean } {
    const win = getMainWindow()
    if (!win) return { started: false }

    const projectPath = request.project_path
    if (!isAllowedProjectPath(projectPath)) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: 'Project path not allowed' })
      return { started: false }
    }

    const project = upsertProject(projectPath)
    let modelInfo
    try { modelInfo = resolveProjectModel(project) }
    catch (e) {
      win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: (e as Error).message })
      return { started: false }
    }

    // AI-company: if a request is assigned to an employee, that employee's
    // chosen model + soul persona drive this run.
    const employee = request.assignee_employee_id ? getEmployee(request.assignee_employee_id) : null
    if (employee?.providerId && employee?.modelId) {
      modelInfo = { providerId: employee.providerId, modelId: employee.modelId }
    }
    const soulPrompt = employee ? (getSoul(employee.soulId)?.systemPrompt ?? '') : ''

    activeRuns.get(projectPath)?.abort()
    const ctl = new AbortController()
    activeRuns.set(projectPath, ctl)

    const emit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
      win.webContents.send(IPC.VIBE_PROGRESS, { ...e, projectPath, requestId: request.id })
    }

    ;(async () => {
      try {
        updateRequestStatus(request.id, 'applying')
        if (employee) setEmployeeStatus(employee.id, 'busy')
        const model = createLLMClient(modelInfo.providerId, modelInfo.modelId)
        emit({ type: 'system', text: employee ? `${employee.name} 开始执行（${modelInfo.modelId}）` : `开始执行（${modelInfo.modelId}）` })

        // Loop tasks in order; refresh from DB each iter to support cancel/manual edits
        let safety = 0
        while (safety++ < 100) {
          if (ctl.signal.aborted) break
          const allTasks = listTasks(request.id)
          const nextTask = allTasks.find(t => t.status === 'pending')
          if (!nextTask) break

          // Mark running
          updateTaskStatus(nextTask.id, 'running')
          writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) })
          emit({ type: 'task_status', taskId: nextTask.id, taskStatus: 'running' })
          appendMessage({
            requestId: request.id, role: 'system', taskId: nextTask.id,
            content: `开始任务：${nextTask.title}`
          })

          const taskToolEmit = (e: Omit<VibeProgressEvent, 'projectPath'>) => {
            emit({ ...e, taskId: nextTask.id })
            // Persist tool events to message log (skip the raw text streams — those go to vibe_messages assistant role below)
            if (e.type === 'tool_use') {
              appendMessage({
                requestId: request.id, role: 'tool', taskId: nextTask.id,
                content: e.toolArgsPreview ?? '',
                toolName: e.toolName, isError: false
              })
            } else if (e.type === 'tool_result') {
              appendMessage({
                requestId: request.id, role: 'tool', taskId: nextTask.id,
                content: e.toolResultPreview ?? '',
                toolName: e.toolName, isError: !!e.isError
              })
            }
          }
          const rawTools = buildVibeTools(projectPath, taskToolEmit, ctl.signal)

          const { section: applySkillsSection, skills: applySkills } = buildVibeSkillsSection()
          let tools: Record<string, Tool> = applyVibeSkillsFilter(rawTools, applySkills)
          const applyRuntimeSkills = applySkills.filter(s => s.runtime)
          if (applyRuntimeSkills.length) {
            tools = { ...tools, ...buildVibeSkillTools(projectPath, applyRuntimeSkills, taskToolEmit, ctl.signal) }
          }

          const otherTasks = allTasks.filter(t => t.id !== nextTask.id)
          let accumulated = ''
          let runError: Error | null = null
          let usage: { promptTokens?: number; completionTokens?: number } | null = null
          try {
            const result = streamText({
              model,
              system: (soulPrompt ? soulPrompt + '\n\n---\n\n' : '') + buildApplySystem(request, nextTask, otherTasks) + applySkillsSection,
              messages: [{ role: 'user', content: nextTask.description || nextTask.title }],
              tools,
              maxSteps: 25,
              maxRetries: 2,
              abortSignal: ctl.signal,
              onError: ({ error }) => {
                console.error('[vibe] streamText error:', error)
                runError = error as Error
              }
            })
            for await (const chunk of result.textStream) {
              if (ctl.signal.aborted) break
              if (chunk) {
                accumulated += chunk
                emit({ type: 'text', text: chunk, taskId: nextTask.id })
              }
            }
            await result.finishReason.catch(() => null)
            usage = await result.usage.catch(() => null)
          } catch (err) {
            runError = err as Error
          }

          if (ctl.signal.aborted) {
            // leave the task as pending so user can resume later by re-applying
            updateTaskStatus(nextTask.id, 'pending')
            writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) })
            break
          }

          if (runError) {
            updateTaskStatus(nextTask.id, 'error', runError.message)
            writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) })
            emit({ type: 'task_status', taskId: nextTask.id, taskStatus: 'error', text: runError.message })
            appendMessage({
              requestId: request.id, role: 'system', taskId: nextTask.id,
              content: `任务失败：${runError.message}`, isError: true
            })
            // Stop the apply loop on first error so user can review
            break
          }

          updateTaskStatus(nextTask.id, 'done')
          writeTasksMd({ projectPath, slug: request.slug, tasks: listTasks(request.id) })
          emit({ type: 'task_status', taskId: nextTask.id, taskStatus: 'done' })
          if (employee) bumpEmployeeStats(employee.id, { out: 1 }) // 每完成一个任务 +1 产出
          if (accumulated.trim()) {
            const inTok = finiteUsage(usage?.promptTokens)
            const outTok = finiteUsage(usage?.completionTokens)
            const cost = inTok != null && outTok != null && (inTok > 0 || outTok > 0)
              ? computeCost(modelInfo.modelId, inTok, outTok)
              : null
            appendMessage({
              requestId: request.id, role: 'assistant', taskId: nextTask.id,
              content: accumulated.trim(),
              inputTokens: inTok, outputTokens: outTok, costUsd: cost, model: modelInfo.modelId
            })
          }
        }

        // Update request-level status
        const finalTasks = listTasks(request.id)
        const stillPending = finalTasks.some(t => t.status === 'pending' || t.status === 'error')
        updateRequestStatus(request.id, stillPending ? 'proposed' : 'done')
        if (employee) {
          setEmployeeStatus(employee.id, 'idle')
          if (!stillPending) bumpEmployeeStats(employee.id, { done: 1 }) // 整个需求交付 → 完成 +1
        }

        if (ctl.signal.aborted) {
          win.webContents.send(IPC.VIBE_DONE, { projectPath, requestId: request.id, cancelled: true })
        } else {
          win.webContents.send(IPC.VIBE_DONE, { projectPath, requestId: request.id })
        }
      } catch (err) {
        const msg = (err as Error)?.message || String(err)
        console.error('[vibe] apply failed:', err)
        updateRequestStatus(request.id, 'proposed')
        win.webContents.send(IPC.VIBE_ERROR, { projectPath, requestId: request.id, error: msg })
      } finally {
        if (activeRuns.get(projectPath) === ctl) activeRuns.delete(projectPath)
        if (employee) setEmployeeStatus(employee.id, 'idle') // 确保任何退出路径都释放忙碌态
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
    const ctl = activeRuns.get(abs)
    if (ctl) {
      ctl.abort()
      activeRuns.delete(abs)
      return { ok: true }
    }
    return { ok: false, reason: 'No active run' }
  })
}
