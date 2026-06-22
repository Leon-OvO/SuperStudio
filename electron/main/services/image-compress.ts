import { nativeImage } from 'electron'

/**
 * Auto-compress oversized images so a large photo "just works" instead of being
 * rejected by the vision / image-edit endpoints. Only kicks in above `maxBytes`;
 * smaller images are passed through untouched (original format + quality kept).
 *
 * Strategy: decode with Electron's built-in nativeImage (no native deps), then
 * walk progressively smaller long-edge caps × JPEG qualities, returning the FIRST
 * result that fits (so quality is preserved as much as possible). If even the
 * smallest/lowest still exceeds the cap — or the format can't be decoded at all
 * (SVG / animated GIF / HEIC …) — it throws a clear, actionable error. That is the
 * "真的压缩不动再提示报错" path; callers surface the message to the user.
 */

/** 4 MB — safely under the common 5 MB per-image vision limit even after the
 *  ~1.37× base64 inflation the SDK applies before upload. */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024

// Progressively smaller long-edge caps (px) and JPEG qualities to try, in order
// of decreasing quality. The first combination that fits wins.
const EDGE_CAPS = [4096, 3072, 2560, 2048, 1600, 1280, 1024, 768]
const QUALITIES = [82, 70, 58, 46, 36]

export interface CompressResult {
  /** The (possibly re-encoded) image bytes. */
  data: Buffer
  /** The new mime when re-encoded to JPEG; '' when `compressed` is false. */
  mime: string
  /** Whether the bytes were actually re-encoded (false ⇒ original returned as-is). */
  compressed: boolean
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

/**
 * Compress `input` to fit within `maxBytes`. Returns `{ compressed: false }` with
 * the original buffer when it's already small enough. Throws when it can't fit.
 */
export function compressImageToFit(
  input: Buffer,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
  label = '图片'
): CompressResult {
  if (input.length <= maxBytes) return { data: input, mime: '', compressed: false }

  const img = nativeImage.createFromBuffer(input)
  if (img.isEmpty()) {
    // Couldn't decode it (vector / animated / exotic format) → can't recompress.
    throw new Error(
      `${label} 体积 ${mb(input.length)}MB，超过 ${mb(maxBytes)}MB 上限，且该格式无法自动压缩，请改用更小的 JPG/PNG 图片`
    )
  }

  const { width, height } = img.getSize()
  const maxEdge = Math.max(width, height) || 1
  const caps = [maxEdge, ...EDGE_CAPS.filter(c => c < maxEdge)]

  let smallest = input
  for (const cap of caps) {
    let scaled = img
    if (cap < maxEdge) {
      const w = width >= height ? cap : Math.max(1, Math.round((width * cap) / maxEdge))
      const h = height > width ? cap : Math.max(1, Math.round((height * cap) / maxEdge))
      scaled = img.resize({ width: w, height: h, quality: 'better' })
    }
    for (const q of QUALITIES) {
      const out = scaled.toJPEG(q)
      if (out.length < smallest.length) smallest = out
      if (out.length <= maxBytes) return { data: out, mime: 'image/jpeg', compressed: true }
    }
  }

  // Smallest dimensions + lowest quality still over the cap.
  throw new Error(
    `${label} 压缩后仍有 ${mb(smallest.length)}MB，超过 ${mb(maxBytes)}MB 上限，请改用更小或更简单的图片`
  )
}
