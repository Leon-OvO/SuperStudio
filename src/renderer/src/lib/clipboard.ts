/**
 * Convert any blob (jpg/webp/etc.) to PNG by drawing to a canvas.
 * Required because `navigator.clipboard.write` accepts only image/png reliably.
 */
async function convertToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('canvas 2d context unavailable'))
      ctx.drawImage(img, 0, 0)
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/png')
    }
    img.onerror = () => reject(new Error('image load failed'))
    img.src = URL.createObjectURL(blob)
  })
}

/**
 * Copy an image (referenced by its src URL — typically local-file:///…) to the OS clipboard
 * as a PNG. Returns true on success, false on failure.
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const res = await fetch(src)
    const blob = await res.blob()
    const pngBlob = blob.type === 'image/png' ? blob : await convertToPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
    return true
  } catch (e) {
    console.error('[clipboard] copy image failed:', e)
    return false
  }
}
