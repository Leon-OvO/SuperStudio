import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Film, Play, X, Upload, Wand2, Download,
  Trash2, ChevronDown, ChevronRight, Dice5, Lock, Unlock, Settings2,
  Plus, Pause, ArrowRight, MoveUpRight, MoveUpLeft, MoveLeft, MoveRight,
  MoveDownLeft, MoveDownRight, ArrowUp, ArrowDown, Clock,
  PanelLeftClose, PanelLeftOpen, FolderOpen
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useT } from '../../lib/i18n'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Select, type SelectOption } from '../../components/ui/Select'
import { useVideoJobsStore, subscribeVideoProgress, type VideoJob, type JobStatus } from '../../stores/videoJobs'
import { extractVideoFrame, blobToBase64 } from '../../lib/video-frame'
import type { GalleryItem, ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { estimateVideoEta } from '../../../../shared/video-eta'

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const ASPECTS = [
  { value: '9:16', label: '9:16', hint: '竖屏 · 短视频' },
  { value: '1:1', label: '1:1', hint: '方形 · 社媒' },
  { value: '16:9', label: '16:9', hint: '横屏 · 电影感' }
] as const

const DURATIONS = [5, 10] as const

const CAMERA_MOVES = [
  { key: 'upleft', icon: MoveUpLeft, label: '左上' },
  { key: 'up', icon: ArrowUp, label: '上摇' },
  { key: 'upright', icon: MoveUpRight, label: '右上' },
  { key: 'left', icon: MoveLeft, label: '左移' },
  { key: 'still', icon: null, label: '静止' },
  { key: 'right', icon: MoveRight, label: '右移' },
  { key: 'downleft', icon: MoveDownLeft, label: '左下' },
  { key: 'down', icon: ArrowDown, label: '下摇' },
  { key: 'downright', icon: MoveDownRight, label: '右下' }
] as const

// Camera-move keywords appended to the prompt. Most video models honor plain
// English/Chinese directional cues — fancier params (camera path JSON, etc.)
// vary per provider and aren't worth abstracting until we add a second one.
const CAMERA_PROMPT_HINT: Record<string, string> = {
  still: '',
  up: '镜头上摇',
  down: '镜头下摇',
  left: '镜头左移',
  right: '镜头右移',
  upleft: '镜头左上移',
  upright: '镜头右上移',
  downleft: '镜头左下移',
  downright: '镜头右下移'
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function aspectStyle(aspect: VideoJob['aspect']): React.CSSProperties {
  return { aspectRatio: aspect.replace(':', ' / ') }
}

function toLocalUrl(p: string): string {
  const fwd = p.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

/** Best-effort parse of "prompt  ·  16:9 · 5s" suffix written by the IPC
 *  handler. Falls back to undefined when the suffix is missing (e.g. items
 *  produced by an older build or by chat/workflow). */
function parseGalleryNote(note: string): { prompt: string; aspect?: VideoJob['aspect']; durationSec?: number } {
  const match = note.match(/^(.*?)\s+·\s+(9:16|1:1|16:9)\s+·\s+(\d+)s\s*$/)
  if (!match) return { prompt: note }
  return {
    prompt: match[1].trim(),
    aspect: match[2] as VideoJob['aspect'],
    durationSec: Number(match[3])
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────

export function VideoPage() {
  const t = useT()
  const jobs = useVideoJobsStore(s => s.jobs)
  const galleryEpoch = useVideoJobsStore(s => s.galleryEpoch)
  const submitJob = useVideoJobsStore(s => s.submit)
  const cancelJob = useVideoJobsStore(s => s.cancel)
  const removeJob = useVideoJobsStore(s => s.remove)

  const dlg = useConfirmDialog()

  const [paramsOpen, setParamsOpen] = useState(true)

  // ── settings + providers (loaded once on mount) ────────────────────────
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [defaultProviderId, setDefaultProviderId] = useState<string>('')
  const [defaultModel, setDefaultModel] = useState<string>('')

  // ── form state ─────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  /** The provider that owns `model`. May differ from defaultProviderId if the
   *  user picks a model from a non-default provider in the dropdown. */
  const [providerId, setProviderId] = useState<string>('')
  const [model, setModel] = useState<string>('')
  const [aspect, setAspect] = useState<typeof ASPECTS[number]['value']>('16:9')
  const [duration, setDuration] = useState<number>(5)
  const [camera, setCamera] = useState<string>('still')
  const [seedLocked, setSeedLocked] = useState(false)
  const [seed, setSeed] = useState<number>(0)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [negativeOpen, setNegativeOpen] = useState(false)
  const [reference, setReference] = useState<{ file: File; previewUrl: string } | null>(null)
  const [frameRole, setFrameRole] = useState<'first' | 'last' | 'reference'>('first')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── gallery history ────────────────────────────────────────────────────
  const [history, setHistory] = useState<GalleryItem[]>([])

  // Subscribe to main-side progress events once per page lifetime.
  useEffect(() => {
    const off = subscribeVideoProgress()
    return off
  }, [])

  // Load settings + provider list on mount. The "video provider" might be the
  // same one used for chat (e.g. an OpenAI-compat aggregator that also exposes
  // video models), so we offer every model from that provider as the picker
  // options rather than restricting to a hardcoded list.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [settings, provs] = await Promise.all([
          window.api.getSettings() as Promise<AppSettings>,
          window.api.listProviders() as Promise<ProviderConfig[]>
        ])
        if (cancelled) return
        setProviders(provs)
        setDefaultProviderId(settings.defaultVideoProviderId)
        setDefaultModel(settings.defaultVideoModel)
        setProviderId(settings.defaultVideoProviderId || '')
        setModel(settings.defaultVideoModel || '')
      } catch (e) {
        toast.error('加载视频设置失败：' + (e as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Reload video history from gallery when:
  //   - the page first mounts
  //   - a job lands successfully (epoch bump)
  //   - the user deletes / refreshes manually (handled inline)
  const reloadHistory = useCallback(async () => {
    try {
      const items = await window.api.listGallery({ type: 'video' }) as GalleryItem[]
      setHistory(items)
    } catch (e) {
      toast.error('加载历史失败：' + (e as Error).message)
    }
  }, [])

  useEffect(() => { reloadHistory() }, [reloadHistory, galleryEpoch])

  // Backfill thumbnails for any history item that doesn't have one yet.
  // Renderer-side ffmpeg-free extraction — runs in the background and patches
  // the row in-place so the existing card swaps from icon → still frame
  // without needing a full reload.
  // Ids we've already tried to extract a thumbnail for. Each successful patch
  // calls setHistory, which re-runs this effect; without this guard the new run
  // would re-extract every still-pending clip from scratch (O(N²) decode churn).
  // Marking before the await lets a re-run resume past the in-flight item, and
  // also stops a corrupt clip from being retried forever.
  const attemptedThumbsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    let cancelled = false
    const queue = history.filter(it => !it.thumbnailPath && !attemptedThumbsRef.current.has(it.id))
    if (queue.length === 0) return
    ;(async () => {
      for (const item of queue) {
        if (cancelled) return
        attemptedThumbsRef.current.add(item.id)
        const blob = await extractVideoFrame(toLocalUrl(item.filePath), 'first')
        if (!blob || cancelled) continue
        try {
          const base64 = await blobToBase64(blob)
          const res = await window.api.saveVideoThumbnail({
            galleryId: item.id, base64, ext: 'jpg'
          })
          if (cancelled || !res.ok || !res.thumbnailPath) continue
          setHistory(curr => curr.map(h =>
            h.id === item.id ? { ...h, thumbnailPath: res.thumbnailPath } : h
          ))
        } catch {
          // best-effort — keep going so a single corrupt clip doesn't block the rest
        }
      }
    })()
    return () => { cancelled = true }
  }, [history])

  // ── derived ────────────────────────────────────────────────────────────

  /** All models from all providers, grouped per provider for the optgroup'd
   *  <select>. Empty providers (no models listed) are filtered out so the
   *  dropdown isn't full of empty groups. */
  const groupedModels = useMemo(() => {
    return providers
      .filter(p => Array.isArray(p.models) && p.models.length > 0)
      .map(p => ({
        providerId: p.id,
        providerName: p.name,
        models: p.models
      }))
  }, [providers])

  const hasAnyModel = groupedModels.length > 0

  /** Flattened options for the themed <Select>. `groupLabel` drives the section
   *  headers (one per provider). Value encodes provider+model joined with `::`
   *  so the same model name under two providers stays unambiguous. */
  const modelOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = []
    for (const g of groupedModels) {
      for (const m of g.models) {
        const isDefault = g.providerId === defaultProviderId && m === defaultModel
        opts.push({
          value: `${g.providerId}::${m}`,
          label: isDefault ? `${m}（默认）` : m,
          groupLabel: g.providerName
        })
      }
    }
    return opts
  }, [groupedModels, defaultProviderId, defaultModel])

  /** Encoded select value — provider id + model id are joined with `::` so a
   *  single change event uniquely identifies the (provider, model) pair, even
   *  when the same model name appears under two different providers. */
  const selectValue = providerId && model ? `${providerId}::${model}` : ''

  const activeJobs = useMemo(
    () => jobs.filter(j => j.status === 'queued' || j.status === 'running'),
    [jobs]
  )
  // failed / canceled stick around until the user dismisses them; show them
  // next to the historical items so the failure isn't easy to miss.
  const failedJobs = useMemo(
    () => jobs.filter(j => j.status === 'failed' || j.status === 'canceled'),
    [jobs]
  )

  // ── handlers ───────────────────────────────────────────────────────────

  const handleRandomSeed = () => setSeed(Math.floor(Math.random() * 1_000_000_000))
  const handlePickReference = () => fileInputRef.current?.click()

  /** Single funnel for "user gave us an image" — used by file input, drag/drop,
   *  and clipboard paste. Validates type, revokes the old preview URL, and
   *  swaps in the new one. */
  const acceptReferenceFile = useCallback((f: File | null | undefined): boolean => {
    if (!f) return false
    if (!f.type.startsWith('image/')) {
      toast.error('只支持图片文件作为参考图')
      return false
    }
    setReference(prev => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return { file: f, previewUrl: URL.createObjectURL(f) }
    })
    return true
  }, [])

  const handleReferenceFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptReferenceFile(e.target.files?.[0] ?? null)
    e.target.value = ''
  }

  const [dragActive, setDragActive] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragActive(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear when we leave the drop container, not when entering a child.
    if (e.currentTarget === e.target) setDragActive(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    acceptReferenceFile(e.dataTransfer.files?.[0])
  }

  // Page-level paste handler — fires no matter where focus is, so the user can
  // Ctrl+V a copied screenshot without needing to click into a specific zone.
  // We bail out without preventDefault when the clipboard has only text, so
  // pasting into the prompt textarea still works normally.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) {
            e.preventDefault()
            const ok = acceptReferenceFile(file)
            if (ok) toast.success('已从剪贴板贴入参考图')
            return
          }
        }
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [acceptReferenceFile])

  const handleClearReference = () => {
    if (reference?.previewUrl) URL.revokeObjectURL(reference.previewUrl)
    setReference(null)
  }

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      toast.error('请输入提示词')
      return
    }
    if (!providerId || !model) {
      toast.error('请先在左侧选择一个视频模型')
      return
    }

    // Camera move stays in the prompt — there's no widely-supported structured
    // field for it. Negative prompt goes through as its own API field now, so
    // we no longer glue "负面：…" onto the prompt string.
    let finalPrompt = prompt.trim()
    const cam = CAMERA_PROMPT_HINT[camera]
    if (cam) finalPrompt += `，${cam}`

    await submitJob({
      prompt: finalPrompt,
      negativePrompt: negative.trim() || undefined,
      providerId,
      model,
      aspect,
      durationSec: duration,
      reference: reference?.file ?? null,
      frameRole: reference ? frameRole : undefined,
      // Only send a seed when the user locked one — otherwise let the provider
      // randomize. seed 0 is treated as "unset" downstream.
      seed: seedLocked && seed > 0 ? seed : undefined
    })
  }, [prompt, providerId, model, camera, negative, aspect, duration, reference, frameRole, seedLocked, seed, submitJob])

  const handleReuseAsFirstFrame = useCallback(async (item: GalleryItem) => {
    try {
      const blob = await extractVideoFrame(toLocalUrl(item.filePath), 'last', {
        mimeType: 'image/png',
        // Don't downscale here — the user is feeding it into a new generation,
        // so we want the highest fidelity the source clip can give us.
        maxWidth: 0
      })
      if (!blob) {
        toast.error('抽取尾帧失败：无法解码该视频')
        return
      }
      const file = new File([blob], `last-frame-${item.id}.png`, { type: 'image/png' })
      if (reference?.previewUrl) URL.revokeObjectURL(reference.previewUrl)
      setReference({ file, previewUrl: URL.createObjectURL(file) })
      setFrameRole('first')
      setParamsOpen(true)
      toast.success('已抽取尾帧并设为首帧')
    } catch (e) {
      toast.error('抽取尾帧失败：' + (e as Error).message)
    }
  }, [reference])

  const handleRegenerate = useCallback((item: GalleryItem) => {
    const parsed = parseGalleryNote(item.prompt)
    setPrompt(parsed.prompt)
    if (parsed.aspect) setAspect(parsed.aspect)
    if (parsed.durationSec) setDuration(parsed.durationSec)
    setParamsOpen(true)
    toast.info('参数已填入左侧，可调整后再次生成')
  }, [])

  const handleDownload = useCallback(async (item: GalleryItem) => {
    try {
      const result = await window.api.saveFileAs(item.filePath)
      if (!result.canceled) toast.success('已保存')
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    }
  }, [])

  const handleDeleteHistory = useCallback(async (item: GalleryItem) => {
    if (!(await dlg.confirm({ message: '确定删除该视频？', tone: 'danger', confirmLabel: '删除' }))) return
    try {
      await window.api.deleteGalleryItem(item.id)
      await reloadHistory()
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message)
    }
  }, [dlg, reloadHistory])

  const handleRevealHistory = useCallback(async (item: GalleryItem) => {
    try {
      await window.api.showItemInFolder(item.filePath)
    } catch (e) {
      toast.error('打开失败：' + (e as Error).message)
    }
  }, [])

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: Params panel ──────────────────────────────────────────── */}
      {paramsOpen ? (
        <aside className="w-[340px] shrink-0 border-r border-border bg-card/40 flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2 shrink-0">
            <Film size={15} className="text-primary" />
            <h2 className="text-sm font-semibold flex-1">{t('video.title')}</h2>
            <button
              onClick={() => setParamsOpen(false)}
              title="收起参数面板"
              className="p-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {/* Model */}
            <Field label={t('video.model')}>
              {!hasAnyModel ? (
                <p className="text-[11px] text-muted-foreground/70 px-2.5 py-1.5 rounded-lg bg-muted/40 border border-dashed border-border">
                  请先在「设置」中添加 Provider 并配置模型
                </p>
              ) : (
                <Select
                  value={selectValue}
                  onChange={v => {
                    const [pid, mid] = v.split('::')
                    setProviderId(pid)
                    setModel(mid)
                  }}
                  options={modelOptions}
                  placeholder="选择视频模型"
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              )}
            </Field>

            {/* Reference image */}
            <Field label={t('video.reference')} hint="可作为首帧 / 尾帧 / 风格参考 · 支持拖拽、粘贴">
              <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleReferenceFile} />
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                  'rounded-lg transition-colors',
                  dragActive && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background'
                )}
              >
                {reference ? (
                  <div className="rounded-lg border border-border bg-muted/30 p-2 space-y-2">
                    <div
                      className="relative rounded-md bg-muted overflow-hidden flex items-center justify-center"
                      style={{ aspectRatio: '16 / 9' }}
                    >
                      <img
                        src={reference.previewUrl}
                        alt=""
                        className="w-full h-full object-contain"
                      />
                      <button
                        onClick={handleClearReference}
                        title="移除"
                        className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md bg-black/50 text-white flex items-center justify-center hover:bg-destructive transition-colors"
                      >
                        <X size={11} />
                      </button>
                      {dragActive && (
                        <div className="absolute inset-0 bg-primary/20 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
                          <span className="text-[11px] font-medium text-primary-foreground bg-primary/80 px-2 py-1 rounded-md">
                            松开替换参考图
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate">{reference.file.name}</p>
                    <div className="flex gap-1 text-[10px]">
                      {(['first', 'last', 'reference'] as const).map(r => (
                        <button
                          key={r}
                          onClick={() => setFrameRole(r)}
                          className={cn(
                            'flex-1 px-2 py-1 rounded-md transition-colors',
                            frameRole === r
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                          )}
                        >
                          {r === 'first' ? t('video.frameFirst') : r === 'last' ? t('video.frameLast') : t('video.frameStyle')}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={handlePickReference}
                    className={cn(
                      'w-full rounded-lg border border-dashed transition-colors py-6 flex flex-col items-center gap-1.5',
                      dragActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:border-primary/60 hover:bg-primary/5 bg-muted/30 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Upload size={18} strokeWidth={1.5} />
                    <span className="text-[11px]">{dragActive ? '松开以使用该图片' : '点击上传 / 拖拽 / 粘贴图片'}</span>
                    <span className="text-[10px] text-muted-foreground/60">支持 PNG / JPG / WebP</span>
                  </button>
                )}
              </div>
            </Field>

            {/* Prompt */}
            <Field label={t('video.prompt')} trailing={
              <span className="text-[10px] text-muted-foreground/60">{prompt.length} / 800</span>
            }>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, 800))}
                rows={4}
                placeholder="描述你想要的镜头、动作、氛围…"
                className="w-full px-2.5 py-2 text-xs rounded-lg bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none transition-all resize-none placeholder:text-muted-foreground/50"
              />
            </Field>

            {/* Negative (collapsible) */}
            <Disclosure
              open={negativeOpen}
              onToggle={() => setNegativeOpen(o => !o)}
              label={t('video.negative')}
              hint="不希望出现的元素"
            >
              <textarea
                value={negative}
                onChange={e => setNegative(e.target.value)}
                rows={2}
                placeholder="模糊、低质量、变形、水印…"
                className="w-full px-2.5 py-2 text-xs rounded-lg bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none transition-all resize-none placeholder:text-muted-foreground/50"
              />
            </Disclosure>

            {/* Aspect */}
            <Field label={t('video.aspect')}>
              <div className="grid grid-cols-3 gap-1.5">
                {ASPECTS.map(a => (
                  <button
                    key={a.value}
                    onClick={() => setAspect(a.value)}
                    title={a.hint}
                    className={cn(
                      'py-2 rounded-lg text-xs font-medium transition-colors',
                      aspect === a.value
                        ? 'bg-primary/10 text-primary ring-1 ring-primary/40'
                        : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <div className="flex items-center justify-center gap-1.5">
                      <span
                        className="bg-current rounded-sm opacity-60"
                        style={{
                          width: a.value === '9:16' ? 6 : a.value === '1:1' ? 10 : 14,
                          height: a.value === '9:16' ? 12 : a.value === '1:1' ? 10 : 8
                        }}
                      />
                      {a.label}
                    </div>
                  </button>
                ))}
              </div>
            </Field>

            {/* Duration */}
            <Field label={t('video.duration')}>
              <div className="flex gap-1.5">
                {DURATIONS.map(d => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={cn(
                      'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      duration === d
                        ? 'bg-primary/10 text-primary ring-1 ring-primary/40'
                        : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </Field>

            {/* Advanced (collapsible) */}
            <Disclosure
              open={advancedOpen}
              onToggle={() => setAdvancedOpen(o => !o)}
              label={t('video.advanced')}
              hint="运镜 / 种子"
            >
              <div className="space-y-4 pt-1">
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1.5">运镜方向</p>
                  <div className="grid grid-cols-3 gap-1 w-[150px]">
                    {CAMERA_MOVES.map(m => (
                      <button
                        key={m.key}
                        onClick={() => setCamera(m.key)}
                        title={m.label}
                        className={cn(
                          'aspect-square rounded-md flex items-center justify-center transition-colors',
                          camera === m.key
                            ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                            : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                      >
                        {m.icon ? <m.icon size={14} /> : <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] text-muted-foreground mb-1.5">种子</p>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={seed}
                      onChange={e => setSeed(Number(e.target.value))}
                      disabled={!seedLocked}
                      placeholder="随机"
                      className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none transition-all disabled:opacity-50"
                    />
                    <button
                      onClick={() => setSeedLocked(l => !l)}
                      title={seedLocked ? '锁定中（结果可复现）' : '未锁定（每次随机）'}
                      className={cn(
                        'p-1.5 rounded-lg transition-colors',
                        seedLocked
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                      )}
                    >
                      {seedLocked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                    <button
                      onClick={handleRandomSeed}
                      title="随机一个新的种子"
                      className="p-1.5 rounded-lg bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      <Dice5 size={12} />
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-1">
                    注：锁定后会把种子透传给模型；是否生效取决于具体模型。未锁定时每次随机。
                  </p>
                </div>
              </div>
            </Disclosure>
          </div>

          {/* Footer: preset + generate */}
          <div className="px-4 py-3 border-t border-border bg-card/60 shrink-0 space-y-2">
            <div className="flex items-center gap-1.5">
              <button
                title="保存当前参数为预设（即将支持）"
                disabled
                className="flex-1 px-2.5 py-1.5 text-[11px] rounded-lg bg-muted/60 text-muted-foreground/50 cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Plus size={11} /> 存为预设
              </button>
              <button
                title="参数预设（即将支持）"
                disabled
                className="px-2.5 py-1.5 text-[11px] rounded-lg bg-muted/60 text-muted-foreground/50 cursor-not-allowed flex items-center gap-1.5"
              >
                <Settings2 size={11} /> 预设
                <ChevronDown size={10} />
              </button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={!prompt.trim() || !providerId || !model}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2 shadow-sm"
            >
              <Film size={14} />
              {t('video.generate')}
              <span className="text-[10px] opacity-70">约 {formatDuration(estimateVideoEta(model, duration))}</span>
            </button>
          </div>
        </aside>
      ) : (
        <aside className="w-12 shrink-0 border-r border-border bg-card/40 flex flex-col items-center py-3">
          <button
            onClick={() => setParamsOpen(true)}
            title="展开参数面板"
            className="p-2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <PanelLeftOpen size={15} />
          </button>
        </aside>
      )}

      {/* ── Right: Tasks + history ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="px-6 py-3 border-b border-border flex items-center gap-3 shrink-0">
          <h2 className="text-base font-semibold">{t('video.tasks')}</h2>
          {activeJobs.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {activeJobs.length} 进行中
            </span>
          )}
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {history.length + jobs.length} 条历史
            </span>
            <button
              onClick={reloadHistory}
              className="px-2 py-1 rounded-md hover:bg-muted hover:text-foreground transition-colors"
            >
              {t('video.refresh')}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {activeJobs.length > 0 && (
            <section>
              <SectionHeader label={t('video.sectionActive')} count={activeJobs.length} />
              <div className="space-y-2.5">
                {activeJobs.map(j => (
                  <ActiveJobCard key={j.id} job={j} onCancel={() => cancelJob(j.id)} />
                ))}
              </div>
            </section>
          )}

          {failedJobs.length > 0 && (
            <section>
              <SectionHeader label={t('video.sectionFailed')} count={failedJobs.length} />
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {failedJobs.map(j => (
                  <FailedJobCard key={j.id} job={j} onDismiss={() => removeJob(j.id)} />
                ))}
              </div>
            </section>
          )}

          {history.length > 0 && (
            <section>
              <SectionHeader label={t('video.sectionHistory')} count={history.length} />
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {history.map(item => (
                  <HistoryCard
                    key={item.id}
                    item={item}
                    onRegenerate={() => handleRegenerate(item)}
                    onReuseFirstFrame={() => handleReuseAsFirstFrame(item)}
                    onDownload={() => handleDownload(item)}
                    onReveal={() => handleRevealHistory(item)}
                    onDelete={() => handleDeleteHistory(item)}
                  />
                ))}
              </div>
            </section>
          )}

          {activeJobs.length === 0 && failedJobs.length === 0 && history.length === 0 && (
            <div className="flex-1 flex items-center justify-center py-24">
              <div className="text-center text-muted-foreground text-sm">
                <p className="text-3xl mb-3">🎬</p>
                <p>{t('video.empty')}</p>
                {!model && (
                  <p className="text-[11px] text-muted-foreground/60 mt-2">
                    提示：先在左侧选择视频模型，或在「设置 → 默认模型」配置默认模型
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {dlg.element}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────

function Field({
  label, hint, trailing, children
}: {
  label: string
  hint?: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
        {trailing}
      </div>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/60 mt-1">{hint}</p>}
    </div>
  )
}

function Disclosure({
  open, onToggle, label, hint, children
}: {
  open: boolean
  onToggle: () => void
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>{label}</span>
        {hint && <span className="text-muted-foreground/50 font-normal">· {hint}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-3">
      {label}
      <span className="ml-2 text-muted-foreground/40 font-normal normal-case tracking-normal">{count}</span>
    </h3>
  )
}

function StatusPill({ status }: { status: JobStatus }) {
  if (status === 'queued') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">排队中</span>
  }
  if (status === 'running') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary font-medium flex items-center gap-1">
        <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
        生成中
      </span>
    )
  }
  if (status === 'succeeded') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">已完成</span>
  }
  if (status === 'canceled') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium">已取消</span>
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-destructive/10 text-destructive font-medium">失败</span>
}

function ActiveJobCard({ job, onCancel }: { job: VideoJob; onCancel: () => void }) {
  // Best-effort progress — clamps at 95% so we don't show "100%" before the
  // file actually arrives. The real completion event drops the card entirely.
  const ratio = job.etaSeconds > 0 ? Math.min(0.95, job.elapsedSeconds / job.etaSeconds) : 0
  const pct = Math.round(ratio * 100)
  const remaining = Math.max(0, job.etaSeconds - job.elapsedSeconds)
  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <div
          className="w-20 rounded-lg overflow-hidden bg-gradient-to-br from-primary/15 via-primary/5 to-background flex items-center justify-center shrink-0 relative"
          style={aspectStyle(job.aspect)}
        >
          {job.referencePreviewUrl ? (
            <img src={job.referencePreviewUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <Film size={18} className="text-muted-foreground/40" />
          )}
          {job.status === 'running' && (
            <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px] flex items-center justify-center">
              <span className="text-white text-[10px] font-semibold tabular-nums">{pct}%</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusPill status={job.status} />
            <span className="text-[10px] text-muted-foreground truncate">{job.model}</span>
            <span className="text-[10px] text-muted-foreground/50 shrink-0">· {job.aspect} · {job.durationSec}s</span>
          </div>
          <p className="text-xs text-foreground/85 line-clamp-2 leading-snug mb-2">{job.prompt}</p>

          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                job.status === 'queued' ? 'bg-muted-foreground/30' : 'bg-primary'
              )}
              style={{ width: job.status === 'queued' ? '4px' : `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-foreground tabular-nums">
            <span>
              {job.status === 'queued' ? '等待提交…' : `已用 ${formatDuration(job.elapsedSeconds)}`}
            </span>
            <span>
              {job.status === 'queued' ? `预计 ${formatDuration(job.etaSeconds)}` : `剩余 ~${formatDuration(remaining)}`}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={onCancel}
            title={job.status === 'running' ? '取消生成' : '移出队列'}
            className="p-1.5 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            {job.status === 'running' ? <Pause size={13} /> : <X size={13} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function FailedJobCard({ job, onDismiss }: { job: VideoJob; onDismiss: () => void }) {
  const isCanceled = job.status === 'canceled'
  return (
    <div className={cn(
      'group rounded-xl border overflow-hidden shadow-sm transition-all',
      isCanceled ? 'border-border bg-card' : 'border-destructive/30 bg-destructive/5'
    )}>
      <div
        className={cn(
          'relative w-full flex items-center justify-center px-4 py-6',
          isCanceled ? 'bg-muted/30' : 'bg-destructive/5'
        )}
        style={aspectStyle(job.aspect)}
      >
        <div className="text-center">
          <X size={28} className={cn('mx-auto mb-1', isCanceled ? 'text-muted-foreground/60' : 'text-destructive/60')} />
          <p className={cn('text-[11px]', isCanceled ? 'text-muted-foreground' : 'text-destructive')}>
            {job.errorMessage ?? (isCanceled ? '已取消' : '生成失败')}
          </p>
        </div>
      </div>

      <div className="p-3 space-y-2">
        <p className="text-xs text-foreground/85 line-clamp-2 leading-snug min-h-[2.6em]">{job.prompt}</p>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate flex-1">{job.model}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{job.aspect}</span>
        </div>
        <div className="flex items-center gap-1 pt-1.5 border-t border-border/60">
          <button
            onClick={onDismiss}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X size={11} /> 关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function HistoryCard({
  item, onRegenerate, onReuseFirstFrame, onDownload, onReveal, onDelete
}: {
  item: GalleryItem
  onRegenerate: () => void
  onReuseFirstFrame: () => void
  onDownload: () => void
  onReveal: () => void
  onDelete: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const parsed = parseGalleryNote(item.prompt)
  const aspect: VideoJob['aspect'] = parsed.aspect ?? '16:9'

  const handlePlay = () => {
    setPlaying(true)
    // Defer to next tick so the <video> is mounted before we call play().
    setTimeout(() => videoRef.current?.play().catch(() => { /* user-gesture issue, ignore */ }), 0)
  }

  return (
    <div className="group rounded-xl border border-border bg-card overflow-hidden shadow-sm hover:shadow-md hover:border-border/80 transition-all">
      <div
        className="relative w-full overflow-hidden bg-gradient-to-br from-primary/15 via-primary/5 to-background flex items-center justify-center"
        style={aspectStyle(aspect)}
      >
        {playing ? (
          <video
            ref={videoRef}
            src={toLocalUrl(item.filePath)}
            controls
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <>
            {item.thumbnailPath ? (
              <img
                src={toLocalUrl(item.thumbnailPath)}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <Film size={36} className="text-primary/40" />
            )}
            <button
              onClick={handlePlay}
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30"
              title="播放预览"
            >
              <span className="w-12 h-12 rounded-full bg-white/90 text-foreground flex items-center justify-center shadow-lg">
                <Play size={18} className="ml-0.5" />
              </span>
            </button>
            {parsed.durationSec && (
              <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium tabular-nums">
                {parsed.durationSec}s
              </span>
            )}
          </>
        )}
      </div>

      <div className="p-3 space-y-2">
        <p className="text-xs text-foreground/85 line-clamp-2 leading-snug min-h-[2.6em]">{parsed.prompt}</p>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate flex-1">{item.modelName ?? '未知模型'}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{aspect}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{formatRelative(item.createdAt)}</span>
        </div>

        <div className="flex items-center gap-1 pt-1.5 border-t border-border/60">
          <ActionBtn icon={ArrowRight} label="作为首帧" title="抽取这段视频的尾帧并填入参数面板作为新任务的首帧" onClick={onReuseFirstFrame} />
          <ActionBtn icon={Wand2} label="再来一版" title="使用相同 prompt 填入参数面板" onClick={onRegenerate} />
          <ActionBtn icon={Download} label="保存" onClick={onDownload} />
          <ActionBtn icon={FolderOpen} label="位置" title="在文件夹中显示" onClick={onReveal} />
          <ActionBtn icon={Trash2} label="删除" danger onClick={onDelete} />
        </div>
      </div>
    </div>
  )
}

function ActionBtn({
  icon: Icon, label, title, danger, onClick
}: {
  icon: typeof Wand2
  label: string
  title?: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className={cn(
        'flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[10px] transition-colors',
        danger
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      <Icon size={11} />
      <span className="truncate">{label}</span>
    </button>
  )
}
