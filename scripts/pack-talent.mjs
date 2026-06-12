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

// ── 部门中文标签 ─────────────────────────────────────────────────────────────
const DEPT_LABEL = { engineering: '工程研发', design: '设计', product: '产品', marketing: '营销增长', qa: '测试质量', data: '数据/AI', game: '游戏', finance: '财务', sales: '销售', security: '安全', legal: '法务合规', operations: '运营职能', research: '研究' }

// ── 英文角色 token → 中文（用于给英文包套中文名）──────────────────────────────
const ACRONYMS = new Set(['api', 'ui', 'ux', 'ai', 'seo', 'ci', 'cd', 'sql', 'c4', 'qa', 'llm', 'nlp', 'css', 'html', 'sdk', 'cli', 'gpu'])
const ROLE_DICT = {
  // 角色
  engineer: '工程师', developer: '开发', architect: '架构师', designer: '设计师', expert: '专家', specialist: '专家',
  analyst: '分析师', manager: '经理', reviewer: '评审', auditor: '审计师', optimizer: '优化师', automator: '自动化工程师',
  debugger: '调试专家', researcher: '研究员', orchestrator: '编排官', strategist: '策略师', writer: '撰稿人', scientist: '科学家',
  consultant: '顾问', lead: '负责人', master: '大师', guardian: '守护者', creator: '创作者', coordinator: '协调员',
  builder: '构建师', tester: '测试工程师', pro: '专家', agent: '智能体', mate: '助手', advisor: '顾问', planner: '规划师',
  // 领域
  ml: '机器学习', devops: 'DevOps', backend: '后端', frontend: '前端', fullstack: '全栈', full: '全', stack: '栈',
  data: '数据', database: '数据库', cloud: '云', security: '安全', mobile: '移动端', web: 'Web', game: '游戏',
  brand: '品牌', content: '内容', marketing: '营销', sales: '销售', product: '产品', network: '网络', blockchain: '区块链',
  infrastructure: '基础设施', infra: '基础设施', platform: '平台', performance: '性能', monitoring: '监控',
  observability: '可观测性', deployment: '部署', deploy: '部署', automation: '自动化', incident: '事件', response: '响应',
  error: '错误', code: '代码', programming: '编程', development: '研发', design: '设计', review: '评审', optimization: '优化',
  documentation: '文档', doc: '文档', compliance: '合规', technical: '技术', systems: '系统', system: '系统',
  apps: '应用', app: '应用', python: 'Python', react: 'React', node: 'Node', java: 'Java', golang: 'Go', rust: 'Rust',
  typescript: 'TypeScript', javascript: 'JavaScript', multi: '多', context: '上下文', ship: '交付',
  accessibility: '无障碍', analytics: '分析', growth: '增长', community: '社区', economy: '经济', balance: '数值',
  level: '关卡', monetization: '商业化', localization: '本地化', live: '运营', ops: '运维', prompt: '提示词',
  vision: '视觉', image: '图像', video: '视频', audio: '音频', test: '测试', testing: '测试', debugging: '调试',
  team: '团队', teams: '团队', integration: '集成', migration: '迁移', refactor: '重构', generator: '生成器',
  // 高频补充
  account: '客户', accounts: '账务', payable: '应付', installer: '安装器', organizer: '编排官', store: '商店',
  ad: '广告', ads: '广告', reporter: '报告员', validator: '校验器', visual: '视觉', implementer: '实现工程师',
  experiment: '实验', tracker: '追踪器', feedback: '反馈', synthesizer: '归纳师', finance: '财务', curator: '策展人',
  prototyper: '原型师', rapid: '快速', sprint: '冲刺', prioritizer: '优先级规划师', support: '支持', success: '成功',
  onboarding: '引导', retention: '留存', partnership: '合作', legal: '法务', recruiter: '招聘官', copywriter: '文案',
  copywriting: '文案', email: '邮件', newsletter: '邮件', podcast: '播客', photo: '摄影', illustration: '插画',
  motion: '动效', sound: '音效', music: '音乐', narrative: '叙事', story: '剧情', quest: '任务', combat: '战斗',
  physics: '物理', shader: '着色器', render: '渲染', graphics: '图形', gameplay: '玩法', tutorial: '教程',
  privacy: '隐私', governance: '治理', ethics: '伦理', fraud: '反欺诈', risk: '风控', trading: '交易',
  contract: '合约', wallet: '钱包', smart: '智能', indexer: '索引器', scaling: '扩容', latency: '延迟',
  caching: '缓存', queue: '队列', streaming: '流式', realtime: '实时', batch: '批处理', pipeline: '管线',
  workflow: '工作流', scheduler: '调度器', connector: '连接器', adapter: '适配器', gateway: '网关',
  serverless: '无服务器', microservices: '微服务', shipper: '交付官', curation: '策展', validator2: '校验器',
  reliability: '可靠性', site: '站点', sre: 'SRE', release: '发布', config: '配置', dependency: '依赖',
  knowledge: '知识', search: '搜索', recommendation: '推荐', personalization: '个性化', chatbot: '聊天机器人',
  voice: '语音', translation: '翻译', summarizer: '摘要师', classifier: '分类器', detector: '检测器',
  scraper: '采集器', crawler: '爬虫', parser: '解析器', formatter: '格式化器', linter: '代码检查器',
  finance2: '财务', operations: '运营', operator: '运营', growth2: '增长', seo2: 'SEO',
  // 角色后缀补充（压低混合中英名）
  hacker: '黑客', maintainer: '维护工程师', checker: '检查员', responder: '响应官', analyzer: '分析师',
  fixer: '修复工程师', benchmarker: '基准测试师', benchmark: '基准测试', engager: '互动官', evaluator: '评估师',
  coach: '教练', producer: '制作人', injector: '注入器', whimsy: '趣味', studio: '工作室', tool: '工具',
  results: '结果', curator2: '策展人', validator3: '校验器', maintainer2: '维护工程师', tester2: '测试工程师'
}
function tokenize(s) {
  return String(s)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // UIVisual → UI Visual, APIClient → API Client
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase → camel Case
    .split(/[-_\s]+/).map(t => t.trim()).filter(Boolean)
}
/** 把英文角色 id 翻成中文名；wshobson 的 `category__role` 取 `__` 后段。未知 token 保留（acronym 大写）。*/
function translateRoleName(localId, fmName) {
  const roleId = String(localId).split('__').pop()
  const toks = tokenize(roleId.toLowerCase())
  if (!toks.length) return fmName || localId
  return toks.map(t => ROLE_DICT[t] || (ACRONYMS.has(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))).join('')
}

