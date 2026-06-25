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
// `<dir>/.mcp.json` (Claude-Code convention) are loaded FOR THIS RUN ONLY:
//   - never written to the skills DB or the global MCP store
//   - never copied to userData — read in place from the working directory
//   - gone the moment the working directory changes
//
// This keeps a project's own tools self-contained without polluting the user's
// global「技能中心」/「设置-MCP」.
// ============================================================================

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__'])
const MAX_SKILL_BUNDLES = 50

function findManifest(dir: string): string | null {
  for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(dir, cand)
    try { if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
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
    try { content = fs.readFileSync(manifest, 'utf8') } catch { continue }
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
      allowScripts: true,
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

function toServerConfig(name: string, raw: RawMcpEntry, h: string): McpServerConfig | null {
  if (raw.disabled === true || raw.enabled === false) return null
  const transport: 'stdio' | 'sse' = raw.transport
    ? raw.transport
    : raw.url ? 'sse' : 'stdio'
  if (transport === 'stdio' && !raw.command) return null
  if (transport === 'sse' && !raw.url) return null
  return {
    id: `workdir:${h}:${name}`,
    name,
    enabled: true,
    transport,
    command: raw.command,
    args: raw.args,
    env: raw.env,
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
    const servers = (parsed as { mcpServers?: Record<string, RawMcpEntry> })?.mcpServers
    if (servers && typeof servers === 'object') {
      for (const [name, raw] of Object.entries(servers)) {
        const cfg = toServerConfig(name, raw || {}, h)
        if (cfg) out.push(cfg)
      }
    } else if (Array.isArray(parsed)) {
      for (const raw of parsed as Array<RawMcpEntry & { name?: string; id?: string }>) {
        const name = raw.name || raw.id
        if (!name) continue
        const cfg = toServerConfig(name, raw, h)
        if (cfg) out.push(cfg)
      }
    }
    return out
  }
  return []
}
