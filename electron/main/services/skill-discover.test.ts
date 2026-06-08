import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { TEST_USERDATA } = vi.hoisted(() => {
  const _os = require('os'); const _path = require('path')
  return { TEST_USERDATA: _path.join(_os.tmpdir(), 'ss-discover-userdata') }
})
vi.mock('electron', () => ({ app: { getPath: () => TEST_USERDATA } }))
vi.mock('./store', () => ({ getSettings: vi.fn(() => ({ skillDiscoverDir: '' })) }))
vi.mock('./skills-db', () => ({ listInstalledSkills: vi.fn(() => []) }))

import { discoverLocalSkills } from './skill-discover'
import { getSettings } from './store'
import { listInstalledSkills } from './skills-db'

const mockSettings = vi.mocked(getSettings)
const mockInstalled = vi.mocked(listInstalledSkills)

const tmpDirs: string[] = []
function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-discover-'))
  tmpDirs.push(d)
  return d
}
/** Create <root>/<bundle>/SKILL.md with the given frontmatter name. */
function makeBundle(root: string, dirName: string, skillName: string): string {
  const dir = path.join(root, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: desc of ${skillName}\n---\n\nbody`, 'utf8')
  return dir
}

beforeEach(() => {
  mockSettings.mockReturnValue({ skillDiscoverDir: '' } as never)
  mockInstalled.mockReturnValue([])
})
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe('discoverLocalSkills', () => {
  it('finds bundles in the custom scan folder', () => {
    const custom = mkdir()
    const fooDir = makeBundle(custom, 'foo', 'Foo Skill')
    fs.mkdirSync(path.join(custom, 'not-a-skill')) // no SKILL.md → ignored
    mockSettings.mockReturnValue({ skillDiscoverDir: custom } as never)

    const found = discoverLocalSkills()
    const foo = found.find(s => path.resolve(s.path) === path.resolve(fooDir))
    expect(foo).toBeTruthy()
    expect(foo!.name).toBe('Foo Skill')
    expect(foo!.source).toBe('custom')
    expect(found.find(s => s.path.endsWith('not-a-skill'))).toBeUndefined()
  })

  it('finds bundles under an open project .claude/skills', () => {
    const proj = mkdir()
    const barDir = makeBundle(path.join(proj, '.claude', 'skills'), 'bar', 'Bar Skill')

    const found = discoverLocalSkills(proj)
    const bar = found.find(s => path.resolve(s.path) === path.resolve(barDir))
    expect(bar).toBeTruthy()
    expect(bar!.source).toBe('project')
  })

  it('flags already-imported bundles by derived id', () => {
    const custom = mkdir()
    makeBundle(custom, 'cool', 'My Cool Skill')   // derived id: local-my_cool_skill
    makeBundle(custom, 'fresh', 'Brand New Skill')
    mockSettings.mockReturnValue({ skillDiscoverDir: custom } as never)
    mockInstalled.mockReturnValue([{ id: 'local-my_cool_skill', name: 'My Cool Skill' } as never])

    const found = discoverLocalSkills()
    expect(found.find(s => s.name === 'My Cool Skill')!.alreadyImported).toBe(true)
    expect(found.find(s => s.name === 'Brand New Skill')!.alreadyImported).toBe(false)
  })
})
