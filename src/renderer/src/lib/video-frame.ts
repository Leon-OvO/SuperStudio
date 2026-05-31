/**
 * Extract a still frame from a local video file using a hidden HTMLVideoElement
 * + canvas. Avoids a native ffmpeg dependency (~80MB) by leaning on the
 * Chromium decoder that's already in the renderer.
 *
 * The local-file:// protocol is registered with corsEnabled, so toBlob /
 * toDataURL won't taint the canvas.
 */

export type FramePosition = 'first' | 'last'

interface ExtractOptions {
  /** Output mime, defaults to image/jpeg (smaller than png — fine for thumbs). */
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp'
  /** JPEG/WEBP quality 0..1, defaults to 0.82. */
  quality?: number
  /** Max width — frames are downscaled to keep gallery thumbs cheap. 0 = no limit. */
  maxWidth?: number
}

const DEFAULT_OPTS: Required<ExtractOptions> = {
  mimeType: 'image/jpeg',
  quality: 0.82,
  maxWidth: 640
}

/**
 * Extract a single frame as a Blob. Resolves with null if the browser can't
 * decode the video — caller should treat that as "no thumbnail" rather than
 * a hard error.
 */
export async function extractVideoFrame(
  videoUrl: string,
  position: FramePosition,
  opts: ExtractOptions = {}
): Promise<Blob | null> {
  const { mimeType, quality, maxWidth } = { ...DEFAULT_OPTS, ...opts }

  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = videoUrl

  try {
    await waitForMetadata(video)

    // For 'last' we seek slightly before the end — exact `duration` often
    // returns a black frame or fails to fire `seeked`.
    const target = position === 'first'
      ? 0
      : Math.max(0, (video.duration || 1) - 0.05)

    await seekTo(video, target)

    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null

    const scale = maxWidth > 0 && w > maxWidth ? maxWidth / w : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob | null>(resolve => {
      canvas.toBlob(b => resolve(b), mimeType, quality)
    })
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/** Convert a Blob to a raw base64 string (no data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = reader.result as string
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.duration > 0) return resolve()
    const onMeta = (): void => { cleanup(); resolve() }
    const onErr = (): void => { cleanup(); reject(new Error('video metadata failed')) }
    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('error', onErr)
    }
    video.addEventListener('loadedmetadata', onMeta, { once: true })
    video.addEventListener('error', onErr, { once: true })
  })
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return resolve()
    const onSeeked = (): void => { cleanup(); resolve() }
    const onErr = (): void => { cleanup(); reject(new Error('video seek failed')) }
    const cleanup = (): void => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onErr)
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onErr, { once: true })
    video.currentTime = time
  })
}
