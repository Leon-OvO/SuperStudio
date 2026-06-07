#!/usr/bin/env node
// verify-core-clean.mjs
//
// Guards the core/proprietary boundary for the DWork private build. The
// deliverable "core" must not import proprietary modules or contain proprietary
// brand strings, so that the source handed to customers leaks no IP and builds
// without the private overlay.
//
// Run in CI on the core repo (where PROPRIETARY paths don't exist, so any hit is
// a real leak). Run in the SuperStudio monorepo it doubles as the decoupling
// punch-list: every reported hit is a core→proprietary coupling still to invert
// before the split.
//
// Usage:  node scripts/verify-core-clean.mjs            # report + exit 1 on hits
//         node scripts/verify-core-clean.mjs --list     # report only, exit 0

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Paths that are NOT core — never shipped to customers. Excluded from scanning
// AND forbidden as import targets from core.
const PROPRIETARY_PATHS = [
  'electron/main/supercode-api.ts',
  'electron/main/auth-store.ts',
  'electron/main/ipc/auth.ts',
  'electron/main/ipc/dashboard.ts',
  'electron/main/services/providers/', // overlay impls (registered, not imported by core)
  'src/renderer/src/lib/supercode-api.ts',
  'src/renderer/src/lib/register-account-ui.ts', // renderer overlay injection (core ships a no-op stub)
  'src/shared/brand-links.ts', // account links/copy (core ships an empty stub; overlay fills SuperStudio's)
  'src/renderer/src/pages/Login/',
  'src/renderer/src/pages/Settings/AccountTab.tsx',
  'src/renderer/src/pages/Dashboard/',
  'scripts/pack-talent.mjs',
  'scripts/verify-core-clean.mjs',
  'model.conf',
  'sources/',
  'bp/',
  'demo/',
  'docs/',
  'openspec/',
  '.claude/',
]

// Import specifiers that, if referenced from a core file, are a leak.
const PROPRIETARY_IMPORT_MARKERS = [
  'supercode-api',
  'auth-store',
  '/ipc/auth',
  '/ipc/dashboard',
  'pages/Login',
  'pages/Dashboard',
  'Settings/AccountTab',
  'services/providers/', // core must go through the seam, not the impl
]

// Brand / IP tokens that must never appear in core source (strings, comments,
// URLs). The neutral release-host owner is allowed only in updater/model-conf
// once they're seam-injected — by then they're in the overlay, so we forbid it
// in core too.
const FORBIDDEN_TOKENS = [
  'supercode',
  'SuperCode',
  'supercode.help',
  'SuperStudio', // old product brand — DWork deliverable must not mention it
  'superstudio',
  'sub2api',
  '词元引力',
  'TokenG',
  'xizim',
  // NOTE: 'Leon-OvO' is the permitted release-host owner (user-facing links may
  // use it); only 'xizim' (private source repo) is forbidden. See memory.
]

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.txt'])

function isProprietary(file) {
  const f = file.replaceAll('\\', '/')
  return PROPRIETARY_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
}

function tracked() {
  try {
    const out = execSync('git ls-files -z', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = out.split('\0').map((s) => s.trim()).filter(Boolean)
    if (files.length) return files
  } catch {
    // not a git repo yet (e.g. freshly split core/) — fall back to fs walk
  }
  const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'split-out', '.claude'])
  const acc = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else acc.push(p.replaceAll('\\', '/').replace(/^\.\//, ''))
    }
  }
  walk('.')
  return acc
}

const violations = []
for (const file of tracked()) {
  if (isProprietary(file)) continue
  if (!SCAN_EXT.has(path.extname(file))) continue
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const isImport = /\b(import|require)\b/.test(line) || /from\s+['"]/.test(line)
    if (isImport) {
      // Sanctioned injection stubs: core ships a no-op at this path and the
      // overlay overwrites it at build (file-override model). Not a leak.
      const sanctionedStub = line.includes('register-proprietary') || line.includes('register-account-ui')
      if (!sanctionedStub) {
        for (const m of PROPRIETARY_IMPORT_MARKERS) {
          if (line.includes(m)) {
            violations.push({ file, line: i + 1, kind: 'import', detail: m, text: line.trim() })
          }
        }
      }
    }
    for (const t of FORBIDDEN_TOKENS) {
      if (line.includes(t)) {
        violations.push({ file, line: i + 1, kind: 'token', detail: t, text: line.trim().slice(0, 160) })
      }
    }
  })
}

if (violations.length === 0) {
  console.log('✓ core is clean — no proprietary imports or brand tokens found')
  process.exit(0)
}

// Group by file for a readable punch-list.
const byFile = new Map()
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, [])
  byFile.get(v.file).push(v)
}
const imports = violations.filter((v) => v.kind === 'import').length
const tokens = violations.filter((v) => v.kind === 'token').length
console.log(`✗ core boundary violations: ${violations.length} (${imports} proprietary imports, ${tokens} brand tokens) in ${byFile.size} files\n`)
for (const [file, vs] of [...byFile.entries()].sort()) {
  console.log(file)
  for (const v of vs) {
    console.log(`  ${v.line}: [${v.kind}:${v.detail}] ${v.text}`)
  }
  console.log('')
}

const listOnly = process.argv.includes('--list')
process.exit(listOnly ? 0 : 1)
