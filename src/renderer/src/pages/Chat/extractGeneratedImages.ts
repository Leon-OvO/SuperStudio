import type { Message } from '../../../../shared/ipc-types'

export interface GeneratedImageRef {
  path: string
  /** Stable, chronological label shown in the @-mention picker, e.g. "图1". */
  label: string
}

/**
 * Every image this conversation has produced, in chronological order, for the
 * composer's @-mention picker. Mirrors the artifact extraction MessageList uses
 * (builtin image_generate result.images + any MCP tool's image artifacts), so the
 * picker and the inline thumbnails always agree. Deduped by path; first occurrence
 * keeps its stable label.
 */
export function extractGeneratedImages(messages: Message[]): GeneratedImageRef[] {
  const paths: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (tc.toolName === '__retry__') continue
      if (tc.toolName === 'image_generate') {
        const result = tc.result as { images?: Array<{ path: string }> } | undefined
        result?.images?.forEach(img => { if (img?.path) paths.push(img.path) })
      }
      const mcp = tc.result as { artifacts?: Array<{ type: string; path: string }> } | undefined
      if (mcp?.artifacts) {
        for (const a of mcp.artifacts) if (a.type === 'image' && a.path) paths.push(a.path)
      }
    }
  }
  const seen = new Set<string>()
  const out: GeneratedImageRef[] = []
  for (const p of paths) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push({ path: p, label: `图${out.length + 1}` })
  }
  return out
}
