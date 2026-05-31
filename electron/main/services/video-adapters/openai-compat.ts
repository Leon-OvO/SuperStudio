import fs from 'fs'
import { isTransientNetworkError } from '../image'
import type { VideoProviderAdapter, AdapterContext, VideoJobInput, SubmitResult, PollResult } from './types'

/**
 * The "OpenAI-compat" shape that most aggregators (SuperCode, Pollinations,
 * various proxies) expose for video generation:
 *
 *   POST /v1/videos/generations  →  { id?: string, data?: [{ url? }] }
 *   GET  /v1/videos/generations/{id}  →  { status, data?: [{ url? }], error? }
 *
 * Some providers return the finished URL synchronously in the POST response
 * (text-to-video with `n:1` on cheaper models); others always go through the
 * async polling path. We handle both transparently.
 */

const ASPECT_SIZE: Record<NonNullable<VideoJobInput['aspect']>, string> = {
  '9:16': '720x1280',
  '1:1': '720x720',
  '16:9': '1280x720'
}

const FRAME_ROLE_FIELD: Record<NonNullable<VideoJobInput['frameRole']>, string> = {
  first: 'image',
  last: 'last_frame',
  reference: 'image_reference'
}

function baseUrl(ctx: AdapterContext): string {
  return (ctx.provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
}

/** Map a file extension to its image MIME. Strict providers validate the
 *  data-URL MIME against the actual bytes, so a hardcoded image/png would make
 *  them reject any JPEG/WebP reference the user uploads. */
function mimeForImagePath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

/** fetch() with retry on transient network errors (ECONNRESET, fetch failed,
 *  …) — mirrors the image-edit path so a flaky aggregator connection doesn't
 *  fail an otherwise-fine video job. HTTP error statuses are NOT retried here;
 *  callers decide what a non-OK status means (submit throws, poll → pending). */
async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      lastErr = err
      // Never retry a user-initiated abort, and stop once attempts are exhausted
      // or the error isn't a transient network blip.
      if (signal?.aborted || !isTransientNetworkError(err) || attempt === MAX_ATTEMPTS) break
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

async function buildBody(ctx: AdapterContext, input: VideoJobInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: ctx.model,
    prompt: input.prompt,
    n: 1
  }
  if (input.negativePrompt && input.negativePrompt.trim()) {
    body.negative_prompt = input.negativePrompt.trim()
  }
  if (input.aspect) {
    // Ship both: Kling/Vidu honor aspect_ratio, Sora honors size — unknown
    // fields are ignored by everyone else.
    body.aspect_ratio = input.aspect
    body.size = ASPECT_SIZE[input.aspect]
  }
  if (typeof input.duration === 'number' && input.duration > 0) {
    body.duration = input.duration
  }
  if (typeof input.seed === 'number' && input.seed > 0) {
    body.seed = input.seed
  }
  if (input.referenceImagePath) {
    // Async read so a large reference image doesn't block the main event loop
    // right when the user clicks Generate. readFile throws if the file is gone,
    // which the caller surfaces as a submit failure (better than silently
    // dropping the reference, which the old existsSync guard did).
    const imgData = await fs.promises.readFile(input.referenceImagePath)
    const mime = mimeForImagePath(input.referenceImagePath)
    const dataUrl = `data:${mime};base64,${imgData.toString('base64')}`
    const field = FRAME_ROLE_FIELD[input.frameRole ?? 'first']
    body[field] = dataUrl
  }
  return body
}

export const openAiCompatAdapter: VideoProviderAdapter = {
  name: 'openai-compat',

  /** Catch-all — assume OpenAI-compat unless a more specific adapter wins.
   *  Add provider-specific adapters above this one in the registry. */
  matches() {
    return true
  },

  async submit(ctx, input): Promise<SubmitResult> {
    const body = JSON.stringify(await buildBody(ctx, input))
    const res = await fetchWithRetry(`${baseUrl(ctx)}/v1/videos/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.provider.apiKey}`
      },
      body,
      signal: ctx.abortSignal
    }, ctx.abortSignal)
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Video submission failed: ${err}`)
    }
    const data = await res.json() as { id?: string; data?: Array<{ url?: string }> }

    // Sync path — finished URL in the POST response, skip polling entirely.
    if (data.data?.[0]?.url) return { kind: 'sync', url: data.data[0].url }

    if (!data.id) throw new Error('No job ID returned from video API')
    return { kind: 'async', jobId: data.id }
  },

  async poll(ctx, jobId): Promise<PollResult> {
    let res: Response
    try {
      res = await fetchWithRetry(`${baseUrl(ctx)}/v1/videos/generations/${jobId}`, {
        headers: { Authorization: `Bearer ${ctx.provider.apiKey}` },
        signal: ctx.abortSignal
      }, ctx.abortSignal)
    } catch {
      // Transient network error even after retries — treat as pending so the
      // outer polling loop keeps trying (it has its own 10-minute timeout).
      return { kind: 'pending' }
    }
    // Some providers blip on a single poll — treat non-OK as pending rather
    // than failing the whole job. The outer loop will eventually time out
    // if these never recover.
    if (!res.ok) return { kind: 'pending' }

    const data = await res.json() as {
      status?: string
      data?: Array<{ url?: string }>
      error?: { message?: string }
    }
    if (data.status === 'succeeded' && data.data?.[0]?.url) {
      return { kind: 'done', url: data.data[0].url }
    }
    if (data.status === 'failed') {
      return { kind: 'failed', error: data.error?.message || 'Unknown error' }
    }
    return { kind: 'pending' }
  }
}
