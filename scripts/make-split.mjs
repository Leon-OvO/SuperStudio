#!/usr/bin/env node
// make-split.mjs — produce the DWork core/ + proprietary overlay/ trees.
//
// File-override model: `core/` is the deliverable (no proprietary IP, no-op
// injection stubs, scrubbed comments); `overlay/` holds the proprietary files
// that overwrite core's stubs + add the supercode/talent/remote implementations
// to build SuperStudio. Non-destructive: reads the current repo via `git
// ls-files`, writes only under split-out/.
//
// After running:  cd split-out/core && node scripts/verify-core-clean.mjs   → must pass
//
// Usage: node scripts/make-split.mjs

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const OUT = 'split-out'
const CORE = path.join(OUT, 'core')
const OVERLAY = path.join(OUT, 'overlay')

// Files that never ship in core. They go to overlay/ instead (verbatim copy).
// NOTE: scripts/verify-core-clean.mjs is NOT here — it ships in core as the CI guard.
const NEVER_SHIP = [
  'electron/main/supercode-api.ts',
  'electron/main/auth-store.ts',
  'electron/main/ipc/auth.ts',
  'electron/main/ipc/dashboard.ts',
  'electron/main/services/providers/github-remote-control.ts',
  'electron/main/services/providers/supercode-auth-provider.ts',
  'electron/main/services/providers/register-proprietary.ts',
  'src/renderer/src/lib/supercode-api.ts',
  'src/renderer/src/lib/register-account-ui.ts',
  'src/shared/brand-links.ts',
  'src/shared/flavor.test.ts', // tests the multi-flavor resolver; core is a fixed-dwork stub
  'src/renderer/src/pages/Login/',
  'src/renderer/src/pages/Settings/AccountTab.tsx',
  'src/renderer/src/pages/Settings/CreateKeyDialog.tsx',
  'src/renderer/src/pages/Dashboard/',
  'scripts/pack-talent.mjs',
  'scripts/make-split.mjs', // the split tool itself — not part of the deliverable
  'scripts/verify-core-clean.mjs', // the guard spells out the forbidden brand words — run it pre-delivery, don't ship it
  'model.conf',
  'docs/',
  'openspec/',
  'sources/', // ~840 talent personas in raw .md (kept private; the packed .enc ships)
  'bp/',      // business plan
  'demo/',    // internal demos
  'mobile-app/',     // separate Capacitor Android workstream — not part of the DWork desktop deliverable
  'mobile-shell/',   // separate Capacitor Android workstream — not part of the DWork desktop deliverable
  'mobile-backend/', // mobile BFF (references supercode) — must NOT ship to the DWork core
  'mobile-admin/',   // separate admin-console workstream (imports pages/Login + pages/Dashboard) — not part of the DWork desktop deliverable
  '.github/', // GitHub Actions CI — belongs to the SuperStudio build, useless on the DWork (Gogs) repo
  // talent-crypto + the packed resources/talent-pool.enc SHIP to entitled DWork
  // customers (paid content), so they are NOT excluded here.
]

