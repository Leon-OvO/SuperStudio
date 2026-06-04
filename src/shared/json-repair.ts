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
 * Parse JSON, falling back to repairUnescapedQuotes on failure. Returns the
 * parsed value, or throws the ORIGINAL parse error if even the repaired text
 * won't parse (so callers see the true reason).
 */
export function parseJsonLoose<T = unknown>(s: string): T {
  try {
    return JSON.parse(s) as T
  } catch (err) {
    try {
      return JSON.parse(repairUnescapedQuotes(s)) as T
    } catch {
      throw err
    }
  }
}
