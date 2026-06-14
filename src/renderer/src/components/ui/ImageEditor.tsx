import { useEffect, useRef, useState } from 'react'
import { BRAND } from '@shared/brand'
import {
  X, Brush, Eraser, Undo2, RotateCcw, Wand2, Type, Scissors, Maximize2,
  Loader2, Sparkles, Check
} from 'lucide-react'
import { cn } from '../../lib/utils'

export type EditMode = 'inpaint' | 'text_replace' | 'outpaint' | 'bg_removal'

interface Props {
  /** Local-file URL or http URL of the image to edit. */
  src: string
  /** Optional session id — propagated to gallery save. */
  sessionId?: string
  onClose: () => void
  /** Called with the new image path when the edit succeeds. */
  onApplied?: (newPath: string, galleryId: number) => void
}

const RATIO_PRESETS: Array<{ label: string; value: string; w: number; h: number }> = [
  { label: '1:1',  value: '1024x1024', w: 1024, h: 1024 },
  { label: '4:3',  value: '1024x768',  w: 1024, h: 768 },
  { label: '3:4',  value: '768x1024',  w: 768, h: 1024 },
  { label: '16:9', value: '1792x1008', w: 1792, h: 1008 },
  { label: '9:16', value: '1008x1792', w: 1008, h: 1792 },
  { label: '3:2',  value: '1536x1024', w: 1536, h: 1024 },
  { label: '2:3',  value: '1024x1536', w: 1024, h: 1536 }
]

const MODE_TABS: Array<{ value: EditMode; label: string; icon: React.ReactNode; hint: string }> = [
  { value: 'inpaint',      label: '局部修改', icon: <Brush size={13} />,   hint: '在图中涂抹要修改的区域，再描述修改内容' },
  { value: 'text_replace', label: '无痕改字', icon: <Type size={13} />,    hint: '涂抹要替换的文字区域，输入新文字，自动保持字体一致' },
  { value: 'bg_removal',   label: '一键抠图', icon: <Scissors size={13} />, hint: '自动移除背景，保留主体；无需涂抹' },
  { value: 'outpaint',     label: 'AI 扩图', icon: <Maximize2 size={13} />, hint: '选择目标比例，AI 自动扩展画面，整体风格保持不变' }
]

