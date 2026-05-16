import type { Message } from '../../../shared/ipc-types'

function pad(n: number): string { return String(n).padStart(2, '0') }

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function safeFileName(title: string): string {
  // Replace characters illegal on Windows; trim length so the dialog default
  // doesn't blow up.
  return title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'session'
}

/** Build a Markdown transcript of a session — friendly for sharing / archival. */
export function toMarkdown(sessionTitle: string, messages: Message[]): string {
  const lines: string[] = []
  lines.push(`# ${sessionTitle || '未命名对话'}`)
  lines.push('')
  if (messages.length === 0) {
    lines.push('（这个对话还没有内容。）')
    return lines.join('\n')
  }
  lines.push(`> 导出于 ${formatTimestamp(Date.now())} · 共 ${messages.length} 条消息`)
  lines.push('')

  for (const m of messages) {
    const stamp = formatTimestamp(m.createdAt)
    if (m.role === 'user') {
      lines.push(`## 🧑 你 · ${stamp}`)
    } else if (m.role === 'assistant') {
      const modelHint = m.meta?.model ? ` · ${m.meta.model}` : ''
      lines.push(`## 🤖 助手${modelHint} · ${stamp}`)
    } else {
      lines.push(`## 🔧 ${m.role} · ${stamp}`)
    }
    lines.push('')

    // Attachments
    if (m.attachments && m.attachments.length) {
      const lines2: string[] = []
      for (const att of m.attachments) {
        if (att.mimeType?.startsWith('image/')) {
          lines2.push(`![${att.name}](${att.path})`)
        } else {
          lines2.push(`📎 \`${att.name}\` — \`${att.path}\``)
        }
      }
      lines.push(lines2.join('\n'))
      lines.push('')
    }

    // Tool calls — summarize as a fenced block
    if (m.toolCalls && m.toolCalls.length) {
      for (const tc of m.toolCalls) {
        if (tc.toolName === '__retry__') continue
        lines.push(`<details>`)
        lines.push(`<summary>🔧 工具调用：<code>${tc.toolName}</code></summary>`)
        lines.push('')
        lines.push('```json')
        lines.push(JSON.stringify({ args: tc.args, result: tc.result }, null, 2))
        lines.push('```')
        lines.push('')
        lines.push(`</details>`)
        lines.push('')
      }
    }

    if (m.content) {
      lines.push(m.content)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // Trim trailing separator
  while (lines.length && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '---')) lines.pop()
  return lines.join('\n')
}

/** Full-fidelity JSON dump — round-trippable. */
export function toJson(sessionTitle: string, messages: Message[]): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    title: sessionTitle,
    messageCount: messages.length,
    messages
  }, null, 2)
}

export interface ExportTarget {
  format: 'markdown' | 'json'
  defaultName: string
  content: string
  filters: Array<{ name: string; extensions: string[] }>
}

export function buildExportTarget(
  format: 'markdown' | 'json',
  sessionTitle: string,
  messages: Message[]
): ExportTarget {
  const base = safeFileName(sessionTitle)
  const stamp = `${new Date().getFullYear()}${pad(new Date().getMonth() + 1)}${pad(new Date().getDate())}`
  if (format === 'markdown') {
    return {
      format,
      defaultName: `${base}-${stamp}.md`,
      content: toMarkdown(sessionTitle, messages),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }]
    }
  }
  return {
    format,
    defaultName: `${base}-${stamp}.json`,
    content: toJson(sessionTitle, messages),
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
  }
}
