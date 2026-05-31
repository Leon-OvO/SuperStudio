import type { ProviderConfig } from '../../../../src/shared/ipc-types'

/** Shared input the page passes down — adapter-agnostic. */
export interface VideoJobInput {
  prompt: string
  negativePrompt?: string
  duration?: number
  aspect?: '9:16' | '1:1' | '16:9'
  /** Reproducibility seed; adapters drop it if their API doesn't accept one. */
  seed?: number
  /** Absolute path to a staged reference / first-frame / last-frame image. */
  referenceImagePath?: string
  /** Maps to provider-specific fields (image / last_frame / image_reference). */
  frameRole?: 'first' | 'last' | 'reference'
}

/** Per-call context — provider creds, target model, abort. */
export interface AdapterContext {
  provider: ProviderConfig
  model: string
  abortSignal?: AbortSignal
}

/** Some providers return the finished video URL inline; others queue + poll. */
export type SubmitResult =
  | { kind: 'sync'; url: string }
  | { kind: 'async'; jobId: string }

export type PollResult =
  | { kind: 'pending' }
  | { kind: 'done'; url: string }
  | { kind: 'failed'; error: string }

export interface VideoProviderAdapter {
  /** Human label, used for logging / error messages only. */
  name: string

  /** Detection. The first adapter whose `matches()` returns true wins. The
   *  fallback `openai-compat` adapter should always match last via a catch-all
   *  so unknown providers still work. */
  matches(provider: ProviderConfig, model: string): boolean

  submit(ctx: AdapterContext, input: VideoJobInput): Promise<SubmitResult>

  /** Only called for async submits. Adapters whose protocol can't get here
   *  may throw — the loop will catch and surface it as a failed job. */
  poll(ctx: AdapterContext, jobId: string): Promise<PollResult>

  /** Optional override for the poll cadence. Defaults to 5000ms. */
  pollIntervalMs?: number
}
