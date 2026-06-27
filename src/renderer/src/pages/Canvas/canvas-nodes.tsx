import { createContext, useContext, useState, useRef } from 'react'
import { Handle, Position, NodeToolbar, NodeResizer, type NodeProps } from '@xyflow/react'
import { Loader2, Trash2, Maximize2, Download, ArrowUp, ImageOff, Sparkles, Play, Plus, FolderOpen, Layers, X, Wand2, ChevronDown, Pencil, RotateCw, Users } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toLocalFileUrl } from '../../lib/attachments'
import { dept } from '../../lib/departments'
import type { EmployeeInfo } from '../../../../shared/ipc-types'
import { useCanvasBridge } from './CanvasBridge'
import { useCanvasMentionPicker } from './canvas-mention'
import { RichComposer, type RichComposerHandle, type RichSegment } from '../Chat/RichComposer'
import { toast } from '../../components/ui/Toast'

/** Free-canvas image card. `status:'generating'` is a placeholder that fills in
 *  when its generation resolves; otherwise it shows the image at `path`. */
export interface ImageCardData {
  // Index signature so it satisfies React Flow's Node['data'] (Record<string, unknown>).
  [key: string]: unknown
  /** 'video' cards render a <video> at `path`; default/'image' render an <img>. */
  kind?: 'image' | 'video'
  path?: string
  status?: 'generating' | 'done' | 'error'
  /** The prompt that produced this card (shown as a caption). */
  prompt?: string
  /** The prompt draft typed into this node's bar — recorded on the canvas and kept
   *  across deselect (so 扩写 results aren't lost when clicking away). */
  draftPrompt?: string
  /** Generation inputs stored so 重新生成 can replay exactly. */
  genRefs?: string[]
  genSize?: string
  genQuality?: string
}

/** A reference stack — several images piled together that act as ONE prompt's
 *  joint reference set (e.g. a model photo + a clothing photo → e-commerce shots). */
export interface RefStackData {
  [key: string]: unknown
  refs?: string[]
  draftPrompt?: string
}

/** Page-level handlers the cards call (generate / delete / save / zoom). Passed via
 *  context so custom nodes can reach them without serialising callbacks into data. */
export interface CanvasHandlers {
  onGenerate: (sourceNodeId: string, prompt: string, count: number, size: string, quality: string, scene: string, extraRefs?: string[]) => void
  onDelete: (nodeId: string) => void
  onDownload: (path: string) => void
  onLightbox: (path: string) => void
  /** Re-run the generation that produced this card (same prompt/refs/params), in place. */
  onRegenerate: (nodeId: string) => void
  /** Prompt draft is page-owned (recorded + survives deselect); 扩写 also runs page-side. */
  onDraftChange: (nodeId: string, text: string) => void
  onExpand: (nodeId: string) => void
  expanding: Set<string>
  /** Reference-stack actions. */
  onGenerateFromStack: (stackId: string, prompt: string, count: number, size: string, quality: string, scene: string, extraRefs?: string[]) => void
  onStackAddLocal: (stackId: string) => void
  onStackAddGallery: (stackId: string) => void
  onStackRemoveRef: (stackId: string, index: number) => void
  onStackUngroup: (stackId: string) => void
  /** Pull one image out of a stack onto the canvas as an editable card. */
  onStackExtract: (stackId: string, index: number) => void
  /** Source node ids whose generation is in flight (disables their生成 button). */
  busy: Set<string>
  /** Default image model name, shown as a chip in the prompt bar (cosmetic). */
  imageModelName?: string
}
export const CanvasContext = createContext<CanvasHandlers | null>(null)

const COUNTS = [1, 2, 4, 6, 9]

/** Inline 张数 dropdown. Absolute (not fixed) popover so it stays anchored under
 *  NodeToolbar's CSS transform; closes via focus-within onBlur (no flaky timers),
 *  options are real <button>s clicked with onClick so selection always registers. */
