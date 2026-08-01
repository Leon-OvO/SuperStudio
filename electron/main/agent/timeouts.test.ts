import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_TOOLS_TIMEOUT_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
} from './timeouts'

const MAIN_DIR = path.resolve(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(MAIN_DIR, rel), 'utf8')

/**
 * 这三条是「防漂移」测试，不是在测常量本身。
 *
 * 背景：同一个 MCP 服务器有两条到达路径（进程内引擎 services/mcp.ts、外部 CLI 运行时
 * worker/runtime/*），历史上两边各抄了一份超时常量并且漂移了 —— 一次实测 178s 的出图
 * 工具走 CLI（300s）成功、走内置引擎（120s）被判超时甚至重发，白烧一次三分钟的出图。
 * 只要有人在调用点写回本地字面量，下面的用例就会变红。
 */
describe('MCP 超时常量的单一真相源', () => {
  const CONSUMERS = [
    'services/mcp.ts',
    'worker/runtime/claude-runtime.ts',
    'worker/runtime/opencode-runtime.ts',
  ]

  it('三个调用点都从 agent/timeouts 取值，没有一个自带数字字面量', () => {
    for (const rel of CONSUMERS) {
      const src = read(rel)
      expect(src, `${rel} 应从 agent/timeouts 引入超时常量`).toMatch(
        /from '(\.\.\/)+agent\/timeouts'/
      )
      // `const XXX_TIMEOUT_MS = 120_000` 这类本地字面量正是漂移的来源。
      const literals = src.match(/const\s+\w*TIMEOUT\w*\s*=\s*[\d_]+/g) ?? []
      expect(literals, `${rel} 不应自带超时数字字面量`).toEqual([])
    }
  })

  it('工具调用上限不低于生图自身的上限，否则正常出图会被判超时', () => {
    const imageSrc = read('services/image.ts')
    const m = imageSrc.match(/IMAGE_GEN_TIMEOUT_MS\s*=\s*([\d_]+)/)
    expect(m, 'services/image.ts 里应能找到 IMAGE_GEN_TIMEOUT_MS').not.toBeNull()
    const imageCap = Number(m![1].replace(/_/g, ''))
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(imageCap)
  })

  it('握手/列表是廉价往返，必须远短于一次工具调用', () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBeLessThan(MCP_TOOL_CALL_TIMEOUT_MS)
    expect(MCP_LIST_TOOLS_TIMEOUT_MS).toBeLessThan(MCP_CONNECT_TIMEOUT_MS)
  })
})
