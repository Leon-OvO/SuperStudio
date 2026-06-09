import { useState, useRef, useCallback, useEffect, useMemo, Fragment } from 'react'
import { BRAND } from '@shared/brand'
import type { GeneratedImageRef } from './extractGeneratedImages'
import type { GalleryItem } from '../../../../shared/ipc-types'

/** Max 素材库 results the @-picker requests per query (LIMIT pushed into SQL). */
const MENTION_GALLERY_LIMIT = 40
import { Send, Square, Paperclip, X, ImagePlus, FileText, ImageOff, Monitor, Folder, FolderOpen, Check, AtSign } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ModelPicker } from './ModelPicker'
import { Select } from '../../components/ui/Select'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { toast } from '../../components/ui/Toast'
import { type ImageParams, IMAGE_RATIOS, computeImageSize } from './ChatHeader'

interface Attachment { name: string; path: string; mimeType: string }

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void
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
  /** Controlled attachments state (lifted to parent so external sources can inject). */
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  /** Images this conversation generated — for the `@` mention picker. */
  generatedImages?: GeneratedImageRef[]
  /** Currently-selected model (provider + model name); empty strings = use defaults. */
  providerId: string
  model: string
  onModelChange: (providerId: string, model: string) => void
  /** Image params shown when imageMode is true. */
  imageParams: ImageParams
  onImageParamsChange: (params: ImageParams) => void
  /** Open the global ImageEditor with the given src. */
  onEditImage: (src: string) => void
}

