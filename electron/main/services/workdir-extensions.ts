import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { parseSkillMd, listBundleFiles } from './skill-files'
import type { InstalledSkill, SkillScenario } from './skills-db'
import type { McpServerConfig } from '../../../src/shared/ipc-types'

// ============================================================================
// 工作目录扩展（随对话临时生效）
//
// When a conversation pins a working directory (or a 工作台 project is open),
// any skills under `<dir>/.claude/skills/<bundle>/SKILL.md` and MCP servers in
// `<dir>/.mcp.json` are loaded FOR THIS RUN ONLY:
//   - never written to the skills DB or the global MCP store
//   - never copied to userData — read in place from the working directory
//   - gone the moment the working directory changes
//
// This keeps a project's own tools self-contained without polluting the user's
// global「技能中心」/「设置-MCP」.
//
// ---------------------------------------------------------------------------
// 信任模型（改这个文件前先读完）
//
// 工作目录里的一切内容一律视为「第三方不可信输入」：用户很可能只是把别人给的
// 一个仓库设成了工作目录，仓库里的 .mcp.json / .claude/skills 是仓库作者写的，
// 不是用户写的。因此本模块的唯一职责是**降权**，绝不提权：
//   1. 只降权不提权 —— 工作目录来源的能力上限必须 <= 用户在设置里手工配置的同类
//      能力。任何「工作目录的东西比用户手配的东西权限更大」的写法都是 bug。
//   2. 敏感环境变量默认剔除 —— 工作目录声明的 MCP env 里凡是名字像密钥/口令的
//      一律不透传（用户在「设置-MCP」手配的 server 不受此限，很多 server 就靠
//      env 里的 key 工作，那是用户自己的选择）。
//   3. fail closed —— 解析/读取出任何岔子一律返回空数组，绝不做「部分加载」：
//      半个配置被加载比完全不加载更危险，也更难排查。
//   4. 只沿用文件本身，不跟随符号链接 —— 目录项与清单文件都要用 lstat 判定。
// ============================================================================

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__'])
const MAX_SKILL_BUNDLES = 50

/**
 * 名字命中即视为敏感的环境变量（工作目录来源专用）。
 * 覆盖 *KEY* / *SECRET* / *TOKEN* / 口令 / 凭据 / 授权头一类。
 */
const SENSITIVE_ENV_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i

/**
 * 过滤工作目录声明的 MCP 环境变量：名字像密钥的一律剔除。
 * 只用于工作目录来源；用户在设置页手工配置的 server 保持全量继承。
 */
export function sanitizeWorkdirEnv(
  env: Record<string, string> | undefined
): { env: Record<string, string> | undefined; dropped: string[] } {
  if (!env || typeof env !== 'object') return { env: undefined, dropped: [] }
  const kept: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE_ENV_RE.test(k)) { dropped.push(k); continue }
    kept[k] = v
  }
  return { env: Object.keys(kept).length ? kept : undefined, dropped }
}

/** 清单文件本身也可能是符号链接 —— 用 lstat 判定，只认真实文件。 */
function findManifest(dir: string): string | null {
  for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(dir, cand)
    try { if (fs.lstatSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

/** Stable short hash of the working directory — keeps ephemeral ids unique
 *  across concurrent sessions that pin different dirs but reuse a skill/server
 *  name (otherwise the mcp manager's per-id connection cache would collide). */
function dirHash(dir: string): string {
  return createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8)
}

/**
 * Scan `<dir>/.claude/skills` for Claude-Code-format skill bundles and turn each
 * into an EPHEMERAL InstalledSkill (runtime, enabled, installPath = the original
 * bundle dir). Never touches the DB. Returns [] when the dir has no skills.
 */
export function scanWorkdirSkills(dir: string, scenario: SkillScenario = 'chat'): InstalledSkill[] {
  if (!dir || !dir.trim()) return []
  const root = path.join(dir, '.claude', 'skills')
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) }
  catch { return [] } // no .claude/skills → nothing
  const h = dirHash(dir)
  const out: InstalledSkill[] = []
  for (const e of entries) {
    if (out.length >= MAX_SKILL_BUNDLES) break
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    if (SKIP_DIRS.has(e.name)) continue
    const bundleDir = path.join(root, e.name)
    const manifest = findManifest(bundleDir)
    if (!manifest) continue
    let content = ''
    // fail closed：清单存在却读不出来（权限/占用/损坏），整批放弃，不做部分加载。
    try { content = fs.readFileSync(manifest, 'utf8') } catch (e) {
      console.warn(`[workdir-skills] ${manifest} 读取失败，本次不加载工作目录技能：`, (e as Error).message)
      return []
    }
    const { name, description, body } = parseSkillMd(content)
    const displayName = (name || e.name).trim() || e.name
    out.push({
      id: `workdir:${h}:${displayName.toLowerCase()}`,
      name: displayName,
      description: (description || '').trim(),
      icon: '🧩',
      version: '0.0.0',
      author: '',
      systemPrompt: '',
      toolWhitelist: null,
      starterPrompts: [],
      homepage: undefined,
      suggestedScenarios: [scenario],
      enabled: true,
      enabledScenarios: [scenario],
      sourceUrl: 'workdir',
      installedAt: Date.now(),
      builtin: false,
      runtime: true,
      slug: null,
      installPath: bundleDir,
      skillBody: body,
      resourceFiles: listBundleFiles(bundleDir),
      // 工作目录技能来自第三方仓库，权限不得高于用户手动安装的技能：默认不许跑脚本。
      allowScripts: false,
      // Ephemeral workdir skills aren't tracked in the DB — neutral lifecycle defaults.
      status: 'active',
      origin: 'manual',
      sourceMemoryId: null,
      inducedVersion: 1,
      bodyHash: null,
      triggerReason: null,
      inducedFrom: null,
      timesLoaded: 0,
      timesSucceeded: 0,
      timesFailed: 0,
      lastUsedAt: null,
      confidence: null
    })
  }
  return out
}

