import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Square, Paperclip, ImagePlus, X, FileText, ImageOff, MessageSquare, Search, Bug, Wrench, Wand2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Select } from '../../components/ui/Select'
import { ThinkingModePicker, type ThinkingMode } from '../../components/ThinkingModePicker'
import { SkillQuickBar, SkillIcon } from '../../components/SkillQuickBar'
import { toast } from '../../components/ui/Toast'
import { type ComposerAttachment, getMimeType, toLocalFileUrl, blobToBase64, isImageMime } from '../../lib/attachments'
import type { VibeIntent, InstalledSkillInfo } from '../../../../shared/ipc-types'

export type VibeMode = 'auto' | VibeIntent
export type VibeRunning = 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null

/** 意图元数据 — 工作台各处（输入框/头部徽标/运行横幅）共用的唯一来源。 */
export const INTENT_META: Record<VibeIntent, {
  label: string
  Icon: typeof MessageSquare
  hint: string
  color: string  // tailwind text color for active state
  bg: string     // tailwind bg color for active state
}> = {
  chat:    { label: '对话',     Icon: MessageSquare, hint: '随便聊聊，不读项目文件', color: 'text-slate-700 dark:text-slate-200', bg: 'bg-slate-500/15 border-slate-500/40' },
  explore: { label: '探索',     Icon: Search,        hint: '让 AI 读代码、回答问题（只读）', color: 'text-sky-700 dark:text-sky-300', bg: 'bg-sky-500/15 border-sky-500/40' },
  bugfix:  { label: '修复 BUG', Icon: Bug,           hint: '描述 bug，AI 自动定位并修复', color: 'text-rose-700 dark:text-rose-300', bg: 'bg-rose-500/15 border-rose-500/40' },
  change:  { label: '新需求',   Icon: Wrench,        hint: '把需求拆成任务列表，逐个实施', color: 'text-primary', bg: 'bg-primary/15 border-primary/40' }
}

interface Props {
  value: string
  onChange: (v: string) => void
  mode: VibeMode
  onModeChange: (m: VibeMode) => void
  /** Per-turn 思考模式 (auto/fast/deep). Self-hides for non-thinking models. */
  thinkingMode?: ThinkingMode
  onThinkingModeChange?: (m: ThinkingMode) => void
  /** This project's model (gates the 思考模式 picker); '' → global default. */
  providerId?: string
  model?: string
  running: VibeRunning
  /** Submit the turn; `forceSkillIds` = skills armed via the quick-bar (forced this run). */
  onSubmit: (forceSkillIds?: string[]) => void
  /** Shown as a 停止 button while running; omit to show a disabled send instead. */
  onStop?: () => void
  autoFocus?: boolean
  /** Textarea min/max height in px (the card adds toolbar height on top). */
  minHeight?: number
  maxHeight?: number
  /** Override the auto-mode placeholder (e.g. the hero's example-rich copy). */
  autoPlaceholder?: string
  /** Controlled attachments (lifted to parent so submit can read + clear them). */
  attachments: ComposerAttachment[]
  setAttachments: React.Dispatch<React.SetStateAction<ComposerAttachment[]>>
}

/**
 * 工作台对话输入框 — 与「对话」页 ChatInput 同一套视觉语言：
 * rounded-2xl 卡片容器 + 透明 textarea + 顶部附件工具条 + 底部工具条
 * （左：模式选择，右：发送/停止）+ 卡片下方快捷键提示。支持选文件 / 选图片 /
 * 粘贴图片 / 拖拽，与「对话」页一致（精简了 @素材库引用，那是图片生成专属）。
 */