// ── dept mapping (index.yaml domains → our 13 buckets) ──────────────────────
const DOMAIN_DEPT = {
  'engineering':'engineering','language-specialist':'engineering','documentation':'engineering',
  'blockchain':'engineering','devops':'engineering','infrastructure':'engineering',
  'design':'design',
  'product':'product','planning':'product','business':'product',
  'marketing':'marketing','growth':'marketing','content':'marketing','paid-media':'marketing',
  'qa-testing':'qa','qa':'qa','testing':'qa',
  'ai-ml':'data','data':'data','ml':'data','data-ai':'data',
  'game':'game','gamedev':'game',
  'finance':'finance','accounting':'finance','fintech':'finance',
  'sales':'sales',
  'security':'security',
  'legal':'legal','compliance':'legal',
  'operations':'operations','hr':'operations','recruiting':'operations',
  'customer-success':'operations','supply-chain':'operations','support':'operations',
  'project-management':'operations',
  'research':'research','academic':'research'
}
function deptFromDomains(domains) {
  if (Array.isArray(domains)) for (const d of domains) { const m = DOMAIN_DEPT[String(d).toLowerCase()]; if (m) return m }
  return null
}
function deptHeuristic(source, text) {
  const t = (text || '').toLowerCase()
  // Order matters: most specific first. `text` includes id + 中文 profession/名称。
  // Secondary safety net only — packs classify via index.yaml domains.
  if (source === 'gamedev' || source === 'gamedev-zh' || /game|gamedev|游戏|关卡|数值|玩法/.test(t)) return 'game'
  if (/design|designer|\bui\b|\bux\b|brand|visual|figma|视觉|设计|美术|品牌/.test(t)) return 'design'
  if (/security|secops|appsec|pentest|penetration|vulnerab|\bthreat\b|渗透|漏洞|网络安全/.test(t)) return 'security'
  if (/legal|lawyer|attorney|compliance|paralegal|\bgdpr\b|法务|律师|合规|合同/.test(t)) return 'legal'
  if (/financ|accounting|bookkeep|\bcfo\b|\bfp&?a\b|invoice|payable|treasury|\btax\b|财务|会计|税务|出纳/.test(t)) return 'finance'
  if (/\bsales\b|\bsdr\b|outbound|prospect|pipeline|\bcrm\b|销售|成单|外呼|客户经理/.test(t)) return 'sales'
  if (/academic|anthropolog|histor|psycholog|geograph|narratolog|researcher|scholar|学术|研究员|人类学|历史学|心理学/.test(t)) return 'research'
  if (/operations manager|chief of staff|customer success|onboarding|recruit|\bhr\b|human resources|supply chain|logistics|procurement|招聘|人事|供应链|客户成功|行政/.test(t)) return 'operations'
  if (/\bqa\b|qa-|test|tester|quality|测试|质量|审计/.test(t)) return 'qa'
  if (/market|advertis|\bads?\b|\bseo\b|content|copywrit|growth|social|email|营销|文案|增长|运营|电商|抖音|推广|创意/.test(t)) return 'marketing'
  if (/data-|analyt|\bmlops\b|ml-|llm|ai-engineer|\bnlp\b|\betl\b|数据|分析|算法|模型|报告/.test(t)) return 'data'
  if (/product|\bpm\b|roadmap|scrum|agile|backlog|产品|需求|项目/.test(t)) return 'product'
  return 'engineering' // backend/frontend/api/devops/architect/… default
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
          descZh: e.description?.zh || '',
          profession: typeof e.profession === 'string' ? e.profession.trim() : ''
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
    // 全中文命名：profession(workbuddy 真职位) → 规整 zh 名(gamedev-zh) → 英文角色翻译。
    // 注意 workbuddy 的 display_name.zh 是萌系昵称(如"链审审")，故 profession 优先。
    const name = en.profession || en.nameZh || translateRoleName(localId, fm.name)
    // 部门：兼顾中英关键词（含 profession / 中文名 / 描述）。
    const heur = deptHeuristic(pack, `${localId} ${fm.name || ''} ${en.profession || ''} ${en.nameZh || ''} ${en.descZh || ''}`)
    const dept = heur !== 'engineering' ? heur : (en.dept || 'engineering')
    // 描述：有中文用中文；英文包生成中文简介（卡片展示用，面试里仍看英文原 prompt）。
    const description = en.descZh
      ? en.descZh.slice(0, 300)
      : `${name} · 专注${DEPT_LABEL[dept] || '相关'}领域工作的 AI 员工。`
    const tools = typeof fm.tools === 'string' ? fm.tools.split(',').map(s => s.trim()).filter(Boolean)
                : Array.isArray(fm.tools) ? fm.tools.map(s => String(s).trim()) : []
    out.push({
      id: `${pack}/${localId}`,
      source: pack,
      name,
      description,
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
