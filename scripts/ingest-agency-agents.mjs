#!/usr/bin/env node
// One-off ingestion: curate msitarzewski/agency-agents (MIT) into a DWork/
// SuperStudio talent pack at sources/agency-agents/. Reads an extracted tarball,
// copies the selected agent .md verbatim into souls/, and emits index.yaml +
// _meta.yaml + LICENSE. Re-runnable. Not part of the build.
//
// Usage: node scripts/ingest-agency-agents.mjs <extracted-repo-dir>

import fs from 'node:fs'
import path from 'node:path'

const SRC = process.argv[2] || '/tmp/aa/msitarzewski-agency-agents-a077c9a'
const COMMIT = 'a077c9ac0be381ec15e7dcbb690f641d6091a5db'
const OUT = 'sources/agency-agents'
const SOULS = path.join(OUT, 'souls')

// Whole directories → the index.yaml `domains` tag (drives dept via DOMAIN_DEPT).
const DIR_DOMAIN = {
  finance: 'finance',
  sales: 'sales',
  'paid-media': 'paid-media',
  security: 'security',
  academic: 'academic',
  'spatial-computing': 'engineering',
  'project-management': 'project-management',
  support: 'support',
  product: 'product',
}

// Curated subset of specialized/ (business / professional services) → domain.
// Excludes dev/agent-infra ones (mcp-builder, salesforce-architect, lsp-index,
// model-qa, workflow-architect, orchestrator, identity/zk-*, civil-engineer,
// developer-advocate, strategy-duel, automation-governance, agentic-identity).
const SPECIALIZED = {
  'chief-financial-officer': 'finance',
  'accounts-payable-agent': 'finance',
  'loan-officer-assistant': 'finance',
  'specialized-pricing-analyst': 'finance',
  'medical-billing-coding-specialist': 'finance',
  'legal-billing-time-tracking': 'legal',
  'legal-client-intake': 'legal',
  'legal-document-review': 'legal',
  'data-privacy-officer': 'legal',
  'healthcare-marketing-compliance': 'legal',
  'specialized-chief-of-staff': 'operations',
  'customer-service': 'operations',
  'customer-success-manager': 'operations',
  'hr-onboarding': 'operations',
  'recruitment-specialist': 'operations',
  'operations-manager': 'operations',
  'change-management-consultant': 'operations',
  'corporate-training-designer': 'operations',
  'ma-integration-manager': 'operations',
  'supply-chain-strategist': 'operations',
  'esg-sustainability-officer': 'operations',
  'hospitality-guest-services': 'operations',
  'retail-customer-returns': 'operations',
  'study-abroad-advisor': 'operations',
  'grant-writer': 'operations',
  'healthcare-customer-service': 'operations',
  'language-translator': 'operations',
  'personal-growth-mentor': 'operations',
  'specialized-cultural-intelligence-strategist': 'operations',
  'specialized-korean-business-navigator': 'operations',
  'specialized-french-consulting-market': 'operations',
  'report-distribution-agent': 'operations',
  'specialized-document-generator': 'operations',
  'real-estate-buyer-seller': 'sales',
  'government-digital-presales-consultant': 'sales',
  'sales-data-extraction-agent': 'sales',
  'sales-outreach': 'sales',
  'business-strategist': 'product',
  'organizational-psychologist': 'research',
  'data-consolidation-agent': 'data',
}

// China-market subset of marketing/ → marketing.
const MARKETING_CN = new Set([
  'marketing-baidu-seo-specialist',
  'marketing-bilibili-content-strategist',
  'marketing-china-ecommerce-operator',
  'marketing-china-market-localization-strategist',
  'marketing-cross-border-ecommerce',
  'marketing-douyin-strategist',
  'marketing-kuaishou-strategist',
  'marketing-livestream-commerce-coach',
  'marketing-private-domain-operator',
  'marketing-short-video-editing-coach',
  'marketing-wechat-official-account',
  'marketing-weibo-strategist',
  'marketing-xiaohongshu-specialist',
  'marketing-zhihu-strategist',
  'marketing-video-optimization-specialist',
])

const isDoc = (b) => /^(README|CONTRIBUTING|SECURITY|QUICKSTART|EXECUTIVE-BRIEF|PULL_REQUEST)/i.test(b)

