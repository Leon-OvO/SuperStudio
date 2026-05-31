import { getProviders } from './store'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC, type VideoProgressEvent } from '../../../src/shared/ipc-types'
import { estimateVideoEta } from '../../../src/shared/video-eta'
import { pickAdapter, type VideoJobInput, type AdapterContext } from './video-adapters'

interface VideoParams {
  prompt: string
  /** Forwarded to the adapter as a separate field; adapters that don't honor
   *  it simply drop it from the request body. */
  negativePrompt?: string
  referenceImagePath?: string
  /** Controls which field the reference image lands in (image / last_frame /
   *  image_reference). Defaults to 'first' when a reference is present. */
  frameRole?: 'first' | 'last' | 'reference'
  /** UI aspect; adapters translate to whatever shape their API expects. */
  aspect?: '9:16' | '1:1' | '16:9'
  /** Reproducibility seed; forwarded to adapters that support it. */
  seed?: number
  duration?: number
  settings: { defaultVideoProviderId: string; defaultVideoModel: string; dataDirectory?: string }
  win: BrowserWindow
  sessionId: string
  /** When set, progress events use this id instead of sessionId so the renderer
   *  can pin updates to a specific job card (sessionId is reused for chat sessions). */
  clientJobId?: string
  /** Honored during polling + download so the Stop button can short-circuit a long job. */
  abortSignal?: AbortSignal
}

class AbortedError extends Error {
  constructor() { super('视频生成已被用户中断') }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}

/** Promise that rejects when the signal aborts (used to race against fetches/sleeps). */
function abortRejection(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) return reject(new AbortedError())
    signal.addEventListener('abort', () => reject(new AbortedError()), { once: true })
  })
}

/** Interruptible sleep — wakes up early when the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError())
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new AbortedError())
      }, { once: true })
    }
  })
}

export async function generateVideo(params: VideoParams): Promise<{ path?: string; error?: string }> {
  const { prompt, negativePrompt, referenceImagePath, frameRole, aspect, seed, duration, settings, win, sessionId, clientJobId, abortSignal } = params
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultVideoProviderId)
  if (!provider) throw new Error('Video provider not configured')

  const adapter = pickAdapter(provider, settings.defaultVideoModel)
  const ctx: AdapterContext = { provider, model: settings.defaultVideoModel, abortSignal }
  const input: VideoJobInput = {
    prompt,
    negativePrompt,
    duration,
    aspect,
    seed,
    referenceImagePath,
    frameRole
  }

  const eta = estimateVideoEta(settings.defaultVideoModel, duration ?? 5)
  const startTime = Date.now()

  const emit = (status: VideoProgressEvent['status'], extras: Partial<VideoProgressEvent> = {}): void => {
    if (win.isDestroyed()) return
    const payload: VideoProgressEvent = {
      clientJobId: clientJobId ?? sessionId,
      status,
      elapsedSeconds: Math.floor((Date.now() - startTime) / 1000),
      etaSeconds: eta,
      ...extras
    }
    win.webContents.send(IPC.VIDEO_PROGRESS, payload)
  }

  emit('submitting')

  throwIfAborted(abortSignal)
  const submitResult = await adapter.submit(ctx, input)

  // Sync path — adapter already has the final URL, skip the polling loop.
  if (submitResult.kind === 'sync') {
    emit('downloading')
    const out = await downloadVideo(submitResult.url, settings.dataDirectory, abortSignal)
    emit('succeeded')
    return out
  }

  const jobId = submitResult.jobId
  emit('queued', { jobId })

  const MAX_WAIT_MS = 10 * 60 * 1000
  const POLL_INTERVAL = adapter.pollIntervalMs ?? 5000
  let elapsedMs = 0

  while (elapsedMs < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL, abortSignal)
    elapsedMs = Date.now() - startTime

    emit('running', { jobId })

    throwIfAborted(abortSignal)
    const pollResult = await adapter.poll(ctx, jobId)

    if (pollResult.kind === 'done') {
      emit('downloading', { jobId })
      const out = await downloadVideo(pollResult.url, settings.dataDirectory, abortSignal)
      emit('succeeded', { jobId })
      return out
    }
    if (pollResult.kind === 'failed') {
      throw new Error(`Video generation failed: ${pollResult.error}`)
    }
    // pending → continue
  }
  throw new Error('Video generation timed out after 10 minutes')
}

async function downloadVideo(url: string, dataDirectory?: string, signal?: AbortSignal): Promise<{ path: string }> {
  const baseDir = dataDirectory || app.getPath('userData')
  const videosDir = path.join(baseDir, 'gallery', 'videos')
  fs.mkdirSync(videosDir, { recursive: true })

  const filename = `${randomUUID()}.mp4`
  const filePath = path.join(videosDir, filename)
  // Stream the response straight to disk instead of buffering the whole clip in
  // memory and blocking the event loop on a synchronous write — a 10s clip can
  // be 50-200MB. The abort signal (passed to fetch) tears down the body stream,
  // so Stop interrupts the download cleanly; clean up the partial file on error.
  const res = await Promise.race([
    fetch(url, { signal }),
    abortRejection(signal)
  ])
  if (!res.ok || !res.body) {
    throw new Error(`Video download failed: HTTP ${res.status}`)
  }
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(filePath))
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch { /* ignore — partial file cleanup is best-effort */ }
    if (signal?.aborted) throw new AbortedError()
    throw err
  }
  return { path: filePath }
}
