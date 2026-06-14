/**
 * 员工群聊（多 Agent 互相沟通 + 自动协作）。
 *
 * 用户发一句话后，一个【协调者】先自动判断这是「讨论」还是「需要协作产出交付物」（报告/
 * 文档/方案…），并据此规划分工，然后让被指派的员工依次行动：
 *   - 讨论：成员轮流（或被 @点名者）发表观点，彼此能看到对方的发言。
 *   - 协作产出：协调者把任务拆成有序步骤分派给最合适的成员，全组共写同一个交付物文件
 *     （群聊会话自动获得一个共享工作目录），前面的人起草各部分、最后一人汇总审校定稿。
 * 无需用户手动开关——协调者自动选模式。
 *
 * 每位成员的回合【复用 runAgent】，因此和普通对话一样拥有完整工具/技能（联网/读写文件/
 * 生成图片/技能等）。runAgent 通过 groupTurn 切换人格、模式、任务、共享交付物与流式标注。
 *
 * @点名：用户消息里 @某员工 → 本轮只在被点到的成员里规划与发言。
 */
import { ipcMain, app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { generateText } from 'ai'
import { IPC } from '../../../src/shared/ipc-types'
import { getMainWindow } from '../index'
import { dbRun, dbGet, dbAll } from '../db/sqlite'
import { runAgent, stopAgent } from '../agent/engine'
import { createLLMClient, effectiveProtocol, thinkingStreamOpts } from '../services/llm'
import { getSettings, getProviders } from '../services/store'
import { getEmployee } from '../services/employees-db'
import { getSoul } from '../services/talent-pool'
import { parseJsonLoose, extractJson } from '../../../src/shared/json-repair'
import { randomUUID } from 'crypto'
import type { EmployeeInfo } from '../../../src/shared/ipc-types'

/** Per-session group-round control. `aborted` stops the loop between speakers;
 *  the in-flight speaker's own runAgent is aborted via stopAgent(sessionId). */
const activeGroupRuns = new Map<string, { aborted: boolean }>()

interface GroupStep { employeeId: string; task: string }
interface GroupPlan { kind: 'discuss' | 'collaborate'; deliverable?: string; steps: GroupStep[] }

/** A round suspended on an ask_user choice card. The next user message (their
 *  answer / card click) resumes it: the asking speaker (resumeIndex) re-runs with
 *  the answer now in the transcript, then the remaining steps continue. Kept the
 *  saved plan so resume does NOT re-plan. In-memory: a restart drops it (the user
 *  can just send a new message to start fresh). */
interface PausedRound { steps: GroupStep[]; resumeIndex: number; kind: 'discuss' | 'collaborate'; deliverable?: string }
const pausedRounds = new Map<string, PausedRound>()

/** True if the latest assistant message in this session ended on an ask_user
 *  call — i.e. the speaker is waiting for the user to pick an option. */
function lastTurnAskedUser(sessionId: string): boolean {
  const row = dbGet<{ tool_calls: string | null }>(
    `SELECT tool_calls FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    [sessionId]
  )
  if (!row?.tool_calls) return false
  try {
    const calls = JSON.parse(row.tool_calls) as Array<{ toolName?: string }>
    return Array.isArray(calls) && calls.some(c => c?.toolName === 'ask_user')
  } catch { return false }
}

/** Resolve a session's participating employees, in stored order, skipping any
 *  that were fired (so a removed employee doesn't break the round). */
function resolveMembers(sessionId: string): EmployeeInfo[] {
  const row = dbGet<{ group_employee_ids: string | null }>(
    `SELECT group_employee_ids FROM sessions WHERE id = ?`, [sessionId]
  )
  if (!row?.group_employee_ids) return []
  let ids: string[] = []
  try { ids = JSON.parse(row.group_employee_ids) } catch { return [] }
  return ids.map(id => getEmployee(id)).filter((e): e is EmployeeInfo => !!e)
}

/** Parse @员工 mentions out of the user's message. For each `@`, match the
 *  LONGEST member name that follows (so 张三丰 wins over 张三 at the same spot).
 *  Returns the mentioned members in first-appearance order, de-duplicated. */
function parseMentions(text: string, members: EmployeeInfo[]): EmployeeInfo[] {
  if (!text.includes('@')) return []
  const byLongest = [...members].sort((a, b) => b.name.length - a.name.length)
  const out: EmployeeInfo[] = []
  const seen = new Set<string>()
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue
    const after = text.slice(i + 1)
    const hit = byLongest.find(emp => emp.name && after.startsWith(emp.name))
    if (hit && !seen.has(hit.id)) { seen.add(hit.id); out.push(hit) }
  }
  return out
}

/** Recent labeled transcript (last ~16 turns) for the coordinator's context. */
function recentTranscript(sessionId: string, members: EmployeeInfo[]): string {
  const nameById = new Map(members.map(m => [m.id, m.name]))
  const rows = dbAll<{ role: string; content: string; speaker_employee_id: string | null }>(
    `SELECT role, content, speaker_employee_id FROM messages
     WHERE session_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 16`, [sessionId]
  )
  return rows.reverse().filter(r => (r.content || '').trim()).map(r => {
    if (r.role === 'user') return `用户：${(r.content || '').slice(0, 400)}`
    const who = r.speaker_employee_id ? (nameById.get(r.speaker_employee_id) || '某员工') : '助手'
    return `${who}：${(r.content || '').slice(0, 400)}`
  }).join('\n')
}

/** Fallback plan: everyone gives their take, in order (a plain discussion round). */
function discussFallback(candidates: EmployeeInfo[]): GroupPlan {
  return { kind: 'discuss', steps: candidates.map(c => ({ employeeId: c.id, task: '' })) }
}

/** Does the user seem to want a deliverable file (vs. just an opinion/chat)? Used
 *  to decide whether a single @-mention can skip the coordinator entirely. Broad
 *  on purpose — when unsure we keep planRound (err toward correct, not cheap). */
function wantsDeliverable(text: string): boolean {
  return /报告|文档|文件|方案|计划书|计划|分析|网页|网站|代码|程序|脚本|PPT|幻灯|表格|清单|周报|日报|月报|简历|文案|策划|大纲|提纲|总结成|整理成|汇总|写一份|写个|写一篇|做一份|做个|出一份|生成一份/.test(text)
}

/**
 * Coordinator: auto-decide discuss vs. collaborate and plan the speaking order /
 * task assignment. Uses the global default chat model (falls back to the first
 * member's model). Returns a validated plan; any failure → discussion fallback.
 */
async function planRound(sessionId: string, userText: string, candidates: EmployeeInfo[], explicit: boolean): Promise<GroupPlan> {
  const settings = getSettings()
  let providerId = settings.defaultChatProviderId, modelId = settings.defaultChatModel
  if (!providerId || !modelId) { providerId = candidates[0]?.providerId; modelId = candidates[0]?.modelId }
  if (!providerId || !modelId || candidates.length === 0) return discussFallback(candidates)

  // 快路径：只 @点名了一个成员且不像要交付物（"@小王 帮我看下"这类最常见）→ 协调器
  // 在选人/排序上零自由度，直接走单人讨论，省掉一次协调器 LLM 往返与 15s 超时窗口。
  // 带交付物意图（要报告/文档…）仍走协调器，以免丢掉 collaborate 的共享目录与定稿步骤。
  if (explicit && candidates.length === 1 && !wantsDeliverable(userText)) return discussFallback(candidates)

  const roster = candidates.map(m => {
    const desc = (getSoul(m.soulId)?.description || '').slice(0, 60)
    return `- ${m.name}（id=${m.id}，部门=${m.dept}）${desc ? '：' + desc : ''}`
  }).join('\n')
  const tail = recentTranscript(sessionId, candidates)

  // 选人规则：用户 @点名的成员是明确指定，必须都安排；否则只让相关的人发言、其余沉默。
  const selectionRule = explicit
    ? `- 【用户已点名以下全部成员】steps 必须覆盖他们每一个人（按合适的顺序与分工），不要遗漏，也不要额外加别人。\n`
    : `- 【只让相关的人发言，其余沉默 —— 最重要】只挑选与当前话题真正相关、能给出有价值贡献的成员；与话题无关或不擅长的成员【不要排进 steps】，让他们这轮保持沉默。哪怕最终只有 1 个人发言也完全可以，绝不要为了让每个人都出场而硬凑人头。\n`

  const system =
    `你是一个 AI 团队的协调者，负责把用户的需求安排给【最合适】的成员，并让不相关的人保持沉默。团队成员：\n${roster}\n\n` +
    (tail ? `最近对话：\n${tail}\n\n` : '') +
    `判断用户这条消息该走「讨论」还是「协作产出一份交付物」，并规划分工。只输出 JSON：\n` +
    `{"kind":"discuss"|"collaborate","deliverable":"<若产出，给个文件名如 报告.md>","steps":[{"employeeId":"<上面的id>","task":"<这名成员这步具体做什么>"}]}\n\n` +
    `规则：\n` +
    selectionRule +
    `- 用户想要一份可交付的东西（报告/文档/方案/计划书/分析/网页/代码文件等）→ kind="collaborate"：拆成有序步骤，每步指派最擅长该部分的成员，前面的人起草各自部分，【最后一步指派一人汇总审校定稿】；deliverable 给一个合理文件名。\n` +
    `- 只是想听意见/头脑风暴/答疑/闲聊 → kind="discuss"：steps 只列与话题相关的成员依次发言（task 可空或一句话提示）。\n` +
    `- steps 的 employeeId 必须来自上面列出的 id，只用这些成员；不要空数组（至少 1 人）。\n` +
    `只输出 JSON，不要解释。`

  // 选人是个轻量结构化任务，别让带思考的默认大模型空耗——对 anthropic 协议模型关掉
  // 扩展思考（planRound 走 generateText，拿不到 engine 里 relayCompat 的关思考兜底）。
  const provider = getProviders().find(p => p.id === providerId)
  const thinkOpts = thinkingStreamOpts(provider ? effectiveProtocol(provider, modelId) : undefined, 'fast', modelId)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const { text } = await generateText({
      model: createLLMClient(providerId, modelId),
      system,
      prompt: userText.slice(0, 1500),
      temperature: 0,
      ...thinkOpts,        // anthropic thinking:disabled（+ 可能的 maxTokens 上限）
      maxTokens: 700,      // 选人 JSON 很短 —— 放在 thinkOpts 之后，确保 700 生效
      abortSignal: controller.signal
    })
    // 模型常把 JSON 包在 ```json 围栏或前后加客套话；先抠出 JSON 再解析，
    // 否则解析失败会落回 discussFallback（全员开跑）——把"省钱选人"反转成最贵路径。
    const plan = parseJsonLoose<GroupPlan>(extractJson(text))
    const steps = (Array.isArray(plan?.steps) ? plan.steps : [])
      .filter(s => s && typeof s.employeeId === 'string' && candidates.some(c => c.id === s.employeeId))
      .map(s => ({ employeeId: s.employeeId, task: String(s.task || '') }))
    if (!steps.length) return discussFallback(candidates)
    const kind: GroupPlan['kind'] = plan?.kind === 'collaborate' ? 'collaborate' : 'discuss'
    const deliverable = kind === 'collaborate'
      ? (typeof plan?.deliverable === 'string' && plan.deliverable.trim() ? plan.deliverable.trim() : '协作产出.md')
      : undefined
    return { kind, deliverable, steps }
  } catch {
    return discussFallback(candidates)
  } finally {
    clearTimeout(timer)
  }
}

/** Ensure the group session has a shared working directory (so every member's
 *  file writes converge on one place + a single deliverable). Created lazily on
 *  the first collaborate round, persisted on the session, picked up by the engine. */
function ensureGroupWorkspace(sessionId: string): string {
  const row = dbGet<{ working_dir: string | null }>(`SELECT working_dir FROM sessions WHERE id = ?`, [sessionId])
  const existing = (row?.working_dir || '').trim()
  if (existing) { try { fs.mkdirSync(existing, { recursive: true }) } catch { /* ignore */ } ; return existing }
  const base = (() => { try { return app.getPath('documents') } catch { return app.getPath('userData') } })()
  const dir = path.join(base, '群聊协作产出', sessionId.slice(0, 8))
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  dbRun(`UPDATE sessions SET working_dir = ? WHERE id = ?`, [dir, sessionId])
  return dir
}

/** Run the plan's steps from `fromIndex`, each as a full agent turn. If a speaker
 *  ends its turn by asking the user (ask_user), suspend the round here: save the
 *  remaining plan and stop. The user's next message resumes from this same step. */
async function runSteps(
  sessionId: string,
  win: BrowserWindow,
  ctl: { aborted: boolean },
  steps: GroupStep[],
  kind: 'discuss' | 'collaborate',
  deliverable: string | undefined,
  fromIndex: number
): Promise<number> {
  const members = resolveMembers(sessionId)
  const memberNames = members.map(m => m.name)
  // Resolve the live speakers up-front (drop members fired since planning). Doing
  // this before the loop keeps `more` accurate: the LAST live speaker gets
  // more=false so the renderer stops — skipping a fired member mid-loop would
  // otherwise strand `more` on true and leave the spinner spinning forever.
  const live: Array<{ origIndex: number; emp: EmployeeInfo; task: string }> = []
  for (let i = fromIndex; i < steps.length; i++) {
    const emp = members.find(m => m.id === steps[i].employeeId)
    if (emp) live.push({ origIndex: i, emp, task: steps[i].task })
  }

  let ran = 0
  for (let j = 0; j < live.length; j++) {
    if (ctl.aborted) return ran
    const { origIndex, emp, task } = live[j]
    const soulPrompt = getSoul(emp.soulId)?.systemPrompt ?? ''
    try {
      await runAgent({
        sessionId,
        message: '',
        groupTurn: {
          speakerEmployeeId: emp.id,
          speakerName: emp.name,
          soulPrompt,
          providerId: emp.providerId,
          modelId: emp.modelId,
          memberNames,
          more: j < live.length - 1,
          mode: kind,
          task,
          deliverable
        }
      }, win)
      ran++
    } catch (e) {
      console.error(`[group] ${emp.name} turn crashed:`, (e as Error).message)
      continue
    }
    if (ctl.aborted) return ran
    // Speaker asked the user a choice → pause the whole round until they answer.
    // Resume re-runs from THIS step (the asker, via its original index) so it acts
    // on the answer.
    if (lastTurnAskedUser(sessionId)) {
      pausedRounds.set(sessionId, { steps, resumeIndex: origIndex, kind, deliverable })
      return ran
    }
  }
  return ran
}

/** Emit a terminal signal when a round ran zero turns (e.g. everyone assigned was
 *  fired) so the renderer's running spinner clears instead of spinning forever. */
function unstickIfEmpty(win: BrowserWindow, sessionId: string, ran: number, ctl: { aborted: boolean }): void {
  if (ran === 0 && !ctl.aborted && !pausedRounds.has(sessionId)) {
    win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: '本轮没有成员发言（相关成员可能已离职）。' })
  }
}

