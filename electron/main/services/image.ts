import { getProviders, getSettings } from './store'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

interface GenerateImageParams {
  prompt: string
  n?: number
  size?: string
  quality?: string
  settings: { defaultImageProviderId: string; defaultImageModel: string; dataDirectory?: string }
  referenceImagePaths?: string[]
  /** Optional mask PNG path. Transparent pixels = areas to edit (OpenAI spec). */
  maskPath?: string
  /**
   * When true, fail loudly if /v1/images/edits is unavailable instead of falling
   * back to plain text-to-image. Used by the explicit image-edit feature so users
   * never get an unrelated text-to-image result silently.
   */
  noFallback?: boolean
}

interface GeneratedImage {
  path: string
  url?: string
}

interface GenerateImageResult {
  images: GeneratedImage[]
  referencesIgnored?: boolean
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? ''
  const causeMsg = String((err as Error & { cause?: unknown })?.cause ?? '').toLowerCase()
  const full = `${msg} ${causeMsg}`
  return (
    full.includes('econnreset') ||
    full.includes('econnrefused') ||
    full.includes('etimedout') ||
    full.includes('socket hang up') ||
    full.includes('network') ||
    full.includes('fetch failed')
  )
}

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const { prompt, n = 1, size = '1024x1024', quality, settings, referenceImagePaths, maskPath, noFallback } = params
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultImageProviderId)
  if (!provider) throw new Error('Image provider not configured')

  // Strip trailing /v1 so users can configure baseUrl with or without it
  const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
  const modelName = settings.defaultImageModel || ''
  const isDallE = modelName.startsWith('dall-e')

  let res: Response
  let referencesIgnored = false

  if (referenceImagePaths?.length) {
    // Build a fresh FormData per attempt — undici consumes the body stream on
    // failed requests, so reusing a single FormData across retries can hang.
    const buildForm = () => {
      const fd = new FormData()
      fd.append('model', modelName)
      fd.append('prompt', prompt)
      fd.append('size', size)
      fd.append('n', '1')
      if (quality) fd.append('quality', quality)
      for (let i = 0; i < referenceImagePaths.length; i++) {
        const imgPath = referenceImagePaths[i]
        const ext = imgPath.split('.').pop()?.toLowerCase() || 'png'
        const mime = ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg'
                 : ext === 'webp' ? 'image/webp'
                 : ext === 'gif' ? 'image/gif'
                 : 'image/png'
        const data = fs.readFileSync(imgPath)
        const safeName = `ref-${i + 1}.${ext}`
        fd.append('image[]', new Blob([data], { type: mime }), safeName)
      }
      if (maskPath && fs.existsSync(maskPath)) {
        const maskData = fs.readFileSync(maskPath)
        fd.append('mask', new Blob([maskData], { type: 'image/png' }), 'mask.png')
      }
      return fd
    }

    console.log('[image] edits request', `${baseUrl}/v1/images/edits`,
      `prompt=${prompt.slice(0, 60)} size=${size} refs=${referenceImagePaths.length}${maskPath ? ' +mask' : ''} noFallback=${!!noFallback}`)

    // Try once + one retry on transient network error (ECONNRESET etc.)
    const MAX_ATTEMPTS = 2
    let editsOk = false
    let lastNetworkErr: Error | null = null
    let lastHttpStatus: number | null = null
    let lastHttpBody = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[image] edits retry #${attempt - 1} after transient error`)
          await new Promise(r => setTimeout(r, 1500))
        }
        res = await fetch(`${baseUrl}/v1/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          body: buildForm()
        })
        if (res.ok) {
          editsOk = true
          break
        }
        lastHttpStatus = res.status
        try { lastHttpBody = (await res.text()).slice(0, 400) } catch { /* ignore */ }
        console.warn('[image] edits HTTP', res.status, lastHttpBody.slice(0, 200))
        // Server-side errors aren't retryable in a useful way; stop here
        break
      } catch (networkErr) {
        lastNetworkErr = networkErr as Error
        console.warn('[image] edits network error (attempt', attempt, '):', lastNetworkErr.message)
        if (!isTransientNetworkError(networkErr) || attempt === MAX_ATTEMPTS) break
      }
    }

    if (!editsOk) {
      if (noFallback) {
        // Image-edit feature MUST NOT silently downgrade to text-to-image —
        // that produces a completely unrelated image and confuses the user.
        const detail = lastNetworkErr
          ? `网络错误：${lastNetworkErr.message}（已重试 ${MAX_ATTEMPTS - 1} 次）`
          : `HTTP ${lastHttpStatus}: ${lastHttpBody || '无响应体'}`
        throw new Error(
          `图片编辑端点 /v1/images/edits 请求失败：${detail}。` +
          `请稍后重试，或检查图片代理是否支持编辑功能。`
        )
      }
      // Legacy fallback path (chat reference-image flow): degrade to text-to-image
      // and let the UI inform the user via `referencesIgnored`.
      console.warn('[image] edits failed — falling back to text-to-image (legacy chat flow)')
      referencesIgnored = true
      res = await fetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: modelName, prompt, size, n: 1, ...(quality ? { quality } : {}) })
      })
    }
  } else {
    // Text-to-image: standard JSON body → /v1/images/generations
    const body: Record<string, unknown> = { model: modelName, prompt, size }
    body.n = isDallE ? n : 1
    if (quality) body.quality = quality
    console.log('[image] generate request', `${baseUrl}/v1/images/generations`, `prompt=${prompt.slice(0, 60)} size=${size}`)
    res = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body)
    })
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Image generation failed: ${err}`)
  }
  const data = await res.json() as { data: Array<{ url?: string; b64_json?: string }> }

  const baseDir = settings.dataDirectory || app.getPath('userData')
  const imagesDir = path.join(baseDir, 'gallery', 'images')
  fs.mkdirSync(imagesDir, { recursive: true })
  console.log('[image] response items:', data.data?.length, 'imagesDir:', imagesDir)

  const images: GeneratedImage[] = []
  for (const item of data.data) {
    const filename = `${randomUUID()}.png`
    const filePath = path.join(imagesDir, filename)
    console.log('[image] item keys:', Object.keys(item), 'hasUrl:', !!item.url, 'hasB64:', !!item.b64_json)

    if (item.url) {
      const imgRes = await fetch(item.url)
      const buffer = await imgRes.arrayBuffer()
      fs.writeFileSync(filePath, Buffer.from(buffer))
      console.log('[image] saved from url, size:', buffer.byteLength, 'path:', filePath)
    } else if (item.b64_json) {
      const buf = Buffer.from(item.b64_json, 'base64')
      fs.writeFileSync(filePath, buf)
      console.log('[image] saved from b64, size:', buf.byteLength, 'path:', filePath)
    } else {
      console.warn('[image] item has neither url nor b64_json, skipping')
      continue
    }
    images.push({ path: filePath, url: item.url })
  }
  return { images, referencesIgnored }
}