// Injection-point files: core ships a no-op STUB; overlay carries the real one.
const STUBS = {
  'electron/main/services/providers/register-proprietary.ts':
    `// Core stub — the proprietary overlay overwrites this file. With no overlay,
// the app runs on the seam defaults (BYOK auth, empty talent, no remote control).
export function registerProprietaryProviders(): void {}
`,
  'src/renderer/src/lib/register-account-ui.ts':
    `// Core stub — the proprietary overlay overwrites this file to register the
// account screens (login / account tab / dashboard). With no overlay the BYOK
// flow is used: no login, providers configured locally.
export {}
`,
  'src/shared/brand-links.ts':
    `// Core stub — the overlay (or a customer brand) overwrites this with real
// links/copy. Empty values hide the link / show neutral onboarding copy.
export const BRAND_LINKS = {
  websiteUrl: '',
  accountHintZh: '',
}
`,
  // flavor.ts + brand.ts: core is the DWork product, so it ships a fixed-dwork
  // stub (no multi-flavor machinery, no SuperStudio name). The overlay carries
  // the real multi-flavor versions to build SuperStudio.
  'src/shared/flavor.ts':
    `// Core stub — fixed to the DWork flavor. The overlay overwrites this with the
// real multi-flavor resolver (FLAVOR from __APP_FLAVOR__). Types are kept wide
// (FLAVOR: string, ACCOUNT_MODE: AccountMode) so existing comparisons like
// \`ACCOUNT_MODE === 'hosted'\` still type-check instead of erroring as no-overlap.
export type Flavor = 'dwork'
export type AccountMode = 'hosted' | 'byok'
export const FLAVOR: string = 'dwork'
export const ACCOUNT_MODE: AccountMode = 'byok'
export const IS_DWORK = true
`,
  'src/shared/brand.ts':
    `// Core stub — DWork brand only. The overlay overwrites this with the full
// brand table.
import type { Flavor } from './flavor'

export interface Brand {
  id: Flavor
  productName: string
  appId: string
  displayName: string
  tagline: string
  websiteUrl: string
  copyright: string
  defaultSkin: string
  dataNamespace: string
  updateVersionUrl?: string
  updateReleasesUrl?: string
}

export const BRAND: Brand = {
  id: 'dwork',
  productName: 'DWork',
  appId: 'com.dwork.app',
  displayName: 'DWork',
  tagline: 'AI 工作台',
  websiteUrl: '',
  copyright: 'Copyright © 2026 DWork',
  defaultSkin: 'dwork',
  dataNamespace: 'dwork',
  updateVersionUrl: 'http://git.op.dianhun.cn/dejianxiang/DWork/raw/main/package.json',
  updateReleasesUrl: 'http://git.op.dianhun.cn/dejianxiang/DWork/releases',
}
`,
  'README.md':
    `# DWork

AI 生产力套件 —— 对话、图像、视频、工作流、技能、定时任务，一站式桌面工具。

## 配置模型（自带密钥 / BYOK）

在「设置 → API 提供商」中添加任意兼容 OpenAI 协议的提供商（接口地址 + API Key + 模型），
或 Anthropic / Google Gemini。无需注册账号。

## 开发

\`\`\`bash
npm i
npm run dev          # 启动开发模式
npm run build        # 构建
npm run dist:win     # 打包 Windows 安装包
npm test             # 单元测试
npm run typecheck:web && npm run typecheck:node
\`\`\`

## 技术栈

Electron + React + TypeScript + Vite + Tailwind CSS。
`,
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.md', '.yml', '.yaml'])

function underNeverShip(file) {
  const f = file.replaceAll('\\', '/')
  return NEVER_SHIP.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
}

// Scrub the delivered core source:
//  1) relay/vendor brand words in COMMENT lines (defensive — core has no
//     supercode in code by now) → neutral.
//  2) product rebrand across the WHOLE file: SuperStudio→DWork, superstudio→
//     dwork. core IS the DWork product, and 'superstudio' here is only ever a
//     brand name (db filename, appId, titles, User-Agent…) — never an import or
//     real filename — so a flat rename yields correct DWork values
//     (superstudio.db→dwork.db, com.superstudio.app→com.dwork.app, etc.). The
//     flavor/brand machinery that uses 'superstudio' as an enum is stubbed out.
function scrubText(text) {
  let out = text
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
      if (!isComment) return line
      return line
        .replace(/(api\.)?super\s*code\.help/gi, 'the gateway')
        .replace(/super\s*code/gi, 'account')
        .replace(/词元引力|TokenG|xizim/g, 'the vendor')
        .replace(/sub2api/gi, 'the gateway') // relay proper-noun → generic (forbidden brand token in core)
    })
    .join('\n')
  out = out
    .replace(/SuperStudio/g, 'DWork')
    .replace(/SUPERSTUDIO/g, 'DWORK') // e.g. SUPERSTUDIO_E2E env var
    .replace(/superstudio/g, 'dwork')
  return out
}

