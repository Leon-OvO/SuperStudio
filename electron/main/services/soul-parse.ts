import { parse as parseYaml } from 'yaml'
import type { EmployeeDept } from '../../../src/shared/ipc-types'

/**
 * Runtime soul.md → talent parser.
 *
 * Ported (intentionally, not imported) from the build-time packer
 * scripts/pack-talent.mjs so a USER-IMPORTED soul.md maps to the SAME shape as
 * the bundled catalog — without this core file depending on that build script
 * (which is overlay-only and not shipped to the deliverable core).
 *
 * Compatible with two flavours of soul file:
 *   1. Frontmatter style (`--- name/description/model/tools --- body`)
 *   2. Plain Markdown with NO frontmatter (e.g. an external agent's SOUL.md with
 *      `# Identity / # Style` sections) — the whole file becomes the persona.
 */

export interface ParsedSoul {
  name: string
  description: string
  dept: EmployeeDept | string
  tools: string[]
  recModel: string
  systemPrompt: string
}

const DEPT_LABEL: Record<string, string> = {
  engineering: '工程研发', design: '设计', product: '产品',
  marketing: '营销增长', qa: '测试质量', data: '数据/AI', game: '游戏',
}

const ACRONYMS = new Set(['api', 'ui', 'ux', 'ai', 'seo', 'ci', 'cd', 'sql', 'qa', 'llm', 'nlp', 'css', 'html', 'sdk', 'cli', 'gpu'])

// domain (index.yaml) → our 7 buckets. Kept for parity with the packer.
const DOMAIN_DEPT: Record<string, string> = {
  engineering: 'engineering', 'language-specialist': 'engineering', documentation: 'engineering',
  blockchain: 'engineering', devops: 'engineering', infrastructure: 'engineering', security: 'engineering',
  design: 'design',
  product: 'product', planning: 'product', business: 'product',
  marketing: 'marketing', growth: 'marketing', sales: 'marketing', content: 'marketing',
  'qa-testing': 'qa', qa: 'qa', testing: 'qa',
  'ai-ml': 'data', data: 'data', ml: 'data', 'data-ai': 'data', research: 'data',
  game: 'game', gamedev: 'game',
}

function deptFromDomains(domains: unknown): string | null {
  if (Array.isArray(domains)) {
    for (const d of domains) { const m = DOMAIN_DEPT[String(d).toLowerCase()]; if (m) return m }
  }
  return null
}

/** Keyword heuristic → one of the 7 departments (mirrors pack-talent.mjs). */
function deptHeuristic(text: string): EmployeeDept {
  const t = (text || '').toLowerCase()
  if (/game|gamedev|游戏|关卡|数值|玩法/.test(t)) return 'game'
  if (/design|designer|\bui\b|\bux\b|brand|visual|figma|视觉|设计|美术|品牌/.test(t)) return 'design'
  if (/\bqa\b|qa-|test|tester|quality|测试|质量|审计/.test(t)) return 'qa'
  if (/market|advertis|\bads?\b|\bseo\b|content|copywrit|growth|social|email|营销|文案|增长|运营|电商|抖音|推广|创意/.test(t)) return 'marketing'
  if (/data-|analyt|\bmlops\b|ml-|llm|ai-engineer|\bnlp\b|\betl\b|数据|分析|算法|模型|报告/.test(t)) return 'data'
  if (/product|\bpm\b|roadmap|scrum|agile|backlog|产品|需求|项目/.test(t)) return 'product'
  return 'engineering'
}

function tokenize(s: string): string[] {
  return String(s)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/).map(t => t.trim()).filter(Boolean)
}

/** Turn a file id like `frontend-developer` into a readable name. Keeps the
 *  original casing for non-ASCII (CJK) names. */
function prettifyId(id: string): string {
  const base = String(id).split('__').pop() || id
  if (/[^\x00-\x7F]/.test(base)) return base.trim()   // already CJK / non-ascii → keep
  const toks = tokenize(base.toLowerCase())
  if (!toks.length) return base
  return toks.map(t => (ACRONYMS.has(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))).join(' ')
}

/** Split YAML frontmatter (--- ... ---) from the body. No frontmatter → whole
 *  file is the body (mirrors pack-talent.mjs parseFrontmatter). */
function parseFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  if (!md.startsWith('---')) return { fm: {}, body: md.trim() }
  const end = md.indexOf('\n---', 3)
  if (end < 0) return { fm: {}, body: md.trim() }
  const raw = md.slice(3, end).trim()
  const body = md.slice(end + 4).trim()
  let fm: Record<string, unknown> = {}
  try { fm = (parseYaml(raw) as Record<string, unknown>) || {} } catch { fm = {} }
  return { fm, body }
}

function firstHeading(body: string): string {
  const m = body.match(/^#{1,3}\s+(.+?)\s*$/m)
  return m ? m[1].trim() : ''
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Parse one soul.md into the talent fields. `fileName` is used only for the
 *  fallback name when neither frontmatter nor a heading provides one. */
export function parseSoulMd(md: string, fileName: string): ParsedSoul {
  const { fm, body } = parseFrontmatter(md)
  const localId = fileName.replace(/\.[^.]+$/, '')

  const fmName = asString(fm.name).trim() || asString(fm.title).trim()
  const name = (fmName || firstHeading(body) || prettifyId(localId)).slice(0, 80)

  // tools: SuperStudio `tools` OR an external agent's `allowed-tools`.
  const rawTools = fm.tools ?? (fm as Record<string, unknown>)['allowed-tools'] ?? (fm as Record<string, unknown>).allowedTools
  const tools = typeof rawTools === 'string'
    ? rawTools.split(',').map(s => s.trim()).filter(Boolean)
    : Array.isArray(rawTools) ? rawTools.map(s => String(s).trim()).filter(Boolean) : []

  const recModel = asString(fm.model).toLowerCase()

  const dept = deptFromDomains(fm.domains)
    || deptHeuristic(`${localId} ${name} ${asString(fm.description)} ${body.slice(0, 300)}`)

  const fmDesc = asString(fm.description).trim()
  const description = (fmDesc || `${name} · 专注${DEPT_LABEL[dept] || '相关'}领域工作的 AI 员工。`).slice(0, 300)

  // Body is the persona. If a file is pure frontmatter (no body) fall back to the
  // whole text so we never produce an empty persona.
  const systemPrompt = body || md.trim()

  return { name, description, dept, tools, recModel, systemPrompt }
}
