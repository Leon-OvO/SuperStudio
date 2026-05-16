import { useEffect, useState } from 'react'
import { Minus, Square, X, Maximize2 } from 'lucide-react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const unsub = window.api.onMaximizeChange((v) => setIsMaximized(v))
    return unsub
  }, [])

  // Only render on Windows — macOS uses native hiddenInset traffic lights
  if (window.api.platform !== 'win32') return null

  return (
    <div
      className="flex items-center h-[34px] bg-sidebar border-b border-sidebar-border/60 shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Spacer matching sidebar width */}
      <div className="w-[52px] shrink-0 flex items-center justify-center">
        <div className="w-4 h-4 rounded-md bg-primary flex items-center justify-center shadow-sm">
          <span className="text-primary-foreground font-bold text-[9px] leading-none">S</span>
        </div>
      </div>

      {/* App title */}
      <span className="text-xs text-foreground/70 font-semibold tracking-tight flex-1">
        SuperStudio
      </span>

      {/* Window controls — not draggable */}
      <div
        className="flex items-stretch h-full"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <WinBtn onClick={() => window.api.winMinimize()} label="最小化">
          <Minus size={12} />
        </WinBtn>
        <WinBtn onClick={() => window.api.winMaximize()} label={isMaximized ? '还原' : '最大化'}>
          {isMaximized ? <Maximize2 size={11} /> : <Square size={11} />}
        </WinBtn>
        <WinBtn onClick={() => window.api.winClose()} label="关闭" danger>
          <X size={12} />
        </WinBtn>
      </div>
    </div>
  )
}

function WinBtn({
  onClick,
  label,
  danger,
  children
}: {
  onClick: () => void
  label: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={
        `w-11 flex items-center justify-center text-muted-foreground/60 transition-colors ` +
        (danger
          ? 'hover:bg-red-500 hover:text-white'
          : 'hover:bg-black/10 hover:text-foreground')
      }
    >
      {children}
    </button>
  )
}
