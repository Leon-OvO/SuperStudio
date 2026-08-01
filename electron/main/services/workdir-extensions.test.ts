import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanWorkdirSkills, readWorkdirMcpConfigs, sanitizeWorkdirEnv } from './workdir-extensions'

// 工作目录扩展 = 第三方不可信输入，本组测试锁的是「只降权不提权 + fail closed」。

let root = ''

function makeSkill(name: string, body = '# 示例技能\n\n正文'): string {
  const dir = path.join(root, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试用\n---\n\n${body}`, 'utf8')
  return dir
}

function writeMcp(obj: unknown): void {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(obj), 'utf8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wdext-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }
})

describe('scanWorkdirSkills', () => {
  it('工作目录技能不得比用户手动安装的技能权限更大：allowScripts 必须为 false', () => {
    makeSkill('demo')
    const skills = scanWorkdirSkills(root, 'chat')
    expect(skills).toHaveLength(1)
    expect(skills[0].allowScripts).toBe(false)
  })

  it('SKILL.md 本身是符号链接时不加载（清单文件也要用 lstat 判定）', () => {
    const dir = path.join(root, '.claude', 'skills', 'linked')
    fs.mkdirSync(dir, { recursive: true })
    const real = path.join(root, 'real-skill.md')
    fs.writeFileSync(real, '---\nname: linked\ndescription: 指向外部\n---\n正文', 'utf8')
    try {
      fs.symlinkSync(real, path.join(dir, 'SKILL.md'), 'file')
    } catch {
      // Windows 未开开发者模式时无权建符号链接 —— 跳过而不是假通过
      return
    }
    expect(scanWorkdirSkills(root, 'chat')).toEqual([])
  })

  it('清单存在却读不出来时整批放弃（fail closed，不做部分加载）', () => {
    makeSkill('good')
    makeSkill('zbad')
    const real = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      // 模拟其中一个 bundle 的清单不可读（权限/占用/损坏）
      if (typeof p === 'string' && p.includes(`${path.sep}zbad${path.sep}`)) throw new Error('EACCES')
      return (real as (...a: unknown[]) => unknown)(p, ...rest)
    }) as unknown as typeof fs.readFileSync)
    expect(scanWorkdirSkills(root, 'chat')).toEqual([])
  })
})

describe('sanitizeWorkdirEnv', () => {
  it('剔除名字像密钥/口令/令牌的变量，保留普通变量', () => {
    const { env, dropped } = sanitizeWorkdirEnv({
      OPENAI_API_KEY: 'sk-x',
      MY_SECRET: '1',
      GH_TOKEN: '2',
      DB_PASSWORD: '3',
      AUTHORIZATION: '4',
      LOG_LEVEL: 'debug'
    })
    expect(env).toEqual({ LOG_LEVEL: 'debug' })
    expect(dropped.sort()).toEqual(['AUTHORIZATION', 'DB_PASSWORD', 'GH_TOKEN', 'MY_SECRET', 'OPENAI_API_KEY'])
  })

  it('全被剔除时返回 undefined 而不是空对象', () => {
    expect(sanitizeWorkdirEnv({ API_KEY: 'x' }).env).toBeUndefined()
  })
})

describe('readWorkdirMcpConfigs', () => {
  it('工作目录声明的敏感环境变量被剔除，普通变量保留', () => {
    writeMcp({ mcpServers: { demo: { command: 'node', args: ['s.js'], env: { API_KEY: 'sk-x', LOG_LEVEL: 'debug' } } } })
    const cfgs = readWorkdirMcpConfigs(root)
    expect(cfgs).toHaveLength(1)
    expect(cfgs[0].env).toEqual({ LOG_LEVEL: 'debug' })
  })

  it('任意一条 server 配置不完整 → 整份不加载（fail closed）', () => {
    writeMcp({ mcpServers: { ok: { command: 'node' }, broken: { args: ['x'] } } })
    expect(readWorkdirMcpConfigs(root)).toEqual([])
  })

  it('数组写法里出现无名条目 → 整份不加载', () => {
    writeMcp([{ name: 'ok', command: 'node' }, { command: 'node' }])
    expect(readWorkdirMcpConfigs(root)).toEqual([])
  })

  it('显式禁用的条目只是跳过，不触发 fail closed', () => {
    writeMcp({ mcpServers: { off: { command: 'node', disabled: true }, on: { command: 'node' } } })
    expect(readWorkdirMcpConfigs(root).map(c => c.name)).toEqual(['on'])
  })

  it('JSON 解析失败返回空', () => {
    fs.writeFileSync(path.join(root, '.mcp.json'), '{ 坏掉的 json', 'utf8')
    expect(readWorkdirMcpConfigs(root)).toEqual([])
  })
})

vi.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getVersion: () => '0.0.0', on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  shell: {}, dialog: {}, session: { defaultSession: {} }, nativeImage: {}, desktopCapturer: {}
}))
vi.mock('../index', () => ({ getMainWindow: () => null }))

// ---------------------------------------------------------------------------
// code_edit 匹配诊断
// 暂借本文件：vibe.ts 目前只能连同 electron 一起 mock 才能导入；
// 后续把 diagnoseEditMatch 抽成独立纯模块后，这组用例应迁到它自己的测试文件。
// ---------------------------------------------------------------------------

async function diag() {
  const m = await import('../ipc/vibe')
  return m.diagnoseEditMatch
}

describe('diagnoseEditMatch', () => {
  it('唯一命中不产生诊断', async () => {
    const d = await diag()
    expect(d(['const a = 1', 'const b = 2', ''].join('\n'), 'const b = 2')).toBe('')
  })

  it('未命中时给出最接近的行号与内容', async () => {
    const d = await diag()
    const file = ['function 计算(a, b) {', '  return a + b', '}', '// 别的内容', ''].join('\n')
    const msg = d(file, '  return a - b')
    expect(msg).toContain('未在文件中找到')
    expect(msg).toContain('2: ')
    expect(msg).toContain('return a + b')
  })

  it('归一化后确实能匹配时才提示全角/弯引号', async () => {
    const d = await diag()
    const file = 'const 标题 = “你好，世界”\n'
    const msg = d(file, 'const 标题 = "你好,世界"')
    expect(msg).toContain('全角')
  })

  it('归一化后仍匹配不上就闭嘴，不瞎猜成因', async () => {
    const d = await diag()
    const file = 'const 标题 = "你好"\n'
    const msg = d(file, 'const 副标题 = "再见"')
    expect(msg).not.toContain('全角')
    expect(msg).not.toContain('CRLF')
  })

  it('只有归一化后能匹配时依然判定为未命中（绝不按归一化结果写回）', async () => {
    const d = await diag()
    // 返回非空诊断 = code_edit 拒绝执行，而不是把全角括号当半角替换掉
    expect(d('a（b）c\n', 'a(b)c')).not.toBe('')
  })

  it('CRLF 差异优先提示换行符', async () => {
    const d = await diag()
    const file = 'line1\r\nline2\r\n'
    const msg = d(file, 'line1\nline2')
    expect(msg).toContain('CRLF')
  })

  it('多次命中列出命中行号', async () => {
    const d = await diag()
    const file = ['x', 'foo()', 'y', 'foo()', 'z', ''].join('\n')
    const msg = d(file, 'foo()')
    expect(msg).toContain('匹配了 2 次')
    expect(msg).toContain('命中行号：2、4')
  })

  it('空 oldString 给出明确文案', async () => {
    const d = await diag()
    expect(d('abc', '')).toContain('不能为空')
  })
})

