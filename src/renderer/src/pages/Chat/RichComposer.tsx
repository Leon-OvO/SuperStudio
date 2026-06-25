import { forwardRef, useImperativeHandle, useRef, useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Server, MessageSquare, MessagesSquare, FileText } from 'lucide-react'
import type { SshConnectionMeta, ContextRef } from '../../../../shared/ipc-types'

/** A reference the user @-mentioned, rendered as an inline chip in the editor. */
export type InlineRef =
  | { kind: 'image'; path: string; label: string; mime: string }
  | { kind: 'file'; path: string; name: string; mime: string }
  | { kind: 'ssh'; conn: SshConnectionMeta }
  | { kind: 'msg'; text: string; label: string }
  | { kind: 'summary' }

export interface ComposerSerialized {
  /** Plain message text with inline refs flattened to name-based 【…】 tokens. */
  text: string
  /** Files carried by inline 图/文件 chips — @-referenced resources live ONLY as
   *  inline chips (NOT the folded attachments panel); the parent merges these with
   *  the brought-in attachments (de-duped by path) at send time. */
  inlineAttachments: Array<{ name: string; path: string; mimeType: string }>
  sshDefaultConnIds: string[]
  contextRefs: ContextRef[]
}

export interface RichComposerHandle {
  focus(): void
  clear(): void
  isEmpty(): boolean
  serialize(): ComposerSerialized
  /** Replace the active @query (or insert at caret) with an inline ref chip. */
  insertRef(ref: InlineRef): void
  /** Replace the active @query (or insert at caret) with plain text (group @员工). */
  insertText(text: string): void
  /** Replace the WHOLE editor content with plain text (drops chips). Used by the
   *  canvas composer's 扩写 to write back an expanded prompt. */
  setText(text: string): void
  /** Insert a bare `@` at the caret and open the mention picker (toolbar button). */
  triggerMention(): void
  /** Delete the active @query text without inserting anything (used when an @-pick
   *  routes elsewhere, e.g. an image becomes a left-side tile rather than a chip). */
  removeQuery(): void
}

interface Props {
  placeholder: string
  disabled: boolean
  /** @query changed (null = no active mention). */
  onMention: (query: string | null) => void
  /** Enter pressed without shift (and not composing / not handled by the picker). */
  onEnter: () => void
  /** Editor content emptiness changed — drives canSend + placeholder. */
  onEmptyChange: (empty: boolean) => void
  /** Images pasted/dropped — the parent turns them into left-side tiles. */
  onPasteFiles: (files: File[]) => void
  /** While a mention picker is open, let the parent drive Arrow/Enter/Tab/Esc.
   *  Return true if it handled the key (we then preventDefault). */
  onMentionKeyDown?: (e: React.KeyboardEvent) => boolean
}

