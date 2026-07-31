import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { IPC } from '../../../src/shared/ipc-types'
import { getSettings } from './store'
import { generateImage } from './image'
import { saveGalleryItem } from './gallery'
import { getActiveSkillsForScenario } from './skills-db'
import type { InstalledSkill } from './skills-db'
import { recordSkillSignals } from './skill-evolution'
import { readSkillResource, readSkillResourceAt } from './skill-files'
import type { BridgeRunContext } from './mcp-bridge'

/**
 * MCP 桥的工具集 —— 外部 code CLI（OpenCode / Claude Code）经此调用 SuperStudio 独有能力。
 *
 * 首刀两组：**生图** 与 **技能**。刻意不暴露 bash / 文件读写 —— CLI 自带这些，重复暴露
 * 只会让模型犯选择困难，且多一份权限面。技能脚本仍由 CLI 自己的 bash 跑（load_skill 会
 * 回 basePath）。
 *
 * 与自研引擎的对应关系（保持语义一致，避免两套行为漂移）：
 *   image_generate  ← agent/engine.ts 的同名工具
 *   load_skill / read_skill_file ← agent/skill-tools.ts
 */

type ToolShape = Record<string, z.ZodTypeAny>
interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * registerTool 的薄封装。
 *
 * 为什么要包一层：SDK 的 `registerTool` 泛型（zod v3/v4 兼容层 + outputSchema 推断）在本仓
 * 的 zod 3.25 下会把 tsc 顶出 TS2589「类型实例化过深」。schema 仍然用 zod 写（它决定 CLI
 * 看到的 JSON Schema），只在这一处断言一次，不把 any 撒到每个工具里。
 *
 * 入参在 SDK 侧已按 schema 校验过才会调到 handler，所以 handler 内的取值是安全的。
 */
function addTool(
  mcp: McpServer,
  name: string,
  description: string,
  inputSchema: ToolShape,
  handler: (args: Record<string, unknown>) => Promise<ToolTextResult>
): void {
  const target = mcp as unknown as {
    registerTool(
      n: string,
      c: { description: string; inputSchema: ToolShape },
      cb: (args: Record<string, unknown>) => Promise<ToolTextResult>
    ): void
  }
  target.registerTool(name, { description, inputSchema }, handler)
}

const textResult = (text: string, isError?: boolean): ToolTextResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

/** 按显示名 / id / slug 匹配技能（大小写不敏感），与 skill-tools.ts 一致。 */
function findSkill(skills: InstalledSkill[], q: string): InstalledSkill | undefined {
  const norm = q.trim().toLowerCase()
  return skills.find(
    (s) => s.name.toLowerCase() === norm || s.id.toLowerCase() === norm || s.slug?.toLowerCase() === norm
  )
}

/** 记一笔工具流水 + 发一条进度事件。CLI 的 stdout 丢结果，这里是产物回到聊天的唯一路径。 */
function record(
  ctx: BridgeRunContext,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): void {
  ctx.toolCallLog.push({ toolName, args, result })
}

