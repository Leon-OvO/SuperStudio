import { describe, it, expect } from 'vitest'
import { reconcileGrounding } from './grounding'

const ok = (toolName: string, result: unknown) => ({ toolName, args: {}, result })
const err = (toolName: string, msg = 'boom') => ({ toolName, args: {}, result: { error: msg } })

describe('reconcileGrounding — unbacked action claims', () => {
  it('flags a file claim with no successful write tool', () => {
    const f = reconcileGrounding('已为你生成 Excel 文件并保存到桌面。', [])
    expect(f.unbackedActions).toContain('生成/保存文件')
  })
  it('does NOT flag a file claim backed by a successful write', () => {
    const f = reconcileGrounding('已生成报告文件。', [ok('write_text_file', { path: 'D:/r.html', modified: 'D:/r.html' })])
    expect(f.unbackedActions).toHaveLength(0)
  })
  it('treats an errored tool as NOT success (claim still unbacked)', () => {
    const f = reconcileGrounding('已生成报告文件。', [err('write_text_file')])
    expect(f.unbackedActions).toContain('生成/保存文件')
  })
  it('flags 发布 with no publish/upload tool', () => {
    expect(reconcileGrounding('已发布到小红书。', []).unbackedActions).toContain('发布/上传')
    expect(reconcileGrounding('已发布到小红书。', [ok('xhs_publish', { ok: true })]).unbackedActions).toHaveLength(0)
  })
  it('flags 根据搜索结果 with no web tool', () => {
    expect(reconcileGrounding('根据搜索结果，最新版本是 5.0。', []).unbackedActions).toContain('搜索/检索')
    expect(reconcileGrounding('根据搜索结果，最新版本是 5.0。', [ok('web_search', { results: [{ url: 'https://x.com' }] })]).unbackedActions).toHaveLength(0)
  })
  it('accepts an artifact produced by a non-builtin (MCP) tool via produced path', () => {
    const f = reconcileGrounding('已生成图片。', [ok('mcp__draw', { images: [{ path: 'a.png' }] })])
    expect(f.unbackedActions).toHaveLength(0)
  })
  it('flags 已执行脚本 with no run_script/ssh_exec/bash call (the "贴脚本给用户代跑" anti-pattern)', () => {
    expect(reconcileGrounding('我已执行脚本，结果如下。', []).unbackedActions).toContain('执行脚本/命令')
    expect(reconcileGrounding('已运行 Python 脚本完成统计。', [ok('file_read', { content: 'x' })]).unbackedActions).toContain('执行脚本/命令')
  })
  it('does NOT flag 已执行脚本 backed by a successful run_script (even non-zero exit = it DID run)', () => {
    expect(reconcileGrounding('已执行脚本。', [ok('run_script', { code: 0, stdout: 'ok' })]).unbackedActions).toHaveLength(0)
    expect(reconcileGrounding('已在服务器上执行命令。', [ok('ssh_exec', { exitCode: 0, stdout: 'ok' })]).unbackedActions).toHaveLength(0)
  })
  it('accepts a local 查到/检索 claim backed by file_read (xlsx value-search counts as retrieval)', () => {
    expect(reconcileGrounding('已查到该 ID 所在行。', [ok('file_read', { content: '行6: ...' })]).unbackedActions).toHaveLength(0)
  })
})

describe('reconcileGrounding — does not false-flag', () => {
  it('ignores negated / hypothetical claims', () => {
    expect(reconcileGrounding('我还没生成文件。', []).unbackedActions).toHaveLength(0)
    expect(reconcileGrounding('无法打开网页。', []).unbackedActions).toHaveLength(0)
    expect(reconcileGrounding('如果搜索结果不够，我再试。', []).unbackedActions).toHaveLength(0)
  })
  it('ignores plain answers with no action claim', () => {
    expect(reconcileGrounding('这是一段普通的解释，没有声称做了什么。', []).unbackedActions).toHaveLength(0)
  })
  it('empty text → no findings', () => {
    expect(reconcileGrounding('', [ok('web_search', {})]).unbackedActions).toHaveLength(0)
  })
})

describe('reconcileGrounding — fabricated URLs (debug-only signal)', () => {
  it('flags a printed URL not in the gathered web evidence', () => {
    const f = reconcileGrounding('详见 https://fake.example.com/page', [ok('web_search', { results: [{ url: 'https://real.example.com/a' }] })])
    expect(f.fabricatedUrls.some(u => u.includes('fake.example.com'))).toBe(true)
  })
  it('does NOT flag URLs when there is no web evidence (may be user/memory provided)', () => {
    const f = reconcileGrounding('参考 https://whatever.com', [])
    expect(f.fabricatedUrls).toHaveLength(0)
  })
  it('does NOT flag a printed URL that matches the evidence', () => {
    const f = reconcileGrounding('来源 https://real.example.com/a', [ok('web_open', { finalUrl: 'https://real.example.com/a' })])
    expect(f.fabricatedUrls).toHaveLength(0)
  })
})