export function groupChatHandlers(): void {
  // Run ONE round. With a new user message the coordinator plans; without one
  // (继续讨论) it re-plans from the transcript. If a round is paused waiting on an
  // ask_user choice, the next message is treated as the answer and RESUMES it.
  ipcMain.handle(IPC.GROUP_RUN, async (_e, args: { sessionId: string; message?: string }) => {
    const win = getMainWindow()
    if (!win) return { error: 'No window' }
    const { sessionId } = args
    const members = resolveMembers(sessionId)
    if (members.length === 0) {
      win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: '该群聊没有可用的员工（可能都已离职）。' })
      return { started: false }
    }
    const text = (args.message || '').trim()

    // ── RESUME: a round is suspended on an ask_user card → this message is the
    // user's answer. Persist it, then continue the saved plan from the asker. ──
    const paused = pausedRounds.get(sessionId)
    if (paused) {
      pausedRounds.delete(sessionId)
      if (text) {
        dbRun(
          `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
          [randomUUID(), sessionId, args.message, Date.now()]
        )
      }
      const prior = activeGroupRuns.get(sessionId)
      if (prior) { prior.aborted = true; stopAgent(sessionId) }
      const ctl = { aborted: false }
      activeGroupRuns.set(sessionId, ctl)
      ;(async () => {
        try {
          const ran = await runSteps(sessionId, win, ctl, paused.steps, paused.kind, paused.deliverable, paused.resumeIndex)
          unstickIfEmpty(win, sessionId, ran, ctl)
        } catch (e) {
          win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: (e as Error).message })
        } finally {
          if (activeGroupRuns.get(sessionId) === ctl) activeGroupRuns.delete(sessionId)
        }
      })()
      return { started: true, resumed: true }
    }

    // ── NEW round ──────────────────────────────────────────────────────────
    // @点名 → 只在被点到的成员里规划/发言；否则全员。
    const mentioned = text ? parseMentions(text, members) : []
    const candidates = mentioned.length ? mentioned : members

    // Persist the user's opening message (if any) so it's part of the transcript.
    if (text) {
      dbRun(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
        [randomUUID(), sessionId, args.message, Date.now()]
      )
    }

    const prior = activeGroupRuns.get(sessionId)
    if (prior) { prior.aborted = true; stopAgent(sessionId) }
    const ctl = { aborted: false }
    activeGroupRuns.set(sessionId, ctl)

    ;(async () => {
      try {
        // Coordinator decides discuss vs. collaborate + WHO speaks (irrelevant
        // members stay silent). @-mentioned members are an explicit pick → all speak.
        const plan = await planRound(sessionId, text || '（请继续推进上面的任务或讨论：未完成的接着做，已完成则审校完善）', candidates, mentioned.length > 0)
        if (ctl.aborted) return
        const deliverable = plan.kind === 'collaborate' ? plan.deliverable : undefined
        if (plan.kind === 'collaborate') ensureGroupWorkspace(sessionId)
        const ran = await runSteps(sessionId, win, ctl, plan.steps, plan.kind, deliverable, 0)
        unstickIfEmpty(win, sessionId, ran, ctl)
      } catch (e) {
        win.webContents.send(IPC.AGENT_ERROR, { sessionId, error: (e as Error).message })
      } finally {
        if (activeGroupRuns.get(sessionId) === ctl) activeGroupRuns.delete(sessionId)
      }
    })()

    return { started: true }
  })

  ipcMain.handle(IPC.GROUP_STOP, (_e, sessionId: string) => {
    const ctl = activeGroupRuns.get(sessionId)
    if (ctl) ctl.aborted = true
    pausedRounds.delete(sessionId)  // abandon any pending pause
    stopAgent(sessionId)  // abort the speaker whose turn is in flight
    activeGroupRuns.delete(sessionId)
    return { ok: true }
  })
}
