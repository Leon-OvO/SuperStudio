import { describe, it, expect } from 'vitest'
import { scrubAddresses } from './scrub'

describe('scrubAddresses', () => {
  it('strips scheme URLs', () => {
    expect(scrubAddresses('打开 https://api.supercode.help/v1/chat 失败')).toBe('打开 [链接] 失败')
    expect(scrubAddresses('see http://x.com/a?b=1#c here')).toBe('see [链接] here')
    expect(scrubAddresses('ws://example.net:8080/sock')).toBe('[链接]')
  })

  it('strips file URLs', () => {
    expect(scrubAddresses('file:///F:/proj/a.png')).toBe('[链接]')
    expect(scrubAddresses('local-file:///F:/x.jpg done')).toBe('[链接] done')
  })

  it('strips IPv4 (with optional port) and localhost', () => {
    expect(scrubAddresses('connect 1.2.3.4:8080 now')).toBe('connect [地址] now')
    expect(scrubAddresses('host 10.0.0.1')).toBe('host [地址]')
    expect(scrubAddresses('dev server localhost:5173 up')).toBe('dev server [地址] up')
  })

  it('strips bare domains ending in a curated TLD', () => {
    expect(scrubAddresses('reach api.supercode.help fast')).toBe('reach [地址] fast')
    expect(scrubAddresses('foo.com and bar.cn')).toBe('[地址] and [地址]')
    expect(scrubAddresses('host www.example.net:443/path x')).toBe('host [地址] x')
  })

  it('does NOT touch ordinary file names / paths', () => {
    expect(scrubAddresses('编辑 vibe.ts 完成')).toBe('编辑 vibe.ts 完成')
    expect(scrubAddresses('wrote index.html and main.py')).toBe('wrote index.html and main.py')
    expect(scrubAddresses('styles.css app.tsx data.json README.md')).toBe('styles.css app.tsx data.json README.md')
    // ambiguous-with-directory TLDs stay untouched when bare (no scheme)
    expect(scrubAddresses('build to dist/ then foo.app')).toBe('build to dist/ then foo.app')
  })

  it('handles empty / nullish input', () => {
    expect(scrubAddresses('')).toBe('')
    expect(scrubAddresses(null)).toBe('')
    expect(scrubAddresses(undefined)).toBe('')
  })
})
