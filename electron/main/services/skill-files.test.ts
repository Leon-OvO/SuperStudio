import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// skill-files reads app.getPath('userData') to resolve the skills dir. Point it
// at a throwaway temp dir so imports write somewhere harmless.
const { TEST_USERDATA } = vi.hoisted(() => {
  const _os = require('os'); const _path = require('path')
  return { TEST_USERDATA: _path.join(_os.tmpdir(), 'ss-skilltest-userdata') }
})
vi.mock('electron', () => ({ app: { getPath: () => TEST_USERDATA } }))

import { importLocalSkillBundle, downloadSkillBundle, skillDir } from './skill-files'

const tmpDirs: string[] = [TEST_USERDATA]
function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-skillsrc-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

const SKILL_MD = `---
name: My Cool Skill
description: does cool things
---

# My Cool Skill

Body here.
`

describe('importLocalSkillBundle — single file (the 20MB bug fix)', () => {
  it('imports ONLY the picked file, never walking its parent directory', () => {
    const messy = mkdir()
    // A loose SKILL.md sitting next to lots of unrelated junk — the old code
    // walked all of this and tripped the 20MB cap.
    fs.writeFileSync(path.join(messy, 'SKILL.md'), SKILL_MD, 'utf8')
    fs.writeFileSync(path.join(messy, 'unrelated-1.bin'), Buffer.alloc(3 * 1024 * 1024)) // 3 MB junk
    fs.writeFileSync(path.join(messy, 'notes.txt'), 'nothing to do with the skill')
    fs.mkdirSync(path.join(messy, 'subdir'))
    fs.writeFileSync(path.join(messy, 'subdir', 'more.bin'), Buffer.alloc(2 * 1024 * 1024))

    const bundle = importLocalSkillBundle(path.join(messy, 'SKILL.md'))

    expect(bundle.files).toEqual(['SKILL.md'])         // ONLY the file, no siblings
    expect(bundle.name).toBe('My Cool Skill')
    expect(bundle.id).toBe('local-my_cool_skill')
    expect(bundle.skillMd).toContain('Body here.')
    // The written bundle on disk contains exactly SKILL.md.
    expect(fs.readdirSync(bundle.installPath)).toEqual(['SKILL.md'])
  })

  it('derives the name from the filename when there is no frontmatter name', () => {
    const messy = mkdir()
    const p = path.join(messy, 'my-loose-skill.md')
    fs.writeFileSync(p, '# Just a heading\n\nno frontmatter here', 'utf8')
    const bundle = importLocalSkillBundle(p)
    expect(bundle.files).toEqual(['SKILL.md'])
    expect(bundle.id).toBe('local-my-loose-skill')
  })
})

describe('importLocalSkillBundle — folder (bundle import unchanged)', () => {
  it('walks the selected folder and pulls in bundled resources', () => {
    const root = mkdir()
    const bundleDir = path.join(root, 'weather-skill')
    fs.mkdirSync(path.join(bundleDir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, 'SKILL.md'), SKILL_MD, 'utf8')
    fs.writeFileSync(path.join(bundleDir, 'scripts', 'run.py'), 'print("hi")', 'utf8')

    const bundle = importLocalSkillBundle(bundleDir)
    expect(bundle.files).toContain('SKILL.md')
    expect(bundle.files).toContain('scripts/run.py')
  })
})

// ----------------------------------------------------------------------------
// downloadSkillBundle — transactional install + sha256 + binary safety.
// ----------------------------------------------------------------------------

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Fake SkillHub server backed by an in-memory file map. Routes both the
 *  `/files` listing and `/file?path=...` byte endpoints that skill-files.ts
 *  hits via global fetch(). `sha256Overrides` lets a test lie about a file's
 *  hash (to simulate corruption/tampering) while `failOn` lets a test make a
 *  specific file's download reject (to simulate a mid-download network drop). */
function mockSkillHub(opts: {
  files: Record<string, Buffer>
  sha256Overrides?: Record<string, string>
  omitSha256For?: Set<string>
  failOn?: string
}): void {
  const { files, sha256Overrides = {}, omitSha256For = new Set(), failOn } = opts
  const jsonRes = (body: unknown): Response => ({
    ok: true, status: 200, json: async () => body, arrayBuffer: async () => { throw new Error('not used') }
  } as unknown as Response)
  const bytesRes = (buf: Buffer): Response => ({
    ok: true, status: 200, json: async () => { throw new Error('not used') },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } as unknown as Response)

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url)
    if (u.pathname.endsWith('/files')) {
      const list = Object.entries(files).map(([p, buf]) => ({
        path: p,
        size: buf.length,
        sha256: omitSha256For.has(p) ? undefined : (sha256Overrides[p] ?? sha256Hex(buf))
      }))
      return jsonRes({ files: list })
    }
    if (u.pathname.endsWith('/file')) {
      const p = u.searchParams.get('path') || ''
      if (failOn && p === failOn) throw new Error('simulated network drop')
      const buf = files[p]
      if (!buf) return { ok: false, status: 404 } as unknown as Response
      return bytesRes(buf)
    }
    return { ok: false, status: 404 } as unknown as Response
  }))
}

