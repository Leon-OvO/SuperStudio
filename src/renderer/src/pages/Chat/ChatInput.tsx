import { useState, useRef, useCallback, useEffect, useMemo, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { BRAND } from '@shared/brand'
import type { GeneratedImageRef } from './extractGeneratedImages'
import type { GalleryItem, SshConnectionMeta, ContextRef } from '../../../../shared/ipc-types'
import { RichComposer, type RichComposerHandle } from './RichComposer'

/** Max 素材库 results the @-picker requests per query (LIMIT pushed into SQL). */
const MENTION_GALLERY_LIMIT = 40
import { Send, Square, Paperclip, X, ImagePlus, FileText, ImageOff, Monitor, Folder, FolderOpen, AtSign, Server, MessageSquare, MessagesSquare, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ModelPicker } from './ModelPicker'
import { Select } from '../../components/ui/Select'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { toast } from '../../components/ui/Toast'
import { type ImageParams, IMAGE_RATIOS, computeImageSize } from './ChatHeader'

interface Attachment { name: string; path: string; mimeType: string }

/** Extra @-mentioned references sent alongside the text + attachments. */
interface MentionPayload { sshDefaultConnIds?: string[]; contextRefs?: ContextRef[] }

interface Props {
  onSend: (text: string, attachments?: Attachment[], mentions?: MentionPayload) => void
  onStop: () => void
  isRunning: boolean
  disabled: boolean
  imageMode?: boolean
  /** Per-turn "强制本轮生成图片" toggle — generate an image this turn even with a
   *  chat model selected (uses the default image model). Works alongside imageMode. */
  forceImage?: boolean
  onForceImageChange?: (on: boolean) => void
  /** "电脑操控" mode: this turn runs the screenshot loop to drive the desktop. */
  computerMode?: boolean
  onComputerModeChange?: (on: boolean) => void
  /** Whether the Computer Use plugin is enabled (Settings → 插件). The 电脑操控
   *  toggle is only shown when this is true. */
  computerUseEnabled?: boolean
  /** This conversation's working directory (absolute path); '' = unset. When set,
   *  the agent default-saves files there and can list its contents. */
  workingDir?: string
  /** Set or clear the working directory (receives '' to clear). When provided,
   *  the 工作目录 chip is shown in the toolbar. */
  onSetWorkingDir?: (dir: string) => void
  /** Controlled attachments state (lifted to parent so external sources can inject).
   *  These are pasted/dropped/selected files — shown as LEFT-side tiles. @-mentioned
   *  refs instead become inline chips inside the rich editor. */
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  /** Images this conversation generated — for the `@` mention picker. */
  generatedImages?: GeneratedImageRef[]
  /** Recent messages of this conversation — for `@`-referencing one to follow up on. */
  recentMessages?: Array<{ id: string; role: string; content: string }>
  /** Currently-selected model (provider + model name); empty strings = use defaults. */
  providerId: string
  model: string
  onModelChange: (providerId: string, model: string) => void
  /** Image params shown when imageMode is true. */
  imageParams: ImageParams
  onImageParamsChange: (params: ImageParams) => void
  /** Open the global ImageEditor with the given src. */
  onEditImage: (src: string) => void
  /** Group chat: members that can be @-mentioned. When provided, typing `@`
   *  opens an employee picker (to direct a turn) instead of the rich picker. */
  mentionEmployees?: Array<{ id: string; name: string; dept: string }>
}

/** A single row in the rich `@` picker (attachment / image / SSH server / context). */
type MentionEntry =
  | { kind: 'image'; key: string; label: string; sub: string; path: string; group: string }
  | { kind: 'file'; key: string; label: string; sub: string; path: string; name: string; mime: string }
  | { kind: 'ssh'; key: string; label: string; sub: string; conn: SshConnectionMeta }
  | { kind: 'msg'; key: string; label: string; sub: string; text: string }
  | { kind: 'summary'; key: string; label: string; sub: string }

/** Short one-line preview of a message body (strip think blocks + collapse space). */
function msgSnippet(s: string): string {
  const clean = (s || '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean
}

export function ChatInput({
  onSend, onStop, isRunning, disabled, imageMode,
  forceImage, onForceImageChange,
  computerMode, onComputerModeChange, computerUseEnabled,
  workingDir, onSetWorkingDir,
  attachments, setAttachments, generatedImages, recentMessages,
  providerId, model, onModelChange,
  imageParams, onImageParamsChange,
  onEditImage, mentionEmployees
}: Props) {
  // Group session → `@` mentions employees (to direct a turn) instead of the rich
  // picker (images / 服务器 / 上下文).
  const employeeMentionMode = (mentionEmployees?.length ?? 0) > 0
  const composerRef = useRef<RichComposerHandle>(null)
  const [composerEmpty, setComposerEmpty] = useState(true)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // Active `@` query (null = picker closed), reported by the rich editor.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  // 素材库 results, searched on-demand (debounced, LIMIT'd) so a huge library never
  // loads wholesale. Cap reached => MENTION_GALLERY_LIMIT exactly.
  const [galleryResults, setGalleryResults] = useState<GeneratedImageRef[]>([])
  const [sshConns, setSshConns] = useState<SshConnectionMeta[]>([])
  // Folded attachments panel (above the box) open/closed.
  const [attachOpen, setAttachOpen] = useState(true)
  const ctxMenu = useImageContextMenu()

  // Lazy-load the credential-free SSH connection list once (skip in group chat).
  useEffect(() => {
    if (employeeMentionMode) return
    let cancelled = false
    window.api.sshListMeta?.().then((list: SshConnectionMeta[]) => { if (!cancelled) setSshConns(list || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [employeeMentionMode])

  // 右键消息「引用追问」→ 把那段内容插成一个「引用」行内胶囊（随消息以 contextRef 发送）。
  useEffect(() => {
    const handler = (e: Event) => {
      const text = ((e as CustomEvent).detail?.text || '').trim()
      if (!text) return
      composerRef.current?.insertRef({ kind: 'msg', text, label: msgSnippet(text) })
      composerRef.current?.focus()
    }
    window.addEventListener('chat:quote', handler)
    return () => window.removeEventListener('chat:quote', handler)
  }, [])

  const active = mentionQuery !== null

  // Group employee @-mention matches (filtered by the @query).
  const employeeMatches = useMemo(() => {
    if (!active || !employeeMentionMode) return []
    const q = (mentionQuery ?? '').toLowerCase()
    return (mentionEmployees ?? []).filter(e => !q || e.name.toLowerCase().includes(q))
  }, [active, mentionQuery, employeeMentionMode, mentionEmployees])

  // 本对话生成 (in-memory, filtered by query) + 素材库 (server-searched), de-duped by path.
  const imageMatches = useMemo(() => {
    if (!active || employeeMentionMode) return []
    const q = (mentionQuery ?? '').toLowerCase()
    const chat = (generatedImages ?? []).filter(g =>
      !q || g.label.toLowerCase().includes(q) || (g.path.split(/[\\/]/).pop() || '').toLowerCase().includes(q))
    const seen = new Set(chat.map(g => g.path))
    return [...chat, ...galleryResults.filter(g => !seen.has(g.path))]
  }, [active, mentionQuery, employeeMentionMode, generatedImages, galleryResults])

  // Rich picker rows: 当前附件(优先) + 图片 + 服务器 + 上下文(历史消息 / 整段摘要). Filtered by the @query.
  const richSections = useMemo((): Array<{ key: string; title: string; entries: MentionEntry[] }> => {
    if (!active || employeeMentionMode) return []
    const q = (mentionQuery ?? '').toLowerCase()
    const match = (s?: string) => !q || (s || '').toLowerCase().includes(q)

    // 当前附件优先：已带入的附件排在最前，@ 选中后在文中插一个指针胶囊。
    const attach: MentionEntry[] = attachments
      .filter(a => match(a.name))
      .map(a => a.mimeType.startsWith('image/')
        ? { kind: 'image', key: 'att:' + a.path, label: a.name, sub: '附件', path: a.path, group: '当前附件' }
        : { kind: 'file', key: 'att:' + a.path, label: a.name, sub: '附件', path: a.path, name: a.name, mime: a.mimeType })

    const images: MentionEntry[] = imageMatches.map(g => ({
      kind: 'image', key: 'img:' + g.path, label: g.label,
      sub: g.path.split(/[\\/]/).pop() || '', path: g.path, group: g.group || '本对话生成'
    }))
    const servers: MentionEntry[] = sshConns
      .filter(c => match(c.name) || match(c.host) || match(c.username))
      .slice(0, 20)
      .map(c => ({ kind: 'ssh', key: 'ssh:' + c.id, label: c.name, sub: `${c.username}@${c.host}`, conn: c }))
    const msgs: MentionEntry[] = (recentMessages ?? [])
      .filter(m => (m.content || '').trim())
      .slice(-15).reverse()
      .filter(m => match(m.content))
      .slice(0, 8)
      .map(m => ({ kind: 'msg', key: 'msg:' + m.id, label: (m.role === 'user' ? '我' : 'AI') + '：' + msgSnippet(m.content), sub: '', text: m.content }))
    const summary: MentionEntry[] = (!q || '整段对话摘要 对话摘要 摘要 summary'.includes(q))
      ? [{ kind: 'summary', key: 'summary', label: '整段对话摘要', sub: '基于本对话整体来回答这次追问' }]
      : []

    const out: Array<{ key: string; title: string; entries: MentionEntry[] }> = []
    if (attach.length) out.push({ key: 'attach', title: '当前附件（优先）', entries: attach })
    if (images.length) out.push({ key: 'image', title: '图片（参考图）', entries: images })
    if (servers.length) out.push({ key: 'ssh', title: '服务器（设为本轮默认）', entries: servers })
    if (msgs.length || summary.length) out.push({ key: 'ctx', title: '对话上下文', entries: [...msgs, ...summary] })
    return out
  }, [active, mentionQuery, employeeMentionMode, attachments, imageMatches, sshConns, recentMessages])

  // Category filter for the picker — keeps it scannable when many @ types match.
  type MentionCat = 'all' | 'attach' | 'image' | 'ssh' | 'ctx'
  const [mentionCat, setMentionCat] = useState<MentionCat>('all')
  useEffect(() => { if (!active) setMentionCat('all') }, [active])
  const visibleSections = useMemo(
    () => mentionCat === 'all' ? richSections : richSections.filter(s => s.key === mentionCat),
    [richSections, mentionCat]
  )
  const flatEntries = useMemo(() => visibleSections.flatMap(s => s.entries), [visibleSections])
  useEffect(() => { setMentionIndex(0) }, [mentionQuery, mentionCat])
  // Tabs to show: 全部 + whichever categories currently have matches.
  const catTabs = useMemo(() => {
    const tabs: Array<{ key: MentionCat; label: string }> = [{ key: 'all', label: '全部' }]
    if (richSections.some(s => s.key === 'attach')) tabs.push({ key: 'attach', label: '附件' })
    if (richSections.some(s => s.key === 'image')) tabs.push({ key: 'image', label: '图片' })
    if (richSections.some(s => s.key === 'ssh')) tabs.push({ key: 'ssh', label: '服务器' })
    if (richSections.some(s => s.key === 'ctx')) tabs.push({ key: 'ctx', label: '上下文' })
    return tabs
  }, [richSections])

  // Debounced 素材库 search whenever the @query changes (skip in employee-mention mode).
  useEffect(() => {
    if (!active || employeeMentionMode) { setGalleryResults([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const items = (await window.api.searchGallery(mentionQuery ?? '', MENTION_GALLERY_LIMIT)) as GalleryItem[]
        if (cancelled) return
        setGalleryResults(items.map(it => ({
          path: it.filePath,
          label: it.filePath.split(/[\\/]/).pop() || '素材',
          group: '素材库'
        })))
      } catch { if (!cancelled) setGalleryResults([]) }
    }, 180)
    return () => { cancelled = true; clearTimeout(t) }
  }, [active, mentionQuery, employeeMentionMode])

  const mimeForImagePath = (p: string): string => {
    const ext = (p.split('.').pop() || 'png').toLowerCase()
    return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif'
      : ext === 'bmp' ? 'image/bmp' : 'image/png'
  }

  // Pick a rich-picker row → insert an inline chip ONLY. @-referenced resources live
  // as inline chips (carrying their own attachment), NOT the folded panel above; they
  // merge in (de-duped by path) at send time.
  const pickEntry = useCallback((e: MentionEntry) => {
    if (e.kind === 'image') {
      void window.api.approvePath(e.path)
      composerRef.current?.insertRef({ kind: 'image', path: e.path, label: e.label, mime: mimeForImagePath(e.path) })
    } else if (e.kind === 'file') {
      composerRef.current?.insertRef({ kind: 'file', path: e.path, name: e.name, mime: e.mime })
    } else if (e.kind === 'ssh') {
      composerRef.current?.insertRef({ kind: 'ssh', conn: e.conn })
    } else if (e.kind === 'msg') {
      composerRef.current?.insertRef({ kind: 'msg', text: e.text, label: msgSnippet(e.text) })
    } else {
      composerRef.current?.insertRef({ kind: 'summary' })
    }
    setMentionQuery(null)
  }, [])

  const insertEmployeeMention = useCallback((name: string) => {
    composerRef.current?.insertText('@' + name + ' ')
    setMentionQuery(null)
  }, [])

  // Close preview on Escape
  useEffect(() => {
    if (!previewSrc) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreviewSrc(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewSrc])

  const handleSend = useCallback(() => {
    if (isRunning) return
    const ser = composerRef.current?.serialize()
    const text = (ser?.text || '').trim()
    // Inline 图/文件 chips (@-referenced, carry their own file) + the folded panel's
    // brought-in attachments → one list, de-duped by path (inline wins on collision).
    const seen = new Set<string>()
    const finalAttachments: Attachment[] = []
    for (const a of [...(ser?.inlineAttachments ?? []), ...attachments]) {
      if (seen.has(a.path)) continue
      seen.add(a.path)
      finalAttachments.push(a)
    }
    if (!text && finalAttachments.length === 0) return
    const mentions: MentionPayload | undefined = (ser && (ser.sshDefaultConnIds.length || ser.contextRefs.length))
      ? { sshDefaultConnIds: ser.sshDefaultConnIds, contextRefs: ser.contextRefs }
      : undefined
    onSend(text, finalAttachments.length ? finalAttachments : undefined, mentions)
    composerRef.current?.clear()
    setAttachments([])
  }, [isRunning, attachments, onSend, setAttachments])

  // While the picker is open, drive Arrow/Enter/Tab/Esc from the rich editor's
  // keydown. Returns true when a key was consumed (editor then preventDefaults).
  const onMentionKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!active) return false
    if (employeeMentionMode && employeeMatches.length > 0) {
      const len = employeeMatches.length
      if (e.key === 'ArrowDown') { setMentionIndex(i => (i + 1) % len); return true }
      if (e.key === 'ArrowUp') { setMentionIndex(i => (i - 1 + len) % len); return true }
      if (e.key === 'Enter' || e.key === 'Tab') { const hi = employeeMatches[Math.min(mentionIndex, len - 1)]; if (hi) insertEmployeeMention(hi.name); return true }
      if (e.key === 'Escape') { setMentionQuery(null); return true }
      return false
    }
    if (!employeeMentionMode && flatEntries.length > 0) {
      const len = flatEntries.length
      if (e.key === 'ArrowDown') { setMentionIndex(i => (i + 1) % len); return true }
      if (e.key === 'ArrowUp') { setMentionIndex(i => (i - 1 + len) % len); return true }
      if (e.key === 'Enter' || e.key === 'Tab') { const hi = flatEntries[Math.min(mentionIndex, len - 1)]; if (hi) pickEntry(hi); return true }
      if (e.key === 'Escape') { setMentionQuery(null); return true }
      return false
    }
    return false
  }, [active, employeeMentionMode, employeeMatches, flatEntries, mentionIndex, insertEmployeeMention, pickEntry])

  const removeAttachment = (i: number) => setAttachments(a => a.filter((_, j) => j !== i))

  // Pick a working directory for this conversation.
  const handlePickWorkingDir = useCallback(async () => {
    if (!onSetWorkingDir) return
    const paths = await window.api.openFileDialog({ properties: ['openDirectory'] })
    if (paths?.length) onSetWorkingDir(paths[0])
  }, [onSetWorkingDir])

  const workingDirName = workingDir ? (workingDir.split(/[\\/]/).filter(Boolean).pop() || workingDir) : ''

  // Images pasted/dropped into the editor → left-side tiles (written to a temp file).
  const addPastedFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const base64 = await blobToBase64(file)
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        const rand = Math.random().toString(36).slice(2, 8)
        const filename = `paste-${Date.now()}-${rand}.${ext}`
        const result = await window.api.writeTempFile({ name: filename, data: base64 })
        setAttachments(prev => [...prev, { name: `粘贴图片.${ext}`, path: result.path, mimeType: file.type || 'image/png' }])
      } catch (err) {
        console.error('[paste]', err)
        toast.error('粘贴图片失败：' + (err as Error).message)
      }
    }
  }, [setAttachments])

  const handleFileSelect = async () => {
    const paths = await window.api.openFileDialog({ properties: ['openFile', 'multiSelections'] })
    if (!paths?.length) return
    setAttachments(prev => [...prev, ...paths.map((p: string) => ({
      name: p.split(/[\\/]/).pop() || p, path: p, mimeType: getMimeType(p)
    }))])
  }

  const handleImageSelect = async () => {
    const paths = await window.api.openFileDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (!paths?.length) return
    setAttachments(prev => [...prev, ...paths.map((p: string) => ({
      name: p.split(/[\\/]/).pop() || p, path: p, mimeType: getMimeType(p)
    }))])
  }

  // Drag-and-drop file upload → left-side tiles.
  const [dragOver, setDragOver] = useState(false)
  const addDroppedFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const realPath = window.api.getPathForFile(file)
        if (realPath) {
          await window.api.approvePath(realPath)
          setAttachments(prev => [...prev, { name: file.name, path: realPath, mimeType: file.type || getMimeType(realPath) }])
        } else {
          const base64 = await blobToBase64(file)
          const ext = (file.name.split('.').pop() || 'bin').toLowerCase()
          const rand = Math.random().toString(36).slice(2, 8)
          const result = await window.api.writeTempFile({ name: `drop-${Date.now()}-${rand}.${ext}`, data: base64 })
          setAttachments(prev => [...prev, { name: file.name, path: result.path, mimeType: file.type || getMimeType(file.name) }])
        }
      } catch (err) {
        console.error('[drop]', err)
        toast.error(`添加「${file.name}」失败：` + (err as Error).message)
      }
    }
  }, [setAttachments])

  const handleDragOver = (e: React.DragEvent) => {
    if (isRunning || disabled) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (isRunning || disabled) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length) addDroppedFiles(files)
  }

  const showImageControls = !!imageMode || !!forceImage

  const placeholder = isRunning
    ? '⏳ Agent 正在执行中，可点击「停止」中断…'
    : showImageControls
      ? '描述你想生成的图片内容…'
      : `与 ${BRAND.displayName} 对话…  @ 引用图片/服务器/上下文`

  const canSend = (!composerEmpty || attachments.length > 0) && !disabled
  const showEmployeePicker = active && employeeMentionMode && employeeMatches.length > 0
  const showRichPicker = active && !employeeMentionMode && richSections.length > 0

  return (
    <div className="px-4 pb-4 pt-1 shrink-0">

      {/* Folded attachments panel — ABOVE the box. Resources brought in via
          paste/drop/select/Gallery live here as a collapsible list of thumbnails /
          file rows (not chips); @-referencing one inserts a pointer chip in the text. */}
      {attachments.length > 0 && (
        <div className="mb-2 rounded-xl border border-border bg-card/60 overflow-hidden">
          <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => setAttachOpen(o => !o)}
              className="flex items-center gap-1.5 hover:text-foreground transition-colors"
            >
              <Paperclip size={13} /> 附件 · {attachments.length}
              {attachOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            <button
              type="button"
              onClick={() => setAttachments([])}
              disabled={isRunning}
              title="清空全部附件"
              className="flex items-center gap-1 hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={12} /> 清空
            </button>
          </div>
          {attachOpen && (
            <div className="px-3 pb-2 flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <AttachmentItem
                  key={i}
                  att={att}
                  onPreview={() => att.mimeType.startsWith('image/') && setPreviewSrc(toLocalFileUrl(att.path))}
                  onRemove={() => removeAttachment(i)}
                  onContextMenu={e => {
                    if (!att.mimeType.startsWith('image/')) return
                    ctxMenu.open(e, {
                      filePath: att.path,
                      src: toLocalFileUrl(att.path),
                      onPreview: () => setPreviewSrc(toLocalFileUrl(att.path)),
                      onEdit: () => onEditImage(toLocalFileUrl(att.path))
                    })
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main input container */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-2xl border bg-card transition-all duration-200',
          'focus-within:ring-1 focus-within:ring-ring focus-within:border-ring/60',
          dragOver && 'ring-2 ring-primary/70 border-primary/60',
          disabled ? 'opacity-60 cursor-not-allowed' : 'shadow-sm hover:shadow-md hover:border-border/80'
        )}
      >
        {/* Drag-over overlay */}
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/[0.06] border-2 border-dashed border-primary/50 pointer-events-none">
            <span className="flex items-center gap-2 text-sm font-medium text-primary">
              <Paperclip size={15} /> 松手添加为附件
            </span>
          </div>
        )}

        {/* @-employee picker (group chat). */}
        {showEmployeePicker && (
          <div className="absolute bottom-full left-2 mb-2 z-30 w-60 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl p-1">
            <div className="px-2 py-1 text-[10px] text-muted-foreground select-none">@ 点名让某位员工发言</div>
            {employeeMatches.map((emp, i) => (
              <button
                key={emp.id}
                type="button"
                onMouseDown={e => { e.preventDefault(); insertEmployeeMention(emp.name) }}
                onMouseEnter={() => setMentionIndex(i)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                  i === mentionIndex ? 'bg-accent' : 'hover:bg-accent/60'
                )}
              >
                <AtSign size={13} className="text-primary shrink-0" />
                <span className="text-xs font-medium truncate">{emp.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Rich @-picker — pick a 图片 / 服务器 / 上下文 row to insert an inline chip. */}
        {showRichPicker && (
          <div className="absolute bottom-full left-2 mb-2 z-30 w-80 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl p-1">
            <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-foreground/80 select-none">可能 @ 的内容</div>
            {catTabs.length > 2 && (
              <div className="flex items-center gap-1 px-2 pb-1.5 flex-wrap">
                {catTabs.map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onMouseDown={e => { e.preventDefault(); setMentionCat(tab.key) }}
                    className={cn(
                      'px-2 py-0.5 rounded-full text-[10.5px] transition-colors',
                      mentionCat === tab.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
            {(() => {
              let flatIdx = -1
              return visibleSections.map(section => (
                <Fragment key={section.key}>
                  <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium text-muted-foreground/80 select-none">{section.title}</div>
                  {section.entries.map(entry => {
                    flatIdx++
                    const i = flatIdx
                    const activeRow = i === mentionIndex
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        onMouseDown={e => { e.preventDefault(); pickEntry(entry) }}
                        onMouseEnter={() => setMentionIndex(i)}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                          activeRow ? 'bg-accent' : 'hover:bg-accent/60'
                        )}
                      >
                        {entry.kind === 'image' ? (
                          <img src={toLocalFileUrl(entry.path)} loading="lazy" className="w-8 h-8 rounded object-cover border border-border shrink-0" alt={entry.label} />
                        ) : (
                          <span className={cn('w-8 h-8 rounded flex items-center justify-center shrink-0',
                            entry.kind === 'ssh' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                            {entry.kind === 'ssh' ? <Server size={14} /> : entry.kind === 'summary' ? <MessagesSquare size={14} /> : entry.kind === 'file' ? <FileText size={14} /> : <MessageSquare size={14} />}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium truncate">{entry.label}</span>
                          {entry.sub && <span className="block text-[10px] text-muted-foreground truncate">{entry.sub}</span>}
                        </span>
                      </button>
                    )
                  })}
                </Fragment>
              ))
            })()}
            {!flatEntries.length && (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground/70 select-none">没有匹配的内容，换个关键词试试</div>
            )}
            {galleryResults.length >= MENTION_GALLERY_LIMIT && (
              <div className="px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground/70 select-none">素材库结果较多，输入关键词缩小范围</div>
            )}
          </div>
        )}

        {/* Top toolbar */}
        <div className="flex items-center gap-1 px-2.5 pt-2 pb-1">
          <ToolbarIcon
            icon={<Paperclip size={16} />}
            title={showImageControls ? '添加参考图 / 文件（支持多张）' : '附加文件'}
            onClick={showImageControls ? handleImageSelect : handleFileSelect}
            disabled={isRunning}
          />
          <ToolbarIcon
            icon={<AtSign size={16} />}
            title="@ 引用：图片做参考图 / 服务器设为本轮默认 / 对话内容追问（输入 @ 也可）"
            onClick={() => composerRef.current?.triggerMention()}
            disabled={isRunning}
          />
          {!imageMode && onForceImageChange && (
            <ToolbarToggle
              icon={<ImagePlus size={16} />}
              label="生成图片"
              active={!!forceImage}
              tone="primary"
              title={forceImage ? '本轮将生成图片（点此关闭，恢复普通对话）' : '本轮强制生成图片：用默认图片模型，可加参考图与规则'}
              onClick={() => onForceImageChange(!forceImage)}
              disabled={isRunning}
            />
          )}
          {!imageMode && onComputerModeChange && computerUseEnabled && (
            <ToolbarToggle
              icon={<Monitor size={16} />}
              label="电脑操控"
              active={!!computerMode}
              tone="danger"
              title={computerMode ? '电脑操控已开启：本轮 AI 可看屏幕、操作鼠标键盘。点击关闭' : '开启电脑操控：让 AI 看屏幕、操作你的鼠标键盘'}
              onClick={() => onComputerModeChange(!computerMode)}
              disabled={isRunning}
            />
          )}
          {onSetWorkingDir && (
            workingDir ? (
              <div title={`工作目录：${workingDir}（点击更换 · × 清除）`}
                className="inline-flex items-center gap-1 h-7 pl-1.5 pr-1 rounded-md text-primary text-xs shrink-0">
                <button type="button" onClick={handlePickWorkingDir} disabled={isRunning}
                  className="inline-flex items-center gap-1 min-w-0 disabled:opacity-40 disabled:cursor-not-allowed">
                  <FolderOpen size={15} className="shrink-0" />
                  <span className="max-w-[120px] truncate font-medium">{workingDirName}</span>
                </button>
                <button type="button" onClick={() => onSetWorkingDir('')} disabled={isRunning} title="清除工作目录"
                  className="opacity-60 hover:opacity-100 disabled:opacity-30"><X size={11} /></button>
              </div>
            ) : (
              <ToolbarIcon icon={<Folder size={16} />} title="设置本对话的工作目录：之后新建 / 读写文件默认放这里；目录内的 .claude/skills 与 .mcp.json 会自动加载" onClick={handlePickWorkingDir} disabled={isRunning} />
            )
          )}
        </div>

        {/* Rich editor */}
        <RichComposer
          ref={composerRef}
          placeholder={placeholder}
          disabled={isRunning || disabled}
          onMention={setMentionQuery}
          onEnter={handleSend}
          onEmptyChange={setComposerEmpty}
          onPasteFiles={addPastedFiles}
          onMentionKeyDown={onMentionKeyDown}
        />

        {/* Image parameters row */}
        {showImageControls && (
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-1 flex-wrap text-[10.5px] text-muted-foreground border-t border-border/40">
            <span className="font-medium text-foreground/70">图片参数</span>
            <Select<ImageParams['resolution']>
              value={imageParams.resolution}
              onChange={v => onImageParamsChange({ ...imageParams, resolution: v })}
              options={[{ value: '1K', label: '1K' }, { value: '2K', label: '2K' }, { value: '4K', label: '4K' }]}
              size="sm" title="分辨率" placement="top"
            />
            <Select<ImageParams['quality']>
              value={imageParams.quality}
              onChange={v => onImageParamsChange({ ...imageParams, quality: v })}
              options={[{ value: 'standard', label: '标准' }, { value: 'hd', label: '高清' }]}
              size="sm" title="品质" placement="top"
            />
            <Select
              value={imageParams.ratio}
              onChange={v => onImageParamsChange({ ...imageParams, ratio: v })}
              options={IMAGE_RATIOS.map(r => ({ value: r, label: r }))}
              size="sm" title="比例" placement="top"
            />
            <Select
              value={String(imageParams.count)}
              onChange={v => onImageParamsChange({ ...imageParams, count: Number(v) as ImageParams['count'] })}
              options={[{ value: '1', label: '×1' }, { value: '2', label: '×2' }, { value: '3', label: '×3' }, { value: '4', label: '×4' }]}
              size="sm" title="数量" placement="top"
            />
            <span className="text-muted-foreground/60 text-[10px] ml-auto">
              {computeImageSize(imageParams.resolution, imageParams.ratio)}
              {imageParams.count > 1 ? ` · ${imageParams.count} 张` : ''}
            </span>
          </div>
        )}

        {/* Bottom bar — model picker on the left, 发送 on the right. */}
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <ModelPicker providerId={providerId} model={model} onChange={onModelChange} />
          </div>
          {isRunning ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-destructive text-destructive-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm shrink-0"
            >
              <Square size={11} fill="currentColor" />
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all shadow-sm shrink-0',
                canSend
                  ? 'bg-primary text-primary-foreground hover:opacity-90 active:scale-95'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
            >
              <Send size={11} />
              发送
            </button>
          )}
        </div>
      </div>

      {/* Keyboard hint */}
      {!isRunning && (
        <p className="text-center text-[10px] text-muted-foreground/35 mt-1.5 select-none">
          Enter 发送 · Shift+Enter 换行
        </p>
      )}

      {/* Attachment lightbox */}
      {previewSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6"
          onClick={() => setPreviewSrc(null)}
        >
          <button
            onClick={() => setPreviewSrc(null)}
            className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white"
          >
            <X size={16} />
          </button>
          <img
            src={previewSrc}
            alt="预览"
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {ctxMenu.element}
    </div>
  )
}

/** An item in the folded attachments panel: an image thumbnail tile or a file
 *  row, each with a remove × and a hover preview (enlarged image / file path). */
function AttachmentItem({ att, onPreview, onRemove, onContextMenu }: {
  att: { name: string; path: string; mimeType: string }
  onPreview: () => void
  onRemove: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const [failed, setFailed] = useState(false)
  // Hover preview is portaled to <body> with fixed positioning so the folded
  // panel's overflow-hidden (and any clipping ancestor) can't cut it off.
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null)
  const tileRef = useRef<HTMLDivElement>(null)
  const isImg = att.mimeType.startsWith('image/')
  const src = toLocalFileUrl(att.path)
  return (
    <div
      ref={tileRef}
      className="relative group shrink-0"
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHoverRect(tileRef.current?.getBoundingClientRect() ?? null)}
      onMouseLeave={() => setHoverRect(null)}
    >
      {isImg ? (
        <button
          type="button"
          onClick={onPreview}
          title={`${att.name}  (点击放大 · 悬停预览)`}
          className="block h-14 w-14 rounded-lg border border-border overflow-hidden hover:ring-2 hover:ring-ring/40 transition-all"
        >
          {failed ? (
            <span className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground"><ImageOff size={15} /></span>
          ) : (
            <img src={src} className="w-full h-full object-cover" alt={att.name} onError={() => setFailed(true)} />
          )}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 h-14 px-2.5 rounded-lg bg-muted border border-border/60 text-xs max-w-[170px]">
          <FileText size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground/80">{att.name}</span>
        </div>
      )}
      {hoverRect && createPortal(
        <div
          className="fixed z-[120] -translate-x-1/2 -translate-y-full pointer-events-none"
          style={{ left: hoverRect.left + hoverRect.width / 2, top: hoverRect.top - 8 }}
        >
          {isImg && !failed ? (
            <img src={src} alt={att.name} className="max-w-[280px] max-h-[220px] rounded-lg border border-border shadow-xl bg-card object-contain" />
          ) : (
            <div className="max-w-[300px] rounded-lg border border-border bg-popover shadow-xl p-2 text-xs">
              <span className="block font-medium truncate">{att.name}</span>
              <span className="block text-[10px] text-muted-foreground break-all">{att.path}</span>
            </div>
          )}
        </div>,
        document.body
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 bg-background border border-border text-muted-foreground hover:text-foreground rounded-full p-0.5 shadow opacity-0 group-hover:opacity-100 transition-opacity"
        title="移除"
      >
        <X size={10} />
      </button>
    </div>
  )
}

/** A borderless icon button in the top toolbar (WeChat-desktop style). */
function ToolbarIcon({ icon, title, onClick, disabled }: {
  icon: React.ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
    >
      {icon}
    </button>
  )
}

/** A per-turn toggle in the top toolbar. */
function ToolbarToggle({ icon, label, active, tone, title, onClick, disabled }: {
  icon: React.ReactNode
  label: string
  active: boolean
  tone: 'primary' | 'danger'
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  const activeCls = tone === 'danger'
    ? 'text-red-600 dark:text-red-400 bg-red-500/10'
    : 'text-primary bg-primary/10'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center gap-1 h-7 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0',
        active ? `pl-1.5 pr-2 ${activeCls}` : 'w-7 justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60'
      )}
    >
      {icon}
      {active && <span className="text-xs font-medium">{label}</span>}
    </button>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.readAsDataURL(blob)
  })
}

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', md: 'text/markdown'
  }
  return map[ext || ''] || 'application/octet-stream'
}

function toLocalFileUrl(filePath: string): string {
  const fwd = filePath.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}