function transformPackageJson(text) {
  const pkg = JSON.parse(text)
  pkg.name = 'dwork'
  pkg.version = '0.1.10'
  pkg.description = 'DWork — AI Productivity Suite'
  if (pkg.scripts) {
    // Core IS the DWork product → default flavor is dwork.
    pkg.scripts.dev = 'cross-env FLAVOR=dwork node scripts/dev.js'
    pkg.scripts.build = 'cross-env FLAVOR=dwork electron-vite build'
    delete pkg.scripts['pack:talent']
    // dwork:* variants are redundant in core (core already builds dwork)
    delete pkg.scripts['dev:dwork']
    delete pkg.scripts['build:dwork']
    delete pkg.scripts['dist:dwork:win']
    delete pkg.scripts['dist:dwork:mac']
  }
  if (pkg.build) {
    pkg.build.productName = 'DWork'
    pkg.build.appId = 'com.dwork.app'
    pkg.build.copyright = 'Copyright © 2026 DWork'
    pkg.build.win = pkg.build.win || {}
    pkg.build.win.icon = 'build/dwork/icon.ico'
    if (pkg.build.nsis) {
      pkg.build.nsis.installerIcon = 'build/dwork/icon.ico'
      pkg.build.nsis.uninstallerIcon = 'build/dwork/icon.ico'
    }
    // Drop the GitHub auto-publish target (it names the upstream repo/owner);
    // DWork releases are handled separately. extraResources (incl. the licensed
    // talent-pool.enc) is kept — DWork ships the talent bundle.
    delete pkg.build.publish
  }
  // Belt-and-suspenders: rebrand any residual product-name strings in the JSON.
  return (JSON.stringify(pkg, null, 2) + '\n').replace(/SuperStudio/g, 'DWork').replace(/superstudio/g, 'dwork')
}

const CORE_GITIGNORE_EXTRA = `
# Proprietary material not shipped to DWork (raw personas / business docs)
sources/
bp/
demo/
split-out/
`

function writeFile(root, rel, content) {
  const dest = path.join(root, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, content)
}

function copyFile(root, rel) {
  writeFile(root, rel, fs.readFileSync(rel))
}

// ---- run ----
try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* may be locked on Windows; clean manually */ }

// --cached --others --exclude-standard: tracked + untracked source files
// (the DWork architecture files are still untracked), minus anything gitignored
// (node_modules, out, dist, talent-pool.enc, .claude, openspec). -z avoids
// git's quoting of spaces / non-ASCII paths (the Swagger docs).
const tracked = execSync('git ls-files --cached --others --exclude-standard -z', { encoding: 'utf8' })
  .split('\0').map((s) => s.trim()).filter(Boolean)

let coreCount = 0, overlayCount = 0, stubCount = 0, scrubCount = 0
for (const file of tracked) {
  if (file.startsWith(OUT + '/')) continue
  // Defensive: never copy a stray .git move-aside backup (e.g. `.tmp-dwork-core-git/`
  // left at repo root while preserving core/.git across this script's rmSync). It's
  // untracked so `git ls-files --others` would otherwise slurp its 300 internal
  // objects straight into the deliverable. (Prefer moving such backups OUTSIDE the
  // repo, but guard here too.)
  if (file.startsWith('.tmp-dwork-')) continue
  // Stubs first: core gets a no-op, overlay gets the real file to overwrite it.
  if (STUBS[file]) {
    writeFile(CORE, file, STUBS[file])
    copyFile(OVERLAY, file)
    stubCount++
    continue
  }
  if (underNeverShip(file)) {
    copyFile(OVERLAY, file)
    overlayCount++
    continue
  }
  if (file === 'package.json') {
    writeFile(CORE, file, transformPackageJson(fs.readFileSync(file, 'utf8')))
    coreCount++
    continue
  }
  // tray.ts ships an INLINE base64 tray icon — swap it for the DWork lightning.
  if (file === 'electron/main/services/tray.ts') {
    let t = fs.readFileSync(file, 'utf8')
    if (fs.existsSync('build/dwork/tray.b64.txt')) {
      const b64 = fs.readFileSync('build/dwork/tray.b64.txt', 'utf8').trim()
      t = t.replace(/const TRAY_ICON_PNG_BASE64 =[\s\S]*?\n\nexport /, `const TRAY_ICON_PNG_BASE64 = '${b64}'\n\nexport `)
    }
    writeFile(CORE, file, scrubText(t))
    coreCount++
    continue
  }
  // Scrub text files by extension, plus a few extensionless text files (LICENSE).
  if (SCAN_EXT.has(path.extname(file)) || path.basename(file) === 'LICENSE') {
    const raw = fs.readFileSync(file, 'utf8')
    const scrubbed = scrubText(raw)
    if (scrubbed !== raw) scrubCount++
    writeFile(CORE, file, scrubbed)
  } else {
    copyFile(CORE, file)
  }
  coreCount++
}

