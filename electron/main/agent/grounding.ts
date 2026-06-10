// Grounding reconciliation — the deterministic, zero-cost "did you actually do
// what you claimed?" check. Run AFTER the stream finishes, BEFORE the assistant
// message is committed. It closes the loop on the anti-fabrication PROMPT: the
// prompt ASKS the model not to claim unbacked actions; this CHECKS the final text
// against the turn's real tool evidence (toolCallLog) and flags mismatches.
//
// Pure + side-effect free (string/regex over a few KB + set lookups over the
// in-memory toolCallLog) → no extra LLM call, no tokens, no latency, no loop risk.
// It only ANNOTATES (caller appends one soft line / stashes debug info); it never
// blocks, deletes, or re-runs. Keys off toolCallLog presence + result.error rather
// than a per-tool phrase table, so tools added later are covered for free.

export interface GroundingToolCall {
  toolName?: string
  args?: unknown
  result?: unknown
}

export interface GroundingFindings {
  /** Claimed actions ("已生成文件" / "已发布" / "根据搜索结果…") with no SUCCESSFUL
   *  matching tool call this turn. The high-precision, user-surfaceable signal. */
  unbackedActions: string[]
  /** http(s) URLs printed in the answer that don't appear in any web tool's
   *  results this turn — only collected when web evidence EXISTS (else skipped to
   *  avoid flagging user/memory-provided links). Lower precision → debug-only. */
  fabricatedUrls: string[]
}

/** A tool entry counts as success iff it ran and its result has no `error`. Error
 *  results in toolCallLog are `{error: ...}` objects; the repeat-guard short-circuit
 *  pushes NOTHING (so a guarded call is correctly absent → unbacked). Mirrors the
 *  success predicate in engine.ts extractArtifactPaths. */
function succeeded(c: GroundingToolCall): boolean {
  const r = c.result
  if (r == null) return false
  if (typeof r === 'object') return !((r as { error?: unknown }).error)
  if (typeof r === 'string') return !/^\s*\[[^\]]*error/i.test(r) // "[xxx error] …"
  return true
}

function resultObj(c: GroundingToolCall): Record<string, unknown> | undefined {
  return c.result && typeof c.result === 'object' ? (c.result as Record<string, unknown>) : undefined
}

// Negation/hypothetical cues right before a claim — if present, it's not a
// completion assertion ("还没生成" / "无法打开" / "如果搜索" / "并非根据搜索结果").
const NEGATION_BEFORE = /(未|没有?|无法|不能|不曾|尚未|还没|并非|不是|如果|若|将要?|打算|准备|需要|建议|应该)\s*$/

interface ClaimRule {
  label: string
  re: RegExp
  /** Given the set of successful tool names + whether any file/image/video
   *  artifact was actually produced, is this claim backed? */
  backed: (succ: Set<string>, art: { file: boolean; image: boolean; video: boolean }) => boolean
}