describe('downloadSkillBundle — transactional install', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('round-trips binary bytes exactly (no UTF-8 corruption)', async () => {
    // A byte sequence that is invalid UTF-8 / would be mangled by a
    // decode-then-reencode round trip (lone continuation bytes, invalid start bytes).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x0d, 0x0a, 0x1a, 0x0a])
    mockSkillHub({ files: { 'SKILL.md': Buffer.from('---\nname: bin\n---\nbody', 'utf8'), 'assets/logo.png': png } })

    const bundle = await downloadSkillBundle('bin-slug', 'bin-skill-test')
    const onDisk = fs.readFileSync(path.join(bundle.installPath, 'assets', 'logo.png'))
    expect(Buffer.compare(onDisk, png)).toBe(0)
  })

  it('aborts the whole bundle when a file fails sha256 verification, leaving nothing installed', async () => {
    const good = Buffer.from('print(1)', 'utf8')
    mockSkillHub({
      files: { 'SKILL.md': Buffer.from('---\nname: bad\n---\nbody', 'utf8'), 'run.py': good },
      sha256Overrides: { 'run.py': '0'.repeat(64) } // deliberately wrong hash
    })

    const id = 'sha-mismatch-test'
    await expect(downloadSkillBundle('bad-slug', id)).rejects.toThrow(/sha256/)
    expect(fs.existsSync(skillDir(id))).toBe(false)
    // No leftover staging directories either.
    const leftovers = fs.readdirSync(TEST_USERDATA + '/skills').filter(n => n.startsWith('.staging-'))
    expect(leftovers).toEqual([])
  })

  it('skips sha256 checking (with a warning) when the server omits the field', async () => {
    const buf = Buffer.from('no hash provided', 'utf8')
    mockSkillHub({
      files: { 'SKILL.md': Buffer.from('---\nname: nohash\n---\nbody', 'utf8'), 'data.txt': buf },
      omitSha256For: new Set(['data.txt'])
    })
    const bundle = await downloadSkillBundle('nohash-slug', 'nohash-test')
    expect(fs.readFileSync(path.join(bundle.installPath, 'data.txt'))).toEqual(buf)
  })

  it('leaves a previously-installed skill fully intact when a mid-upgrade download fails', async () => {
    const id = 'upgrade-drop-test'
    const v1Script = Buffer.from('print("v1")', 'utf8')
    mockSkillHub({ files: { 'SKILL.md': Buffer.from('---\nname: up\n---\nv1 body', 'utf8'), 'run.py': v1Script } })
    const v1 = await downloadSkillBundle('up-slug', id)
    expect(fs.readFileSync(path.join(v1.installPath, 'run.py'))).toEqual(v1Script)

    // Simulate an upgrade whose network drops partway through the file list.
    const v2Script = Buffer.from('print("v2")', 'utf8')
    mockSkillHub({
      files: {
        'SKILL.md': Buffer.from('---\nname: up\n---\nv2 body', 'utf8'),
        'run.py': v2Script,
        'extra.py': Buffer.from('print("extra")', 'utf8')
      },
      failOn: 'extra.py'
    })
    await expect(downloadSkillBundle('up-slug', id)).rejects.toThrow(/simulated network drop/)

    // The v1 install must be completely untouched — same file, same content.
    expect(fs.existsSync(skillDir(id))).toBe(true)
    expect(fs.readFileSync(path.join(skillDir(id), 'run.py'))).toEqual(v1Script)
    expect(fs.readFileSync(path.join(skillDir(id), 'SKILL.md'), 'utf8')).toContain('v1 body')
    expect(fs.existsSync(path.join(skillDir(id), 'extra.py'))).toBe(false)

    // No leftover .bak-* or .staging-* directories after rollback.
    const leftovers = fs.readdirSync(TEST_USERDATA + '/skills').filter(n => n.startsWith('.staging-') || n.includes('.bak-'))
    expect(leftovers).toEqual([])
  })
})
