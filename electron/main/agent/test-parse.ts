/**
 * Lightweight, dependency-free parser for test-runner output (jest / vitest /
 * pytest). Used by the Vibe `code_test` tool to turn raw stdout+stderr into a
 * structured pass/fail summary + the list of failing tests, so the agent can
 * read *which* tests failed and why, then fix-and-retry — instead of eyeballing
 * a wall of text.
 *
 * Deliberately regex-based and tolerant: if a framework's format shifts we may
 * miss a count or a failure name, but we never throw — the caller always also
 * forwards a truncated raw tail for the model to fall back on.
 */

export type TestFramework = 'jest' | 'vitest' | 'pytest' | 'unknown'

export interface TestFailure {
  /** Test name / id (e.g. "adds two numbers" or "tests/test_x.py::test_y"). */
  name: string
  /** Best-effort one-line failure reason, when the runner prints one inline. */
  message?: string
}

export interface ParsedTestResult {
  framework: TestFramework
  passed: number | null
  failed: number | null
  /** Total reported by the runner; may be null if not printed. */
  total: number | null
  /** True only when we positively parsed `failed === 0`. Null = unknown (the
   *  caller should fall back to the process exit code). */
  ok: boolean | null
  failures: TestFailure[]
}

/** Strip ANSI color/escape sequences — runners colorize by default and the
 *  codes break naive regexes. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

function num(m: RegExpMatchArray | null, i = 1): number | null {
  if (!m || m[i] == null) return null
  const n = parseInt(m[i], 10)
  return Number.isFinite(n) ? n : null
}

function dedupeFailures(list: TestFailure[]): TestFailure[] {
  const seen = new Set<string>()
  const out: TestFailure[] = []
  for (const f of list) {
    const key = f.name.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ name: key, message: f.message?.trim() || undefined })
  }
  return out
}

/** Heuristically detect which runner produced this output. */
export function detectFramework(text: string): TestFramework {
  if (/^=+.*\b(passed|failed|error)\b.*\bin\b.*=+$/m.test(text) || /^FAILED\s+\S+::/m.test(text)) {
    return 'pytest'
  }
  // Jest prints "Tests:  N passed, M total"; vitest prints "Tests  N passed (M)".
  if (/^\s*Tests:\s+.*\btotal\b/m.test(text)) return 'jest'
  if (/^\s*Test Files\s+/m.test(text) || /^\s*Tests\s+\d+\s+(passed|failed)/m.test(text)) return 'vitest'
  return 'unknown'
}

function parseJest(text: string): ParsedTestResult {
  // "Tests:       1 failed, 1 skipped, 2 passed, 4 total"
  const line = text.match(/^\s*Tests:\s+(.+?)\s*$/m)?.[1] ?? ''
  const passed = num(line.match(/(\d+)\s+passed/))
  const total = num(line.match(/(\d+)\s+total/))
  // Jest omits "0 failed" when green — derive it from the totals so an all-pass
  // run reports failed=0 / ok=true (not unknown).
  const skipped = num(line.match(/(\d+)\s+(?:skipped|todo)/)) ?? 0
  let failed = num(line.match(/(\d+)\s+failed/))
  if (failed == null && total != null) failed = Math.max(0, total - (passed ?? 0) - skipped)
  const failures: TestFailure[] = []
  // Per-test: "  ✕ adds two numbers (3 ms)"
  for (const m of text.matchAll(/^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*m?s\))?\s*$/gm)) {
    failures.push({ name: m[1] })
  }
  // Block headers: "  ● Calculator › adds two numbers" (carries the suite path).
  for (const m of text.matchAll(/^\s*●\s+(.+?)\s*$/gm)) {
    failures.push({ name: m[1].replace(/\s*›\s*/g, ' › ') })
  }
  return {
    framework: 'jest', passed, failed, total,
    ok: failed != null ? failed === 0 : null,
    failures: dedupeFailures(failures),
  }
}

function parseVitest(text: string): ParsedTestResult {
  // "Tests  1 failed | 2 passed (3)"  /  "Tests  3 passed (3)"
  const line = text.match(/^\s*Tests\s+(.+?)\s*$/m)?.[1] ?? ''
  const passed = num(line.match(/(\d+)\s+passed/))
  const skipped = num(line.match(/(\d+)\s+(?:skipped|todo)/)) ?? 0
  const total = num(line.match(/\((\d+)\)\s*$/))
  // Vitest omits "0 failed" when green — derive from the parenthesized total so
  // an all-pass run reports failed=0 / ok=true.
  let failed = num(line.match(/(\d+)\s+failed/))
  if (failed == null && total != null) failed = Math.max(0, total - (passed ?? 0) - skipped)
  const failures: TestFailure[] = []
  // "FAIL  src/foo.test.ts > suite > adds numbers"
  for (const m of text.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)) {
    failures.push({ name: m[1].replace(/\s*>\s*/g, ' > ') })
  }
  // "   × adds numbers 1ms"  (leading × marks a failed case)
  for (const m of text.matchAll(/^\s*[×✗]\s+(.+?)(?:\s+\d+\s*m?s)?\s*$/gm)) {
    failures.push({ name: m[1] })
  }
  return {
    framework: 'vitest', passed, failed, total,
    ok: failed != null ? failed === 0 : null,
    failures: dedupeFailures(failures),
  }
}

function parsePytest(text: string): ParsedTestResult {
  // Summary line: "=========== 1 failed, 2 passed, 1 error in 0.12s ==========="
  const summary = text.match(/^=+\s*(.+?\bin\b\s+[\d.]+s.*?)\s*=+\s*$/m)?.[1] ?? ''
  const failed = num(summary.match(/(\d+)\s+failed/))
  const errored = num(summary.match(/(\d+)\s+error/))
  const passed = num(summary.match(/(\d+)\s+passed/))
  const skipped = num(summary.match(/(\d+)\s+skipped/))
  const failedTotal = (failed ?? 0) + (errored ?? 0)
  const total = summary
    ? (failed ?? 0) + (errored ?? 0) + (passed ?? 0) + (skipped ?? 0)
    : null
  const failures: TestFailure[] = []
  // "FAILED tests/test_x.py::test_y - assert 1 == 2"
  for (const m of text.matchAll(/^(?:FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.+))?\s*$/gm)) {
    failures.push({ name: m[1], message: m[2] })
  }
  return {
    framework: 'pytest',
    passed,
    failed: summary ? failedTotal : null,
    total,
    ok: summary ? failedTotal === 0 : null,
    failures: dedupeFailures(failures),
  }
}

/**
 * Parse test-runner output into a structured result. `framework` may be forced;
 * 'auto'/omitted runs detection. Never throws.
 */
export function parseTestOutput(
  rawOutput: string,
  framework: TestFramework | 'auto' = 'auto'
): ParsedTestResult {
  const text = stripAnsi(rawOutput || '')
  const fw = !framework || framework === 'auto' ? detectFramework(text) : framework
  switch (fw) {
    case 'jest': return parseJest(text)
    case 'vitest': return parseVitest(text)
    case 'pytest': return parsePytest(text)
    default:
      return { framework: 'unknown', passed: null, failed: null, total: null, ok: null, failures: [] }
  }
}
