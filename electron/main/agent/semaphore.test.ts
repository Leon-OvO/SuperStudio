import { describe, it, expect } from 'vitest'
import { Semaphore } from './semaphore'

describe('Semaphore', () => {
  it('caps concurrency at max and queues the rest', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const task = async () => {
      const release = await sem.acquire()
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 10))
      active--
      release()
    }
    await Promise.all(Array.from({ length: 6 }, task))
    expect(peak).toBe(2)
    expect(sem.inFlight).toBe(0)
  })

  it('run() releases the slot even when fn throws', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // Slot must be free again — a follow-up run resolves.
    await expect(sem.run(async () => 42)).resolves.toBe(42)
    expect(sem.inFlight).toBe(0)
  })

  it('release is idempotent (double-call does not over-free)', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release() // no-op
    const r2 = await sem.acquire()
    expect(sem.inFlight).toBe(1)
    r2()
  })
})
