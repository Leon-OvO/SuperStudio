#!/usr/bin/env node
/**
 * Build-time talent-pool packer.
 *
 * Walks `sources/<pack>/souls/**.md` (840-ish agent personas), maps each into a
 * catalog entry, and writes an AES-256-GCM encrypted bundle to
 * `resources/talent-pool.enc` that ships with the app.
 *
 * SECURITY NOTE: the key is embedded in the shipped app (see talent-crypto.ts),
 * so this is OBFUSCATION (stops casual copying of the .md from the install dir),
 * NOT real protection. Confirmed acceptable with the product owner.
 *
 * Runs as a prebuild step (package.json `build`). Skips silently if `sources/`
 * is absent so a build without the pack still succeeds (app shows empty market).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SOURCES = path.join(ROOT, 'sources')
const OUT = path.join(ROOT, 'resources', 'talent-pool.enc')

// 32-byte key shared with electron/main/services/talent-crypto.ts. Obfuscation only.
const KEY = Buffer.from('5f3a9c1e8d7b6a4f2031e5c7a9b8d6f40c2e1a3b5d7f9081726354adef012345', 'hex')

// ── dept mapping (index.yaml domains → our 7 buckets) ───────────────────────
const DOMAIN_DEPT = {
  'engineering':'engineering','language-specialist':'engineering','documentation':'engineering',
  'blockchain':'engineering','devops':'engineering','infrastructure':'engineering','security':'engineering',
  'design':'design',
  'product':'product','planning':'product','business':'product',
  'marketing':'marketing','growth':'marketing','sales':'marketing','content':'marketing',
  'qa-testing':'qa','qa':'qa','testing':'qa',
  'ai-ml':'data','data':'data','ml':'data','data-ai':'data','research':'data',
  'game':'game','gamedev':'game'
}
function deptFromDomains(domains) {
  if (Array.isArray(domains)) for (const d of domains) { const m = DOMAIN_DEPT[String(d).toLowerCase()]; if (m) return m }
  return null
}
function deptHeuristic(source, text) {
  const t = (text || '').toLowerCase()
  // Order matters: most specific first. `text` includes the id (rich keywords
  // like "api-designer", "data-engineer", "game-economy-designer").
  if (source === 'gamedev' || /game|gamedev|游戏/.test(t)) return 'game'
  if (/design|designer|\bui\b|\bux\b|brand|visual|figma|视觉|设计/.test(t)) return 'design'
  if (/\bqa\b|qa-|test|tester|quality|测试|质量/.test(t)) return 'qa'
  if (/market|advertis|\bads?\b|\bseo\b|content|copywrit|growth|social|email|营销|文案|增长|运营/.test(t)) return 'marketing'
  if (/data-|analyt|\bmlops\b|ml-|llm|ai-engineer|\bnlp\b|\betl\b|数据|分析/.test(t)) return 'data'
  if (/product|\bpm\b|roadmap|scrum|agile|backlog|产品|需求/.test(t)) return 'product'
  return 'engineering' // backend/frontend/api/devops/security/architect/… default
}

// ── frontmatter parser (--- ... --- + body) ─────────────────────────────────
function parseFrontmatter(md) {
  if (!md.startsWith('---')) return { fm: {}, body: md.trim() }
  const end = md.indexOf('\n---', 3)
  if (end < 0) return { fm: {}, body: md.trim() }
  const raw = md.slice(3, end).trim()
  const body = md.slice(end + 4).trim()
  let fm = {}
  try { fm = parseYaml(raw) || {} } catch { fm = {} }
  return { fm, body }
}

function packSource(packDir, pack) {
  const soulsDir = path.join(packDir, 'souls')
  if (!fs.existsSync(soulsDir)) return []

  // Optional index.yaml → enrich by local_id (domains, zh display name/desc).
  const enrich = {}
  const idxPath = path.join(packDir, 'index.yaml')
  if (fs.existsSync(idxPath)) {
    try {
      const idx = parseYaml(fs.readFileSync(idxPath, 'utf8'))
      for (const e of (idx?.experts || [])) {
        const lid = e.local_id || (e.soul_path ? path.basename(e.soul_path, '.md') : null)
        if (lid) enrich[lid] = {
          dept: deptFromDomains(e.domains),
          nameZh: e.display_name?.zh || '',
          descZh: e.description?.zh || ''
        }
      }
    } catch { /* ignore malformed index */ }
  }

  const out = []
  const files = fs.readdirSync(soulsDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.md'))
  for (const rel of files) {
    const full = path.join(soulsDir, rel)
    let md
    try { md = fs.readFileSync(full, 'utf8') } catch { continue }
    const { fm, body } = parseFrontmatter(md)
    if (!body) continue
    const localId = path.basename(rel, '.md')
    const en = enrich[localId] || {}
    const name = en.nameZh || fm.name || localId
    const description = en.descZh || (typeof fm.description === 'string' ? fm.description : '') || ''
    // Heuristic on id+name+description is per-expert specific; index.yaml domains
    // are alphabetically-sorted multi-tags (ai-ml almost always first) so they're
    // only a weak fallback when the heuristic finds nothing better.
    const heur = deptHeuristic(pack, `${localId} ${fm.name || ''} ${description}`)
    const dept = heur !== 'engineering' ? heur : (en.dept || 'engineering')
    const tools = typeof fm.tools === 'string' ? fm.tools.split(',').map(s => s.trim()).filter(Boolean)
                : Array.isArray(fm.tools) ? fm.tools.map(s => String(s).trim()) : []
    out.push({
      id: `${pack}/${localId}`,
      source: pack,
      name,
      description: description.slice(0, 300),
      dept,
      tools,
      recModel: typeof fm.model === 'string' ? fm.model.toLowerCase() : '',
      systemPrompt: body
    })
  }
  return out
}

function main() {
  if (!fs.existsSync(SOURCES)) {
    console.warn('[pack-talent] sources/ 不存在，跳过（应用将显示空人才市场）')
    return
  }
  const packs = fs.readdirSync(SOURCES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  let catalog = []
  for (const pack of packs) catalog = catalog.concat(packSource(path.join(SOURCES, pack), pack))

  // Stable order for reproducible builds (no Date/random in output).
  catalog.sort((a, b) => a.id.localeCompare(b.id))

  const plaintext = Buffer.from(JSON.stringify({ version: 1, count: catalog.length, entries: catalog }), 'utf8')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  // Layout: [12B iv][16B tag][ciphertext]
  const bundle = Buffer.concat([iv, tag, enc])

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, bundle)
  const byDept = {}
  for (const e of catalog) byDept[e.dept] = (byDept[e.dept] || 0) + 1
  console.log(`[pack-talent] ${catalog.length} 个人才 → ${path.relative(ROOT, OUT)} (${(bundle.length/1024).toFixed(0)} KB)`)
  console.log('[pack-talent] 部门分布:', byDept)
}

main()
