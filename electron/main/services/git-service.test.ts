import { describe, it, expect } from 'vitest'
import { splitFileDiff, buildHunkPatch, countHunks, hunkFingerprint, hunkFingerprints } from './git-service'

const TWO_HUNK_DIFF = `diff --git a/foo.txt b/foo.txt
index 0000001..0000002 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3
@@ -10,2 +10,3 @@
 line10
+inserted
 line11`

describe('splitFileDiff', () => {
  it('separates the header from per-hunk blocks', () => {
    const { header, hunks } = splitFileDiff(TWO_HUNK_DIFF)
    expect(header.split('\n')).toEqual([
      'diff --git a/foo.txt b/foo.txt',
      'index 0000001..0000002 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
    ])
    expect(hunks).toHaveLength(2)
    expect(hunks[0].startsWith('@@ -1,3 +1,3 @@')).toBe(true)
    expect(hunks[1].startsWith('@@ -10,2 +10,3 @@')).toBe(true)
    expect(hunks[0]).toContain('+line2-changed')
    expect(hunks[1]).toContain('+inserted')
  })

  it('handles an empty diff', () => {
    expect(splitFileDiff('')).toEqual({ header: '', hunks: [] })
    expect(splitFileDiff('   \n  ')).toEqual({ header: '', hunks: [] })
  })

  it('handles a header with no hunks', () => {
    const d = 'diff --git a/x b/x\nindex 1..2 100644'
    expect(splitFileDiff(d)).toEqual({ header: d, hunks: [] })
  })
})

describe('countHunks', () => {
  it('counts @@ blocks', () => {
    expect(countHunks(TWO_HUNK_DIFF)).toBe(2)
    expect(countHunks('')).toBe(0)
  })
})

describe('buildHunkPatch', () => {
  it('emits header + the chosen hunk, newline-terminated', () => {
    const p0 = buildHunkPatch(TWO_HUNK_DIFF, 0)!
    expect(p0).toContain('--- a/foo.txt')
    expect(p0).toContain('+++ b/foo.txt')
    expect(p0).toContain('@@ -1,3 +1,3 @@')
    expect(p0).toContain('+line2-changed')
    // Must NOT include the second hunk.
    expect(p0).not.toContain('+inserted')
    expect(p0.endsWith('\n')).toBe(true)

    const p1 = buildHunkPatch(TWO_HUNK_DIFF, 1)!
    expect(p1).toContain('@@ -10,2 +10,3 @@')
    expect(p1).toContain('+inserted')
    expect(p1).not.toContain('+line2-changed')
  })

  it('returns null for out-of-range indices', () => {
    expect(buildHunkPatch(TWO_HUNK_DIFF, 2)).toBe(null)
    expect(buildHunkPatch(TWO_HUNK_DIFF, -1)).toBe(null)
    expect(buildHunkPatch('', 0)).toBe(null)
  })
})

describe('hunkFingerprint', () => {
  const HUNK = '@@ -10,2 +10,3 @@\n line10\n+inserted\n line11'

  it('同一块整体位移后仍是同一个指纹', () => {
    // 前面的块变长/变短只会改起始行号，本块内容没变，必须还认得出来。
    const moved = HUNK.replace('@@ -10,2 +10,3 @@', '@@ -37,2 +41,3 @@')
    expect(hunkFingerprint(moved)).toBe(hunkFingerprint(HUNK))
  })

  it('正文改一个字符就是另一个指纹', () => {
    expect(hunkFingerprint(HUNK.replace('+inserted', '+inserted!'))).not.toBe(hunkFingerprint(HUNK))
    // 行数（不是行号）变了也算另一块。
    expect(hunkFingerprint(HUNK.replace('@@ -10,2 +10,3 @@', '@@ -10,2 +10,4 @@'))).not.toBe(hunkFingerprint(HUNK))
    // `@@` 后面的函数上下文变了同样算另一块。
    expect(hunkFingerprint(`${HUNK.split('\n')[0]} func foo()`)).not.toBe(hunkFingerprint(HUNK.split('\n')[0]))
  })

  it('两个内容不同的块指纹不同，且长度稳定', () => {
    const fps = hunkFingerprints(TWO_HUNK_DIFF)
    expect(fps).toHaveLength(2)
    expect(fps[0]).not.toBe(fps[1])
    expect(fps[0]).toMatch(/^[0-9a-f]{12}$/)
    expect(hunkFingerprints('')).toEqual([])
  })
})
