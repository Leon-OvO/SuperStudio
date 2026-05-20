import { useEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '../../../lib/utils'
import type { VibeMessageInfo } from '../../../../../shared/ipc-types'

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>
  messages: VibeMessageInfo[]
}

interface MarkerInfo {
  id: string
  role: string
  isError: boolean
  topRatio: number
  heightRatio: number
}

// Tailwind classes per role — picked so user / assistant turns are obvious
// at-a-glance even at 56px wide, and tool calls fade into the background.
const ROLE_COLORS: Record<string, string> = {
  user: 'bg-blue-500/70',
  assistant: 'bg-primary/70',
  tool: 'bg-slate-400/45',
  system: 'bg-amber-400/50'
}

/**
 * VS Code–style messages minimap. Renders a fixed-width strip on the right
 * side of the messages scroll container with:
 *   - Color-coded markers for every message (by role)
 *   - A draggable viewport rectangle showing what's currently on screen
 *
 * Click anywhere to jump; click-and-drag to scrub. Hides itself when the
 * content doesn't overflow (nothing to scroll = nothing to navigate).
 */
export function MessagesMinimap({ scrollRef, messages }: Props) {
  const [markers, setMarkers] = useState<MarkerInfo[]>([])
  const [viewport, setViewport] = useState({ topRatio: 0, heightRatio: 1 })
  const [needed, setNeeded] = useState(false)
  const minimapRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Re-measure markers and viewport whenever messages list changes or
  // any message bubble resizes (markdown can reflow asynchronously).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const measure = () => {
      const scrollHeight = el.scrollHeight
      const clientHeight = el.clientHeight
      if (scrollHeight === 0) {
        setMarkers([])
        setNeeded(false)
        return
      }
      setNeeded(scrollHeight > clientHeight + 1)
      const items = el.querySelectorAll<HTMLElement>('[data-msg-id]')
      const next: MarkerInfo[] = []
      items.forEach(item => {
        next.push({
          id: item.getAttribute('data-msg-id') || '',
          role: item.getAttribute('data-msg-role') || 'system',
          isError: item.getAttribute('data-msg-error') === '1',
          topRatio: item.offsetTop / scrollHeight,
          heightRatio: item.offsetHeight / scrollHeight
        })
      })
      setMarkers(next)
      setViewport({
        topRatio: el.scrollTop / scrollHeight,
        heightRatio: Math.min(clientHeight / scrollHeight, 1)
      })
    }

    measure()

    // Observe container AND each message — markdown / streaming text changes
    // height after mount, so we can't just measure once.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    el.querySelectorAll<HTMLElement>('[data-msg-id]').forEach(c => ro.observe(c))

    const onScroll = () => {
      const sh = el.scrollHeight
      const ch = el.clientHeight
      if (sh === 0) return
      setViewport({
        topRatio: el.scrollTop / sh,
        heightRatio: Math.min(ch / sh, 1)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef, messages.length, messages.map(m => m.content.length).join('|')])

  function scrollFromClient(clientY: number) {
    const el = scrollRef.current
    const mm = minimapRef.current
    if (!el || !mm) return
    const rect = mm.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    const targetTop = ratio * el.scrollHeight - el.clientHeight / 2
    el.scrollTop = Math.max(0, Math.min(targetTop, el.scrollHeight - el.clientHeight))
  }

  const onMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = true
    scrollFromClient(e.clientY)

    const onMove = (ev: MouseEvent) => {
      if (draggingRef.current) scrollFromClient(ev.clientY)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!needed || messages.length === 0) return null

  return (
    <div
      ref={minimapRef}
      onMouseDown={onMouseDown}
      className="relative w-[56px] shrink-0 border-l border-border/40 bg-card/40 cursor-pointer select-none hover:bg-card/60 transition-colors group"
      title="点击或拖动浏览对话"
    >
      {/* Message markers — color-coded by role, sized by content length */}
      {markers.map(m => {
        const color = m.isError
          ? 'bg-destructive/70'
          : (ROLE_COLORS[m.role] || 'bg-muted-foreground/40')
        return (
          <div
            key={m.id}
            className={cn('absolute left-1.5 right-1.5 rounded-sm', color)}
            style={{
              top: `${m.topRatio * 100}%`,
              height: `max(2px, ${m.heightRatio * 100}%)`,
              minHeight: '2px'
            }}
          />
        )
      })}
      {/* Viewport indicator — draggable handle */}
      <div
        className="absolute left-0 right-0 border-y border-primary/60 bg-primary/15 group-hover:bg-primary/25 transition-colors pointer-events-none"
        style={{
          top: `${viewport.topRatio * 100}%`,
          height: `${Math.max(viewport.heightRatio * 100, 4)}%`
        }}
      />
    </div>
  )
}
