import { describe, it, expect } from 'vitest'
import { redactSecrets, REDACT_PATTERN_COUNT } from './redact'

describe('redactSecrets', () => {
  it('不误伤 task- / disk- / risk- 这类含 sk 子串的普通词', () => {
    const s = 'task-123 完成，disk-usage 正常，risk-level 低'
    expect(redactSecrets(s)).toBe(s)
  })

  it('脱敏 sk- 形状的 key（裸值场景，不带 key: 前缀）', () => {
    const s = '密钥泄漏在日志里：sk-abcdefghijklmnop1234567890 请立即撤销'
    const out = redactSecrets(s)
    expect(out).not.toContain('abcdefghijklmnop1234567890')
    expect(out).toContain('sk-<redacted>')
  })

  it('脱敏 xai- / glpat- / xox[abp]- / AIza / github_pat_', () => {
    expect(redactSecrets('xai-1234567890abcdef1234')).toContain('xai-<redacted>')
    expect(redactSecrets('glpat-1234567890abcdef1234')).toContain('glpat-<redacted>')
    expect(redactSecrets('xoxb-1234567890-abcdefghij')).toContain('<redacted-slack-token>')
    expect(redactSecrets('AIzaSyD1234567890abcdefghijklmnopqrstu')).toContain('AIza<redacted>')
    expect(redactSecrets('github_pat_11ABCDEFG1234567890abcdefghijk')).toContain('github_pat_<redacted>')
  })

  it('脱敏 PEM 块', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----'
    const out = redactSecrets(`cert:\n${pem}`)
    expect(out).not.toContain('MIIBOgIBAAJBAK')
    expect(out).toContain('<redacted>')
  })

  it('脱敏 key: value / key=value / Bearer 形态', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).toContain('Authorization=<redacted>')
    expect(redactSecrets('password=SuperSecret123!')).toContain('password=<redacted>')
  })

  it('URL 用结构化重写：清 userinfo、丢弃 hash、脱敏敏感 query', () => {
    const out = redactSecrets('见 https://user:pass@api.example.com/v1/models?key=sk-realkeyvalue1234&foo=bar#frag')
    expect(out).not.toContain('user:pass')
    expect(out).not.toContain('frag')
    expect(out).not.toContain('sk-realkeyvalue1234')
    expect(out).toContain('foo=bar')
  })

  it('无密钥形状的普通文本原样返回（同一引用，零分配）', () => {
    const s = '这是一段普通的日志文本，没有任何敏感信息。'
    expect(redactSecrets(s)).toBe(s)
  })

  it('模式数量 tripwire：新增/删除脱敏模式时必须同步更新此断言', () => {
    // 当前：1 条 KV_PATTERN + N 条 SHAPE_PATTERNS + 1 条 PEM_PATTERN
    expect(REDACT_PATTERN_COUNT).toBe(12)
  })
})
