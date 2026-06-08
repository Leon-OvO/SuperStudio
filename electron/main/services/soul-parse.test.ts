import { describe, it, expect } from 'vitest'
import { parseSoulMd } from './soul-parse'

describe('parseSoulMd', () => {
  it('parses a SuperStudio-style soul.md (frontmatter + body)', () => {
    const md = [
      '---',
      'name: 前端工程师',
      'description: 专注 React 的前端开发',
      'model: Sonnet',
      'tools: web_open, file_write',
      '---',
      '你是一名资深前端工程师，精通 React 与 TypeScript。',
    ].join('\n')
    const s = parseSoulMd(md, 'frontend.md')
    expect(s.name).toBe('前端工程师')
    expect(s.description).toBe('专注 React 的前端开发')
    expect(s.recModel).toBe('sonnet')                 // lowercased
    expect(s.tools).toEqual(['web_open', 'file_write']) // comma string → array
    expect(s.dept).toBe('engineering')
    expect(s.systemPrompt).toContain('资深前端工程师')
  })

  it('handles a plain Markdown SOUL.md with NO frontmatter', () => {
    const md = [
      '# Identity',
      'You are Aria, a meticulous QA engineer.',
      '# Style',
      'Be terse and test-driven.',
    ].join('\n')
    const s = parseSoulMd(md, 'aria-soul.md')
    expect(s.name).toBe('Identity')                   // first heading
    expect(s.recModel).toBe('')                       // no model → empty
    expect(s.tools).toEqual([])
    expect(s.dept).toBe('qa')                         // heuristic on "QA engineer"
    expect(s.systemPrompt).toContain('meticulous QA engineer') // whole file is the persona
    expect(s.systemPrompt).toContain('# Style')
  })

  it('maps OpenClaw-style rich frontmatter (allowed-tools, list) + name fallback to filename', () => {
    const md = [
      '---',
      'preamble-tier: 2',
      'version: 1.0',
      'allowed-tools:',
      '  - read',
      '  - write',
      'triggers: [deploy, ship]',
      '---',
      'Operate as a release orchestrator. OPENCLAW_SESSION drives the loop.',
    ].join('\n')
    const s = parseSoulMd(md, 'release_orchestrator.md')
    expect(s.name).toBe('Release Orchestrator')       // no name/heading → prettified filename
    expect(s.tools).toEqual(['read', 'write'])        // allowed-tools (list) → tools
    expect(s.systemPrompt).toContain('release orchestrator')
  })

  it('falls back to the whole file when frontmatter exists but body is empty', () => {
    const md = '---\nname: Solo\n---\n'
    const s = parseSoulMd(md, 'solo.md')
    expect(s.name).toBe('Solo')
    expect(s.systemPrompt.length).toBeGreaterThan(0)
  })
})