// Completion-form claims (anchored on 已/刚, or the strong "根据…搜索…结果"). Each
// maps to the tool(s) (or produced artifact) that would make it true.
// `(已|刚)[^。！\n]{0,4}?<verb>` allows a few words between the completion anchor
// and the verb ("已【为你】生成", "已【成功】发布", "已【经】打开"), lazily so it
// stays close. The 已/刚 anchor itself rules out most negations ("还没生成").
const CLAIM_RULES: ClaimRule[] = [
  {
    label: '生成/保存文件',
    re: /(已|刚)[^。！\n]{0,4}?(生成|创建|写入|保存|导出|存为|存到|写好|做好)[^。！\n]{0,12}(文件|表格|excel|xlsx|csv|json|html|文档|报告|脚本|代码|网页|markdown|md|ppt|word)/i,
    backed: (s, art) => s.has('file_write') || s.has('write_text_file') || art.file,
  },
  {
    label: '生成图片',
    re: /(已|刚)[^。！\n]{0,4}?(生成|画|做|绘制)[^。！\n]{0,6}图(片|像)?/,
    backed: (s, art) => s.has('image_generate') || s.has('image_edit') || art.image,
  },
  {
    label: '生成视频',
    re: /(已|刚)[^。！\n]{0,4}?生成[^。！\n]{0,6}视频/,
    backed: (s, art) => s.has('video_generate') || art.video,
  },
  {
    label: '发布/上传',
    re: /(已|刚)[^。！\n]{0,4}?(发布|上传|投稿)/,
    backed: (s) => s.has('xhs_publish') || s.has('web_upload'),
  },
  {
    label: '搜索/检索',
    re: /根据[^。！\n]{0,4}(搜索|检索)[^。！\n]{0,4}结果|(已|刚)[^。！\n]{0,4}?(搜索|检索|查了|查到|搜了一下|搜了)/,
    // file_read covers local retrieval too (xlsx value-search, grep-in-file).
    backed: (s) => s.has('web_search') || s.has('web_open') || s.has('file_read'),
  },
  {
    label: '打开/抓取网页',
    re: /(已|刚)[^。！\n]{0,4}?(打开|访问|抓取|爬取|读取了)[^。！\n]{0,4}(网页|页面|网站|链接|url)/i,
    backed: (s) => s.has('web_open') || s.has('web_snapshot'),
  },
  {
    // Catches "把脚本贴给用户代跑" disguised as "已执行/已跑" — the script-
    // offloading anti-pattern. Backed only by a REAL local/remote exec call.
    label: '执行脚本/命令',
    re: /(已|刚)[^。！\n]{0,4}?(执行|运行|跑了?|跑完|跑通)[^。！\n]{0,10}(脚本|命令|python|bash|shell|\.bat|\.sh|\.py|node|程序)/i,
    backed: (s) => s.has('run_script') || s.has('ssh_exec') || s.has('bash'),
  },
]

const URL_RE = /https?:\/\/[^\s)）"'<>，。、]+/gi

/** Reconcile the final answer text against the turn's tool evidence. */
export function reconcileGrounding(fullText: string, toolCallLog: GroundingToolCall[]): GroundingFindings {
  const findings: GroundingFindings = { unbackedActions: [], fabricatedUrls: [] }
  if (!fullText || !fullText.trim()) return findings

  // Successful tool names + whether any real artifact was produced.
  const succ = new Set<string>()
  const art = { file: false, image: false, video: false }
  const evidenceUrls: string[] = []
  for (const c of toolCallLog) {
    if (!succeeded(c)) continue
    if (c.toolName) succ.add(c.toolName)
    const r = resultObj(c)
    if (r) {
      if (typeof r.path === 'string') {
        if (/\.(mp4|mov|webm|mkv)$/i.test(r.path)) art.video = true
        else if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(r.path)) art.image = true
        else art.file = true
      }
      if (Array.isArray(r.images) && r.images.length) art.image = true
      if (c.toolName === 'file_write' && (r.modified || r.created)) art.file = true
      // collect web evidence urls
      if (Array.isArray(r.results)) for (const it of r.results) { const u = (it as { url?: string })?.url; if (typeof u === 'string') evidenceUrls.push(u) }
      if (typeof r.finalUrl === 'string') evidenceUrls.push(r.finalUrl)
      if (Array.isArray(r.links)) for (const l of r.links) { const u = typeof l === 'string' ? l : (l as { url?: string })?.url; if (typeof u === 'string') evidenceUrls.push(u) }
    }
  }

  // Claim reconciliation.
  for (const rule of CLAIM_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(fullText))) {
      const before = fullText.slice(Math.max(0, m.index - 6), m.index)
      if (NEGATION_BEFORE.test(before)) continue
      if (!rule.backed(succ, art)) {
        findings.unbackedActions.push(rule.label)
        break // one hit per rule is enough
      }
    }
  }
  findings.unbackedActions = Array.from(new Set(findings.unbackedActions))

  // Fabricated-URL check — only meaningful when the turn actually gathered web
  // evidence; otherwise printed URLs may be legitimately user/memory-provided.
  if (evidenceUrls.length) {
    const norm = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
    const ev = evidenceUrls.map(norm)
    const printed = (fullText.match(URL_RE) || []).map(norm)
    for (const p of printed) {
      if (!ev.some(e => e.startsWith(p) || p.startsWith(e))) findings.fabricatedUrls.push(p)
    }
    findings.fabricatedUrls = Array.from(new Set(findings.fabricatedUrls))
  }

  return findings
}
