import { useEffect, useRef, useState } from 'react'
import { Copy, Download, FolderOpen, Maximize2, Check, Wand2, ImagePlus } from 'lucide-react'
import { copyImageToClipboard } from '../../lib/clipboard'

interface MenuState {
  x: number
  y: number
  filePath: string
  src: string
  onPreview?: () => void
  onEdit?: () => void
  onUseAsReference?: () => void
}

export interface ImageContextMenuHandle {
  open: (e: React.MouseEvent, opts: { filePath: string; src: string; onPreview?: () => void; onEdit?: () => void; onUseAsReference?: () => void }) => void
}

interface Props {
  /** Optional: hide the "在画廊预览" item (set when the menu is opened inside the preview itself). */
  hidePreview?: boolean
}

/**
 * Reusable right-click menu for images. Wrap with `useImageContextMenu()` for a small API.
 * Renders absolutely-positioned menu via portal-less fixed div (good enough for our z-index needs).
 */
export function useImageContextMenu({ hidePreview }: Props = {}) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape
  useEffect(() => {
    if (!menu) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])

  function open(e: React.MouseEvent, opts: { filePath: string; src: string; onPreview?: () => void; onEdit?: () => void; onUseAsReference?: () => void }) {
    e.preventDefault()
    e.stopPropagation()
    // Clamp to viewport — taller menu now that we have up to 5 items
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 220)
    setMenu({ x, y, ...opts })
  }

  async function handleCopy() {
    if (!menu) return
    const ok = await copyImageToClipboard(menu.src)
    setMenu(null)
    setToast(ok ? '已复制到剪贴板' : '复制失败')
  }

  async function handleSaveAs() {
    if (!menu) return
    setMenu(null)
    try {
      const result = await window.api.saveFileAs(menu.filePath)
      if (!result.canceled) setToast('已保存到 ' + truncatePath(result.filePath || ''))
    } catch (e) {
      setToast('保存失败：' + (e as Error).message)
    }
  }

  async function handleReveal() {
    if (!menu) return
    setMenu(null)
    try {
      await window.api.showItemInFolder(menu.filePath)
    } catch (e) {
      setToast('打开文件夹失败：' + (e as Error).message)
    }
  }

  function handlePreview() {
    menu?.onPreview?.()
    setMenu(null)
  }

  const element = (
    <>
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[180px] bg-popover border border-border rounded-lg shadow-xl py-1 text-sm select-none origin-top-left animate-menu-in"
          style={{ left: menu.x, top: menu.y }}
          onClick={e => e.stopPropagation()}
        >
          {!hidePreview && menu.onPreview && (
            <MenuItem icon={<Maximize2 size={13} />} label="在大图中查看" onClick={handlePreview} />
          )}
          {menu.onUseAsReference && (
            <MenuItem icon={<ImagePlus size={13} />} label="用作参考图（基于此图继续生成）" onClick={() => { menu.onUseAsReference?.(); setMenu(null) }} />
          )}
          {menu.onEdit && (
            <MenuItem icon={<Wand2 size={13} />} label="编辑（局部修改 / 抠图 / 改字 / 扩图）" onClick={() => { menu.onEdit?.(); setMenu(null) }} />
          )}
          <MenuItem icon={<Copy size={13} />} label="复制图片" onClick={handleCopy} />
          <MenuItem icon={<Download size={13} />} label="另存为…" onClick={handleSaveAs} />
          <MenuItem icon={<FolderOpen size={13} />} label="在文件夹中显示" onClick={handleReveal} />
        </div>
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] bg-foreground/90 text-background px-3.5 py-1.5 rounded-lg text-xs shadow-lg flex items-center gap-1.5 pointer-events-none">
          <Check size={12} />
          {toast}
        </div>
      )}
    </>
  )

  return { open, element } satisfies { open: ImageContextMenuHandle['open']; element: React.ReactNode }
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent text-foreground/90 hover:text-foreground transition-colors"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs">{label}</span>
    </button>
  )
}

function truncatePath(p: string, max = 40): string {
  if (p.length <= max) return p
  return '…' + p.slice(p.length - max + 1)
}
