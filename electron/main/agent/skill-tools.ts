import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { readSkillResource } from '../services/skill-files'
import { runShell } from '../services/shell'
import type { InstalledSkill } from '../services/skills-db'

// ============================================================================
// Runtime-skill tools — the on-demand half of progressive disclosure.
//
// The system prompt only lists each enabled runtime skill's name+description.
// When the model decides a skill applies it calls `load_skill` to pull the
// full SKILL.md body, then `read_skill_file` for bundled references and `bash`
// to run bundled scripts.
// ============================================================================

export interface SkillToolHooks {
  onUse?: (toolName: string, args: Record<string, unknown>) => void
  onResult?: (toolName: string, args: Record<string, unknown>, result: unknown, isError: boolean) => void
}

export interface BuildSkillToolsOpts {
  /** Active runtime skills for the current scenario. */
  activeSkills: InstalledSkill[]
  /** Working directory for the `bash` tool. */
  cwd: string
  abortSignal: AbortSignal
  /** Expose the general `bash` tool. Caller decides based on allowScripts. */
  includeBash: boolean
  hooks?: SkillToolHooks
}

/** Match an enabled runtime skill by display name / id / slug (case-insensitive). */
function findSkill(skills: InstalledSkill[], q: string): InstalledSkill | undefined {
  const norm = q.trim().toLowerCase()
  return skills.find(s =>
    s.name.toLowerCase() === norm ||
    s.id.toLowerCase() === norm ||
    (s.slug?.toLowerCase() === norm)
  )
}

export function buildSkillTools(opts: BuildSkillToolsOpts): Record<string, Tool> {
  const { activeSkills, cwd, abortSignal, includeBash, hooks } = opts
  const skillNames = activeSkills.map(s => s.name).join(', ') || '(none)'

  const tools: Record<string, Tool> = {
    load_skill: tool({
      description:
        'Load the full instructions of an enabled skill. The system prompt only ' +
        'lists each skill by name + a short description; call this to get the ' +
        'complete SKILL.md body, the skill\'s on-disk base path, and the list of ' +
        `bundled resource files before acting on a skill. Available skills: ${skillNames}.`,
      parameters: z.object({
        name: z.string().describe('The skill name exactly as listed in "Available Skills".')
      }),
      execute: async ({ name }) => {
        hooks?.onUse?.('load_skill', { name })
        const skill = findSkill(activeSkills, name)
        if (!skill) {
          const result = { error: `未找到名为 "${name}" 的技能。可用技能：${skillNames}` }
          hooks?.onResult?.('load_skill', { name }, result, true)
          return result
        }
        const result = {
          name: skill.name,
          instructions: skill.skillBody || '(此技能没有 SKILL.md 正文)',
          basePath: skill.installPath,
          resources: skill.resourceFiles,
          scriptsAllowed: skill.allowScripts,
          note: skill.allowScripts
            ? '可用 read_skill_file 读取上面的资源文件；可用 bash 运行 scripts/ 下的脚本（用 basePath 拼出绝对路径）。'
            : '用户已禁止该技能运行脚本，请勿执行其 scripts/ 目录下的脚本。'
        }
        hooks?.onResult?.('load_skill', { name }, { resources: skill.resourceFiles.length }, false)
        return result
      }
    }),

    read_skill_file: tool({
      description:
        'Read a text file bundled inside an installed skill (e.g. references/*.md, ' +
        'scripts/*.sh). Path is relative to the skill\'s bundle root.',
      parameters: z.object({
        skill: z.string().describe('Skill name (as listed in "Available Skills").'),
        path: z.string().describe('Bundle-relative file path, e.g. "references/examples.md".')
      }),
      execute: async ({ skill, path: p }) => {
        hooks?.onUse?.('read_skill_file', { skill, path: p })
        const found = findSkill(activeSkills, skill)
        if (!found) {
          const result = { error: `未找到技能 "${skill}"` }
          hooks?.onResult?.('read_skill_file', { skill, path: p }, result, true)
          return result
        }
        try {
          const content = readSkillResource(found.id, p)
          hooks?.onResult?.('read_skill_file', { skill, path: p }, { bytes: content.length }, false)
          return { content }
        } catch (e) {
          const result = { error: (e as Error).message }
          hooks?.onResult?.('read_skill_file', { skill, path: p }, result, true)
          return result
        }
      }
    })
  }

  if (includeBash) {
    tools.bash = tool({
      description:
        'Run a shell command — used to execute skill-bundled scripts. Runs ' +
        'through the OS shell, so python / .bat / .sh / node scripts all work ' +
        '(e.g. `python "<basePath>/scripts/x.py"`, `node "<basePath>/x.js"`, or ' +
        'a `.bat`/`.sh` by absolute path). Captures stdout+stderr, 120s timeout. ' +
        `Working directory: ${cwd}. Reference skill scripts by absolute path ` +
        '(use the basePath returned by load_skill).',
      parameters: z.object({
        command: z.string().describe('Shell command to run.')
      }),
      execute: async ({ command }) => {
        hooks?.onUse?.('bash', { command })
        try {
          const result = await runShell(command, cwd, abortSignal, 120_000)
          hooks?.onResult?.('bash', { command },
            { code: result.code, timedOut: result.timedOut }, result.code !== 0)
          return result
        } catch (e) {
          const result = { error: (e as Error).message }
          hooks?.onResult?.('bash', { command }, result, true)
          return result
        }
      }
    })
  }

  return tools
}