// Collect [absPath, localId, domain] for every included file.
function collect() {
  const picks = []
  for (const [dir, domain] of Object.entries(DIR_DOMAIN)) {
    const d = path.join(SRC, dir)
    if (!fs.existsSync(d)) { console.warn('missing dir', dir); continue }
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.md') || isDoc(f)) continue
      picks.push([path.join(d, f), path.basename(f, '.md'), domain])
    }
  }
  for (const [lid, domain] of Object.entries(SPECIALIZED)) {
    const p = path.join(SRC, 'specialized', lid + '.md')
    if (fs.existsSync(p)) picks.push([p, lid, domain])
    else console.warn('missing specialized', lid)
  }
  for (const lid of MARKETING_CN) {
    const p = path.join(SRC, 'marketing', lid + '.md')
    if (fs.existsSync(p)) picks.push([p, lid, 'marketing'])
    else console.warn('missing marketing', lid)
  }
  return picks
}

// Pull `name` and `description` out of the YAML frontmatter without a YAML lib.
function frontmatter(md) {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end < 0) return {}
  const fm = md.slice(3, end)
  const lines = fm.split('\n')
  const out = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z_]+):\s?(.*)$/)
    if (!m) continue
    const key = m[1]
    if (key !== 'name' && key !== 'description') continue
    let val = m[2]
    if (val === '|' || val === '>' || val === '') {
      // block scalar: take following indented lines until next top-level key
      const acc = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[a-zA-Z_]+:/.test(lines[j])) break
        acc.push(lines[j].trim())
      }
      val = acc.join(' ')
    }
    out[key] = val.replace(/\s+/g, ' ').trim()
  }
  return out
}

const yamlStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }

const picks = collect()
const seen = new Set()
fs.mkdirSync(SOULS, { recursive: true })

const experts = []
const deptHint = {}
for (const [abs, lid, domain] of picks) {
  if (seen.has(lid)) { console.warn('DUP local_id skipped:', lid); continue }
  seen.add(lid)
  const md = fs.readFileSync(abs, 'utf8')
  const fm = frontmatter(md)
  fs.writeFileSync(path.join(SOULS, lid + '.md'), md)
  experts.push({
    lid,
    domain,
    name: fm.name || lid,
    desc: clip(fm.description, 180),
  })
  deptHint[domain] = (deptHint[domain] || 0) + 1
}

// index.yaml — profession = English name (display), description.zh = English
// blurb (so market cards show real text; CN localization is a follow-up).
let idx = '# Auto-generated by scripts/ingest-agency-agents.mjs — curated subset of\n'
idx += '# msitarzewski/agency-agents (MIT). domains drive dept; profession = display name.\n'
idx += 'experts:\n'
for (const e of experts.sort((a, b) => a.lid.localeCompare(b.lid))) {
  idx += `- id: agency-agents/${e.lid}\n`
  idx += `  local_id: ${e.lid}\n`
  idx += `  soul_path: souls/${e.lid}.md\n`
  idx += `  domains: [${e.domain}]\n`
  idx += `  profession: ${yamlStr(e.name)}\n`
  idx += `  description:\n    zh: ${yamlStr(e.desc)}\n`
  idx += `  authority_score: 0.85\n`
  idx += `  added_at: '2026-06-12'\n`
}
fs.writeFileSync(path.join(OUT, 'index.yaml'), idx)

// _meta.yaml
const meta = `source_id: agency-agents
display_name: Agency Agents
upstream_url: https://github.com/msitarzewski/agency-agents
license: MIT
last_commit_sha: ${COMMIT}
trust_tier: tier-2
authority_score: 0.85
language: en
total_experts: ${experts.length}
last_sync: '2026-06-12T00:00:00+08:00'
sync_strategy: manual_curation
notes: >-
  Curated business / finance / sales / security / legal / operations / research
  subset of msitarzewski/agency-agents (MIT, (c) 2025 AgentLand Contributors).
  Engineering / GIS / game-dev / docs excluded (already covered or non-persona).
  Attribution preserved per MIT — see sources/agency-agents/LICENSE.
`
fs.writeFileSync(path.join(OUT, '_meta.yaml'), meta)

// LICENSE (verbatim, MIT requires it)
const lic = fs.readdirSync(SRC).find(f => /^LICENSE/i.test(f))
if (lic) fs.copyFileSync(path.join(SRC, lic), path.join(OUT, 'LICENSE'))
else console.warn('LICENSE not found in source')

console.log(`[ingest] ${experts.length} souls → ${SOULS}`)
console.log('[ingest] domain 分布:', JSON.stringify(deptHint))
