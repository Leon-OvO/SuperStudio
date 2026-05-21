import { useRef } from 'react'
import { useUIStore } from '../../stores/ui'

/**
 * 4px vertical drag handle between the Vibe sidebar (requests / files) and the
 * editor area. Drag right to grow, left to shrink. Width clamped to [180, 560].
 */
export function SidebarResizer() {
  const setWidth = useUIStore(u => u.setVibeSidebarWidth)
  const width = useUIStore(u => u.vibeSidebarWidth)
  const startXRef = useRef(0)
  const startWRef = useRef(0)

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    startXRef.current = e.clientX
    startWRef.current = width

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startXRef.current
      setWidth(startWRef.current + delta)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/50 transition-colors"
      title="拖动调整侧栏宽度"
    />
  )
}