export function ChatInput({
  onSend, onStop, isRunning, disabled, imageMode,
  forceImage, onForceImageChange,
  computerMode, onComputerModeChange, computerUseEnabled,
  workingDir, onSetWorkingDir,
  attachments, setAttachments, generatedImages,
  providerId, model, onModelChange,
  imageParams, onImageParamsChange,
  onEditImage
}: Props) {
  const [text, setText] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // `@` mention picker: {start} = index of the '@'. Multi-select — clicking a row
  // toggles a reference live and the popup STAYS open; the @query token is removed
  // only when the picker closes (Enter/Tab/Esc/blur).
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  // 素材库 results, searched on-demand (debounced, LIMIT'd) so a huge library never
  // loads wholesale. Cap reached => MENTION_GALLERY_LIMIT exactly.
  const [galleryResults, setGalleryResults] = useState<GeneratedImageRef[]>([])
  const mentionAddedRef = useRef<Set<string>>(new Set())  // paths toggled-on this @ session
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const ctxMenu = useImageContextMenu()

  // 本对话生成 (in-memory, filtered by query) + 素材库 (server-searched), de-duped by path.
  const mentionItems = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const chat = (generatedImages ?? []).filter(g =>
      !q || g.label.toLowerCase().includes(q) || (g.path.split(/[\\/]/).pop() || '').toLowerCase().includes(q))
    const seen = new Set(chat.map(g => g.path))
    return [...chat, ...galleryResults.filter(g => !seen.has(g.path))]
  }, [mention, generatedImages, galleryResults])
  useEffect(() => { setMentionIndex(0) }, [mention?.query])
  // How many currently-shown picker items are already referenced (footer count).
  const pickedCount = mention ? mentionItems.filter(g => attachments.some(a => a.path === g.path)).length : 0

  // Debounced 素材库 search whenever the @query changes.
  useEffect(() => {
    if (!mention) { setGalleryResults([]); mentionAddedRef.current = new Set(); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const items = (await window.api.searchGallery(mention.query, MENTION_GALLERY_LIMIT)) as GalleryItem[]
        if (cancelled) return
        setGalleryResults(items.map(it => ({
          path: it.filePath,
          label: it.filePath.split(/[\\/]/).pop() || '素材',
          group: '素材库'
        })))
      } catch { if (!cancelled) setGalleryResults([]) }
    }, 180)
    return () => { cancelled = true; clearTimeout(t) }
  }, [mention])

  // Detect an `@token` immediately left of the caret (no whitespace inside, `@` at a
  // word boundary). Always allows `@` so 素材库 can be searched even with no chat images.
  const detectMention = useCallback((value: string, caret: number): { query: string; start: number } | null => {
    const upto = value.slice(0, caret)
    const at = upto.lastIndexOf('@')
    if (at === -1) return null
    const between = upto.slice(at + 1)
    if (/\s/.test(between)) return null
    const before = at === 0 ? '' : value[at - 1]
    if (before && !/\s/.test(before)) return null
    return { query: between, start: at }
  }, [])

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    setMention(detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length))
  }

  // Close the picker: strip the "@query" token from the text. Selections are already
  // applied live, so closing never loses them.
  const closeMention = useCallback(() => {
    setMention(m => {
      if (m) setText(prev => {
        // Drop "@query" plus one trailing space so "a @x b" → "a b", not "a  b".
        const after = prev.slice(m.start + 1 + m.query.length).replace(/^[ \t]/, '')
        return prev.slice(0, m.start) + after
      })
      return null
    })
    setGalleryResults([])
    mentionAddedRef.current = new Set()
  }, [])

  // Toolbar "引用图片" entry: insert an `@` at the caret and open the picker — makes
  // the @-reference feature discoverable instead of a hidden keystroke.
  const insertMentionTrigger = useCallback(() => {
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const insert = (before.length > 0 && !/\s$/.test(before) ? ' ' : '') + '@'
    const next = before + insert + text.slice(caret)
    const newCaret = before.length + insert.length
    setText(next)
    setMention(detectMention(next, newCaret))
    setTimeout(() => {
      const e2 = textareaRef.current
      if (e2) { e2.focus(); e2.setSelectionRange(newCaret, newCaret) }
    }, 0)
  }, [text, detectMention])

  // Toggle an image as a reference attachment (multi-select). Popup stays open.
  const toggleMentionImage = useCallback((item: GeneratedImageRef) => {
    const p = item.path
    if (attachments.some(a => a.path === p)) {
      mentionAddedRef.current.delete(p)
      setAttachments(prev => prev.filter(a => a.path !== p))
      return
    }
    const name = p.split(/[\\/]/).pop() || 'reference.png'
    const ext = (name.split('.').pop() || 'png').toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif'
      : ext === 'bmp' ? 'image/bmp' : 'image/png'
    // Already allowlisted for gallery/generated, but approve defensively (imports).
    void window.api.approvePath(p)
    mentionAddedRef.current.add(p)
    setAttachments(prev => prev.some(a => a.path === p) ? prev : [...prev, { name: item.label, path: p, mimeType: mime }])
  }, [attachments, setAttachments])

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
    const trimmed = text.trim()
    if (!trimmed || isRunning) return
    onSend(trimmed, attachments.length ? attachments : undefined)
    setText('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, attachments, isRunning, onSend, setAttachments])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the @-mention popup is open, the arrow/enter keys drive it.
    if (mention && mentionItems.length > 0) {
      const len = mentionItems.length
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % len); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => (i - 1 + len) % len); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        // If nothing was multi-selected this session, treat Enter as quick-pick of the
        // highlighted row (backward-compatible single select); otherwise just finish.
        if (mentionAddedRef.current.size === 0) {
          const hi = mentionItems[Math.min(mentionIndex, len - 1)]
          if (hi) toggleMentionImage(hi)
        }
        closeMention()
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMention(); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const removeAttachment = (i: number) => setAttachments(a => a.filter((_, j) => j !== i))

  // Pick a working directory for this conversation. The chosen folder becomes the
  // agent's default save location + an approved read/write root for the session.
  const handlePickWorkingDir = useCallback(async () => {
    if (!onSetWorkingDir) return
    const paths = await window.api.openFileDialog({ properties: ['openDirectory'] })
    if (paths?.length) onSetWorkingDir(paths[0])
  }, [onSetWorkingDir])

  const workingDirName = workingDir ? (workingDir.split(/[\\/]/).filter(Boolean).pop() || workingDir) : ''

  const handlePaste = async (e: React.ClipboardEvent) => {
    const imageItems = Array.from(e.clipboardData.items).filter(item => item.type.startsWith('image/'))
    if (!imageItems.length) return
    e.preventDefault()
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      try {
        const base64 = await blobToBase64(file)
        const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        // ASCII-only filesystem name → safe for multipart Content-Disposition headers
        // and for local-file:// protocol URLs. Display name stays human-friendly.
        const rand = Math.random().toString(36).slice(2, 8)
        const filename = `paste-${Date.now()}-${rand}.${ext}`
        const displayName = `粘贴图片.${ext}`
        const result = await window.api.writeTempFile({ name: filename, data: base64 })
        setAttachments(prev => [...prev, { name: displayName, path: result.path, mimeType: item.type }])
      } catch (err) {
        console.error('[paste]', err)
        toast.error('粘贴图片失败：' + (err as Error).message)
      }
    }
  }

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

  // Drag-and-drop file upload. Dropped File objects no longer carry .path on
  // Electron 32+, so resolve via webUtils (window.api.getPathForFile); if a file
  // has no disk backing, fall back to writing a temp file (same as paste).
  const [dragOver, setDragOver] = useState(false)

  const addDroppedFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const realPath = window.api.getPathForFile(file)
        if (realPath) {
          // Drag-drop bypasses the picker/paste allowlisting — approve the path
          // first, else the local-file:// thumbnail preview 403s (broken image).
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
    // Ignore leave events caused by moving over a child element.
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

  // Image controls (params row + 参考图 button) show in classic image mode OR when
  // the per-turn 生成图片 toggle is on — so a chat model can generate this turn.
  const showImageControls = !!imageMode || !!forceImage

  const placeholder = isRunning
    ? '⏳ Agent 正在执行中，可点击「停止」中断…'
    : showImageControls
      ? '描述你想生成的图片内容…'
      : `与 ${BRAND.displayName} 对话… (Enter 发送，Shift+Enter 换行)`

  const canSend = !!text.trim() && !disabled

  return (
    <div className="px-4 pb-4 pt-1 shrink-0">

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {attachments.map((att, i) => (
            att.mimeType.startsWith('image/') ? (
              <ImageAttachmentThumb
                key={i}
                src={toLocalFileUrl(att.path)}
                name={att.name}
                onPreview={() => setPreviewSrc(toLocalFileUrl(att.path))}
                onRemove={() => removeAttachment(i)}
                onContextMenu={e => ctxMenu.open(e, {
                  filePath: att.path,
                  src: toLocalFileUrl(att.path),
                  onPreview: () => setPreviewSrc(toLocalFileUrl(att.path)),
                  onEdit: () => onEditImage(toLocalFileUrl(att.path))
                })}
              />
            ) : (
              <div key={i} className="flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 rounded-xl bg-muted border border-border/60 text-xs max-w-[180px] group">
                <FileText size={12} className="shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground/80">{att.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="shrink-0 text-muted-foreground hover:text-foreground ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={10} />
                </button>
              </div>
            )
          ))}
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

        {/* @-mention picker — multi-select images (本对话生成 / 素材库) as references.
            Click toggles live; popup stays open. Finish via 「完成」 / click-away / Enter. */}
        {mention && mentionItems.length > 0 && (
          <div className="absolute bottom-full left-2 mb-2 z-30 w-72 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl p-1">
            <div className="px-2 py-1 text-[10px] text-muted-foreground select-none">
              @ 引用图片作为参考图（可多选，点缩略图即添加）
            </div>
            {mentionItems.map((g, i) => {
              const curGroup = g.group || '本对话生成'
              const showHeader = curGroup !== (i > 0 ? (mentionItems[i - 1].group || '本对话生成') : null)
              const fname = g.path.split(/[\\/]/).pop() || ''
              const checked = attachments.some(a => a.path === g.path)
              return (
                <Fragment key={g.path}>
                  {showHeader && (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium text-muted-foreground/80 select-none">{curGroup}</div>
                  )}
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); toggleMentionImage(g) }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                      i === mentionIndex ? 'bg-accent' : 'hover:bg-accent/60'
                    )}
                  >
                    <span className={cn(
                      'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                      checked ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                    )}>
                      {checked && <Check size={11} />}
                    </span>
                    <img src={toLocalFileUrl(g.path)} loading="lazy" className="w-9 h-9 rounded object-cover border border-border shrink-0" alt={g.label} />
                    <span className="text-xs font-medium shrink-0">{g.label}</span>
                    {fname !== g.label && <span className="text-[10px] text-muted-foreground truncate">{fname}</span>}
                  </button>
                </Fragment>
              )
            })}
            {galleryResults.length >= MENTION_GALLERY_LIMIT && (
              <div className="px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground/70 select-none">素材库结果较多，输入关键词缩小范围</div>
            )}
            {/* Confirm bar — so finishing isn't Enter-only. */}
            <div className="sticky bottom-0 -mx-1 -mb-1 mt-1 px-2.5 py-1.5 bg-popover border-t border-border/60 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">已选 {pickedCount} 张 · 点空白处也可结束</span>
              <button
                type="button"
                onMouseDown={e => { e.preventDefault(); closeMention(); setTimeout(() => textareaRef.current?.focus(), 0) }}
                className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90 active:scale-95 transition-transform"
              >
                完成
              </button>
            </div>
          </div>
        )}

        {/* Top toolbar — WeChat-desktop style: a row of borderless icons. Toggles
            collapse to an icon when off and expand to a tinted icon+label when on. */}
        <div className="flex items-center gap-1 px-2.5 pt-2 pb-1">
          <ToolbarIcon
            icon={<Paperclip size={16} />}
            title={showImageControls ? '添加参考图 / 文件（支持多张）' : '附加文件'}
            onClick={showImageControls ? handleImageSelect : handleFileSelect}
            disabled={isRunning}
          />
          <ToolbarIcon
            icon={<AtSign size={16} />}
            title="引用图片作为参考图：选本对话生成图或素材库（输入 @ 也可）"
            onClick={insertMentionTrigger}
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
              <ToolbarIcon icon={<Folder size={16} />} title="设置本对话的工作目录：之后新建 / 读写文件默认放这里" onClick={handlePickWorkingDir} disabled={isRunning} />
            )
          )}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onSelect={e => setMention(detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length))}
          onBlur={() => setTimeout(() => { if (mention && document.activeElement !== textareaRef.current) closeMention() }, 150)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={isRunning || disabled}
          placeholder={placeholder}
          rows={2}
          className={cn(
            'w-full px-4 pt-3.5 pb-2 resize-none bg-transparent text-base outline-none',
            'placeholder:text-muted-foreground/60 leading-relaxed',
            (isRunning || disabled) && 'cursor-not-allowed'
          )}
          style={{ maxHeight: 240, minHeight: 56 }}
          onInput={e => {
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 240) + 'px'
          }}
        />

        {/* Image parameters row — shown in image mode or when 生成图片 toggle is on */}
        {showImageControls && (
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-1 flex-wrap text-[10.5px] text-muted-foreground border-t border-border/40">
            <span className="font-medium text-foreground/70">图片参数</span>

            <Select<ImageParams['resolution']>
              value={imageParams.resolution}
              onChange={v => onImageParamsChange({ ...imageParams, resolution: v })}
              options={[
                { value: '1K', label: '1K' },
                { value: '2K', label: '2K' },
                { value: '4K', label: '4K' }
              ]}
              size="sm"
              title="分辨率"
              placement="top"
            />

            <Select<ImageParams['quality']>
              value={imageParams.quality}
              onChange={v => onImageParamsChange({ ...imageParams, quality: v })}
              options={[
                { value: 'standard', label: '标准' },
                { value: 'hd', label: '高清' }
              ]}
              size="sm"
              title="品质"
              placement="top"
            />

            <Select
              value={imageParams.ratio}
              onChange={v => onImageParamsChange({ ...imageParams, ratio: v })}
              options={IMAGE_RATIOS.map(r => ({ value: r, label: r }))}
              size="sm"
              title="比例"
              placement="top"
            />

            <Select
              value={String(imageParams.count)}
              onChange={v => onImageParamsChange({ ...imageParams, count: Number(v) as ImageParams['count'] })}
              options={[
                { value: '1', label: '×1' },
                { value: '2', label: '×2' },
                { value: '3', label: '×3' },
                { value: '4', label: '×4' }
              ]}
              size="sm"
              title="数量"
              placement="top"
            />

            <span className="text-muted-foreground/60 text-[10px] ml-auto">
              {computeImageSize(imageParams.resolution, imageParams.ratio)}
              {imageParams.count > 1 ? ` · ${imageParams.count} 张` : ''}
            </span>
          </div>
        )}

        {/* Bottom bar — WeChat style: model picker on the left, 发送 on the right. */}
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">

          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <ModelPicker providerId={providerId} model={model} onChange={onModelChange} />
          </div>

          {/* Right: Send / Stop */}
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

      {/* Attachment lightbox — click to enlarge, click outside or Esc to close */}
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

function ImageAttachmentThumb({
  src, name, onPreview, onRemove, onContextMenu
}: {
  src: string
  name: string
  onPreview: () => void
  onRemove: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="relative group shrink-0" onContextMenu={onContextMenu}>
      <button
        type="button"
        onClick={onPreview}
        title={`${name}  (点击放大预览 · 右键菜单可编辑)`}
        className="block h-24 w-24 rounded-xl border border-border shadow-sm overflow-hidden hover:ring-2 hover:ring-ring/40 transition-all"
      >
        {failed ? (
          <span className="w-full h-full flex flex-col items-center justify-center gap-0.5 bg-muted text-muted-foreground">
            <ImageOff size={16} />
            <span className="text-[8px]">加载失败</span>
          </span>
        ) : (
          <img
            src={src}
            className="w-full h-full object-cover"
            alt={name}
            onError={() => setFailed(true)}
          />
        )}
      </button>
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 bg-background border border-border text-muted-foreground hover:text-foreground rounded-full p-0.5 shadow opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X size={10} />
      </button>
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] rounded-b-xl px-1.5 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        {name}
      </div>
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

/** A per-turn toggle in the top toolbar: an icon when off, an icon + tinted label
 *  when on — so the active state reads at a glance without a separate chip. */
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