/** Raw shape of a Claude-Code `.mcp.json` entry. */
interface RawMcpEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  transport?: 'stdio' | 'sse'
  disabled?: boolean
  enabled?: boolean
}

/** 'skip' = 配置里显式禁用（正常情况，跳过即可）；'invalid' = 配置写坏了（触发 fail closed）。 */
function toServerConfig(name: string, raw: RawMcpEntry, h: string): McpServerConfig | 'skip' | 'invalid' {
  if (raw.disabled === true || raw.enabled === false) return 'skip'
  const transport: 'stdio' | 'sse' = raw.transport
    ? raw.transport
    : raw.url ? 'sse' : 'stdio'
  if (transport === 'stdio' && !raw.command) return 'invalid'
  if (transport === 'sse' && !raw.url) return 'invalid'
  // 工作目录来源：剔除敏感环境变量（见文件头信任模型第 2 条）。
  const { env, dropped } = sanitizeWorkdirEnv(raw.env)
  if (dropped.length) {
    console.warn(`[workdir-mcp] "${name}" 的环境变量 ${dropped.join('、')} 名称疑似密钥，已按工作目录降权策略剔除`)
  }
  return {
    id: `workdir:${h}:${name}`,
    name,
    enabled: true,
    transport,
    command: raw.command,
    args: raw.args,
    env,
    url: raw.url,
    headers: raw.headers
  }
}

/**
 * Read `<dir>/.mcp.json` (or `<dir>/.claude/mcp.json`) and parse it into ephemeral
 * McpServerConfig[]. Accepts the Claude-Code `{ "mcpServers": { name: {...} } }`
 * shape and a bare array of configs. Never throws — returns [] on any problem.
 */
export function readWorkdirMcpConfigs(dir: string): McpServerConfig[] {
  if (!dir || !dir.trim()) return []
  const h = dirHash(dir)
  const candidates = [path.join(dir, '.mcp.json'), path.join(dir, '.claude', 'mcp.json')]
  for (const file of candidates) {
    let content = ''
    try { content = fs.readFileSync(file, 'utf8') } catch { continue }
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch (e) {
      console.warn(`[workdir-mcp] ${file} 解析失败：`, (e as Error).message)
      return []
    }
    const out: McpServerConfig[] = []
    // fail closed：只要有一条 server 写坏了，整份配置都不加载 —— 部分加载会让用户
    // 以为工具齐了，实际少一半，排查成本更高。
    const servers = (parsed as { mcpServers?: Record<string, RawMcpEntry> })?.mcpServers
    if (servers && typeof servers === 'object') {
      for (const [name, raw] of Object.entries(servers)) {
        const cfg = toServerConfig(name, raw || {}, h)
        if (cfg === 'invalid') {
          console.warn(`[workdir-mcp] ${file} 中 "${name}" 配置不完整，本次不加载工作目录 MCP`)
          return []
        }
        if (cfg !== 'skip') out.push(cfg)
      }
    } else if (Array.isArray(parsed)) {
      for (const raw of parsed as Array<RawMcpEntry & { name?: string; id?: string }>) {
        const name = raw?.name || raw?.id
        if (!name) {
          console.warn(`[workdir-mcp] ${file} 中存在无名 server 配置，本次不加载工作目录 MCP`)
          return []
        }
        const cfg = toServerConfig(name, raw, h)
        if (cfg === 'invalid') {
          console.warn(`[workdir-mcp] ${file} 中 "${name}" 配置不完整，本次不加载工作目录 MCP`)
          return []
        }
        if (cfg !== 'skip') out.push(cfg)
      }
    }
    return out
  }
  return []
}
