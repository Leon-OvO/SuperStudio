import { describe, it, expect } from 'vitest'
import { parseJsonLoose, repairBadEscapes, extractJson } from './json-repair'

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

  it('repairs an unescaped Windows path (bad backslash escape)', () => {
    // The exact "Bad escaped character" failure: a lone backslash before a
    // non-escape char (here a drive path inside a value).
    const broken = '[{"params":{"value":"导出到 D:\\Administrator\\Desktop\\周报.xlsx"}}]'
    expect(() => JSON.parse(broken)).toThrow()
    const fixed = parseJsonLoose<Array<{ params: { value: string } }>>(broken)
    expect(fixed[0].params.value).toBe('导出到 D:\\Administrator\\Desktop\\周报.xlsx')
  })

  it('keeps valid \\n / \\t / \\uXXXX escapes intact while fixing bad ones', () => {
    const s = '[{"v":"行1\\n行2\\t制表\\u0041 但坏的\\x转义"}]'
    const fixed = parseJsonLoose<Array<{ v: string }>>(s)
    expect(fixed[0].v).toBe('行1\n行2\t制表A 但坏的\\x转义')
  })

  it('repairBadEscapes leaves clean JSON unchanged', () => {
    const clean = '[{"a":"x\\ny","b":1}]'
    expect(repairBadEscapes(clean)).toBe(clean)
  })
})

describe('extractJson', () => {
  it('strips a ```json fence', () => {
    expect(extractJson('```json\n{"kind":"discuss"}\n```')).toBe('{"kind":"discuss"}')
  })
  it('strips a bare ``` fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('drops prose preamble and postamble around the object', () => {
    expect(extractJson('好的，这是规划：{"kind":"collaborate","steps":[]}。希望有帮助')).toBe('{"kind":"collaborate","steps":[]}')
  })
  it('handles preamble + fenced object together', () => {
    expect(extractJson('规划如下：\n```json\n{"x":1}\n```')).toBe('{"x":1}')
  })
  it('extracts a top-level array', () => {
    expect(extractJson('结果：[1,2,3] 完成')).toBe('[1,2,3]')
  })
  it('leaves clean JSON unchanged and is parseable', () => {
    const s = '{"kind":"discuss","steps":[{"employeeId":"e1","task":""}]}'
    expect(extractJson(s)).toBe(s)
    expect(parseJsonLoose(extractJson(s))).toEqual({ kind: 'discuss', steps: [{ employeeId: 'e1', task: '' }] })
  })
  it('returns trimmed text unchanged when no JSON present', () => {
    expect(extractJson('  抱歉，我无法完成  ')).toBe('抱歉，我无法完成')
  })
})
