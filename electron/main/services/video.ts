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
}

export async function generateVideo(params: VideoParams): Promise<{ path?: string; error?: string }> {
  const { prompt, referenceImagePath, duration, settings, win, sessionId } = params
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultVideoProviderId)
  if (!provider) throw new Error('Video provider not configured')

  const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')

  // Submit job
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

  const submitRes = await fetch(`${baseUrl}/v1/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body)
  })
  if (!submitRes.ok) {
    const err = await submitRes.text()
    throw new Error(`Video submission failed: ${err}`)
  }
  const submitData = await submitRes.json() as { id?: string; data?: Array<{ url?: string }> }

  // If immediate response with URL
  if (submitData.data?.[0]?.url) {
    return downloadVideo(submitData.data[0].url, settings.dataDirectory)
  }

  // Poll for completion (job ID)
  const jobId = submitData.id
  if (!jobId) throw new Error('No job ID returned from video API')

  const MAX_WAIT_MS = 10 * 60 * 1000
  const POLL_INTERVAL = 5000
  const startTime = Date.now()
  let elapsed = 0

  while (elapsed < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL)
    elapsed = Date.now() - startTime

    win.webContents.send(IPC.VIDEO_PROGRESS, {
      sessionId,
      jobId,
      elapsedSeconds: Math.floor(elapsed / 1000),
      status: 'waiting'
    })

    const pollRes = await fetch(`${baseUrl}/v1/videos/generations/${jobId}`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` }
    })
    if (!pollRes.ok) continue

    const pollData = await pollRes.json() as {
      status?: string
      data?: Array<{ url?: string }>
      error?: { message: string }
    }

    if (pollData.status === 'succeeded' && pollData.data?.[0]?.url) {
      return downloadVideo(pollData.data[0].url, settings.dataDirectory)
    }
    if (pollData.status === 'failed') {
      throw new Error(`Video generation failed: ${pollData.error?.message || 'Unknown error'}`)
    }
  }
  throw new Error('Video generation timed out after 10 minutes')
}

async function downloadVideo(url: string, dataDirectory?: string): Promise<{ path: string }> {
  const baseDir = dataDirectory || app.getPath('userData')
  const videosDir = path.join(baseDir, 'gallery', 'videos')
  fs.mkdirSync(videosDir, { recursive: true })

  const filename = `${randomUUID()}.mp4`
  const filePath = path.join(videosDir, filename)
  const res = await fetch(url)
  const buffer = await res.arrayBuffer()
  fs.writeFileSync(filePath, Buffer.from(buffer))
  return { path: filePath }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
