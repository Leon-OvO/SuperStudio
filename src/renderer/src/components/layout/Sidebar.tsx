import type { ReactNode } from 'react'
import {
  MessageSquare, Zap, Image, BookOpen, Code2, Sparkles, CalendarClock, Settings,
  Sun, Moon, Languages, PanelLeftClose, PanelLeftOpen, type LucideIcon
} from 'lucide-react'
import { useUIStore } from '../../stores/ui'
import { useScheduledNotifications } from '../../stores/scheduledNotifications'
import { cn } from '../../lib/utils'
import { useT, setLanguage, useLanguage } from '../../lib/i18n'

export function Sidebar() {
  const { currentPage, setPage, theme, toggleTheme, sidebarExpanded, setSidebarExpanded } = useUIStore()
  const expanded = sidebarExpanded
  const t = useT()
  const lang = useLanguage()
  const hasUnreadScheduled = useScheduledNotifications(s => Object.keys(s.unread).length > 0)

  // Dashboard is intentionally not in the side nav — accessible from the top-right
  // user menu (TopBarUser) so the left nav stays focused on workspace pages.
  const navItems = [
    { id: 'chat' as const, icon: MessageSquare, label: t('nav.chat') },
    { id: 'vibe' as const, icon: Code2, label: t('nav.vibe') },
    { id: 'workflow' as const, icon: Zap, label: t('nav.workflow') },
    { id: 'gallery' as const, icon: Image, label: t('nav.gallery') },
    { id: 'knowledge' as const, icon: BookOpen, label: t('nav.knowledge') },
    { id: 'skills' as const, icon: Sparkles, label: t('nav.skills') },
    { id: 'scheduler' as const, icon: CalendarClock, label: t('nav.scheduler') },
  ]

  const themeLabel = theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')

  return (
    <aside
      className={cn(
        'flex flex-col py-3 gap-0.5 bg-sidebar border-r border-sidebar-border shrink-0 px-2 transition-[width] duration-200',
        expanded ? 'w-[148px]' : 'w-[52px] items-center'
      )}
    >
      {/* Collapse / expand toggle — the logo + wordmark live in the TitleBar,
          so we deliberately don't repeat them here. */}
      {expanded ? (
        <button
          onClick={() => setSidebarExpanded(false)}
          title={t('nav.collapse')}
          className="group w-full h-8 mb-2 rounded-lg flex items-center gap-2 px-2.5 text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
        >
          <span className="flex-1 text-left text-[11px] font-medium tracking-wide truncate">
            {t('nav.collapse')}
          </span>
          <PanelLeftClose
            size={15}
            strokeWidth={1.75}
            className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
          />
        </button>
      ) : (
        <NavButton
          icon={PanelLeftOpen}
          iconSize={16}
          label={t('nav.expand')}
          expanded={false}
          onClick={() => setSidebarExpanded(true)}
        />
      )}

      {/* Main nav */}
      <div className="w-full flex flex-col gap-0.5">
        {navItems.map(({ id, icon, label }) => (
          <NavButton
            key={id}
            icon={icon}
            label={label}
            active={currentPage === id}
            expanded={expanded}
            dot={id === 'scheduler' && hasUnreadScheduled && currentPage !== 'scheduler'}
            onClick={() => setPage(id)}
          />
        ))}
      </div>

      <div className="flex-1" />

      {/* Bottom utilities */}
      <div className="w-full flex flex-col gap-0.5">
        <NavButton
          icon={Languages}
          iconSize={16}
          label={t('nav.languageSwitch')}
          expanded={expanded}
          onClick={() => setLanguage(lang === 'zh' ? 'en' : 'zh')}
          cornerBadge={lang.toUpperCase()}
          trailing={lang.toUpperCase()}
        />
        <NavButton
          icon={theme === 'dark' ? Sun : Moon}
          iconSize={16}
          label={themeLabel}
          expanded={expanded}
          onClick={toggleTheme}
        />
        <NavButton
          icon={Settings}
          label={t('nav.settings')}
          active={currentPage === 'settings'}
          expanded={expanded}
          onClick={() => setPage('settings')}
        />
      </div>
    </aside>
  )
}

function NavButton({
  icon: Icon, iconSize = 17, label, active = false, expanded, onClick, dot = false, cornerBadge, trailing
}: {
  icon: LucideIcon
  iconSize?: number
  label: string
  active?: boolean
  expanded: boolean
  onClick: () => void
  dot?: boolean
  /** Tiny badge over the icon, collapsed mode only (e.g. current language code). */
  cornerBadge?: ReactNode
  /** Trailing element shown after the label, expanded mode only. */
  trailing?: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={expanded ? undefined : label}
      className={cn(
        'w-full h-9 rounded-lg flex items-center transition-all relative group',
        expanded ? 'px-2.5 gap-2.5' : 'justify-center',
        active
          ? 'bg-primary/10 text-primary shadow-sm'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full -ml-2" />
      )}
      <span className="relative shrink-0 flex items-center justify-center">
        <Icon size={iconSize} strokeWidth={active ? 2 : 1.75} />
        {dot && (
          <span className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-red-500 ring-1 ring-sidebar" />
        )}
        {!expanded && cornerBadge != null && (
          <span className="absolute -right-2 -bottom-1.5 text-[8px] font-bold leading-none">{cornerBadge}</span>
        )}
      </span>
      {expanded && <span className="flex-1 text-left text-[13px] truncate">{label}</span>}
      {expanded && trailing != null && (
        <span className="text-[10px] font-semibold text-muted-foreground/70 shrink-0">{trailing}</span>
      )}
      {!expanded && (
        <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md bg-foreground/90 text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
          {label}
        </span>
      )}
    </button>
  )
}
