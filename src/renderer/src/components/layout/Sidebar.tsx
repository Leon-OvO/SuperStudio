import { MessageSquare, Zap, Image, BookOpen, Settings, Sun, Moon } from 'lucide-react'
import { useUIStore } from '../../stores/ui'
import { cn } from '../../lib/utils'

const navItems = [
  { id: 'chat' as const, icon: MessageSquare, label: '对话' },
  { id: 'workflow' as const, icon: Zap, label: '工作流' },
  { id: 'gallery' as const, icon: Image, label: '画廊' },
  { id: 'knowledge' as const, icon: BookOpen, label: '知识库' },
]

export function Sidebar() {
  const { currentPage, setPage, theme, toggleTheme } = useUIStore()

  return (
    <aside className="w-[52px] flex flex-col items-center py-3 gap-0.5 bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="w-8 h-8 rounded-xl bg-primary flex items-center justify-center mb-3 shadow-md shadow-primary/30">
        <span className="text-primary-foreground font-bold text-sm leading-none">S</span>
      </div>

      <div className="w-full px-2 flex flex-col gap-0.5">
        {navItems.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setPage(id)}
            title={label}
            className={cn(
              'w-full h-9 rounded-lg flex items-center justify-center transition-all relative group',
              currentPage === id
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {currentPage === id && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full -ml-2" />
            )}
            <Icon size={17} strokeWidth={currentPage === id ? 2 : 1.75} />
            {/* Tooltip */}
            <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md bg-foreground/90 text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
              {label}
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="w-full px-2 flex flex-col gap-0.5">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换亮色' : '切换暗色'}
          className="w-full h-9 rounded-lg flex items-center justify-center transition-all relative group text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {theme === 'dark'
            ? <Sun size={16} strokeWidth={1.75} />
            : <Moon size={16} strokeWidth={1.75} />
          }
          <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md bg-foreground/90 text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
            {theme === 'dark' ? '切换亮色' : '切换暗色'}
          </span>
        </button>

        {/* Settings */}
        <button
          onClick={() => setPage('settings')}
          title="设置"
          className={cn(
            'w-full h-9 rounded-lg flex items-center justify-center transition-all relative group',
            currentPage === 'settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <Settings size={17} strokeWidth={currentPage === 'settings' ? 2 : 1.75} />
          <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md bg-foreground/90 text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
            设置
          </span>
        </button>
      </div>
    </aside>
  )
}
