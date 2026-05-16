import { getProviders } from './store'
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'

interface VideoParams {
  prompt: string
  referenceImagePath?: string
  duration?: number
  settings: { defaultVideoProviderId: string; defaultVideoModel: string; dataDirectory?: string }
  win: BrowserWindow
  sessionId: string
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
  const { prompt, referenceImagePath, duration, settings, win, sessionId, abortSignal } = params
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultVideoProviderId)
  if (!provider) throw new Error('Video provider not configured')

  const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')

  // Submit job — pass the signal so the initial POST is also abortable.
  const body: Record<string, unknown> = {
    model: settings.defaultVideoModel,
    prompt,
    n: 1
  }
  if (typeof duration === 'number' && duration > 0) {
    body.duration = duration
  }
  if (referenceImagePath && fs.existsSync(referenceImagePath)) {
    const imgData = fs.readFileSync(referenceImagePath)
    body.image = `data:image/png;base64,${imgData.toString('base64')}`
  }

  throwIfAborted(abortSignal)
  const submitRes = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!submitRes.ok) {
    const err = await submitRes.text()
    throw new Error(`Video submission failed: ${err}`)
  }
  const submitData = await submitRes.json() as { id?: string; data?: Array<{ url?: string }> }

  if (submitData.data?.[0]?.url) {
    return downloadVideo(submitData.data[0].url, settings.dataDirectory, abortSignal)
  }

  const jobId = submitData.id
  if (!jobId) throw new Error('No job ID returned from video API')

  const MAX_WAIT_MS = 10 * 60 * 1000
  const POLL_INTERVAL = 5000
  const startTime = Date.now()
  let elapsed = 0

  while (elapsed < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL, abortSignal)
    elapsed = Date.now() - startTime

    win.webContents.send(IPC.VIDEO_PROGRESS, {
      sessionId,
      jobId,
      elapsedSeconds: Math.floor(elapsed / 1000),
      status: 'waiting'
    })

    throwIfAborted(abortSignal)
    const pollRes = await fetch(`${baseUrl}/v1/videos/generations/${jobId}`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: abortSignal
    })
    if (!pollRes.ok) continue

    const pollData = await pollRes.json() as {
      status?: string
      data?: Array<{ url?: string }>
      error?: { message: string }
    }

    if (pollData.status === 'succeeded' && pollData.data?.[0]?.url) {
      return downloadVideo(pollData.data[0].url, settings.dataDirectory, abortSignal)
    }
    if (pollData.status === 'failed') {
      throw new Error(`Video generation failed: ${pollData.error?.message || 'Unknown error'}`)
    }
  }
  throw new Error('Video generation timed out after 10 minutes')
}

async function downloadVideo(url: string, dataDirectory?: string, signal?: AbortSignal): Promise<{ path: string }> {
  const baseDir = dataDirectory || app.getPath('userData')
  const videosDir = path.join(baseDir, 'gallery', 'videos')
  fs.mkdirSync(videosDir, { recursive: true })

  const filename = `${randomUUID()}.mp4`
  const filePath = path.join(videosDir, filename)
  // Race the fetch+read against the abort signal so a multi-hundred-MB
  // download is interrupted cleanly when the user clicks Stop.
  const res = await Promise.race([
    fetch(url, { signal }),
    abortRejection(signal)
  ])
  const buffer = await Promise.race([
    res.arrayBuffer(),
    abortRejection(signal)
  ])
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return { path: filePath }
}