function toLocalFileUrl(filePath: string): string {
  const fwd = filePath.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

let chipSeq = 0
const nextKey = (): string => `chip-${++chipSeq}-${performance.now().toString(36)}`

/** Build a contenteditable=false chip span for an inline ref. */
function buildChip(key: string, ref: InlineRef): HTMLSpanElement {
  const span = document.createElement('span')
  span.dataset.chip = key
  span.contentEditable = 'false'
  span.className = 'rc-chip'
  // Leading icon / thumbnail.
  if (ref.kind === 'image') {
    const img = document.createElement('img')
    img.src = toLocalFileUrl(ref.path)
    img.className = 'rc-chip-thumb'
    img.alt = ref.label
    span.appendChild(img)
  } else {
    const ic = document.createElement('span')
    ic.className = 'rc-chip-ic'
    ic.textContent = ref.kind === 'ssh' ? '🖥' : ref.kind === 'summary' ? '📚' : ref.kind === 'file' ? '📎' : '💬'
    span.appendChild(ic)
  }
  // Label (textContent → no injection).
  const lbl = document.createElement('span')
  lbl.className = 'rc-chip-lbl'
  lbl.textContent =
    ref.kind === 'image' ? ref.label
    : ref.kind === 'file' ? ref.name
    : ref.kind === 'ssh' ? ref.conn.name
    : ref.kind === 'msg' ? ref.label
    : '对话摘要'
  span.appendChild(lbl)
  // Remove button (delegated click via data-chip-remove).
  const rm = document.createElement('span')
  rm.className = 'rc-chip-x'
  rm.dataset.chipRemove = key
  rm.textContent = '×'
  span.appendChild(rm)
  return span
}

/** Rich composer: a contenteditable editor where @-referenced files / servers /
 *  context render as inline chips that flow with the typed text. Uncontrolled
 *  (the DOM owns content); the parent reads it via serialize() on send. */
export const RichComposer = forwardRef<RichComposerHandle, Props>(function RichComposer(
  { placeholder, disabled, onMention, onEnter, onEmptyChange, onPasteFiles, onMentionKeyDown }, ref
) {
  const editorRef = useRef<HTMLDivElement>(null)
  const refMap = useRef<Map<string, InlineRef>>(new Map())
  const composingRef = useRef(false)
  // The text range of the active @query (so insertRef/insertText can replace it).
  const mentionRange = useRef<{ node: Text; at: number; end: number } | null>(null)
  const [empty, setEmpty] = useState(true)
  const [hover, setHover] = useState<{ key: string; top: number; left: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncEmpty = useCallback(() => {
    const el = editorRef.current
    const isEmpty = !el || (!(el.textContent || '').trim() && refMap.current.size === 0)
    setEmpty(isEmpty)
    onEmptyChange(isEmpty)
  }, [onEmptyChange])

  // Detect an `@token` immediately left of a collapsed caret inside a text node.
  const detectMention = useCallback(() => {
    if (composingRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) { onMention(null); mentionRange.current = null; return }
    const node = sel.anchorNode
    if (!node || node.nodeType !== Node.TEXT_NODE || !editorRef.current?.contains(node)) { onMention(null); mentionRange.current = null; return }
    const tn = node as Text
    const offset = sel.anchorOffset
    const before = (tn.textContent || '').slice(0, offset)
    const at = before.lastIndexOf('@')
    if (at === -1) { onMention(null); mentionRange.current = null; return }
    const between = before.slice(at + 1)
    if (/[\s ]/.test(between)) { onMention(null); mentionRange.current = null; return }
    // '@' triggers at a boundary: start / whitespace / any NON-latin-word char — so it
    // fires right after CJK text (which has no word spaces). Only a latin word char
    // before '@' counts as mid-identifier (email "a@b") and is suppressed below.
    const prevRaw = at === 0 ? '' : before[at - 1]
    const prev = prevRaw && /[A-Za-z0-9_]/.test(prevRaw) ? prevRaw : ''
    if (prev && !/[\s ]/.test(prev)) { onMention(null); mentionRange.current = null; return }
    mentionRange.current = { node: tn, at, end: offset }
    onMention(between)
  }, [onMention])

  const handleInput = useCallback(() => {
    syncEmpty()
    detectMention()
  }, [syncEmpty, detectMention])

  // Place the caret right after `node`.
  const caretAfter = (node: Node) => {
    const sel = window.getSelection()
    if (!sel) return
    const r = document.createRange()
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  // Resolve a Range at the active @query (deleting it), or the current caret.
  const rangeForInsert = (): Range => {
    const mr = mentionRange.current
    if (mr && mr.node.parentNode && editorRef.current?.contains(mr.node)) {
      const r = document.createRange()
      const len = mr.node.textContent?.length ?? 0
      r.setStart(mr.node, Math.min(mr.at, len))
      r.setEnd(mr.node, Math.min(mr.end, len))
      r.deleteContents()
      r.collapse(true)
      return r
    }
    const sel = window.getSelection()
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) return sel.getRangeAt(0)
    // Fallback: end of editor.
    const r = document.createRange()
    const el = editorRef.current!
    r.selectNodeContents(el)
    r.collapse(false)
    return r
  }

  const insertRef = useCallback((data: InlineRef) => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const range = rangeForInsert()
    const key = nextKey()
    const chip = buildChip(key, data)
    range.insertNode(chip)
    const space = document.createTextNode(' ')
    chip.after(space)
    caretAfter(space)
    refMap.current.set(key, data)
    mentionRange.current = null
    onMention(null)
    syncEmpty()
  }, [onMention, syncEmpty])

  const removeQuery = useCallback(() => {
    const el = editorRef.current
    const mr = mentionRange.current
    if (el && mr && mr.node.parentNode && el.contains(mr.node)) {
      const len = mr.node.textContent?.length ?? 0
      const r = document.createRange()
      r.setStart(mr.node, Math.min(mr.at, len))
      r.setEnd(mr.node, Math.min(mr.end, len))
      r.deleteContents()
      r.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges(); sel?.addRange(r)
    }
    mentionRange.current = null
    onMention(null)
    syncEmpty()
    el?.focus()
  }, [onMention, syncEmpty])

  const insertText = useCallback((text: string) => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const range = rangeForInsert()
    const tn = document.createTextNode(text)
    range.insertNode(tn)
    caretAfter(tn)
    mentionRange.current = null
    onMention(null)
    syncEmpty()
  }, [onMention, syncEmpty])

  const serialize = useCallback((): ComposerSerialized => {
    const el = editorRef.current
    const parts: string[] = []
    const inlineAttachments: Array<{ name: string; path: string; mimeType: string }> = []
    const sshDefaultConnIds: string[] = []
    const contextRefs: ContextRef[] = []
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push((node.textContent || '').replace(/ /g, ' ')); return }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const elNode = node as HTMLElement
      const ck = elNode.dataset?.chip
      if (ck) {
        const d = refMap.current.get(ck)
        if (!d) return
        // Image/file chips carry their own attachment (name-based token; the parent
        // de-dups these against the folded panel's attachments by path at send time).
        if (d.kind === 'image') { parts.push(`【图:${d.label}】`); inlineAttachments.push({ name: d.label, path: d.path, mimeType: d.mime }) }
        else if (d.kind === 'file') { parts.push(`【文件:${d.name}】`); inlineAttachments.push({ name: d.name, path: d.path, mimeType: d.mime }) }
        else if (d.kind === 'ssh') { parts.push(`【服务器:${d.conn.name}】`); sshDefaultConnIds.push(d.conn.id) }
        else if (d.kind === 'msg') { parts.push(`【引用:${d.label}】`); contextRefs.push({ kind: 'message', text: d.text, label: d.label }) }
        else { parts.push('【对话摘要】'); contextRefs.push({ kind: 'summary', label: '对话摘要' }) }
        return
      }
      if (elNode.nodeName === 'BR') { parts.push('\n'); return }
      // Block elements (a <div> per line that contenteditable creates on Enter).
      const isBlock = elNode.nodeName === 'DIV' || elNode.nodeName === 'P'
      if (isBlock && parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n')
      for (const c of Array.from(elNode.childNodes)) walk(c)
    }
    if (el) for (const c of Array.from(el.childNodes)) walk(c)
    return { text: parts.join('').replace(/\n{3,}/g, '\n\n').trim(), inlineAttachments, sshDefaultConnIds, contextRefs }
  }, [])

  const triggerMention = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    const range = (sel && sel.rangeCount && el.contains(sel.anchorNode))
      ? sel.getRangeAt(0)
      : (() => { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); return r })()
    // Prefix a space if the caret isn't at a word boundary, so "@" is detected.
    const node = range.startContainer
    const off = range.startOffset
    const charBefore = node.nodeType === Node.TEXT_NODE && off > 0 ? (node.textContent || '')[off - 1] : ''
    const insert = (charBefore && !/[\s ]/.test(charBefore) ? ' ' : '') + '@'
    const tn = document.createTextNode(insert)
    range.insertNode(tn)
    // Caret must land INSIDE the text node (right after '@'), not at element level —
    // detectMention only recognizes '@' when the selection anchor is a text node.
    const sel2 = window.getSelection()
    const r2 = document.createRange()
    r2.setStart(tn, tn.length)
    r2.collapse(true)
    sel2?.removeAllRanges()
    sel2?.addRange(r2)
    syncEmpty()
    detectMention()
  }, [syncEmpty, detectMention])

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clear: () => {
      const el = editorRef.current
      if (el) el.innerHTML = ''
      refMap.current.clear()
      mentionRange.current = null
      onMention(null)
      syncEmpty()
    },
    isEmpty: () => empty,
    serialize,
    insertRef,
    insertText,
    setText: (text: string) => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = ''
      refMap.current.clear()
      if (text) el.appendChild(document.createTextNode(text))
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(el); r.collapse(false)
      sel?.removeAllRanges(); sel?.addRange(r)
      mentionRange.current = null
      onMention(null)
      syncEmpty()
    },
    triggerMention,
    removeQuery
  }), [empty, serialize, insertRef, insertText, triggerMention, removeQuery, onMention, syncEmpty])

  // --- Chip remove (delegated) + hover preview ----------------------------
  const removeChip = useCallback((key: string) => {
    const el = editorRef.current
    if (!el) return
    const span = el.querySelector(`[data-chip="${key}"]`)
    if (span) {
      const next = span.nextSibling
      if (next && next.nodeType === Node.TEXT_NODE && (next.textContent === ' ' || next.textContent === ' ')) next.parentNode?.removeChild(next)
      span.parentNode?.removeChild(span)
    }
    refMap.current.delete(key)
    setHover(h => (h?.key === key ? null : h))
    syncEmpty()
    el.focus()
  }, [syncEmpty])

  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const chip = target.closest('[data-chip]') as HTMLElement | null
    if (!chip) return
    const key = chip.dataset.chip!
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    const rect = chip.getBoundingClientRect()
    setHover({ key, top: rect.top, left: rect.left + rect.width / 2 })
  }, [])

  const handleMouseOut = useCallback((e: React.MouseEvent) => {
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(null), 120)
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const rm = target.closest('[data-chip-remove]') as HTMLElement | null
    if (rm) { e.preventDefault(); removeChip(rm.dataset.chipRemove!) }
  }, [removeChip])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let the parent's mention picker consume nav keys first.
    if (onMentionKeyDown && onMentionKeyDown(e)) { e.preventDefault(); return }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onEnter()
      return
    }
    // Backspace right after a chip → remove the whole chip (don't strip its text).
    if (e.key === 'Backspace') {
      const sel = window.getSelection()
      if (sel && sel.isCollapsed && sel.anchorNode) {
        const node = sel.anchorNode
        const offset = sel.anchorOffset
        let chip: HTMLElement | null = null
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node as Text
          // caret at start of a text node whose previous sibling is a chip, OR the
          // text node is just the trailing nbsp right after a chip.
          if (offset === 0 && (t.previousSibling as HTMLElement)?.dataset?.chip) chip = t.previousSibling as HTMLElement
          else if ((offset === 1 && (t.textContent === ' ' || t.textContent === ' ')) && (t.previousSibling as HTMLElement)?.dataset?.chip) chip = t.previousSibling as HTMLElement
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const child = (node as HTMLElement).childNodes[offset - 1] as HTMLElement | undefined
          if (child?.dataset?.chip) chip = child
        }
        if (chip?.dataset.chip) { e.preventDefault(); removeChip(chip.dataset.chip) }
      }
    }
  }, [onMentionKeyDown, onEnter, removeChip])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter(it => it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length) { e.preventDefault(); onPasteFiles(files); return }
    // Plain-text paste only (strip rich HTML so pasted markup can't inject chips).
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (text) document.execCommand('insertText', false, text)
  }, [onPasteFiles])

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])

  return (
    <div className="relative">
      <style>{`
        /* Fixed height + centered content so every chip type (图片缩略图 / 图标 / 文字)
           is exactly the same height regardless of what's inside. */
        .rc-chip{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;box-sizing:border-box;
          height:22px;padding:0 5px 0 4px;margin:0 1px;border-radius:7px;border:1px solid hsl(var(--border));
          background:hsl(var(--muted));font-size:12px;line-height:1;user-select:none;cursor:default;white-space:nowrap;}
        .rc-chip[data-chip]:hover{border-color:hsl(var(--ring)/.6)}
        .rc-chip-thumb{width:15px;height:15px;border-radius:3px;object-fit:cover;display:block;flex:none}
        .rc-chip-ic{width:15px;text-align:center;font-size:12px;line-height:1;flex:none}
        .rc-chip-lbl{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:1}
        .rc-chip-x{display:inline-flex;align-items:center;margin-left:1px;padding:0 1px;color:hsl(var(--muted-foreground));cursor:pointer;border-radius:4px}
        .rc-chip-x:hover{color:hsl(var(--foreground));background:hsl(var(--accent))}
      `}</style>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false; handleInput() }}
        onMouseOver={handleMouseOver}
        onMouseOut={handleMouseOut}
        onClick={handleClick}
        onBlur={() => setTimeout(() => { if (document.activeElement !== editorRef.current) onMention(null) }, 150)}
        className="w-full px-4 pt-3 pb-2 outline-none text-base leading-relaxed overflow-y-auto whitespace-pre-wrap break-words"
        style={{ maxHeight: 240, minHeight: 56 }}
      />
      {empty && (
        <div className="absolute left-4 top-3 text-base text-muted-foreground/60 pointer-events-none select-none">
          {placeholder}
        </div>
      )}
      {hover && (() => {
        const data = refMap.current.get(hover.key)
        if (!data) return null
        // Portal to body: a position:fixed card is trapped by transform'd ancestors
        // (e.g. the canvas ReactFlow viewport); in body it anchors to the viewport.
        return createPortal(
          <ChipPreview data={data} top={hover.top} left={hover.left}
            onEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }}
            onLeave={() => setHover(null)} />,
          document.body
        )
      })()}
    </div>
  )
})

