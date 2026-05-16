import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square, Paperclip, X, ImagePlus, FileText, ImageOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { KbMountSelector } from './KbMountSelector'
import { ModelPicker } from './ModelPicker'
import { Select } from '../../components/ui/Select'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { type ImageParams, IMAGE_RATIOS, computeImageSize } from './ChatHeader'

interface Attachment { name: string; path: string; mimeType: string }

interface Props {
  onSend: (text: string, attachments?: Attachment[]) => void
  onStop: () => void
  isRunning: boolean
  disabled: boolean
  mountedSpaceIds: string[]
  onMountedSpacesChange: (ids: string[]) => void
  imageMode?: boolean
  /** Controlled attachments state (lifted to parent so external sources can inject). */
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
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
  onSend, onStop, isRunning, disabled, mountedSpaceIds, onMountedSpacesChange, imageMode,
  attachments, setAttachments,
  providerId, model, onModelChange,
  imageParams, onImageParamsChange,
  onEditImage
}: Props) {
  const [text, setText] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const ctxMenu = useImageContextMenu()

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const removeAttachment = (i: number) => setAttachments(a => a.filter((_, j) => j !== i))

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
        alert('粘贴图片失败：' + (err as Error).message)
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

  const placeholder = isRunning
    ? '⏳ Agent 正在执行中，可点击「停止」中断…'
    : imageMode
      ? '描述你想生成的图片内容…'
      : '与 SuperStudio 对话… (Enter 发送，Shift+Enter 换行)'

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
      <div className={cn(
        'rounded-2xl border bg-card transition-all duration-200',
        'focus-within:ring-1 focus-within:ring-ring focus-within:border-ring/60',
        disabled ? 'opacity-60 cursor-not-allowed' : 'shadow-sm hover:shadow-md hover:border-border/80'
      )}>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
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

        {/* Image-mode parameters row (only when image model selected) */}
        {imageMode && (
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

            <span className="text-muted-foreground/60 text-[10px] ml-auto">
              {computeImageSize(imageParams.resolution, imageParams.ratio)}
            </span>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center gap-2 px-3 pb-3 pt-0.5">

          {/* Left actions */}
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {imageMode ? (
              <button
                onClick={handleImageSelect}
                disabled={isRunning}
                title="添加参考图（支持多张）"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted/60 hover:border-border/80 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <ImagePlus size={13} />
                参考图
              </button>
            ) : (
              <button
                onClick={handleFileSelect}
                disabled={isRunning}
                title="附加文件"
                className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                <Paperclip size={15} />
              </button>
            )}

            <KbMountSelector mountedIds={mountedSpaceIds} onChange={onMountedSpacesChange} />

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
