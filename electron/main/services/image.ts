import { getProviders } from './store'
import { compressImageToFit, DEFAULT_MAX_IMAGE_BYTES } from './image-compress'
import { logApiRequest, sanitizeUrl } from './request-log'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'

// Image generation can be slow (gpt-image models take 30–120s), but it must NOT
// hang forever when an upstream/relay accepts the connection then never responds
// (the "图片接口一直没返回" symptom — no timeout meant an infinite wait). Cap each
// request with a finite timeout combined with the caller's abort signal.
const IMAGE_GEN_TIMEOUT_MS = 180_000      // 3 min for the generate/edit call
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000  // 1 min to pull the result image bytes
function reqSignal(abortSignal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout
}

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
  /** Cancels the in-flight HTTP requests when the caller aborts (e.g. workflow 停止). */
  abortSignal?: AbortSignal
}

interface GeneratedImage {
  path: string
  url?: string
}

interface GenerateImageResult {
  images: GeneratedImage[]
  referencesIgnored?: boolean
}

export function isTransientNetworkError(err: unknown): boolean {
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

/**
 * Issue ONE image request (either /v1/images/generations or /v1/images/edits)
 * and persist every returned image to disk. `requestedN` is the value sent in
 * the request body — `/v1/images/edits` ignores it and always returns 1, but
 * some text-to-image providers honor it. The outer `generateImage` is
 * responsible for compensating when fewer images come back than requested.
 */
/** fetch wrapper that records image-API requests into the opt-in request log. */
async function traceImageFetch(url: string, init: RequestInit, model?: string): Promise<Response> {
  const method = ((init?.method || 'POST') as string).toUpperCase()
  const t0 = Date.now()
  try {
    const res = await fetch(url, init)
    logApiRequest({ kind: 'image', method, url: sanitizeUrl(url), model, status: res.status, ok: res.ok, durationMs: Date.now() - t0 })
    return res
  } catch (e) {
    logApiRequest({ kind: 'image', method, url: sanitizeUrl(url), model, ok: false, durationMs: Date.now() - t0, error: String((e as Error)?.message || e) })
    throw e
  }
}

async function doOneRequest(
  params: GenerateImageParams,
  requestedN: number
): Promise<GenerateImageResult> {
  const { prompt, size = '1024x1024', quality, settings, referenceImagePaths, maskPath, noFallback, abortSignal } = params
  const providers = getProviders()
  const provider = providers.find(p => p.id === settings.defaultImageProviderId)
  if (!provider) throw new Error('Image provider not configured')

  const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
  const modelName = settings.defaultImageModel || ''
  console.log('[image] resolved provider/model', {
    defaultImageProviderId: settings.defaultImageProviderId,
    providerId: provider.id,
    providerName: provider.name,
    baseUrl,
    model: modelName
  })

  let res: Response | undefined
  let referencesIgnored = false

  if (referenceImagePaths?.length) {
    // /v1/images/edits — OpenAI spec only accepts n=1, so the outer loop is
    // what produces multiple variants.
    // gpt-image 编辑接口的 input_fidelity:'high' 会显著更忠实地保留参考图里的人脸、
    // 细节与材质（解决"换图后人脸全变/质感发假"）。仅对 gpt-image 系列尝试；若网关
    // 不认该字段而报错，下面会自动去掉它重试一次，避免丢参考图降级成纯文生图。
    const fidelitySupported = /gpt-image/i.test(modelName)
    // Read + auto-compress each reference ONCE (shared across the fidelity retry),
    // so an oversized photo gets scaled down to fit instead of 413-ing the edits
    // endpoint. 真的压缩不动 → compressImageToFit throws → surfaced as 生图失败.
    const preparedRefs = referenceImagePaths.map((imgPath, i) => {
      const ext = imgPath.split('.').pop()?.toLowerCase() || 'png'
      let mime = ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg'
               : ext === 'webp' ? 'image/webp'
               : ext === 'gif' ? 'image/gif'
               : 'image/png'
      let data: Buffer = fs.readFileSync(imgPath)
      let name = `ref-${i + 1}.${ext}`
      if (data.length > DEFAULT_MAX_IMAGE_BYTES) {
        const r = compressImageToFit(data, DEFAULT_MAX_IMAGE_BYTES, `参考图 ${i + 1}`)
        if (r.compressed) {
          console.log(`[image] 🗜 compressed 参考图 ${i + 1} ${(data.length / 1024 / 1024).toFixed(1)}MB → ${(r.data.length / 1024 / 1024).toFixed(1)}MB`)
          data = r.data; mime = r.mime; name = `ref-${i + 1}.jpg`
        }
      }
      return { data, mime, name }
    })
    const buildForm = (withFidelity: boolean) => {
      const fd = new FormData()
      fd.append('model', modelName)
      fd.append('prompt', prompt)
      fd.append('size', size)
      fd.append('n', '1')
      if (quality) fd.append('quality', quality)
      if (withFidelity) fd.append('input_fidelity', 'high')
      for (const ref of preparedRefs) {
        fd.append('image[]', new Blob([new Uint8Array(ref.data)], { type: ref.mime }), ref.name)
      }
      if (maskPath && fs.existsSync(maskPath)) {
        const maskData = fs.readFileSync(maskPath)
        fd.append('mask', new Blob([maskData], { type: 'image/png' }), 'mask.png')
      }
      return fd
    }

    console.log('[image] edits request', `${baseUrl}/v1/images/edits`,
      `prompt=${prompt.slice(0, 60)} size=${size} refs=${referenceImagePaths.length}${maskPath ? ' +mask' : ''} noFallback=${!!noFallback}`)

    const MAX_ATTEMPTS = 2
    let editsOk = false
    let lastNetworkErr: Error | null = null
    let lastHttpStatus: number | null = null
    let lastHttpBody = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Only attempt 1 carries input_fidelity; if it HTTP-errors we drop it on the retry.
      const useFidelity = fidelitySupported && attempt === 1
      try {
        if (attempt > 1) {
          console.log(`[image] edits retry #${attempt - 1}`)
          await new Promise(r => setTimeout(r, 1500))
        }
        res = await traceImageFetch(`${baseUrl}/v1/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          body: buildForm(useFidelity),
          signal: reqSignal(abortSignal, IMAGE_GEN_TIMEOUT_MS)
        }, modelName)
        if (res.ok) {
          editsOk = true
          break
        }
        lastHttpStatus = res.status
        try { lastHttpBody = (await res.text()).slice(0, 400) } catch { /* ignore */ }
        console.warn('[image] edits HTTP', res.status, lastHttpBody.slice(0, 200))
        // If this attempt sent input_fidelity, the error may be the gateway rejecting
        // that field — retry once without it (keeps references rather than degrading).
        if (useFidelity && attempt < MAX_ATTEMPTS) { console.log('[image] retrying edits without input_fidelity'); continue }
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
      // Legacy fallback (chat reference-image flow): degrade to text-to-image
      // and let the UI inform the user via `referencesIgnored`.
      console.warn('[image] edits failed — falling back to text-to-image (legacy chat flow)')
      referencesIgnored = true
      res = await traceImageFetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: modelName, prompt, size, n: 1, ...(quality ? { quality } : {}) }),
        signal: reqSignal(abortSignal, IMAGE_GEN_TIMEOUT_MS)
      }, modelName)
    }
  } else {
    // Text-to-image: ask the provider for `requestedN` images in one go.
    // Providers that don't honor `n` will simply return 1; the outer
    // generateImage loop will then top up with extra single-image requests.
    const body: Record<string, unknown> = { model: modelName, prompt, size, n: requestedN }
    if (quality) body.quality = quality
    console.log('[image] generate request', `${baseUrl}/v1/images/generations`,
      `prompt=${prompt.slice(0, 60)} size=${size} n=${requestedN}`)
    try {
      res = await traceImageFetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        signal: reqSignal(abortSignal, IMAGE_GEN_TIMEOUT_MS)
      }, modelName)
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') {
        throw new Error(
          `生图超时：${Math.round(IMAGE_GEN_TIMEOUT_MS / 1000)} 秒内 ${baseUrl}/v1/images/generations 无响应` +
          `（provider=「${provider.name}」, model=${modelName}）。该接口可能不支持此图片模型、或服务端过慢/暂不可用，请换图片模型/接口或稍后重试。`
        )
      }
      throw e // user-abort / real network error
    }
  }

  if (!res) throw new Error('Image generation request did not produce a response')
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`生图失败（provider=「${provider.name}」, baseUrl=${baseUrl}, model=${modelName}）：${err}`)
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
      const imgRes = await fetch(item.url, { signal: reqSignal(abortSignal, IMAGE_DOWNLOAD_TIMEOUT_MS) })
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

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const requestedTotal = Math.min(Math.max(params.n ?? 1, 1), 4)
  const isEditFlow = !!params.referenceImagePaths?.length

  // First attempt: edits flow always sends n=1; text flow asks for the full count
  // (providers that honor `n` finish here in one round-trip).
  const first = await doOneRequest(params, isEditFlow ? 1 : requestedTotal)
  const collected: GeneratedImage[] = [...first.images]

  // Top up with single-image requests if the provider ignored `n` or the edits
  // endpoint capped at 1. Each loop iteration issues exactly one fresh request.
  while (collected.length < requestedTotal) {
    const more = await doOneRequest(params, 1)
    if (more.images.length === 0) break // guard against pathological providers
    collected.push(...more.images.slice(0, requestedTotal - collected.length))
  }

  return { images: collected, referencesIgnored: first.referencesIgnored }
}