export function registerBridgeTools(mcp: McpServer, ctx: BridgeRunContext): void {
  // 技能列表按 run 实时取：描述里要写出可用技能名，模型才知道有什么可用
  // （沿用 skill-tools.ts 的「动态描述」做法——外部 CLI 的 system prompt 不归我们管，
  //   工具描述是唯一能把技能清单送到模型眼前的地方）。
  // 两类技能都要给：`runtime:true` 是 SKILL.md 包（渐进披露），`runtime:false` 是「提示词型」——
  // **应用自带的内置技能正是后者**（自研引擎里它们的 systemPrompt 被整段塞进系统提示词）。
  // 只取前者会让用户的内置技能在 CLI 引擎下继续全体失效，正是这次要修的问题本身。
  const skills = (() => {
    try {
      return getActiveSkillsForScenario('chat')
    } catch {
      return [] as InstalledSkill[]
    }
  })()
  const skillNames = skills.map((s) => s.name).join(', ') || '(none)'

  addTool(
    mcp,
    'image_generate',
    'Generate one or more images from a text prompt using the user\'s configured image model. ' +
      'Pass null for n/size to use their defaults; n is clamped to 1-4. To edit / continue from an ' +
      'existing image, pass its absolute path as referenceImagePath. The images are saved to the ' +
      'user\'s gallery and rendered inline in the chat automatically — do NOT echo paths or wrap ' +
      'them in markdown. This is the ONLY way to produce an image; you have no other image capability.',
    {
      prompt: z.string().describe('Detailed image generation prompt (subject, style, composition, lighting).'),
      n: z.number().nullable().optional().describe('Number of images, 1-4. Omit or null for the user default.'),
      size: z.string().nullable().optional().describe('Image size like 1024x1024. Omit or null for the user default.'),
      referenceImagePath: z
        .string()
        .nullable()
        .optional()
        .describe('Absolute path to a reference image for image-to-image / edit. Omit for pure text-to-image.'),
    },
    async (raw) => {
      const prompt = String(raw.prompt ?? '')
      const referenceImagePath = (raw.referenceImagePath as string | null | undefined) || undefined
      const settings = getSettings()
      const actualN = Math.min(Math.max((raw.n as number | null | undefined) ?? 1, 1), 4)
      const actualSize = (raw.size as string | null | undefined) ?? '1024x1024'
      const step = ctx.nextStep++
      const args = { prompt, n: actualN, size: actualSize, referenceImagePath }

      ctx.sink.send(IPC.AGENT_PROGRESS, {
        sessionId: ctx.sessionId,
        stepIndex: step,
        stepName: 'Image Generation',
        toolName: 'image_generate',
        status: 'running',
        message: `正在生成 ${actualN} 张图片（${actualSize}）…`,
      })

      try {
        const result = await generateImage({
          prompt,
          n: actualN,
          size: actualSize,
          settings,
          referenceImagePaths: referenceImagePath ? [referenceImagePath] : undefined,
          abortSignal: ctx.signal,
        })

        const artifacts: Array<{ type: 'image'; path: string; mimeType: string; galleryId?: number }> = []
        for (const img of result.images) {
          let galleryId: number | undefined
          try {
            // saveGalleryItem 内部会 registerApproved(path)，local-file:// 才肯渲染。
            galleryId = await saveGalleryItem({
              type: 'image',
              filePath: img.path,
              prompt,
              source: 'chat',
              sessionId: ctx.sessionId,
              modelName: settings.defaultImageModel,
            })
          } catch (e) {
            console.warn('[mcp-bridge] gallery save failed:', (e as Error).message)
          }
          artifacts.push({ type: 'image', path: img.path, mimeType: 'image/png', galleryId })
          ctx.sink.send(IPC.AGENT_PROGRESS, {
            sessionId: ctx.sessionId,
            stepIndex: step,
            stepName: 'Image Generation',
            toolName: 'image_generate',
            status: 'done',
            artifact: { type: 'image', path: img.path },
          })
        }

        // 刻意不回传路径：UI 已自动渲染缩略图，模型再回显一遍用户就看到重复
        // （与 services/mcp.ts 的 formatSavedHint 同一理由）。
        const text = `[已生成 ${artifacts.length} 张图片，已存入素材库并在聊天中显示。请勿再输出图片路径或 markdown 图片语法。]`
        record(ctx, 'image_generate', args, { text, artifacts })
        return textResult(text)
      } catch (e) {
        const msg = (e as Error).message || String(e)
        ctx.sink.send(IPC.AGENT_PROGRESS, {
          sessionId: ctx.sessionId,
          stepIndex: step,
          stepName: 'Image Generation',
          toolName: 'image_generate',
          status: 'error',
          message: msg,
        })
        record(ctx, 'image_generate', args, { error: msg })
        // 如实报错但不抛出：一次出图失败不该炸掉 CLI 的整轮工具循环。
        return textResult(`[image_generate error] ${msg}`, true)
      }
    }
  )

  addTool(
    mcp,
    'load_skill',
    'Load the full instructions of one of the user\'s installed skills. Skills are self-contained ' +
      'bundles of instructions + resources the user has enabled in SuperStudio. When a request matches ' +
      'one of them, call this FIRST and then follow the returned instructions. Use read_skill_file for ' +
      'bundled reference files, and your own shell tool to run bundled scripts under the returned ' +
      `basePath (when scriptsAllowed). Available skills: ${skillNames}.`,
    {
      name: z.string().describe('Skill name exactly as listed in this tool\'s description.'),
    },
    async (raw) => {
      const name = String(raw.name ?? '')
      const skill = findSkill(skills, name)
      if (!skill) {
        const err = `未找到名为 "${name}" 的技能。可用技能：${skillNames}`
        record(ctx, 'load_skill', { name }, { error: err })
        return textResult(err, true)
      }
      // 提示词型技能（内置技能多属此类）没有 SKILL.md，正文就是它的 systemPrompt。
      const instructions =
        (skill.runtime ? skill.skillBody : skill.systemPrompt) ||
        skill.skillBody ||
        skill.systemPrompt ||
        '(此技能没有正文)'
      const payload = {
        name: skill.name,
        instructions,
        basePath: skill.installPath,
        resources: skill.resourceFiles,
        scriptsAllowed: skill.allowScripts,
        note: !skill.runtime
          ? '这是提示词型技能：上面就是全部内容，按它执行即可（没有可读的资源文件/脚本）。'
          : skill.allowScripts
            ? '可用 read_skill_file 读取上面的资源文件；可用你自带的 shell 工具运行 scripts/ 下的脚本（用 basePath 拼绝对路径）。'
            : '用户已禁止该技能运行脚本，请勿执行其 scripts/ 目录下的脚本。',
      }
      record(ctx, 'load_skill', { name }, payload)
      // 让自动学习的置信度继续演化（与自研引擎 engine.ts 结束时记信号同一套账）。
      try {
        if (skill.sourceUrl !== 'workdir') {
          recordSkillSignals({
            consultedSkillIds: [skill.id],
            success: true,
            artifacts: 0,
            sessionId: ctx.sessionId,
          })
        }
      } catch {
        /* 信号是锦上添花，失败不影响本次调用 */
      }
      return textResult(JSON.stringify(payload))
    }
  )

  addTool(
    mcp,
    'read_skill_file',
    'Read a text file bundled inside an installed skill (e.g. references/*.md, scripts/*.sh). ' +
      'Path is relative to the skill bundle root returned by load_skill.',
    {
      skill: z.string().describe('Skill name.'),
      path: z.string().describe('Bundle-relative file path, e.g. "references/examples.md".'),
    },
    async (raw) => {
      const skill = String(raw.skill ?? '')
      const p = String(raw.path ?? '')
      const found = findSkill(skills, skill)
      if (!found) {
        const err = `未找到技能 "${skill}"`
        record(ctx, 'read_skill_file', { skill, path: p }, { error: err })
        return textResult(err, true)
      }
      // 提示词型技能磁盘上没有包，直接说清楚，别丢一个含糊的文件系统错误。
      if (!found.runtime) {
        const err = `技能 "${found.name}" 是提示词型技能，没有资源文件；load_skill 返回的正文就是全部内容。`
        record(ctx, 'read_skill_file', { skill, path: p }, { error: err })
        return textResult(err, true)
      }
      try {
        // 工作目录技能住在原地（installPath），不在 userData/skills 下。
        const content = found.installPath
          ? readSkillResourceAt(found.installPath, p)
          : readSkillResource(found.id, p)
        record(ctx, 'read_skill_file', { skill, path: p }, { bytes: content.length })
        return textResult(content)
      } catch (e) {
        const err = (e as Error).message
        record(ctx, 'read_skill_file', { skill, path: p }, { error: err })
        return textResult(err, true)
      }
    }
  )
}
