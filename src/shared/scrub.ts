/**
 * Strip network addresses (URLs / IPs / bare domains) from a string so they
 * never surface in the live "activity log" UI during an AI run.
 *
 * Why shared (not renderer/lib): it's a pure, dependency-free string helper and
 * lives where the vitest config can cover it (`src/shared/**`). Both the
 * renderer (ThinkingConsole, AgentProgress, Vibe store) and, if ever needed,
 * the main process can import it.
 *
 * Design — must NOT mangle ordinary file paths/names (vibe.ts, index.html,
 * main.py). We achieve that two ways:
 *   1. Scheme/IP/localhost forms are unambiguous → always replaced.
 *   2. Bare host names are only treated as domains when they end in a curated
 *      TLD list that deliberately EXCLUDES every code/asset extension. The
 *      ambiguous-with-directory TLDs (.app/.dev/.io/.co…) are intentionally
 *      left OUT of the bare list — those only get scrubbed when they carry a
 *      scheme (caught by rule 1), so a bare `foo.app` is untouched.
 */

// Curated real TLDs used to spot BARE host names (no scheme). Chosen to never
// collide with source-file / asset extensions, so filenames stay intact.
const BARE_TLD =
  'com|cn|net|org|edu|gov|help|cloud|xyz|info|biz|tech|site|online|vip|store|live|news|wiki|email'

// Order matters: scheme URLs first (their \S+ would otherwise swallow a domain
// match mid-token), then IP / localhost, then bare domains.
const RULES: Array<[RegExp, string]> = [
  // 1a. scheme URLs (http/https/ftp/ws/wss) — replace the whole token
  [/\b(?:https?|ftp|wss?):\/\/\S+/gi, '[链接]'],
  // 1b. file URLs
  [/\b(?:file|local-file):\/\/\/?\S*/gi, '[链接]'],
  // 2. IPv4 with optional :port
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[地址]'],
  // 3. localhost with optional :port
  [/\blocalhost(?::\d+)?\b/gi, '[地址]'],
  // 4. bare domains: one+ dotted labels ending in a curated TLD, plus optional
  //    :port and /path. Case-insensitive; labels allow hyphens.
  [
    new RegExp(
      `\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_TLD})\\b(?::\\d+)?(?:\\/[^\\s]*)?`,
      'gi'
    ),
    '[地址]'
  ]
]

/** Replace any URL / IP / bare-domain occurrences with `[链接]` / `[地址]`. */
export function scrubAddresses(s: string | null | undefined): string {
  if (!s) return s ?? ''
  let out = s
  for (const [re, repl] of RULES) out = out.replace(re, repl)
  return out
}
