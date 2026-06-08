import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// skill-files reads app.getPath('userData') to resolve the skills dir. Point it
// at a throwaway temp dir so imports write somewhere harmless.
const { TEST_USERDATA } = vi.hoisted(() => {
  const _os = require('os'); const _path = require('path')
  return { TEST_USERDATA: _path.join(_os.tmpdir(), 'ss-skilltest-userdata') }
})
vi.mock('electron', () => ({ app: { getPath: () => TEST_USERDATA } }))

import { importLocalSkillBundle } from './skill-files'

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
