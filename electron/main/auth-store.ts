/**
 * Auth state persistence — thin wrapper around electron-store with safeStorage encryption.
 * Keeps tokens and key material out of config.json in plaintext.
 */

import Store from 'electron-store'
import { safeStorage } from 'electron'
import { SuperCodeUser } from '../../src/shared/ipc-types'

export interface RawKeyEntry {
  id: number
  key: string       // plaintext API key value
  groupId: number
  platform: string
  groupName: string
}

/** Lightweight key record stored without the actual key value — safe for display. */
export interface KeyMeta {
  id: number
  name: string
  groupId: number
  platform: string
  groupName: string
  keyMasked: string
  status: string
}

interface AuthSchema {
  accessToken: string    // encrypted
  refreshToken: string   // encrypted
  user: SuperCodeUser | null
  // Legacy single-key fields (kept for migration compatibility)
  keyId: number | null
  keyValue: string       // encrypted
  // Multi-key: JSON array of { id, key(encrypted), groupId, platform, groupName }
  allKeysJson: string    // encrypted JSON
  // All available keys from API (no key value) — for display / switching
  keysMetaJson: string
  // User's per-group selection: JSON object { [groupId]: keyId }
  selectedKeyIdsJson: string
  // Credentials saved for silent token refresh — both encrypted via safeStorage
  credEmail: string
  credPassword: string
}

const AUTH_DEFAULTS: AuthSchema = {
  accessToken: '',
  refreshToken: '',
  user: null,
  keyId: null,
  keyValue: '',
  allKeysJson: '',
  keysMetaJson: '',
  selectedKeyIdsJson: '',
  credEmail: '',
  credPassword: ''
}

const ENC_PREFIX = 'ss:enc1:'

function canEncrypt(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

function enc(plain: string): string {
  if (!plain) return ''
  if (!canEncrypt()) return plain
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

function dec(value: string): string {
  if (!value) return ''
  if (!value.startsWith(ENC_PREFIX)) return value
  if (!canEncrypt()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

let _store: Store<AuthSchema> | null = null

function getStore(): Store<AuthSchema> {
  if (!_store) _store = new Store<AuthSchema>({ name: 'auth', defaults: AUTH_DEFAULTS })
  return _store
}

// --- Tokens ---------------------------------------------------------------

export function storeTokens(accessToken: string, refreshToken: string): void {
  getStore().set('accessToken', enc(accessToken))
  getStore().set('refreshToken', enc(refreshToken))
}

export function getAccessToken(): string {
  return dec(getStore().get('accessToken') as string || '')
}

export function getRefreshToken(): string {
  return dec(getStore().get('refreshToken') as string || '')
}

// --- User -----------------------------------------------------------------

export function storeUser(user: SuperCodeUser): void {
  getStore().set('user', user)
}

export function getUser(): SuperCodeUser | null {
  return getStore().get('user') as SuperCodeUser | null
}

// --- Multi-key storage ----------------------------------------------------

export function storeAllKeys(keys: RawKeyEntry[]): void {
  const plain = JSON.stringify(keys)
  getStore().set('allKeysJson', enc(plain))
  // Keep legacy single-key fields in sync (first entry)
  if (keys.length > 0) {
    getStore().set('keyId', keys[0].id)
    getStore().set('keyValue', enc(keys[0].key))
  } else {
    getStore().set('keyId', null)
    getStore().set('keyValue', '')
  }
}

export function getAllKeys(): RawKeyEntry[] {
  const raw = dec(getStore().get('allKeysJson') as string || '')
  if (!raw) {
    // Attempt migration from legacy single-key fields
    const legacyId = getStore().get('keyId') as number | null
    const legacyKey = dec(getStore().get('keyValue') as string || '')
    if (legacyId && legacyKey) {
      return [{ id: legacyId, key: legacyKey, groupId: 0, platform: 'unknown', groupName: 'Default' }]
    }
    return []
  }
  try {
    return JSON.parse(raw) as RawKeyEntry[]
  } catch {
    return []
  }
}

// --- Legacy compat (first key) --------------------------------------------

export function storeKeyInfo(keyId: number, keyValue: string): void {
  getStore().set('keyId', keyId)
  getStore().set('keyValue', enc(keyValue))
}

export function getKeyId(): number | null {
  const keys = getAllKeys()
  if (keys.length > 0) return keys[0].id
  return getStore().get('keyId') as number | null
}

export function getKeyValue(): string {
  const keys = getAllKeys()
  if (keys.length > 0) return keys[0].key
  return dec(getStore().get('keyValue') as string || '')
}

// --- Keys metadata (all keys, no key values) + per-group selection --------

export function storeKeysMeta(keys: KeyMeta[]): void {
  getStore().set('keysMetaJson', JSON.stringify(keys))
}

export function getKeysMeta(): KeyMeta[] {
  try {
    const raw = getStore().get('keysMetaJson') as string || ''
    return raw ? JSON.parse(raw) as KeyMeta[] : []
  } catch { return [] }
}

export function getSelectedKeyIds(): Record<number, number> {
  try {
    const raw = getStore().get('selectedKeyIdsJson') as string || ''
    return raw ? JSON.parse(raw) as Record<number, number> : {}
  } catch { return {} }
}

export function setSelectedKeyId(groupId: number, keyId: number): void {
  const current = getSelectedKeyIds()
  current[groupId] = keyId
  getStore().set('selectedKeyIdsJson', JSON.stringify(current))
}

// --- Credentials (for silent token refresh) ------------------------------

export function storeCredentials(email: string, password: string): void {
  getStore().set('credEmail', enc(email))
  getStore().set('credPassword', enc(password))
}

export function getCredentials(): { email: string; password: string } | null {
  const email = dec(getStore().get('credEmail') as string || '')
  const password = dec(getStore().get('credPassword') as string || '')
  if (!email || !password) return null
  return { email, password }
}

export function clearCredentials(): void {
  getStore().set('credEmail', '')
  getStore().set('credPassword', '')
}

// --- Clear ----------------------------------------------------------------

/** Clears tokens / user / keys but KEEPS saved credentials so we can re-login silently. */
export function clearAuth(): void {
  getStore().set('accessToken', '')
  getStore().set('refreshToken', '')
  getStore().set('user', null)
  getStore().set('keyId', null)
  getStore().set('keyValue', '')
  getStore().set('allKeysJson', '')
  getStore().set('keysMetaJson', '')
  getStore().set('selectedKeyIdsJson', '')
}

/** Full wipe — including saved credentials. Use on explicit user logout / reset. */
export function clearAuthAndCredentials(): void {
  clearAuth()
  clearCredentials()
}

export function isLoggedIn(): boolean {
  return !!getAccessToken()
}
