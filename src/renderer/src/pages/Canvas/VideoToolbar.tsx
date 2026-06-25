import { Captions, Scissors, AudioLines, Sparkles, Maximize } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCanvasBridge } from './CanvasBridge'

/**
 * Top-center video toolbar (reference parity). HONEST: 去除字幕 / 剪辑 / 高清增强 /
 * 音频处理 have NO backend yet — they render as disabled「敬请期待」chips, not faked.
 * Only 适应视图 is wired (to the canvas fitView). Hidden while the multi-select
 * batch bar (a top-center ReactFlow Panel) is up, to avoid overlap.
 */
export function VideoToolbar() {
  const bridge = useCanvasBridge()
  if (bridge.selectedIds.length >= 2) return null
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-card/90 backdrop-blur border border-border shadow-sm">
      <SoonBtn icon={<Captions size={15} />} label="去除字幕" />
      <SoonBtn icon={<Scissors size={15} />} label="剪辑" />
      <SoonBtn icon={<span className="text-[10px] font-bold tracking-tight">HD</span>} label="高清增强" />
      <SoonBtn icon={<AudioLines size={15} />} label="音频处理" />
      <SoonBtn icon={<Sparkles size={15} />} label="视频增强" />
      <div className="w-px h-5 bg-border mx-0.5" />
      <button onClick={bridge.fitView} title="适应视图"
        className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors">
        <Maximize size={15} />
      </button>
    </div>
  )
}

/** A toolbar slot whose backend isn't built yet — visible but inert, labelled 敬请期待. */
function SoonBtn({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      disabled
      title={`${label}（敬请期待）`}
      className={cn('relative flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground/40 cursor-not-allowed')}
    >
      {icon}
      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
    </button>
  )
}
