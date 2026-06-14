/**
 * Shared attachment helpers for composer inputs (对话页 ChatInput / 工作台 VibeComposer).
 * Kept framework-free so both can pick/paste/drop files with one mime + URL source.
 */

export interface ComposerAttachment {
  name: string
  path: string
  mimeType: string
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv'
}

export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return MIME_MAP[ext || ''] || 'application/octet-stream'
}

/** Convert a disk path to the renderer's local-file:// protocol URL for previews. */
export function toLocalFileUrl(filePath: string): string {
  const fwd = filePath.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.readAsDataURL(blob)
  })
}

export const isImageMime = (mime: string): boolean => mime.startsWith('image/')
