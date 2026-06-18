import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toPng } from 'html-to-image'
import { X, Download, Copy, Loader2, Check, ImageIcon, CheckSquare, Square } from 'lucide-react'
import { BRAND } from '@shared/brand'
import type { Message } from '../../../../shared/ipc-types'
import { Markdown } from '../../lib/markdown'
import { toast } from '../../components/ui/Toast'
import { cn } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  sessionTitle: string
  messages: Message[]
}

function toFileUrl(p: string): string {
  const fwd = p.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

function pad(n: number): string { return String(n).padStart(2, '0') }
function stampText(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Strip <think> reasoning blocks so the shared image shows only the answer. */
function answerOf(m: Message): string {
  if (m.role !== 'assistant') return m.content || ''
  return (m.content || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '').trim()
}

/** One-line snippet for the left selection list. */
function snippet(s: string): string {
  const clean = (s || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > 32 ? clean.slice(0, 32) + '…' : (clean || '（无文字内容）')
}

/** Image paths a message contributes: attachments + generated artifacts. */
function imagePaths(m: Message): string[] {
  const out: string[] = []
  for (const att of m.attachments ?? []) if (att.mimeType?.startsWith('image/')) out.push(att.path)
  for (const tc of m.toolCalls ?? []) {
    if (tc.toolName === '__retry__') continue
    if (tc.toolName === 'image_generate') {
      const r = tc.result as { images?: Array<{ path?: string }> } | undefined
      r?.images?.forEach(i => { if (i?.path) out.push(i.path) })
    }
    const arts = (tc.result as { artifacts?: Array<{ type?: string; path?: string }> } | undefined)?.artifacts
    if (Array.isArray(arts)) for (const a of arts) if (a?.type === 'image' && a.path) out.push(a.path)
  }
  return out
}

/**
 * 对话长截图 —— renders the selected messages into a clean, light-themed vertical
 * transcript and exports it as a single tall PNG (save to disk or copy). The
 * capture node is the full, non-virtualized render, so the whole conversation
 * (or any selected subset) ends up in one image for sharing.
 */
export function ConversationImageDialog({ open, onClose, sessionTitle, messages }: Props) {
  // Only real chat messages (skip error banners) — default all selected.
  const shareable = useMemo(
    () => messages.filter(m => (m.role === 'user' || m.role === 'assistant') && !(m.content || '').startsWith('⚠️')),
    [messages]
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(shareable.map(m => m.id)))
  const [busy, setBusy] = useState<null | 'save' | 'copy'>(null)
  const [copied, setCopied] = useState(false)
  const captureRef = useRef<HTMLDivElement>(null)

  if (!open) return null

  const picked = shareable.filter(m => selected.has(m.id))
  const allOn = picked.length === shareable.length && shareable.length > 0
  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(shareable.map(m => m.id)))

  async function capture(): Promise<string | null> {
    const node = captureRef.current
    if (!node) return null
    // Wait a tick so any just-rendered images are in the DOM, then snapshot at 2x.
    return toPng(node, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true, skipFonts: false })
  }

  async function handleSave() {
    if (!picked.length || busy) return
    setBusy('save')
    try {
      const dataUrl = await capture()
      if (!dataUrl) return
      const base64 = dataUrl.split(',')[1]
      const rand = Math.random().toString(36).slice(2, 8)
      const tmp = await window.api.writeTempFile({ name: `chat-shot-${Date.now()}-${rand}.png`, data: base64 })
      const safe = (sessionTitle || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)
      const res = await window.api.saveFileAs(tmp.path, `${safe}-长截图.png`)
      if (res && !res.canceled) toast.success('已保存对话长截图')
    } catch (e) {
      toast.error('生成图片失败：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function handleCopy() {
    if (!picked.length || busy) return
    setBusy('copy')
    try {
      const dataUrl = await capture()
      if (!dataUrl) return
      const { copyImageToClipboard } = await import('../../lib/clipboard')
      const ok = await copyImageToClipboard(dataUrl)
      if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1800); toast.success('已复制到剪贴板') }
      else toast.error('复制失败')
    } catch (e) {
      toast.error('复制失败：' + (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" onMouseDown={onClose}>
      <style>{`
        /* Force a light, readable palette inside the capture node regardless of the
           app theme, so shared images look the same dark or light. */
        .ss-shot{
          --background:0 0% 100%; --foreground:0 0% 12%;
          --card:0 0% 100%; --card-foreground:0 0% 12%;
          --popover:0 0% 100%; --popover-foreground:0 0% 12%;
          --muted:0 0% 96%; --muted-foreground:0 0% 42%;
          --border:0 0% 90%; --input:0 0% 90%;
          --accent:0 0% 96%; --accent-foreground:0 0% 12%;
          --primary:221 83% 53%; --primary-foreground:0 0% 100%;
          --secondary:0 0% 96%; --secondary-foreground:0 0% 12%;
          color:#1f2937;background:#fff;
        }
      `}</style>
      <div
        className="bg-card rounded-xl border border-border shadow-2xl w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold"><ImageIcon size={15} /> 导出对话长截图</div>
          <div className="flex items-center gap-2">
            <button onClick={handleCopy} disabled={!picked.length || !!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-accent transition-colors disabled:opacity-50">
              {busy === 'copy' ? <Loader2 size={13} className="animate-spin" /> : copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />} 复制
            </button>
            <button onClick={handleSave} disabled={!picked.length || !!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90 transition-colors disabled:opacity-50">
              {busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} 保存为图片
            </button>
            <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={16} /></button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* left: message selection */}
          <div className="w-64 shrink-0 border-r border-border flex flex-col min-h-0">
            <button onClick={toggleAll} className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground border-b border-border/60 shrink-0">
              {allOn ? <CheckSquare size={13} /> : <Square size={13} />} 全选 · 已选 {picked.length}/{shareable.length}
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
              {shareable.map(m => {
                const on = selected.has(m.id)
                return (
                  <button key={m.id} onClick={() => toggle(m.id)}
                    className={cn('w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                      on ? 'bg-primary/[0.06]' : 'hover:bg-accent opacity-60')}>
                    {on ? <CheckSquare size={13} className="text-primary shrink-0 mt-0.5" /> : <Square size={13} className="text-muted-foreground shrink-0 mt-0.5" />}
                    <span className="min-w-0">
                      <span className="block text-[11px] font-medium">{m.role === 'user' ? '🧑 你' : '🤖 助手'}</span>
                      <span className="block text-[10.5px] text-muted-foreground truncate">{snippet(m.content)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* right: live preview = capture target */}
          <div className="flex-1 min-w-0 overflow-y-auto bg-neutral-200/60 dark:bg-neutral-800/60 p-4">
            <div ref={captureRef} className="ss-shot mx-auto" style={{ width: 720, padding: 28, borderRadius: 12 }}>
              <div style={{ borderBottom: '1px solid hsl(var(--border))', paddingBottom: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{sessionTitle || '对话记录'}</div>
                <div style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', marginTop: 4 }}>
                  {BRAND.displayName} · 导出于 {stampText(Date.now())} · 共 {picked.length} 条
                </div>
              </div>

              {picked.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'hsl(var(--muted-foreground))', padding: '40px 0', fontSize: 13 }}>请在左侧勾选要导出的消息</div>
              ) : picked.map(m => {
                const isUser = m.role === 'user'
                const imgs = imagePaths(m)
                const text = answerOf(m)
                return (
                  <div key={m.id} style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: isUser ? 'hsl(var(--primary))' : '#0f766e', marginBottom: 6 }}>
                      {isUser ? '🧑 你' : `🤖 助手${m.meta?.model ? ' · ' + m.meta.model : ''}`}
                      <span style={{ fontWeight: 400, color: 'hsl(var(--muted-foreground))', marginLeft: 8, fontSize: 11 }}>{stampText(m.createdAt)}</span>
                    </div>
                    <div style={{
                      background: isUser ? 'hsl(var(--primary) / 0.06)' : 'hsl(var(--muted))',
                      border: '1px solid hsl(var(--border))', borderRadius: 10, padding: '10px 12px'
                    }}>
                      {text ? (
                        isUser
                          ? <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.6 }}>{text}</div>
                          : <Markdown content={text} />
                      ) : imgs.length ? null : <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13 }}>（无文字内容）</span>}
                      {imgs.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: text ? 10 : 0 }}>
                          {imgs.map((p, i) => (
                            <img key={i} src={toFileUrl(p)} crossOrigin="anonymous"
                              style={{ maxWidth: 320, maxHeight: 260, borderRadius: 8, border: '1px solid hsl(var(--border))', objectFit: 'contain' }} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}

              <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: 10, marginTop: 8, fontSize: 10.5, color: 'hsl(var(--muted-foreground))', textAlign: 'center' }}>
                由 {BRAND.displayName} 生成
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
