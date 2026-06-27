import fs from 'fs'
import { compressImageToFit, DEFAULT_MAX_IMAGE_BYTES } from './image-compress'

/** MIME for an image path (used when feeding reference images to a vision model). */
function mimeForImage(p: string): string {
  const ext = (p.split('.').pop() || '').toLowerCase()
  return ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'bmp' ? 'image/bmp'
    : 'image/jpeg'
}

export interface VisionImagePart { type: 'image'; image: Buffer; mimeType: string }

/**
 * Read reference images for a multimodal LLM message: skips missing/unreadable,
 * auto-compresses oversized ones to fit, drops only those that truly can't be
 * compressed. Mirrors the canvas「提示词扩写」reference-image handling.
 */
export function loadImageParts(paths: string[] | undefined, max = 6): VisionImagePart[] {
  const out: VisionImagePart[] = []
  for (const p of (paths || []).slice(0, max)) {
    try {
      if (!p || !fs.existsSync(p)) continue
      let data: Buffer = fs.readFileSync(p)
      let mime = mimeForImage(p)
      if (data.length > DEFAULT_MAX_IMAGE_BYTES) {
        try {
          const r = compressImageToFit(data, DEFAULT_MAX_IMAGE_BYTES, '参考图')
          if (r.compressed) { data = r.data; mime = r.mime }
        } catch { continue } // 真的压缩不动 → 跳过这张
      }
      out.push({ type: 'image', image: data, mimeType: mime })
    } catch { /* skip unreadable */ }
  }
  return out
}