// Ship the licensed talent bundle into core. It's gitignored (so absent from
// the file list) — copy it explicitly. Omit this line for non-entitled builds.
const talentEnc = 'resources/talent-pool.enc'
let talentShipped = false
if (fs.existsSync(talentEnc)) {
  copyFile(CORE, talentEnc)
  talentShipped = true
}

// Make the DWork lightning icons the canonical build/icon.* in core, so the
// runtime window-icon path (build/icon.png) and any build/icon.* reference use
// DWork's — not just the electron-builder win.icon (build/dwork/icon.ico).
for (const f of ['icon.png', 'icon.ico', 'tray.png', 'tray.b64.txt']) {
  const src = `build/dwork/${f}`
  if (fs.existsSync(src)) writeFile(CORE, `build/${f}`, fs.readFileSync(src))
}

// .gitignore additions for core. Strip the upstream `talent-pool.enc` ignore so
// the licensed bundle actually gets committed in an entitled DWork build.
const giPath = path.join(CORE, '.gitignore')
const gi = (fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '')
  .split('\n').filter((l) => !l.includes('talent-pool.enc')).join('\n')
fs.writeFileSync(giPath, gi + CORE_GITIGNORE_EXTRA)

// overlay apply script + readme
writeFile(OVERLAY, 'apply-overlay.mjs',
  `#!/usr/bin/env node
// Copy overlay files over a core checkout to build SuperStudio.
// Usage: node apply-overlay.mjs <path-to-core>
import fs from 'node:fs'; import path from 'node:path'
const core = process.argv[2]; if (!core) { console.error('usage: node apply-overlay.mjs <core-dir>'); process.exit(1) }
function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if (e.name==='apply-overlay.mjs'||e.name==='README.md') continue; if (e.isDirectory()) walk(p); else { const rel=path.relative('.',p); const dest=path.join(core,rel); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(p,dest); console.log('overwrote',rel) } } }
walk('.')
`)
writeFile(OVERLAY, 'README.md',
  `# DWork proprietary overlay\n\nPrivate. Never delivered. Overwrites core's no-op stubs + adds the supercode account / talent-pool / remote-control implementations.\n\nBuild SuperStudio:\n\n    node apply-overlay.mjs ../core   # copy these files into a core checkout\n    cd ../core && FLAVOR=superstudio npm i && npm run dist:win\n\nAlso bring (gitignored / untracked, copy manually): resources/talent-pool.enc, sources/, bp/, the SuperStudio build/icon.*.\n`)

// Leak assertion: none of the never-ship dir prefixes may exist in core/.
// (resources/ is allowed — it carries the licensed talent-pool.enc.)
const LEAK_DIRS = ['sources', 'bp', 'demo', 'docs', 'openspec',
  'electron/main/supercode-api.ts', 'src/renderer/src/pages/Login']
const leaked = LEAK_DIRS.filter((d) => fs.existsSync(path.join(CORE, d)))
if (leaked.length) {
  console.error(`\n❌ LEAK — proprietary paths present in core/: ${leaked.join(', ')}`)
  process.exit(1)
}

console.log(`core files:    ${coreCount} (${scrubCount} rebranded/scrubbed)`)
console.log(`stubs in core: ${stubCount} (real copy in overlay)`)
console.log(`overlay files: ${overlayCount}`)
console.log(`talent bundle: ${talentShipped ? 'shipped to core ✓' : 'not present (empty market)'}`)
console.log(`\nout: ${OUT}/core  +  ${OUT}/overlay`)
console.log(`verify:  node ${path.join('split-out','core','scripts','verify-core-clean.mjs')}`)
