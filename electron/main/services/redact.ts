/**
 * 统一密钥脱敏出口。日志是热路径，所有落盘前必须经过这里。
 *
 * 设计取舍：
 * - 先用一条 union 正则 `test()` 做零成本预判，绝大多数日志行不含任何密钥形状，
 *   不命中直接原样返回，避免每条日志都跑一遍十几条 replace。
 * - URL 用 `new URL()` 结构化重写，不用正则怼 URL：清 userinfo、整个丢弃 hash、
 *   按敏感参数名逐个替换 query 值。正则处理 URL 极易漏掉编码变体/相对协议等边角。
 */

// 每条模式命中后 replace 成的占位串统一带上前缀，方便日志里一眼看出"这里被脱敏过"。
const REDACTED = '<redacted>'

/** 具名 key:value / key=value / Bearer <value> 形态——保留 key 名，隐藏值。
 *  `\b` 锚定避免把 task-xxx / disk-xxx / risk-xxx 这类含 "sk" 子串的普通词误伤。 */
const KV_PATTERN = /\b(authorization|bearer|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|credential)\b(\s*[:=]\s*|\s+)(?:bearer\s+)?(["']?)[^\s"'&]{6,}\3/gi

/** 各厂商 key/token 的固定前缀形状。全部 `\b` 锚定——`sk-` 前必须是词边界，
 *  防止 task-xxx / disk-xxx / risk-xxx 这类普通英文词被"sk"子串误判命中。 */
const SHAPE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, label: 'sk-<redacted>' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g, label: 'sk-ant-<redacted>' },
  { re: /\bxai-[A-Za-z0-9_-]{12,}/g, label: 'xai-<redacted>' },
  { re: /\bgh[posru]_[A-Za-z0-9]{20,}/g, label: '<redacted-gh-token>' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, label: 'github_pat_<redacted>' },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g, label: 'glpat-<redacted>' },
  { re: /\bxox[abp]-[A-Za-z0-9-]{10,}/g, label: '<redacted-slack-token>' },
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, label: 'AIza<redacted>' },
  { re: /\bAKIA[0-9A-Z]{12,}/g, label: '<redacted-aws-key>' },
  // JWT：三段 base64url，用 . 分隔
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, label: '<redacted-jwt>' },
]

/** PEM 块（私钥/证书等）——整块替换，跨行匹配。 */
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g

/** 用于零成本预判的 union 正则：任意一条模式的特征片段命中即需要走完整脱敏。
 *  维护提醒：新增/删除 SHAPE_PATTERNS 或改动 KV_PATTERN 时同步维护本表，
 *  redact.test.ts 里的模式数量 tripwire 会在漏改时报红。 */
const QUICK_PROBE = new RegExp(
  [
    KV_PATTERN.source,
    ...SHAPE_PATTERNS.map(p => p.re.source),
    PEM_PATTERN.source,
  ].join('|'),
  'i'
)

/** 敏感 query 参数名——URL 结构化重写时逐个替换值。 */
const SENSITIVE_QUERY_KEYS = new Set([
  'key', 'apikey', 'api_key', 'token', 'access_token', 'refresh_token',
  'auth', 'authorization', 'secret', 'password', 'signature', 'sig', 'sign',
])

/** 结构化重写单个 URL：清 userinfo、丢弃整个 hash、脱敏敏感 query 参数值。
 *  解析失败（非法 URL / 相对路径）时原样返回，交给外层的正则兜底。 */
function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.username || parsed.password) {
    parsed.username = ''
    parsed.password = ''
  }
  parsed.hash = ''
  let changed = false
  for (const [k, v] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase()) && v) {
      parsed.searchParams.set(k, REDACTED)
      changed = true
    }
  }
  void changed
  return parsed.toString()
}

/** 匹配到 URL 形状的片段（http(s):// 开头，直到空白/引号/尖括号为止），逐个结构化重写。 */
const URL_TOKEN_PATTERN = /https?:\/\/[^\s"'<>)]+/g

/**
 * 统一脱敏入口。落盘前必须经过这里（error-log / request-log / skill-induction 等）。
 * 命中零成本预判为 false 时直接原样返回字符串引用，不做任何字符串分配。
 */
export function redactSecrets(s: string): string {
  if (!s) return s
  let hasUrl = false
  URL_TOKEN_PATTERN.lastIndex = 0
  if (URL_TOKEN_PATTERN.test(s)) hasUrl = true
  if (!hasUrl && !QUICK_PROBE.test(s)) return s

  let out = s
  if (hasUrl) {
    out = out.replace(URL_TOKEN_PATTERN, m => redactUrl(m))
  }
  out = out.replace(PEM_PATTERN, '-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----')
  out = out.replace(KV_PATTERN, '$1=<redacted>')
  for (const { re, label } of SHAPE_PATTERNS) out = out.replace(re, label)
  return out
}

/** 供 tripwire 测试读取模式总数，防止悄悄加/删模式而不同步更新测试。 */
export const REDACT_PATTERN_COUNT = 1 /* KV_PATTERN */ + SHAPE_PATTERNS.length + 1 /* PEM_PATTERN */
