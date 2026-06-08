import { useEffect, useState } from 'react'
import { Minus, Square, X, Maximize2, Sun, Moon, Languages, Zap } from 'lucide-react'
import { TopBarUser } from './TopBarUser'
import { useUIStore } from '../../stores/ui'
import { useT, setLanguage, useLanguage } from '../../lib/i18n'
import { BRAND } from '@shared/brand'
import { ACCOUNT_MODE } from '@shared/flavor'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const isWin = window.api.platform === 'win32'
  const t = useT()
  const lang = useLanguage()
  const { theme, toggleTheme } = useUIStore()

  useEffect(() => {
    if (!isWin) return
    const unsub = window.api.onMaximizeChange((v) => setIsMaximized(v))
    return unsub
  }, [isWin])

  return (
    <div
      className="flex items-center h-[34px] bg-sidebar border-b border-sidebar-border/60 shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Spacer matching sidebar width — on macOS, leave room for traffic lights */}
      {isWin ? (
        <div className="w-[52px] shrink-0 flex items-center justify-center">
          <div className="w-4 h-4 rounded-md bg-primary flex items-center justify-center shadow-sm">
            <Zap size={11} strokeWidth={1.5} fill="currentColor" className="text-white" />
          </div>
        </div>
      ) : (
        <div className="w-[80px] shrink-0" />
      )}

      {/* App title */}
      <span className="text-xs text-foreground/70 font-semibold tracking-tight flex-1">
        {BRAND.productName}
      </span>

      {/* Right cluster: user account + window controls (not draggable) */}
      <div
        className="flex items-center h-full pr-1.5 gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Quick toggles: language + dark mode (moved here from the sidebar) */}
        <TopToggle
          onClick={() => setLanguage(lang === 'zh' ? 'en' : 'zh')}
          title={t('nav.languageSwitch')}
        >
          <Languages size={14} />
          <span className="text-[8px] font-bold leading-none ml-0.5">{lang.toUpperCase()}</span>
        </TopToggle>
        <TopToggle
          onClick={toggleTheme}
          title={theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </TopToggle>
        {ACCOUNT_MODE === 'hosted' && <TopBarUser />}
        {isWin && (
          <div className="flex items-stretch h-full ml-1">
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
        )}
      </div>
    </div>
  )
}

function TopToggle({
  onClick,
  title,
  children
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="h-7 px-1.5 rounded-md flex items-center justify-center text-foreground/70 hover:bg-foreground/10 hover:text-foreground transition-colors"
    >
      {children}
    </button>
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
