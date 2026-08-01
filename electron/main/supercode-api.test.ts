import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// supercode-api.ts imports 'electron' (BrowserWindow) — stub it so this file
// can load under plain vitest/node without an Electron runtime.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))

import { initApiClient, superCodeFetch } from './supercode-api'

describe('superCodeFetch — refresh single-flight', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('并发多个 401 只触发一次 /auth/refresh', async () => {
    let refreshCalls = 0
    let accessToken = 'stale-token'
    const refreshToken = 'refresh-1'

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/v1/auth/refresh')) {
        refreshCalls++
        // simulate token rotation: server issues a fresh refresh_token every time
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'new-token', refresh_token: 'refresh-2', token_type: 'bearer' }),
        } as Response
      }
      // any other endpoint: unauthorized until the token has been refreshed
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
      const ok = authHeader === 'Bearer new-token'
      return {
        ok,
        status: ok ? 200 : 401,
        json: async () => ({}),
      } as Response
    })

    initApiClient({
      getToken: () => accessToken,
      getRefreshToken: () => refreshToken,
      storeTokens: (access) => { accessToken = access },
      clearTokens: () => {},
    })

    const results = await Promise.all([
      superCodeFetch('https://www.supercode.help/api/v1/keys'),
      superCodeFetch('https://www.supercode.help/api/v1/keys'),
      superCodeFetch('https://www.supercode.help/api/v1/keys'),
    ])

    expect(refreshCalls).toBe(1)
    for (const r of results) expect(r.status).toBe(200)
  })
})