export function ImageEditor({ src, sessionId, onClose, onApplied }: Props) {
  const [mode, setMode] = useState<EditMode>('inpaint')
  const [prompt, setPrompt] = useState('')
  const [brushSize, setBrushSize] = useState(40)
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [imageMeta, setImageMeta] = useState<{ width: number; height: number; imageEl: HTMLImageElement } | null>(null)
  const [running, setRunning] = useState(false)
  const [resultPath, setResultPath] = useState<string | null>(null)
  const [resultVersion, setResultVersion] = useState(0)   // cache-bust counter
  const [error, setError] = useState<string | null>(null)
  const [outpaintTarget, setOutpaintTarget] = useState<string>('1024x768') // default 4:3
  const outpaintLayoutRef = useRef<{ targetW: number; targetH: number; ox: number; oy: number; drawW: number; drawH: number } | null>(null)

  // Canvases: bgCanvas (image), maskCanvas (user strokes shown as red overlay)
  const containerRef = useRef<HTMLDivElement>(null)
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawingRef = useRef(false)
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef<ImageData[]>([])

  // Load source image
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => setImageMeta({ width: img.naturalWidth, height: img.naturalHeight, imageEl: img })
    img.onerror = () => setError('图片加载失败')
    img.src = src
  }, [src])

  // Draw image on bgCanvas when meta ready
  useEffect(() => {
    if (!imageMeta || !bgCanvasRef.current || !maskCanvasRef.current) return
    const { imageEl, width, height } = imageMeta

    const bg = bgCanvasRef.current
    bg.width = width
    bg.height = height
    bg.getContext('2d')?.drawImage(imageEl, 0, 0)

    const mask = maskCanvasRef.current
    mask.width = width
    mask.height = height
    historyRef.current = []
  }, [imageMeta])

  // Close on Esc
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !running) onClose()
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Painting ---
  function snapshot() {
    const c = maskCanvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    historyRef.current.push(ctx.getImageData(0, 0, c.width, c.height))
    if (historyRef.current.length > 20) historyRef.current.shift()
  }

  function getCanvasPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = maskCanvasRef.current!
    const rect = c.getBoundingClientRect()
    const scaleX = c.width / rect.width
    const scaleY = c.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode === 'bg_removal' || mode === 'outpaint') return
    if (e.button !== 0) return
    snapshot()
    isDrawingRef.current = true
    const pos = getCanvasPos(e)
    lastPosRef.current = pos
    drawAt(pos.x, pos.y, pos.x, pos.y)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return
    const pos = getCanvasPos(e)
    const last = lastPosRef.current
    if (last) drawAt(last.x, last.y, pos.x, pos.y)
    lastPosRef.current = pos
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false
    lastPosRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }

  function drawAt(x1: number, y1: number, x2: number, y2: number) {
    const c = maskCanvasRef.current
    const ctx = c?.getContext('2d')
    if (!ctx) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brushSize
    if (tool === 'brush') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)' // semi-transparent red overlay
    } else {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
    }
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  function undo() {
    const c = maskCanvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const prev = historyRef.current.pop()
    if (prev) ctx.putImageData(prev, 0, 0)
    else ctx.clearRect(0, 0, c.width, c.height)
  }

  function clearMask() {
    const c = maskCanvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    snapshot()
    ctx.clearRect(0, 0, c.width, c.height)
  }

  // --- Mask export ---
  /**
   * Convert the user's red-painted overlay into an OpenAI-spec mask:
   * - Painted (alpha > 0) → TRANSPARENT in mask (the area to edit)
   * - Untouched → opaque white (preserve)
   */
  function buildInpaintMaskBase64(): string | null {
    const c = maskCanvasRef.current
    if (!c) return null
    const ctx = c.getContext('2d')
    if (!ctx) return null
    const src = ctx.getImageData(0, 0, c.width, c.height)
    // Quick check: is any pixel painted?
    let anyPainted = false
    for (let i = 3; i < src.data.length; i += 4) {
      if (src.data[i] > 0) { anyPainted = true; break }
    }
    if (!anyPainted) return null

    const out = document.createElement('canvas')
    out.width = c.width
    out.height = c.height
    const octx = out.getContext('2d')!
    const dst = octx.createImageData(c.width, c.height)
    for (let i = 0; i < src.data.length; i += 4) {
      const a = src.data[i + 3]
      if (a > 0) {
        // Painted → fully transparent
        dst.data[i] = 0; dst.data[i + 1] = 0; dst.data[i + 2] = 0; dst.data[i + 3] = 0
      } else {
        // Untouched → opaque white
        dst.data[i] = 255; dst.data[i + 1] = 255; dst.data[i + 2] = 255; dst.data[i + 3] = 255
      }
    }
    octx.putImageData(dst, 0, 0)
    return out.toDataURL('image/png').split(',')[1]
  }

  function buildSourceImageBase64(): string {
    const c = bgCanvasRef.current!
    return c.toDataURL('image/png').split(',')[1]
  }

  /**
   * For outpainting: place the original image centered inside a larger canvas
   * of the target dimensions. Returns { imageBase64, maskBase64 } where:
   *   imageBase64 = larger canvas with original centered + transparent surround
   *   maskBase64  = matching size; original region opaque white, surround transparent
   */
  function buildOutpaintAssets(targetW: number, targetH: number): { imageBase64: string; maskBase64: string } {
    if (!imageMeta) throw new Error('图片未就绪')
    const { width: srcW, height: srcH, imageEl } = imageMeta
    // Scale source to fit while keeping aspect ratio
    const scale = Math.min(targetW / srcW, targetH / srcH)
    const drawW = Math.round(srcW * scale)
    const drawH = Math.round(srcH * scale)
    const ox = Math.round((targetW - drawW) / 2)
    const oy = Math.round((targetH - drawH) / 2)

    // Remember placement for the post-composite step
    outpaintLayoutRef.current = { targetW, targetH, ox, oy, drawW, drawH }

    // Build extended image canvas
    const imgC = document.createElement('canvas')
    imgC.width = targetW
    imgC.height = targetH
    imgC.getContext('2d')!.drawImage(imageEl, ox, oy, drawW, drawH)

    // Build mask canvas: white opaque rectangle over original region, transparent elsewhere
    const maskC = document.createElement('canvas')
    maskC.width = targetW
    maskC.height = targetH
    const mctx = maskC.getContext('2d')!
    mctx.clearRect(0, 0, targetW, targetH) // ensure fully transparent
    mctx.fillStyle = '#ffffff'
    mctx.fillRect(ox, oy, drawW, drawH)

    return {
      imageBase64: imgC.toDataURL('image/png').split(',')[1],
      maskBase64: maskC.toDataURL('image/png').split(',')[1]
    }
  }

  /** Promise-based <img> loader. */
  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('image load failed: ' + src))
      img.src = src
    })
  }

  function toLocalUrl(p: string): string {
    return `local-file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`
  }

  /**
   * Post-process the model's result so the saved image is always what the user expects:
   *
   *   inpaint / text_replace — model sometimes returns only the edited region with
   *     transparency around it. Composite source UNDER, result ON TOP so the original
   *     pixels show through any transparent areas → final image is fully opaque.
   *
   *   outpaint — even when the model fills the surround, the original region can drift
   *     a few pixels. Composite the model output as BACKGROUND, then paste the original
   *     source ON TOP at its known offset → original region stays pixel-perfect.
   *
   *   bg_removal — transparency IS the intent; skip compositing.
   *
   * Returns the new base64 PNG to overwrite the file with, or null when no composite needed.
   */
  async function compositeResultPng(resultPath: string): Promise<string | null> {
    if (mode === 'bg_removal' || !imageMeta) return null
    const sourceEl = imageMeta.imageEl
    const resultEl = await loadImage(toLocalUrl(resultPath) + `?v=${Date.now()}`)

    const out = document.createElement('canvas')
    const ctx = out.getContext('2d')!

    if (mode === 'outpaint' && outpaintLayoutRef.current) {
      const { targetW, targetH, ox, oy, drawW, drawH } = outpaintLayoutRef.current
      out.width = targetW
      out.height = targetH
      // Model output covers the full target canvas (may include transparency)
      ctx.drawImage(resultEl, 0, 0, targetW, targetH)
      // Original lays on top at its exact position — preserves pixel-perfect detail
      ctx.drawImage(sourceEl, ox, oy, drawW, drawH)
    } else {
      // inpaint / text_replace — match source dimensions; result scales to fit
      out.width = sourceEl.naturalWidth
      out.height = sourceEl.naturalHeight
      ctx.drawImage(sourceEl, 0, 0)
      ctx.drawImage(resultEl, 0, 0, out.width, out.height)
    }

    return out.toDataURL('image/png').split(',')[1]
  }

  // --- Submit ---
  async function handleApply() {
    if (!imageMeta) return
    setError(null)
    setResultPath(null)
    setRunning(true)
    try {
      let payload: Parameters<typeof window.api.editImage>[0]

      if (mode === 'outpaint') {
        const preset = RATIO_PRESETS.find(r => r.value === outpaintTarget) || RATIO_PRESETS[1]
        const { imageBase64, maskBase64 } = buildOutpaintAssets(preset.w, preset.h)
        payload = {
          mode,
          imageBase64,
          maskBase64,
          size: preset.value,
          sessionId
        }
      } else if (mode === 'bg_removal') {
        payload = {
          mode,
          imageBase64: buildSourceImageBase64(),
          sessionId
        }
      } else {
        const maskBase64 = buildInpaintMaskBase64()
        if (!maskBase64) {
          throw new Error('请先用画笔涂抹要修改的区域')
        }
        if (!prompt.trim()) {
          throw new Error(mode === 'text_replace' ? '请输入要替换的新文字' : '请描述要修改成的内容')
        }
        payload = {
          mode,
          imageBase64: buildSourceImageBase64(),
          maskBase64,
          prompt,
          sessionId
        }
      }

      const result = await window.api.editImage(payload)

      // Composite client-side so the saved file is fully opaque for modes
      // that aren't supposed to produce transparency.
      try {
        const composited = await compositeResultPng(result.path)
        if (composited) {
          await window.api.overwriteImage({ path: result.path, base64: composited })
        }
      } catch (compErr) {
        console.warn('[image-edit] composite failed, keeping raw output:', compErr)
      }

      setResultPath(result.path)
      setResultVersion(v => v + 1)
      onApplied?.(result.path, result.galleryId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const activeTab = MODE_TABS.find(t => t.value === mode)!
  const needsMask = mode === 'inpaint' || mode === 'text_replace'

  return (
    <div className="fixed inset-0 z-[200] bg-black/85 backdrop-blur-sm flex flex-col animate-overlay-in" onClick={running ? undefined : onClose}>
      {/* Top bar */}
      <header className="flex items-center gap-3 px-5 py-3 bg-card/95 border-b border-border" onClick={e => e.stopPropagation()}>
        <Wand2 size={16} className="text-primary" />
        <h2 className="font-semibold text-sm">图片编辑器</h2>
        <div className="flex-1" />
        <button
          onClick={onClose}
          disabled={running}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
        >
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Left: tabs */}
        <aside className="w-44 shrink-0 border-r border-border bg-card/90 p-2 space-y-0.5">
          {MODE_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => { setMode(tab.value); setError(null); setResultPath(null) }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
                mode === tab.value
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}

          <div className="mt-3 pt-3 border-t border-border/60 px-2 text-[10px] text-muted-foreground/70 leading-relaxed">
            {activeTab.hint}
          </div>
        </aside>

        {/* Center: canvas */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 bg-black/30 overflow-hidden" ref={containerRef}>
          {!imageMeta ? (
            <div className="flex items-center gap-2 text-white/80 text-sm">
              <Loader2 size={14} className="animate-spin" /> 加载图片中…
            </div>
          ) : resultPath ? (
            <ResultView
              resultPath={resultPath}
              version={resultVersion}
              showCheckerBg={mode === 'bg_removal'}
              onContinueEditing={() => setResultPath(null)}
              onClose={onClose}
            />
          ) : (
            <CanvasView
              imageMeta={imageMeta}
              bgCanvasRef={bgCanvasRef}
              maskCanvasRef={maskCanvasRef}
              canDraw={needsMask}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              brushSize={brushSize}
              tool={tool}
            />
          )}
        </div>

        {/* Right: controls per mode */}
        <aside className="w-72 shrink-0 border-l border-border bg-card/90 p-4 overflow-y-auto space-y-4">
          {/* Brush controls (only when masking) */}
          {needsMask && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">画笔</h3>
              <div className="flex rounded-lg border border-border overflow-hidden text-xs">
                <button
                  onClick={() => setTool('brush')}
                  className={cn('flex-1 px-2 py-1.5 flex items-center justify-center gap-1', tool === 'brush' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}
                >
                  <Brush size={11} /> 涂抹
                </button>
                <button
                  onClick={() => setTool('eraser')}
                  className={cn('flex-1 px-2 py-1.5 flex items-center justify-center gap-1 border-l border-border', tool === 'eraser' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}
                >
                  <Eraser size={11} /> 擦除
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-6">{brushSize}</span>
                <input
                  type="range"
                  min={5}
                  max={120}
                  value={brushSize}
                  onChange={e => setBrushSize(Number(e.target.value))}
                  className="flex-1"
                />
              </div>
              <div className="flex gap-1">
                <button
                  onClick={undo}
                  title="撤销 (Ctrl+Z)"
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <Undo2 size={11} /> 撤销
                </button>
                <button
                  onClick={clearMask}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <RotateCcw size={11} /> 清除
                </button>
              </div>
            </section>
          )}

          {/* Prompt */}
          {(mode === 'inpaint' || mode === 'text_replace') && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">
                {mode === 'inpaint' ? '修改描述' : '新的文字内容'}
              </h3>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={mode === 'inpaint'
                  ? '描述你想把涂抹区域变成什么…\n例如：把这只狗换成一只猫'
                  : `输入要替换成的新文字…\n例如：${BRAND.displayName}`}
                rows={4}
                className="w-full px-2.5 py-1.5 rounded-md bg-card border border-border text-xs outline-none focus:ring-1 focus:ring-ring resize-none leading-relaxed"
              />
            </section>
          )}

          {/* Outpaint ratio chooser */}
          {mode === 'outpaint' && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">目标比例</h3>
              <div className="grid grid-cols-3 gap-1.5">
                {RATIO_PRESETS.map(r => (
                  <button
                    key={r.value}
                    onClick={() => setOutpaintTarget(r.value)}
                    className={cn(
                      'flex flex-col items-center gap-0.5 px-2 py-2 rounded border text-[11px] transition-colors',
                      outpaintTarget === r.value
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    <RatioPreview w={r.w} h={r.h} />
                    <span>{r.label}</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                原图会居中放置，周围空白区域由 AI 按相同风格自动延伸。
              </p>
            </section>
          )}

          {/* Bg removal: pure action */}
          {mode === 'bg_removal' && (
            <section className="space-y-2">
              <p className="text-xs text-muted-foreground leading-relaxed">
                点击下方「开始」按钮，AI 会自动识别并保留主体，移除背景。
                抠图质量取决于当前所选图片模型对透明背景的支持程度。
              </p>
            </section>
          )}

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2">
              {error}
            </div>
          )}

          {/* Apply */}
          <button
            onClick={handleApply}
            disabled={running || !imageMeta}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all',
              running || !imageMeta
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm'
            )}
          >
            {running ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                {mode === 'bg_removal' ? '开始抠图' : mode === 'outpaint' ? '开始扩图' : '应用修改'}
              </>
            )}
          </button>
        </aside>
      </div>
    </div>
  )
}

function CanvasView({
  imageMeta, bgCanvasRef, maskCanvasRef, canDraw,
  onPointerDown, onPointerMove, onPointerUp, brushSize, tool
}: {
  imageMeta: { width: number; height: number }
  bgCanvasRef: React.RefObject<HTMLCanvasElement>
  maskCanvasRef: React.RefObject<HTMLCanvasElement>
  canDraw: boolean
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void
  brushSize: number
  tool: 'brush' | 'eraser'
}) {
  // Cursor SVG showing brush circle
  const cursor = canDraw
    ? `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="${brushSize}" height="${brushSize}" viewBox="0 0 ${brushSize} ${brushSize}"><circle cx="${brushSize / 2}" cy="${brushSize / 2}" r="${brushSize / 2 - 1}" fill="${tool === 'brush' ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.3)'}" stroke="white" stroke-width="1.5"/></svg>') ${brushSize / 2} ${brushSize / 2}, crosshair`
    : 'default'

  return (
    <div className="relative max-w-full max-h-full" style={{ aspectRatio: `${imageMeta.width}/${imageMeta.height}` }}>
      <canvas
        ref={bgCanvasRef}
        className="block max-w-full max-h-[calc(100vh-180px)] rounded-lg shadow-2xl border border-white/10"
        style={{ aspectRatio: `${imageMeta.width}/${imageMeta.height}` }}
      />
      <canvas
        ref={maskCanvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className={cn('absolute inset-0 w-full h-full touch-none', canDraw ? '' : 'pointer-events-none')}
        style={{ cursor }}
      />
    </div>
  )
}

function ResultView({
  resultPath, version, showCheckerBg, onContinueEditing, onClose
}: {
  resultPath: string
  version: number
  showCheckerBg: boolean
  onContinueEditing: () => void
  onClose: () => void
}) {
  // Cache-bust so the renderer re-fetches after composite overwrite
  const src = `local-file:///${resultPath.replace(/\\/g, '/').replace(/^\//, '')}?v=${version}`

  // 16-px checker pattern; rendered behind the image so transparency is visible
  const checkerBg = showCheckerBg
    ? {
        backgroundImage:
          'linear-gradient(45deg,#888 25%,transparent 25%),linear-gradient(-45deg,#888 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#888 75%),linear-gradient(-45deg,transparent 75%,#888 75%)',
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 0 8px, 8px -8px, 8px 0'
      }
    : undefined

  return (
    <div className="flex flex-col items-center gap-4 max-w-full max-h-full">
      <div className="flex items-center gap-1.5 text-green-400 text-sm">
        <Check size={14} /> 已生成并保存到画廊
      </div>
      <div
        className="rounded-xl shadow-2xl border border-white/10 overflow-hidden"
        style={checkerBg}
      >
        <img src={src} alt="result" className="max-h-[60vh] max-w-full block" />
      </div>
      {showCheckerBg && (
        <p className="text-[11px] text-white/60">
          棋盘格为透明区域指示，导出/保存的实际为透明 PNG
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={onContinueEditing} className="px-4 py-2 rounded-lg text-sm bg-white/10 text-white hover:bg-white/20">
          继续编辑
        </button>
        <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground hover:opacity-90">
          完成
        </button>
      </div>
    </div>
  )
}

function RatioPreview({ w, h }: { w: number; h: number }) {
  const box = 20
  const scale = Math.min(box / w, box / h)
  const pw = Math.max(4, Math.round(w * scale))
  const ph = Math.max(4, Math.round(h * scale))
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`}>
      <rect
        x={(box - pw) / 2} y={(box - ph) / 2}
        width={pw} height={ph} rx={1}
        fill="none" stroke="currentColor" strokeWidth={1.2}
      />
    </svg>
  )
}
