import { describe, it, expect } from 'vitest'
import {
  buildAutoTitle,
  computeToolAllowSet,
  parseSizeFromMessage,
  friendlyError,
  topologicalSort,
  topologicalLevels,
  flattenMcpTools,
  truncateToolResult,
  estimateTokens,
  trimHistoryToBudget,
  looksTruncated
} from './pure'

describe('buildAutoTitle', () => {
  it('trims whitespace/newlines and clamps to 22 chars with ellipsis', () => {
    expect(buildAutoTitle('hello\n\n  world', false, false)).toBe('hello world')
    const long = 'a'.repeat(30)
    expect(buildAutoTitle(long, false, false)).toBe('a'.repeat(22) + '…')
  })
  it('prefixes media turns', () => {
    expect(buildAutoTitle('cat', true, false)).toBe('🖼 cat')
    expect(buildAutoTitle('cat', false, true)).toBe('🎬 cat')
    // image flag wins when both set
    expect(buildAutoTitle('cat', true, true)).toBe('🖼 cat')
  })
})

describe('computeToolAllowSet', () => {
  const skill = (toolWhitelist: string[] | undefined) => ({ toolWhitelist } as Parameters<typeof computeToolAllowSet>[0][number])
  it('returns null when no skills active (no filter)', () => {
    expect(computeToolAllowSet([])).toBeNull()
  })
  it('returns null if any active skill is unrestricted', () => {
    expect(computeToolAllowSet([skill(['web_search']), skill(undefined)])).toBeNull()
  })
  it('unions whitelists from all restricted skills', () => {
    const set = computeToolAllowSet([skill(['web_search']), skill(['file_read', 'web_search'])])
    expect(set).toEqual(new Set(['web_search', 'file_read']))
  })
})

describe('parseSizeFromMessage', () => {
  it('extracts explicit WxH (x, X, or ×)', () => {
    expect(parseSizeFromMessage('给我 1280x720 的图')).toBe('1280x720')
    expect(parseSizeFromMessage('1024×1536 竖图')).toBe('1024x1536')
  })
  it('maps portrait/landscape hints', () => {
    expect(parseSizeFromMessage('画一张竖版海报')).toBe('1024x1792')
    expect(parseSizeFromMessage('a landscape photo')).toBe('1792x1024')
  })
  it('defaults to square', () => {
    expect(parseSizeFromMessage('一只猫')).toBe('1024x1024')
  })
})

describe('friendlyError', () => {
  it('maps known status families', () => {
    expect(friendlyError('Error 429 too many requests')).toContain('429')
    expect(friendlyError('invalid api key')).toContain('401')
    expect(friendlyError('model not found')).toContain('404')
    expect(friendlyError('maximum context length exceeded')).toContain('上下文')
  })
  it('falls back to message + cause for unknown errors', () => {
    expect(friendlyError('weird', 'boom')).toBe('weird\n原因：boom')
    expect(friendlyError('weird')).toBe('weird')
  })
})

describe('topologicalSort', () => {
  it('orders a simple DAG', () => {
    const order = topologicalSort(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]
    )
    expect(order).toEqual(['a', 'b', 'c'])
  })
  it('includes disconnected nodes and ignores edges to unknown nodes', () => {
    const order = topologicalSort(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'ghost' }]
    )
    expect(order.sort()).toEqual(['a', 'b'])
  })
  it('drops nodes stuck in a cycle', () => {
    const order = topologicalSort(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]
    )
    expect(order).toEqual([])
  })
})

describe('topologicalLevels', () => {
  it('groups independent nodes into the same level (diamond)', () => {
    // a → b, a → c, b → d, c → d
    const levels = topologicalLevels(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' }
      ]
    )
    expect(levels[0]).toEqual(['a'])
    expect(levels[1].sort()).toEqual(['b', 'c'])
    expect(levels[2]).toEqual(['d'])
  })
})

describe('flattenMcpTools', () => {
  it('builds qualified names slug__tool and defaults inputSchema', () => {
    const tools = flattenMcpTools('srv1', 'My Server', 'my-server', [
      { name: 'do_thing', description: 'd', inputSchema: { type: 'object', properties: { x: {} } } },
      { name: 'bare' }
    ])
    expect(tools[0].qualifiedName).toBe('my-server__do_thing')
    expect(tools[0].serverId).toBe('srv1')
    expect(tools[1].inputSchema).toEqual({ type: 'object', properties: {} })
  })
})

describe('estimateTokens / trimHistoryToBudget', () => {
  it('estimateTokens ≈ chars/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(401))).toBe(101)
  })
  it('keeps newest turns within budget, drops oldest', () => {
    const hist = [
      { role: 'user', content: 'A'.repeat(400) },   // ~100 tok
      { role: 'assistant', content: 'B'.repeat(400) }, // ~100 tok
      { role: 'user', content: 'C'.repeat(400) }    // ~100 tok
    ]
    const kept = trimHistoryToBudget(hist, 150) // room for ~1 turn + the newest
    expect(kept[kept.length - 1].content[0]).toBe('C') // newest preserved
    expect(kept.length).toBeLessThan(3)
  })
  it('always keeps the most recent message even if it alone exceeds budget', () => {
    const kept = trimHistoryToBudget([{ role: 'user', content: 'X'.repeat(4000) }], 1)
    expect(kept).toHaveLength(1)
  })
})

describe('truncateToolResult', () => {
  it('returns short strings unchanged', () => {
    expect(truncateToolResult('hi', 100)).toBe('hi')
  })
  it('truncates long strings with a marker', () => {
    const out = truncateToolResult('x'.repeat(50), 10) as string
    expect(out.startsWith('x'.repeat(10))).toBe(true)
    expect(out).toContain('truncated 40 chars')
  })
  it('passes through small objects, stringifies+truncates large ones', () => {
    const small = { a: 1 }
    expect(truncateToolResult(small, 100)).toBe(small)
    const big = { blob: 'y'.repeat(200) }
    const out = truncateToolResult(big, 20)
    expect(typeof out).toBe('string')
    expect(out as string).toContain('truncated')
  })
})

describe('looksTruncated', () => {
  it('flags placeholder / "rest unchanged" stubs', () => {
    expect(looksTruncated('function a(){}\n// ... rest of the code unchanged')).toBe(true)
    expect(looksTruncated('<html>\n<!-- ... 其余省略 ... -->\n</html>')).toBe(true)
    expect(looksTruncated('def f():\n    pass\n# ...remaining unchanged')).toBe(true)
    expect(looksTruncated('第一部分内容……\n（其余代码保持不变）')).toBe(true)
    expect(looksTruncated('前面略\n以下省略')).toBe(true)
    expect(looksTruncated('/* ...rest of the file unchanged */')).toBe(true)
    expect(looksTruncated('// (rest of the implementation here)')).toBe(true)
    expect(looksTruncated('表头...\n省略其余若干行')).toBe(true)
  })
  it('does NOT flag legitimate complete content', () => {
    expect(looksTruncated('')).toBe(false)
    expect(looksTruncated('const a = 1\nconst b = 2\nexport { a, b }')).toBe(false)
    // ellipsis used in normal prose (no rest/省略 truncation idiom)
    expect(looksTruncated('他停顿了一下……然后继续说话。')).toBe(false)
    expect(looksTruncated('# 标题\n\n这是一份完整的报告，分析了其余竞争对手的表现。')).toBe(false)
    expect(looksTruncated('Loading... please wait')).toBe(false)
    expect(looksTruncated('TODO: implement the rest later')).toBe(false)
  })
})