export function VibeComposer({
  value, onChange, mode, onModeChange, thinkingMode = 'auto', onThinkingModeChange,
  providerId = '', model = '', running, onSubmit, onStop,
  autoFocus, minHeight = 56, maxHeight = 240, autoPlaceholder,
  attachments, setAttachments
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const isRunning = running !== null
  const [dragOver, setDragOver] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  // Auto-grow tracks `value` (not just keystrokes) so programmatic fills —
  // e.g. clicking an example on the hero — resize correctly too.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px'
  }, [value, maxHeight])

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!previewSrc) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewSrc(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewSrc])

  const removeAttachment = (i: number) => setAttachments(a => a.filter((_, j) => j !== i))

  const pickFiles = useCallback(async (imagesOnly: boolean) => {
    const paths = await window.api.openFileDialog({
      properties: ['openFile', 'multiSelections'],
      ...(imagesOnly ? { filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] } : {})
    })
    if (!paths?.length) return
    setAttachments(prev => [...prev, ...paths.map((p: string) => ({
      name: p.split(/[\\/]/).pop() || p, path: p, mimeType: getMimeType(p)
    }))])
  }, [setAttachments])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageItems = Array.from(e.clipboardData.items).filter(it => it.type.startsWith('image/'))
    if (!imageItems.length) return
    e.preventDefault()
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      try {
        const base64 = await blobToBase64(file)
        const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        // ASCII-only filesystem name → safe for multipart Content-Disposition headers.
        const rand = Math.random().toString(36).slice(2, 8)
        const result = await window.api.writeTempFile({ name: `paste-${Date.now()}-${rand}.${ext}`, data: base64 })
        setAttachments(prev => [...prev, { name: `粘贴图片.${ext}`, path: result.path, mimeType: item.type }])
      } catch (err) {
        toast.error('粘贴图片失败：' + (err as Error).message)
      }
    }
  }, [setAttachments])

  const addDroppedFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const realPath = window.api.getPathForFile(file)
        if (realPath) {
          // Drag-drop bypasses the picker allowlisting — approve so the thumbnail
          // preview (local-file://) doesn't 403.
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
        toast.error(`添加「${file.name}」失败：` + (err as Error).message)
      }
    }
  }, [setAttachments])

  const handleDragOver = (e: React.DragEvent) => {
    if (isRunning) return
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
    if (isRunning) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length) addDroppedFiles(files)
  }

  const placeholder = isRunning
    ? '⏳ 运行中… 完成后可继续输入'
    : mode === 'auto'    ? (autoPlaceholder ?? '说出你的需求，AI 自动判断（聊天/探索/修复/拆需求）…')
    : mode === 'chat'    ? '随便聊点什么…'
    : mode === 'explore' ? '问 AI 关于这个项目的问题…'
    : mode === 'bugfix'  ? '描述 BUG：症状、复现步骤、报错…'
                         : '描述要做的改动，AI 会拆解成可执行任务…'

  const canSend = (!!value.trim() || attachments.length > 0) && !isRunning

  // Skills "armed" for the NEXT send via the quick-bar (forced to load this run).
  const [armedSkills, setArmedSkills] = useState<InstalledSkillInfo[]>([])

  // Quick-bar click: append the primer to the textarea AND arm the skill so the
  // next send forces it to load + run (an armed chip shows above the input).
  const handlePickSkill = useCallback((skill: InstalledSkillInfo, primer: string) => {
    if (isRunning) return
    const next = value ? (value.endsWith('\n') ? value + primer : value + '\n' + primer) : primer
    onChange(next)
    setArmedSkills(prev => prev.some(s => s.id === skill.id) ? prev : [...prev, skill])
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.setSelectionRange(next.length, next.length) }
    })
  }, [isRunning, value, onChange])

  // Single submit path (Enter + 发送 button): forwards armed skill ids, then clears
  // them. Mirrors the parent's empty-guard so an empty Enter doesn't drop arming.
  const submit = useCallback(() => {
    if (isRunning || (!value.trim() && attachments.length === 0)) return
    const ids = armedSkills.map(s => s.id)
    onSubmit(ids.length ? ids : undefined)
    setArmedSkills([])
  }, [isRunning, value, attachments, onSubmit, armedSkills])

  return (
    <div>
      {/* 技能快捷条 — 一键填入引子并「装备」技能（含自主学习到的技能 ✨，强感知自学习能力）。 */}
      <SkillQuickBar scenario="vibe" onPick={handlePickSkill} disabled={isRunning} className="mb-2 px-1" />

      {/* 本轮已「装备」的技能（可移除）——发送时强制加载并使用它们。 */}
      {armedSkills.length > 0 && (
        <div className="mb-2 flex items-center gap-1.5 flex-wrap px-1">
          <span className="text-[11px] text-muted-foreground select-none">本轮使用：</span>
          {armedSkills.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md text-xs border border-primary/30 bg-primary/10 text-primary">
              <SkillIcon skill={s} size={11} />
              <span className="max-w-[140px] truncate font-medium">{s.name}</span>
              <button type="button" onClick={() => setArmedSkills(prev => prev.filter(x => x.id !== s.id))}
                title="移除（本轮不再强制使用）" className="opacity-60 hover:opacity-100"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {attachments.map((att, i) => (
            isImageMime(att.mimeType) ? (
              <ImageThumb
                key={i}
                src={toLocalFileUrl(att.path)}
                name={att.name}
                onPreview={() => setPreviewSrc(toLocalFileUrl(att.path))}
                onRemove={() => removeAttachment(i)}
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

      {/* Main input container — mirrors Chat/ChatInput's card. Card stays fully
          opaque while running — the 停止 button inside it is the only actionable
          control then; only the textarea itself dims (disabled). */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-2xl border bg-card shadow-sm transition-all duration-200',
          'focus-within:ring-1 focus-within:ring-ring focus-within:border-ring/60',
          dragOver && 'ring-2 ring-primary/70 border-primary/60',
          !isRunning && 'hover:shadow-md hover:border-border/80'
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

        {/* Top toolbar — attach file / attach image (borderless icons). */}
        <div className="flex items-center gap-1 px-2.5 pt-2 pb-1">
          <ToolbarIcon icon={<Paperclip size={16} />} title="附加文件" onClick={() => pickFiles(false)} disabled={isRunning} />
          <ToolbarIcon icon={<ImagePlus size={16} />} title="附加图片（也可直接粘贴 / 拖拽）" onClick={() => pickFiles(true)} disabled={isRunning} />
        </div>

        <textarea
          ref={taRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={e => {
            // IME guard: Enter that confirms a composition candidate must not send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          disabled={isRunning}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={cn(
            'w-full px-4 pt-1 pb-2 resize-none bg-transparent text-base outline-none',
            'placeholder:text-muted-foreground/60 leading-relaxed',
            isRunning && 'cursor-not-allowed opacity-60'
          )}
          style={{ maxHeight, minHeight }}
        />

        {/* Bottom bar — mode picker on the left (where Chat puts its ModelPicker),
            发送/停止 on the right. */}
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <Select<VibeMode>
              value={mode}
              onChange={onModeChange}
              disabled={isRunning}
              title="自动让 AI 判断该聊天/探索/修复/拆需求；也可手动锁定某模式"
              popoverWidth={180}
              placement="top"
              options={[
                { value: 'auto', label: '自动识别', icon: <Wand2 size={13} /> },
                { value: 'chat', label: `${INTENT_META.chat.label}（不读项目）` },
                { value: 'explore', label: `${INTENT_META.explore.label}（只读代码）` },
                { value: 'bugfix', label: `${INTENT_META.bugfix.label}（自动定位修复）` },
                { value: 'change', label: `${INTENT_META.change.label}（拆成任务）` }
              ]}
            />
            {onThinkingModeChange && (
              <ThinkingModePicker providerId={providerId} model={model} value={thinkingMode} onChange={onThinkingModeChange} />
            )}
            <span className="text-[11px] text-muted-foreground truncate">
              {mode === 'auto' ? 'AI 自动判断你的意图' : `已锁定：${INTENT_META[mode].label}`}
            </span>
          </div>

          {isRunning && onStop ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-destructive text-destructive-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm shrink-0"
            >
              <Square size={11} fill="currentColor" />
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title={mode === 'auto' ? 'Enter — 自动识别' : `Enter — ${INTENT_META[mode].label}`}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all shadow-sm shrink-0',
                canSend
                  ? 'bg-primary text-primary-foreground hover:opacity-90 active:scale-95'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
            >
              <Send size={11} />
              {mode === 'auto' ? '发送' : INTENT_META[mode].label}
            </button>
          )}
        </div>
      </div>

      {/* Keyboard hint — same as Chat */}
      {!isRunning && (
        <p className="text-center text-[10px] text-muted-foreground/35 mt-1.5 select-none">
          Enter 发送 · Shift+Enter 换行 · 可粘贴 / 拖拽图片
        </p>
      )}

      {/* Attachment lightbox */}
      {previewSrc && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6" onClick={() => setPreviewSrc(null)}>
          <button onClick={() => setPreviewSrc(null)} className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white">
            <X size={16} />
          </button>
          <img src={previewSrc} alt="预览" className="max-w-full max-h-full object-contain rounded-xl shadow-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

function ImageThumb({ src, name, onPreview, onRemove }: {
  src: string; name: string; onPreview: () => void; onRemove: () => void
}) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="relative group shrink-0">
      <button
        type="button"
        onClick={onPreview}
        title={`${name}（点击放大预览）`}
        className="block h-20 w-20 rounded-xl border border-border shadow-sm overflow-hidden hover:ring-2 hover:ring-ring/40 transition-all"
      >
        {failed ? (
          <span className="w-full h-full flex flex-col items-center justify-center gap-0.5 bg-muted text-muted-foreground">
            <ImageOff size={16} />
            <span className="text-[8px]">加载失败</span>
          </span>
        ) : (
          <img src={src} className="w-full h-full object-cover" alt={name} onError={() => setFailed(true)} />
        )}
      </button>
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 bg-background border border-border text-muted-foreground hover:text-foreground rounded-full p-0.5 shadow opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X size={10} />
      </button>
    </div>
  )
}

/** A borderless icon button in the top toolbar (WeChat-desktop style). */
function ToolbarIcon({ icon, title, onClick, disabled }: {
  icon: React.ReactNode; title: string; onClick: () => void; disabled?: boolean
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
