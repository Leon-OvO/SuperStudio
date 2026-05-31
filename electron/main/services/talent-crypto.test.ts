import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { decryptTalent } from './talent-crypto'

// Same key + layout as scripts/pack-talent.mjs and talent-crypto.ts.
const KEY = Buffer.from('5f3a9c1e8d7b6a4f2031e5c7a9b8d6f40c2e1a3b5d7f9081726354adef012345', 'hex')
function encrypt(text: string): Buffer {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc])
}

describe('talent-crypto', () => {
  it('round-trips AES-256-GCM with the [iv][tag][ct] layout', () => {
    const payload = JSON.stringify({ version: 1, entries: [{ id: 'x/y', systemPrompt: '你好' }] })
    expect(decryptTalent(encrypt(payload))).toBe(payload)
  })

  it('throws on a tampered bundle (auth tag mismatch)', () => {
    const buf = encrypt('secret')
    buf[buf.length - 1] ^= 0xff // corrupt last ciphertext byte
    expect(() => decryptTalent(buf)).toThrow()
  })

  it('decrypts the shipped talent-pool.enc when present (≈840 entries with prompts)', () => {
    const file = path.resolve(__dirname, '../../../resources/talent-pool.enc')
    if (!fs.existsSync(file)) return // build artifact may be absent in CI; skip
    const json = JSON.parse(decryptTalent(fs.readFileSync(file))) as { count: number; entries: Array<{ systemPrompt: string }> }
    expect(json.entries.length).toBeGreaterThan(500)
    expect(json.entries.every(e => typeof e.systemPrompt === 'string' && e.systemPrompt.length > 0)).toBe(true)
  })
})
