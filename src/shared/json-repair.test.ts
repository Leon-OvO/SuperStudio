import { describe, it, expect } from 'vitest'
import { parseJsonLoose } from './json-repair'

describe('repairUnescapedQuotes / parseJsonLoose', () => {
  it('repairs unescaped ASCII quotes used as Chinese 引号 inside values', () => {
    const broken = '[{"sheet":"KW8","action":"set_cell","params":{"cell":"A1","value":"进口美妆"代理商"判定"}}]'
    expect(() => JSON.parse(broken)).toThrow()
    const fixed = parseJsonLoose<Array<{ params: { value: string } }>>(broken)
    expect(fixed[0].params.value).toBe('进口美妆"代理商"判定')
  })

  it('leaves valid JSON unchanged', () => {
    const valid = '[{"sheet":"S1","action":"set_range","params":{"startCell":"A1","data":[["序号","平台"]]}}]'
    expect(JSON.stringify(parseJsonLoose(valid))).toBe(JSON.stringify(JSON.parse(valid)))
  })

  it('keeps already-escaped nested quotes intact', () => {
    const escaped = '[{"v":"他说\\"好\\"然后走了"}]'
    expect(parseJsonLoose<Array<{ v: string }>>(escaped)[0].v).toBe('他说"好"然后走了')
  })

  it('throws the original error when even repair cannot parse', () => {
    expect(() => parseJsonLoose('[{"a": ')).toThrow()
  })
})
