import { describe, it, expect } from 'vitest'
import { parseVersion, opencodeNativeCandidates } from './discovery'

describe('parseVersion', () => {
  it('抓 "1.2.3 (Claude Code)" 里的 semver', () => {
    expect(parseVersion('1.2.3 (Claude Code)')).toBe('1.2.3')
  })
  it('抓带前缀的 "opencode 0.4.1"', () => {
    expect(parseVersion('opencode 0.4.1')).toBe('0.4.1')
  })
  it('抓 prerelease "v2.0.0-beta.1"', () => {
    expect(parseVersion('v2.0.0-beta.1')).toBe('2.0.0-beta.1')
  })
  it('多行输出取第一个 semver', () => {
    expect(parseVersion('codex-cli\nversion 0.114.0\nbuild x')).toBe('0.114.0')
  })
  it('无版本返回 null', () => {
    expect(parseVersion('command not found')).toBeNull()
  })
})

describe('opencodeNativeCandidates', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd'

  it('x64 主机优先 x64 → x64-baseline → arm64', () => {
    const c = opencodeNativeCandidates(shim, 'x64')
    const pkgs = c.filter((p) => p.includes('AppData')).map((p) => p.match(/opencode-windows-[\w-]+/)?.[0])
    // 至少前三个（同一 root 下）按优先级排列
    expect(pkgs.slice(0, 3)).toEqual([
      'opencode-windows-x64',
      'opencode-windows-x64-baseline',
      'opencode-windows-arm64',
    ])
  })

  it('arm64 主机优先 arm64', () => {
    const c = opencodeNativeCandidates(shim, 'arm64')
    const first = c[0].match(/opencode-windows-[\w-]+/)?.[0]
    expect(first).toBe('opencode-windows-arm64')
  })

  it('候选路径指向 opencode-ai 包内 bin/opencode.exe', () => {
    const c = opencodeNativeCandidates(shim, 'x64')
    expect(c.every((p) => p.includes('opencode-ai') && p.endsWith('opencode.exe'))).toBe(true)
  })

  it('同时探两个 root（bin 目录 与 其父目录）', () => {
    const c = opencodeNativeCandidates(shim, 'x64')
    // 3 个 arch × 2 个 root = 6 个候选
    expect(c.length).toBe(6)
  })
})
