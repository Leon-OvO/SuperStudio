/**
 * Best-effort repair for the single most common way LLMs emit invalid JSON:
 * unescaped double-quotes INSIDE string values. This happens constantly with
 * Chinese content that uses ASCII " as 引号 — e.g. 阅读项目"材料"目录 — and with
 * models that stringify nested structures but only escape one level deep.
 *
 * Shared (not per-call-site) because both the chat agent's file_write
 * `operationsJson` and the workbench PM proposal's `tasks` hit the exact same
 * failure. Pure + dependency-free so vitest (`src/shared/**`) covers it.
 */

/**
 * Walk a JSON-ish string and escape any double-quote that sits INSIDE a string
 * value but isn't the structural closing quote. A real closing quote is followed
 * (after whitespace) by one of `: , } ]` or end-of-input; anything else means the
 * quote is stray content and must be escaped. Best-effort: intended to run only
 * AFTER a strict parse already failed, so it can only help — a still-broken
 * result fails exactly as before.
 */
export function repairUnescapedQuotes(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!inStr) {
      out += c
      if (c === '"') inStr = true
      continue
    }
    if (c === '\\') {            // keep existing escape sequences verbatim
      out += c + (s[i + 1] ?? '')
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      const next = s[j]
      if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
        out += c               // structural closing quote
        inStr = false
      } else {
        out += '\\"'           // stray content quote → escape it
      }
      continue
    }
    out += c
  }
  return out
}

/**
 * Repair invalid backslash escapes inside JSON strings — the OTHER very common
 * LLM mistake that produces "Bad escaped character in JSON". A Windows path
 * (`D:\Admin`), a literal `\` in content, or a model that under-escapes when it
 * hand-writes a JSON string all leave a backslash that doesn't form a valid JSON
 * escape (`\" \\ \/ \b \f \n \r \t \uXXXX`). Any such lone backslash is doubled
 * so it becomes a literal backslash. Best-effort: run only AFTER a strict parse
 * failed, so it can only help.
 */
export function repairBadEscapes(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!inStr) {
      out += c
      if (c === '"') inStr = true
      continue
    }
    if (c === '\\') {
      const n = s[i + 1]
      if (n === '"' || n === '\\' || n === '/' || n === 'b' || n === 'f' || n === 'n' || n === 'r' || n === 't') {
        out += c + n; i++; continue                       // valid 2-char escape — keep
      }
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += s.slice(i, i + 6); i += 5; continue        // valid \uXXXX — keep
      }
      out += '\\\\'; continue                              // invalid escape → literal backslash
    }
    if (c === '"') { out += c; inStr = false; continue }
    out += c
  }
  return out
}

/**
 * Parse JSON, progressively repairing the two most common LLM mistakes
 * (unescaped content quotes + bad backslash escapes), in both orders. Returns
 * the parsed value, or throws the ORIGINAL parse error if nothing parses (so
 * callers see the true reason).
 */
export function parseJsonLoose<T = unknown>(s: string): T {
  const attempts: Array<(x: string) => string> = [
    (x) => x,
    repairUnescapedQuotes,
    repairBadEscapes,
    (x) => repairUnescapedQuotes(repairBadEscapes(x)),
    (x) => repairBadEscapes(repairUnescapedQuotes(x)),
  ]
  let firstErr: unknown
  for (const f of attempts) {
    try {
      return JSON.parse(f(s)) as T
    } catch (e) {
      if (firstErr === undefined) firstErr = e
    }
  }
  throw firstErr
}
