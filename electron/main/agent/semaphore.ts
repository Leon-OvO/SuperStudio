/**
 * Minimal async semaphore — bounds how many agent runs hit the model/browser
 * concurrently across ALL sessions (chat + scheduler + multiple windows).
 *
 * Without it, a burst of scheduled tasks firing on the same cron minute would
 * spawn N simultaneous LLM streams + N headless browsers → memory spikes and
 * provider 429 storms. Dep-free to keep the bundle lean.
 */

export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  private take(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>(resolve => this.queue.push(resolve))
  }

  private give(): void {
    const next = this.queue.shift()
    if (next) {
      // Hand the slot directly to the next waiter (active stays at max).
      next()
    } else {
      this.active = Math.max(0, this.active - 1)
    }
  }

  /**
   * Acquire a slot, resolving once one is free. Returns an idempotent release
   * function — call it (e.g. in a `finally`) to free the slot. Use this when a
   * surrounding try/finally already exists and wrapping in `run` is awkward.
   */
  async acquire(): Promise<() => void> {
    await this.take()
    let released = false
    return () => {
      if (released) return
      released = true
      this.give()
    }
  }

  /** Run `fn` once a slot is free; the slot is always released afterwards. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  get inFlight(): number {
    return this.active
  }
}

/**
 * Shared limiter for agent runs. 3 keeps an interactive chat responsive while a
 * couple of background/scheduled runs proceed, without melting the machine.
 */
export const agentRunSemaphore = new Semaphore(3)
