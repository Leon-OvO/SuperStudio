import { describe, it, expect, vi } from 'vitest'

// ssh-service imports getSshConnection from ./store (which pulls electron-store);
// resolveSshConnection is pure and doesn't use it, so stub the module.
vi.mock('./store', () => ({ getSshConnection: () => null }))

import { resolveSshConnection } from './ssh-service'
import type { SshConnection } from '../../../src/shared/ipc-types'

const C = (over: Partial<SshConnection>): SshConnection =>
  ({ id: '', name: '', host: '', port: 22, username: 'root', authType: 'password', ...over })

const conns: SshConnection[] = [
  C({ id: 'a', name: 'jps1.fq.ito8.com (root)', host: 'jps1.fq.ito8.com' }),
  C({ id: 'b', name: 'web1', host: '1.2.3.4' }),
  C({ id: 'c', name: 'db prod', host: '10.0.0.5', username: 'admin' }),
  C({ id: 'd', name: 'dup', host: '1.2.3.4' }), // same host as web1 → ambiguous
]

describe('resolveSshConnection', () => {
  it('resolves an imported connection by HOST even when the name has a suffix (the reported bug)', () => {
    expect(resolveSshConnection('jps1.fq.ito8.com', conns).conn?.id).toBe('a')
  })

  it('resolves by exact name and by id', () => {
    expect(resolveSshConnection('jps1.fq.ito8.com (root)', conns).conn?.id).toBe('a')
    expect(resolveSshConnection('b', conns).conn?.id).toBe('b')
  })

  it('resolves a unique fuzzy (substring) match', () => {
    expect(resolveSshConnection('db', conns).conn?.id).toBe('c')
  })

  it('reports ambiguity when a host matches multiple connections', () => {
    const r = resolveSshConnection('1.2.3.4', conns)
    expect(r.conn).toBeUndefined()
    expect(r.error).toContain('不唯一')
  })

  it('reports not-found for an unknown connection', () => {
    const r = resolveSshConnection('nope.example', conns)
    expect(r.conn).toBeUndefined()
    expect(r.error).toContain('未找到')
  })
})
