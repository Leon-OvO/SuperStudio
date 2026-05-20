import { useRef } from 'react'
import { useUIStore } from '../../../stores/ui'

/**
 * 4px drag handle between the editor area and the terminal drawer.
 * Dragging up grows the terminal, down shrinks it. Clamped to [120, 600].
 */
export function TerminalResizeHandle() {
  const setTerminalHeight = useUIStore(u => u.setTerminalHeight)
  const terminalHeight = useUIStore(u => u.terminalHeight)
  const startYRef = useRef(0)
  const startHRef = useRef(0)

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    startYRef.current = e.clientY
    startHRef.current = terminalHeight

    function onMove(ev: MouseEvent) {
      const delta = startYRef.current - ev.clientY  // drag up = positive
      setTerminalHeight(startHRef.current + delta)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="h-1 shrink-0 cursor-ns-resize bg-border hover:bg-primary/50 transition-colors"
      title="拖动调整终端高度"
    />
  )
}