/** Floating preview card shown above a chip on hover. */
function ChipPreview({ data, top, left, onEnter, onLeave }: {
  data: InlineRef
  top: number
  left: number
  onEnter: () => void
  onLeave: () => void
}) {
  return (
    <div
      className="fixed z-50 -translate-x-1/2 -translate-y-full mb-2 max-w-[320px] rounded-xl border border-border bg-popover shadow-xl p-2 text-xs"
      style={{ top: top - 8, left }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {data.kind === 'image' && (
        <div className="flex flex-col gap-1">
          <img src={toLocalFileUrl(data.path)} alt={data.label} className="max-w-[280px] max-h-[200px] rounded-lg object-contain border border-border" />
          <span className="text-muted-foreground truncate">{data.label}</span>
        </div>
      )}
      {data.kind === 'file' && (
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-muted-foreground shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium truncate">{data.name}</span>
            <span className="block text-[10px] text-muted-foreground truncate">{data.path}</span>
          </span>
        </div>
      )}
      {data.kind === 'ssh' && (
        <div className="flex items-start gap-2">
          <Server size={16} className="text-primary shrink-0 mt-0.5" />
          <span className="min-w-0">
            <span className="block font-medium">{data.conn.name}</span>
            <span className="block text-[11px] text-muted-foreground tabular-nums">{data.conn.username}@{data.conn.host}:{data.conn.port}</span>
            {data.conn.group && <span className="block text-[10px] text-muted-foreground/70">分组：{data.conn.group}</span>}
            <span className="block text-[10px] text-primary/80 mt-0.5">本轮 ssh_exec 默认在此服务器执行</span>
          </span>
        </div>
      )}
      {data.kind === 'msg' && (
        <div className="flex items-start gap-2">
          <MessageSquare size={16} className="text-muted-foreground shrink-0 mt-0.5" />
          <span className="min-w-0 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto text-foreground/85">{data.text}</span>
        </div>
      )}
      {data.kind === 'summary' && (
        <div className="flex items-center gap-2">
          <MessagesSquare size={16} className="text-muted-foreground shrink-0" />
          <span>基于本对话整体内容来理解并回答这次追问。</span>
        </div>
      )}
    </div>
  )
}
