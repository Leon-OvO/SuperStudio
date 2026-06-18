import fs from 'fs'
import { app } from 'electron'
import type { SshConnection } from '../../../src/shared/ipc-types'

/**
 * Importer for MobaXterm session exports (.mxtsessions).
 *
 * Format: an INI-like file with [Bookmarks] / [Bookmarks_N] sections. Each
 * session is a line `DisplayName=#<type>#<subtype>%host%port%user%…%keyfile…#<font/color block>…`.
 *   - type 109 = SSH (we import these); 91 = RDP and others are skipped.
 *   - In the connection block (between the 2nd and 3rd '#'), split by '%':
 *       [1]=host  [2]=port  [3]=username (sometimes wrapped in [..])
 *     a key-file path may appear later in that block (E:\key, _DesktopDir_\x.pem…).
 *   - Passwords are NOT in the file (MobaXterm keeps them in an encrypted vault),
 *     so imported password-auth connections come in with an empty password to fill.
 * Chinese installs export this file as GBK/ANSI, so we decode as GBK (utf-8 fallback).
 */

export interface ParsedMobaSession {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  /** Key content if we could read the referenced file on this machine. */
  privateKey?: string
  /** Original key path when we referenced a key but couldn't read it. */
  keyHint?: string
  /** Subfolder this session lived in (MobaXterm SubRep leaf), if any. */
  group?: string
}

function decodeBuffer(buf: Buffer): string {
  // .mxtsessions on Chinese Windows is GBK. Electron's Node ships full ICU so
  // TextDecoder('gbk') works; fall back to utf-8 if not.
  try { return new TextDecoder('gbk', { fatal: false }).decode(buf) }
  catch { return buf.toString('utf8') }
}

function stripBrackets(s: string): string {
  const t = (s || '').trim()
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1).trim() : t
}

/** A connection-block field that looks like a key file path (Windows drive,
 *  unix abs/home/relative, a MobaXterm _XxxDir_ variable, or a *.pem/ppk/key). */
function looksLikeKeyPath(f: string): boolean {
  return /^(_[A-Za-z]+_|[A-Za-z]:|\/|~\/|\.\.?[\\/])/.test(f) || /\.(pem|ppk|key)$/i.test(f)
}

/** Resolve MobaXterm path variables to real paths; null if unresolvable. */
function resolveMobaPath(p: string): string | null {
  if (!p) return null
  let out = p.trim()
  const map: Record<string, string> = {
    _DesktopDir_: safePath('desktop'),
    _DocumentsDir_: safePath('documents'),
    _HomeDir_: safePath('home'),
    _DownloadDir_: safePath('downloads'),
  }
  for (const [k, v] of Object.entries(map)) {
    if (v && out.startsWith(k)) { out = v + out.slice(k.length); break }
  }
  if (/^_[A-Za-z]+_/.test(out)) return null // still an unresolved Moba variable
  return out.replace(/\\/g, '/')
}

function safePath(name: 'desktop' | 'documents' | 'home' | 'downloads'): string {
  try { return app.getPath(name).replace(/\\/g, '/') } catch { return '' }
}

export function parseMobaXterm(buf: Buffer): { sessions: ParsedMobaSession[]; skipped: number } {
  const text = decodeBuffer(buf)
  const sessions: ParsedMobaSession[] = []
  let skipped = 0
  let currentGroup: string | undefined  // SubRep leaf of the current section

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '')
    if (!line.trim()) continue
    if (line.startsWith('[')) { currentGroup = undefined; continue } // new section
    const subM = line.match(/^SubRep\s*=(.*)$/)
    if (subM) {
      // Keep the FULL nested folder path (minus the leading root marker) so the
      // renderer can build a multi-level tree. "root\电魂\web\A类" → "电魂/web/A类";
      // "root\prod" → "prod"; bare "" → ungrouped.
      const segs = subM[1].split('\\').map(s => s.trim()).filter(Boolean)
      if (segs.length && /^<?root>?$/i.test(segs[0])) segs.shift()
      currentGroup = segs.length ? segs.join('/') : undefined
      continue
    }
    if (/^ImgNum\s*=/.test(line)) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    if (!value.includes('#')) continue

    const parts = value.split('#')
    if (parts[1] !== '109') { skipped++; continue } // not SSH (e.g. 91 = RDP)

    const p = (parts[2] || '').split('%')
    const host = (p[1] || '').trim()
    if (!host) { skipped++; continue }
    const port = parseInt(p[2], 10) || 22
    const username = stripBrackets(p[3] || '') || 'root'

    let keyHint: string | undefined
    for (let i = 4; i < p.length; i++) {
      const f = (p[i] || '').trim()
      if (f && looksLikeKeyPath(f)) { keyHint = f; break }
    }

    let authType: 'password' | 'privateKey' = 'password'
    let privateKey: string | undefined
    if (keyHint) {
      authType = 'privateKey'
      const resolved = resolveMobaPath(keyHint)
      if (resolved) {
        try {
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            privateKey = fs.readFileSync(resolved, 'utf8')
          }
        } catch { /* unreadable on this machine — import without the key body */ }
      }
    }

    sessions.push({
      name: name || host,
      host, port, username, authType,
      privateKey,
      keyHint: privateKey ? undefined : keyHint,
      group: currentGroup,
    })
  }

  return { sessions, skipped }
}

export interface SshImportResult { imported: number; duplicates: number; skipped: number; missingKey: number }

/** Parse a .mxtsessions file and persist new SSH connections (deduped by
 *  host:port:user against existing ones). `save`/`existing` are injected so this
 *  stays unit-testable without the store. */
export function importMobaXtermFile(
  filePath: string,
  existing: SshConnection[],
  save: (c: SshConnection) => void,
  newId: () => string,
): SshImportResult {
  const buf = fs.readFileSync(filePath)
  const { sessions, skipped } = parseMobaXterm(buf)
  const seen = new Set(existing.map(c => `${c.host}:${c.port}:${c.username}`.toLowerCase()))
  let imported = 0, duplicates = 0, missingKey = 0
  for (const s of sessions) {
    const key = `${s.host}:${s.port}:${s.username}`.toLowerCase()
    if (seen.has(key)) { duplicates++; continue }
    if (s.authType === 'privateKey' && !s.privateKey) missingKey++
    save({
      id: newId(),
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      authType: s.authType,
      password: s.authType === 'password' ? '' : undefined,
      privateKey: s.authType === 'privateKey' ? (s.privateKey ?? '') : undefined,
      group: s.group,
    })
    seen.add(key)
    imported++
  }
  return { imported, duplicates, skipped, missingKey }
}
