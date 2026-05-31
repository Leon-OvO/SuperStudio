import crypto from 'node:crypto'

/**
 * Decrypt the bundled talent-pool.enc produced by scripts/pack-talent.mjs.
 *
 * OBFUSCATION ONLY: the key is embedded in the shipped app, so this stops casual
 * copying of the soul prompts from the install directory — it is NOT real
 * protection against a motivated attacker (the key ships too). Confirmed
 * acceptable with the product owner; real gating would require a server.
 *
 * Key + layout MUST stay in sync with scripts/pack-talent.mjs:
 *   bundle = [12B iv][16B authTag][ciphertext]  (AES-256-GCM)
 */
const KEY = Buffer.from('5f3a9c1e8d7b6a4f2031e5c7a9b8d6f40c2e1a3b5d7f9081726354adef012345', 'hex')

export function decryptTalent(bundle: Buffer): string {
  const iv = bundle.subarray(0, 12)
  const tag = bundle.subarray(12, 28)
  const data = bundle.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