function CountDropdown({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0"
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false) }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="生成张数"
        className="flex items-center gap-0.5 text-[11px] rounded-full border border-border bg-background pl-2.5 pr-1.5 py-1 hover:bg-accent/40">
        {value} 张 <ChevronDown size={11} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-[60] w-24 rounded-lg border border-border bg-popover shadow-xl py-1">
          {COUNTS.map(c => (
            <button type="button" key={c} onClick={() => { onChange(c); setOpen(false) }}
              className={cn('w-full text-left px-3 py-1.5 text-[12px] hover:bg-accent/50 flex items-center justify-between',
                c === value ? 'text-primary font-medium' : 'text-foreground')}>
              {c} 张 {c === value && <span className="text-primary">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Size / aspect-ratio presets (value = WxH pixels = both resolution and ratio).
 *  Mirrors the app's canonical set (components/ui/ImageEditor RATIO_PRESETS). */
const SIZES: Array<{ label: string; value: string }> = [
  { label: '1:1', value: '1024x1024' },
  { label: '4:3', value: '1024x768' },
  { label: '3:4', value: '768x1024' },
  { label: '3:2', value: '1536x1024' },
  { label: '2:3', value: '1024x1536' },
  { label: '16:9', value: '1792x1008' },
  { label: '9:16', value: '1008x1792' },
]

/** Inline 尺寸/比例 dropdown — same robust pattern as CountDropdown. */
function SizeDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = SIZES.find(s => s.value === value) || SIZES[0]
  return (
    <div className="relative shrink-0"
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false) }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="尺寸 / 比例"
        className="flex items-center gap-0.5 text-[11px] rounded-full border border-border bg-background pl-2.5 pr-1.5 py-1 hover:bg-accent/40">
        {cur.label} <ChevronDown size={11} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-[60] w-36 rounded-lg border border-border bg-popover shadow-xl py-1 max-h-56 overflow-auto">
          {SIZES.map(s => (
            <button type="button" key={s.value} onClick={() => { onChange(s.value); setOpen(false) }}
              className={cn('w-full text-left px-3 py-1.5 text-[12px] hover:bg-accent/50 flex items-center justify-between gap-2',
                s.value === value ? 'text-primary font-medium' : 'text-foreground')}>
              <span>{s.label}</span><span className="text-[10px] text-muted-foreground">{s.value.replace('x', '×')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Image quality (画质) — same standard/hd toggle as chat image generation. */
const QUALITIES: Array<{ label: string; value: string }> = [
  { label: '标准', value: 'standard' },
  { label: '高清', value: 'hd' },
]

/** Inline 画质 dropdown — same robust pattern as CountDropdown. */
function QualityDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = QUALITIES.find(q => q.value === value) || QUALITIES[0]
  return (
    <div className="relative shrink-0"
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false) }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="画质（标准 / 高清）"
        className="flex items-center gap-0.5 text-[11px] rounded-full border border-border bg-background pl-2.5 pr-1.5 py-1 hover:bg-accent/40">
        {cur.label} <ChevronDown size={11} className={cn('text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-[60] w-24 rounded-lg border border-border bg-popover shadow-xl py-1">
          {QUALITIES.map(q => (
            <button type="button" key={q.value} onClick={() => { onChange(q.value); setOpen(false) }}
              className={cn('w-full text-left px-3 py-1.5 text-[12px] hover:bg-accent/50 flex items-center justify-between',
                q.value === value ? 'text-primary font-medium' : 'text-foreground')}>
              {q.label} {q.value === value && <span className="text-primary">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 生图场景预设：把用户描述套进工程化的提示词模板（风格 + 画质 + 构图关键词），
 *  显著提高出图质量与稳定性。`{p}` 是用户描述的占位符。 */
export interface ScenePreset { id: string; label: string; hint: string; template: string }
/** 公共写实质感尾缀：抑制塑料感/过度磨皮/AI 感，追求照片级真实材质与光影。 */
const REALISM = '真实自然的材质质感与光影，照片级真实，避免塑料感、过度磨皮、蜡像感与廉价 AI 感。'
/** 人物面部/身份保持指令——基于参考图换装/换景时尽量锁住长相。 */
const KEEP_FACE = '严格保持参考图中人物的面部特征、五官比例、脸型、肤色与发型完全一致，不改变人物身份与长相；保留真实皮肤纹理与毛孔细节。'

export const SCENES: ScenePreset[] = [
  { id: 'none', label: '通用', hint: '不加修饰，完全按你的描述生成', template: '{p}' },
  { id: 'ecom_white', label: '电商白底主图', hint: '纯白背景 · 居中产品主图', template: `电商产品主图：{p}。纯白色背景，专业棚拍布光，柔和均匀光线，主体居中且占画面主要位置，边缘干净无瑕，材质纹理与反光真实，细节清晰锐利，4K 高分辨率，专业商业产品摄影。${REALISM}` },
  { id: 'model', label: '模特实穿', hint: '保人脸 · 模特自然上身', template: `时尚电商模特实拍：让模特自然穿着展示「{p}」，真实上身效果，自然光线，服装版型与材质真实，时尚杂志写实质感，构图完整，高清。${KEEP_FACE}${REALISM}` },
  { id: 'lifestyle', label: '生活场景', hint: '真实生活方式场景', template: `生活方式场景图：{p}，置于真实自然的生活场景中，自然环境光与真实光影，背景适度虚化，氛围高级；如含人物则保持其面部与身份一致。${REALISM}` },
  { id: 'studio', label: '高级棚拍', hint: '杂志大片 · 保人脸', template: `高级棚拍大片：{p}，专业影棚布光，富有层次的质感打光，干净纯色背景，时尚杂志封面风格，超清细节；如含人物则保持其面部五官与身份一致、皮肤质感真实自然。${REALISM}` },
  { id: 'poster', label: '创意海报', hint: '广告海报 · 留白构图', template: `创意广告海报：{p}，富有视觉冲击力的构图，预留文案留白区域，鲜明而高级的配色，专业平面视觉设计，4K 高清。${REALISM}` },
  { id: 'portrait', label: '写实人像', hint: '保人脸 · 真实肤质', template: `写实人像摄影：{p}，自然柔和光线，五官清晰自然，浅景深背景虚化，85mm 人像镜头质感，高清。${KEEP_FACE}${REALISM}` },
  { id: 'closeup', label: '产品特写', hint: '微距 · 材质细节', template: `产品微距特写：{p}，微距镜头，材质纹理与表面细节清晰真实，柔和自然反光，干净背景，超清细节，专业商业产品摄影。${REALISM}` },
]
export function applyScene(sceneId: string, prompt: string): string {
  const s = SCENES.find(x => x.id === sceneId)
  if (!s || s.id === 'none') return prompt
  // Function replacer so a user prompt containing $&, $1, etc. isn't reinterpreted.
  return s.template.replace('{p}', () => prompt)
}

/** Inline 场景 dropdown — picks a quality preset; tinted when an active scene is on. */
function SceneDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = SCENES.find(s => s.id === value) || SCENES[0]
  const active = cur.id !== 'none'
  return (
    <div className="relative shrink-0"
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false) }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="生图场景预设（提高质量与稳定性）"
        className={cn('flex items-center gap-1 text-[11px] rounded-full border pl-2 pr-1.5 py-1 max-w-[116px]',
          active ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-accent/40')}>
        <Sparkles size={11} className={cn('shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
        <span className="truncate">{cur.label}</span>
        <ChevronDown size={11} className={cn('shrink-0 transition-transform', open && 'rotate-180', active ? 'text-primary' : 'text-muted-foreground')} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 z-[60] w-56 rounded-lg border border-border bg-popover shadow-xl py-1 max-h-72 overflow-auto">
          {SCENES.map(s => (
            <button type="button" key={s.id} onClick={() => { onChange(s.id); setOpen(false) }}
              className={cn('w-full text-left px-3 py-1.5 hover:bg-accent/50', s.id === value && 'bg-accent/40')}>
              <div className={cn('text-[12.5px] flex items-center gap-1.5', s.id === value ? 'text-primary font-medium' : 'text-foreground')}>
                {s.id !== 'none' && <Sparkles size={11} className="text-primary/70 shrink-0" />}{s.label}
              </div>
              <div className="text-[10.5px] text-muted-foreground leading-tight mt-0.5">{s.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Parse a persisted draft (JSON rich segments, or a legacy plain-text string). */
function parseDraftSegments(v?: string): RichSegment[] | undefined {
  if (!v) return undefined
  try { const p = JSON.parse(v); if (Array.isArray(p)) return p as RichSegment[] } catch { /* legacy plain text */ }
  return [{ t: 'text', s: v }]
}

type ChipSeg = Extract<RichSegment, { t: 'chip' }>

/** Replace chips with positional 【图N】 placeholders so 扩写 keeps them in place. */
function tokenizeSegments(segs: RichSegment[]): { text: string; refByToken: Map<number, ChipSeg['ref']> } {
  const refByToken = new Map<number, ChipSeg['ref']>()
  let i = 0
  const text = segs.map(s => s.t === 'text' ? s.s : (refByToken.set(++i, s.ref), `【图${i}】`)).join('')
  return { text, refByToken }
}

/** Rebuild segments from refined text, restoring 【图N】 placeholders to chips IN
 *  PLACE; any chip the model dropped is re-appended so no reference is lost. */
function detokenizeText(text: string, refByToken: Map<number, ChipSeg['ref']>): RichSegment[] {
  const out: RichSegment[] = []
  const used = new Set<ChipSeg['ref']>()
  const re = /【图(\d+)】/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) })
    const ref = refByToken.get(Number(m[1]))
    if (ref) { out.push({ t: 'chip', ref }); used.add(ref) }
    last = re.lastIndex
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) })
  for (const ref of refByToken.values()) if (!used.has(ref)) out.push({ t: 'chip', ref })
  return out.length ? out : [{ t: 'text', s: text }]
}

/** Compact「专家」picker in the prompt bar — pick hired employees (摄影师 / 美工 /
 *  调色…) whose expertise enhances the 扩写. Selection is canvas-level (in the bridge),
 *  so all prompt bars share one team. */
function ExpertPicker({ employees, selectedIds, onToggle }: {
  employees: EmployeeInfo[]
  selectedIds: string[]
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const n = selectedIds.length
  return (
    <div className="relative shrink-0"
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false) }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="选员工专家加持扩写（摄影 / 美工 / 调色…）"
        className={cn('flex items-center gap-1 text-[11px] rounded-full border pl-2 pr-1.5 py-1',
          n > 0 ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:bg-accent/40')}>
        <Users size={11} className={n > 0 ? 'text-primary' : 'text-muted-foreground'} />
        {n > 0 ? `专家 ${n}` : '专家'}
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 z-[60] w-60 max-h-72 overflow-auto rounded-lg border border-border bg-popover shadow-xl py-1">
          <div className="px-3 py-1 text-[10px] text-muted-foreground/60">让员工从专业角度加持「扩写」</div>
          {employees.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground/70 leading-relaxed">还没有员工。去「公司 · 人才市场」雇摄影师 / 美工等图像专家。</div>
          ) : employees.map(e => {
            const on = selectedIds.includes(e.id)
            const d = dept(e.dept)
            return (
              <button type="button" key={e.id} onClick={() => onToggle(e.id)}
                className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/50', on && 'bg-accent/30')}>
                <span className="w-5 h-5 rounded-full grid place-items-center shrink-0 text-[11px]" style={{ background: `${d.color}22` }}>{d.emoji}</span>
                <span className="flex-1 min-w-0"><span className="truncate block">{e.name}</span><span className="text-[9.5px] block" style={{ color: d.color }}>{d.label}</span></span>
                {on && <span className="text-primary text-xs shrink-0">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Shared floating prompt bar (image card + reference stack + central composer).
 *  Built on the chat RichComposer so @-introduced references render as INLINE chips
 *  that flow with the typed text (same as 对话). Uncontrolled — the DOM owns content;
 *  read on submit via serialize(). 扩写 rewrites the text (drops chips). Count/size/
 *  quality/scene stay local. onSubmit gets the prompt text + the inline ref paths. */
export function GenPromptBar({ busy, placeholder, value, onChange, onSubmit }: {
  busy: boolean
  placeholder: string
  /** Persisted draft text — seeds the editor on (re)mount so the prompt survives the
   *  bar being torn down on generate. onChange persists it back (e.g. to node data). */
  value?: string
  onChange?: (text: string) => void
  /** refs = paths of @-introduced inline reference images (canvas / stack / 素材库 / local). */
  onSubmit: (prompt: string, count: number, size: string, quality: string, scene: string, refs: string[]) => void
}) {
  const [count, setCount] = useState(1)
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState('standard')
  const [scene, setScene] = useState('none')
  const [expanding, setExpanding] = useState(false)
  const [empty, setEmpty] = useState(true)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const bridge = useCanvasBridge()
  const composerRef = useRef<RichComposerHandle>(null)

  // @ picker — surfaces reference images; picking inserts inline chips.
  const picker = useCanvasMentionPicker({
    query: mentionQuery,
    nodes: bridge.nodes,
    onInsert: (refs) => refs.forEach(r => composerRef.current?.insertRef(r)),
  })

  const submit = () => {
    const s = composerRef.current?.serialize()
    const prompt = (s?.text ?? '').trim()
    if (!prompt || busy) return
    const refs = (s?.inlineAttachments ?? []).map(a => a.path)
    onSubmit(prompt, count, size, quality, scene, refs)
    // Keep the prompt + @ refs after generating so the user can tweak / regenerate.
  }

  const expand = async () => {
    const segs = composerRef.current?.serializeSegments() ?? []
    const s = composerRef.current?.serialize()
    if (!(s?.text ?? '').trim() || expanding) return
    const refs = (s?.inlineAttachments ?? []).map(a => a.path)
    // Tokenize chips → 【图N】 so the model keeps them IN PLACE while expanding.
    const hasChips = segs.some(g => g.t === 'chip')
    const { text: tokenText, refByToken } = tokenizeSegments(segs)
    const goal = hasChips
      ? `${tokenText}\n\n（注意：文中的【图1】【图2】等是图片占位符，扩写时请把它们保留在语义合适的位置、原样不动，不要删除或改写。）`
      : tokenText
    setExpanding(true)
    try {
      let refined = ''
      if (bridge.expertIds.length) {
        // 专家扩写：选中的员工(摄影师/美工/调色…)各从专业角度加持，汇总成更专业的提示词。
        const r = await window.api.canvasExpertAdvise({ goal, referenceImagePaths: refs.length ? refs : undefined, expertIds: bridge.expertIds })
        if (r.ok && r.refinedPrompt) { refined = r.refinedPrompt; if (r.advices?.length) toast.success(`${r.advices.map(a => a.name).join('、')} 已加持提示词`) }
        else { toast.error(r.error || '专家扩写失败'); return }
      } else {
        const r = await window.api.canvasExpandPrompt({ prompt: goal, referenceImagePaths: refs.length ? refs : undefined }) as { ok?: boolean; text?: string; error?: string }
        if (r?.ok && r.text) refined = r.text
        else { toast.error(r?.error || '扩写失败'); return }
      }
      // Restore chips IN PLACE from the 【图N】 placeholders, then persist (setSegments
      // is imperative — it doesn't fire onInput — so the expanded draft would otherwise
      // be lost on the next generate/remount).
      const newSegs = hasChips ? detokenizeText(refined, refByToken) : [{ t: 'text' as const, s: refined.trim() }]
      composerRef.current?.setSegments(newSegs)
      onChange?.(JSON.stringify(composerRef.current?.serializeSegments() ?? []))
    } catch (e) { toast.error((e as Error).message) } finally { setExpanding(false) }
  }

  return (
    <div className="nowheel nopan nodrag relative w-[472px] rounded-[20px] bg-card/95 backdrop-blur-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.12)] px-0 pt-1 pb-2.5" onPointerDown={e => e.stopPropagation()}>
      {picker.menu}
      <RichComposer
        ref={composerRef}
        initialSegments={parseDraftSegments(value)}
        placeholder={placeholder}
        disabled={busy}
        onMention={setMentionQuery}
        onEnter={submit}
        onEmptyChange={setEmpty}
        onInput={() => onChange?.(JSON.stringify(composerRef.current?.serializeSegments() ?? []))}
        onPasteFiles={() => { /* canvas composer ignores pasted files for now */ }}
        onMentionKeyDown={(e) => {
          // Esc closes the @ menu; stop it bubbling so it doesn't also collapse the
          // central composer / deselect the node.
          if (e.key === 'Escape' && mentionQuery !== null) { e.stopPropagation(); setMentionQuery(null); return true }
          return picker.handleKeyDown(e)
        }}
      />
      <div className="flex items-center gap-1.5 mt-1 px-4">
        <SceneDropdown value={scene} onChange={setScene} />
        <CountDropdown value={count} onChange={setCount} />
        <SizeDropdown value={size} onChange={setSize} />
        <QualityDropdown value={quality} onChange={setQuality} />
        <ExpertPicker
          employees={bridge.employees}
          selectedIds={bridge.expertIds}
          onToggle={(id) => bridge.setExpertIds(bridge.expertIds.includes(id) ? bridge.expertIds.filter(x => x !== id) : [...bridge.expertIds, id])}
        />
        <button onClick={expand} disabled={empty || expanding}
          title={bridge.expertIds.length ? '专家扩写：选中的员工各从专业角度加持提示词' : '提示词扩写（AI 补充画面细节）'}
          className={cn('flex items-center gap-1 text-[11px] rounded-full border px-2 py-1 hover:bg-accent/40 hover:text-foreground disabled:opacity-40 shrink-0',
            bridge.expertIds.length ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
          {expanding ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} {bridge.expertIds.length ? '专家扩写' : '扩写'}
        </button>
        <div className="flex-1" />
        <button onClick={submit} disabled={empty || busy} title="生成（Enter）"
          className="w-9 h-9 shrink-0 rounded-full grid place-items-center bg-primary text-primary-foreground shadow-sm hover:opacity-90 active:scale-95 transition-all disabled:opacity-35 disabled:cursor-not-allowed">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  )
}

function ImageCardNode({ id, data, selected }: NodeProps) {
  const d = data as ImageCardData
  const ctx = useContext(CanvasContext)
  const [failed, setFailed] = useState(false)
  const generating = d.status === 'generating'
  const busy = ctx?.busy.has(id) ?? false
  const isVideo = d.kind === 'video'

  return (
    <>
      {/* Resize handles (corner drag) — only on the selected card. */}
      <NodeResizer isVisible={!!selected && !generating} minWidth={120} minHeight={120} keepAspectRatio
        lineClassName="!border-primary/40" handleClassName="!w-2.5 !h-2.5 !bg-primary !border-2 !border-white !rounded-sm" />

      {/* Floating action toolbar above the card. */}
      <NodeToolbar isVisible={!!selected && !generating} position={Position.Top} offset={8}>
        <div className="flex items-center gap-0.5 px-1 py-1 rounded-xl bg-popover border border-border shadow-lg text-xs">
          <ToolBtn icon={isVideo ? <Play size={13} /> : <Maximize2 size={13} />} label={isVideo ? '播放' : '查看大图'} onClick={() => d.path && ctx?.onLightbox(d.path)} />
          {!isVideo && Array.isArray(d.genRefs) && d.genRefs.length > 0 && d.path && (
            <ToolBtn icon={<RotateCw size={13} />} label="重新生成" onClick={() => ctx?.onRegenerate(id)} />
          )}
          <ToolBtn icon={<Download size={13} />} label="下载" onClick={() => d.path && ctx?.onDownload(d.path)} />
          <ToolBtn icon={<Trash2 size={13} />} label="删除" danger onClick={() => ctx?.onDelete(id)} />
        </div>
      </NodeToolbar>

      {/* Floating prompt bar below the card — type → fan out N images. Image cards only. */}
      <NodeToolbar isVisible={!!selected && !generating && !!d.path && !isVideo} position={Position.Bottom} offset={12}>
        <GenPromptBar busy={busy} placeholder="请输入你想要把这张图改成什么…（「@」引入参考图）"
          value={typeof d.draftPrompt === 'string' ? d.draftPrompt : ''}
          onChange={t => ctx?.onDraftChange(id, t)}
          onSubmit={(p, c, s, q, sc, refs) => ctx?.onGenerate(id, p, c, s, q, sc, refs)} />
      </NodeToolbar>

      {/* The card body. Double-click opens the lightbox (查看大图). */}
      <div
        onDoubleClick={() => { if (d.path && !generating && d.status !== 'error') ctx?.onLightbox(d.path) }}
        title={d.path && !generating ? '双击查看大图' : undefined}
        className={cn(
          'relative w-full h-full rounded-2xl overflow-hidden border bg-card shadow-sm transition-shadow',
          d.path && !generating && 'cursor-zoom-in',
          selected ? 'border-primary ring-2 ring-primary/30' : 'border-border/60 hover:shadow-md'
        )}>
        {generating ? (
          <div className="w-full h-full grid place-items-center bg-gradient-to-b from-muted/30 to-muted/50 gap-2">
            <div className="w-7 h-7 rounded-full border-[2.5px] border-muted-foreground/15 border-t-primary animate-spin" />
            <span className="text-[11px] text-muted-foreground/80 tracking-wide">{isVideo ? '生成视频中…' : '生成中'}</span>
          </div>
        ) : d.status === 'error' ? (
          <div className="w-full h-full grid place-items-center bg-muted/40 text-muted-foreground gap-1">
            <ImageOff size={20} /><span className="text-[10px]">生成失败</span>
          </div>
        ) : isVideo && d.path ? (
          <video src={toLocalFileUrl(d.path)} muted loop playsInline className="w-full h-full object-cover"
            onMouseEnter={e => { e.currentTarget.play().catch(() => { /* ignore autoplay block */ }) }}
            onMouseLeave={e => { e.currentTarget.pause() }} />
        ) : d.path && !failed ? (
          <img src={toLocalFileUrl(d.path)} alt="" onError={() => setFailed(true)} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full grid place-items-center bg-muted/40 text-muted-foreground"><ImageOff size={20} /></div>
        )}

        {/* Video badge so a still-frame video card reads as playable. */}
        {isVideo && d.path && !generating && d.status !== 'error' && (
          <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/55 text-white text-[10px] pointer-events-none">
            <Play size={10} className="fill-current" /> 视频
          </div>
        )}

        {/* Prompt caption — shows what this card was generated from. */}
        {!generating && d.status !== 'error' && d.path && typeof d.prompt === 'string' && d.prompt.trim() && (
          <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/55 to-transparent pointer-events-none">
            <p className="text-[10px] leading-tight text-white/90 line-clamp-2" title={d.prompt}>{d.prompt}</p>
          </div>
        )}
      </div>

      {/* Subtle connection dots (left in / right out) like the reference. */}
      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-background !border-2 !border-primary/50" />
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-background !border-2 !border-primary/50" />
    </>
  )
}

/** A pile of reference images that generate together as one prompt's reference set.
 *  Drag an image onto it (or onto another image) to stack; the prompt bar below
 *  generates using ALL images in the pile as joint references. */
function ReferenceStackNode({ id, data, selected }: NodeProps) {
  const d = data as RefStackData
  const ctx = useContext(CanvasContext)
  const refs = Array.isArray(d.refs) ? d.refs : []
  const busy = ctx?.busy.has(id) ?? false
  const shown = refs.slice(0, 5)

  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={160} minHeight={140}
        lineClassName="!border-primary/40" handleClassName="!w-2.5 !h-2.5 !bg-primary !border-2 !border-white !rounded-sm" />

      {/* Top toolbar: add / ungroup / delete. */}
      <NodeToolbar isVisible={!!selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-0.5 px-1 py-1 rounded-xl bg-popover border border-border shadow-lg text-xs">
          <ToolBtn icon={<Plus size={13} />} label="添加图片" onClick={() => ctx?.onStackAddLocal(id)} />
          <ToolBtn icon={<FolderOpen size={13} />} label="素材库" onClick={() => ctx?.onStackAddGallery(id)} />
          {refs.length >= 1 && <ToolBtn icon={<Layers size={13} />} label="拆分" onClick={() => ctx?.onStackUngroup(id)} />}
          <ToolBtn icon={<Trash2 size={13} />} label="删除" danger onClick={() => ctx?.onDelete(id)} />
        </div>
      </NodeToolbar>

      {/* Joint-reference prompt bar. */}
      <NodeToolbar isVisible={!!selected && refs.length >= 1} position={Position.Bottom} offset={12}>
        <GenPromptBar busy={busy}
          placeholder={`描述要生成的画面（这 ${refs.length} 张一起作为参考，「@」可再加）…`}
          value={typeof d.draftPrompt === 'string' ? d.draftPrompt : ''}
          onChange={t => ctx?.onDraftChange(id, t)}
          onSubmit={(p, c, s, q, sc, refs) => ctx?.onGenerateFromStack(id, p, c, s, q, sc, refs)} />
      </NodeToolbar>

      {/* Body: a fanned pile when idle; a non-overlapping管理网格 when selected. */}
      <div className="relative w-full h-full">
        {/* Rounded card surface (clipped): bg + badge + the selected管理网格. */}
        <div className={cn('absolute inset-0 rounded-2xl border bg-card shadow-sm overflow-hidden',
          selected ? 'border-primary ring-2 ring-primary/30' : 'border-border/60 hover:shadow-md')}>
          {refs.length > 0 && <div className="absolute inset-0 bg-muted/20" />}
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/55 text-white text-[10px] pointer-events-none">
            <Layers size={10} /> 参考组 · {refs.length}
          </div>
          {refs.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-3 text-muted-foreground">
              <Layers size={20} className="opacity-50" />
              <span className="text-[11px]">添加参考图</span>
              <div className="flex items-center gap-2">
                <button onPointerDown={e => e.stopPropagation()} onClick={() => ctx?.onStackAddLocal(id)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border bg-card hover:bg-accent hover:text-foreground text-[11px] transition-colors">
                  <Plus size={13} /> 本地
                </button>
                <button onPointerDown={e => e.stopPropagation()} onClick={() => ctx?.onStackAddGallery(id)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border bg-card hover:bg-accent hover:text-foreground text-[11px] transition-colors">
                  <FolderOpen size={13} /> 素材库
                </button>
              </div>
              <span className="text-[10px] text-muted-foreground/60">也可把画布上的图拖进来</span>
            </div>
          ) : selected ? (
            // Manageable grid — non-overlapping so every action is reachable, indexed by真实下标.
            // 单击缩略图查看大图；hover 出现「提取为可编辑卡片」与「移除」。
            <div className="nowheel absolute inset-0 pt-8 px-2.5 pb-2.5 overflow-auto" onPointerDown={e => e.stopPropagation()}>
              <div className="flex flex-wrap gap-2.5 content-start justify-center">
                {refs.map((p, i) => (
                  <div key={p + i} className="relative group/thumb">
                    <img src={toLocalFileUrl(p)} alt="" draggable={false}
                      onClick={() => ctx?.onLightbox(p)} title="点击查看大图"
                      className="w-32 h-32 object-cover rounded-lg border border-border cursor-zoom-in hover:ring-2 hover:ring-primary/40 transition-shadow" />
                    <button onClick={() => ctx?.onStackExtract(id, i)}
                      className="absolute -top-1.5 -left-1.5 w-6 h-6 rounded-full bg-black/75 text-white grid place-items-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-primary"
                      title="提取为可编辑卡片">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => ctx?.onStackRemoveRef(id, i)}
                      className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-black/75 text-white grid place-items-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-destructive"
                      title="移除这张">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Idle preview: a fanned pile that may spill past the card edge (not clipped). */}
        {refs.length > 0 && !selected && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            {shown.map((p, i) => {
              const n = shown.length
              const offset = (i - (n - 1) / 2) * 34
              const rot = (i - (n - 1) / 2) * 6
              return (
                <img key={p + i} src={toLocalFileUrl(p)} alt="" draggable={false}
                  className="absolute w-32 h-32 object-cover rounded-xl border-2 border-card shadow-md"
                  style={{ transform: `translateX(${offset}px) rotate(${rot}deg)`, zIndex: i }} />
              )
            })}
            {refs.length > 5 && (
              <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px]">+{refs.length - 5}</div>
            )}
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-background !border-2 !border-primary/50" />
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-background !border-2 !border-primary/50" />
    </>
  )
}

function ToolBtn({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn('flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-accent transition-colors', danger && 'text-destructive hover:bg-destructive/10')}
    >
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  )
}

export const CANVAS_NODE_TYPES = { image_card: ImageCardNode, ref_stack: ReferenceStackNode }
