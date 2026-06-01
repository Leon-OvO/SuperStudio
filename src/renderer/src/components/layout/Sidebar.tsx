import type { ReactNode } from 'react'
import {
  MessageSquare, Zap, Image, Film, BookOpen, Building2, Sparkles, CalendarClock, Settings,
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
  // Flat, lean list (the AI-company workspace lives under the 公司/Workbench page's tabs).
  const navItems = [
    { id: 'chat' as const, icon: MessageSquare, label: t('nav.chat') },
    { id: 'vibe' as const, icon: Building2, label: t('nav.vibe') },
    { id: 'video' as const, icon: Film, label: t('nav.video') },
    { id: 'gallery' as const, icon: Image, label: t('nav.gallery') },
    { id: 'workflow' as const, icon: Zap, label: t('nav.workflow') },
    { id: 'knowledge' as const, icon: BookOpen, label: t('nav.knowledge') },
    { id: 'skills' as const, icon: Sparkles, label: t('nav.skills') },
    { id: 'scheduler' as const, icon: CalendarClock, label: t('nav.scheduler') },
  ]

  const themeLabel = theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')

  return (
    <aside
      className={cn(
        'flex flex-col py-3 gap-1.5 bg-sidebar border-r border-sidebar-border shrink-0 px-1.5 items-center transition-[width] duration-200',
        expanded ? 'w-[78px]' : 'w-[56px]'
      )}
    >
      {/* Collapse / expand toggle — the logo + wordmark live in the TitleBar,
          so we deliberately don't repeat them here. Icon-only to keep the
          stacked nav clean; the action is described by its tooltip. */}
      <button
        onClick={() => setSidebarExpanded(!expanded)}
        title={expanded ? t('nav.collapse') : t('nav.expand')}
        className="group w-full h-7 mb-1 rounded-lg flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors"
      >
        {expanded
          ? <PanelLeftClose size={15} strokeWidth={1.75} className="opacity-70 group-hover:opacity-100 transition-opacity" />
          : <PanelLeftOpen size={15} strokeWidth={1.75} className="opacity-70 group-hover:opacity-100 transition-opacity" />}
      </button>

      {/* Main nav — flat, icon-over-label stacked cards. */}
      <div className="w-full flex flex-col gap-1">
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
      <div className="w-full flex flex-col gap-1 pt-1.5 border-t border-sidebar-border/60">
        <NavButton
          icon={Languages}
          label={t('nav.languageSwitch')}
          expanded={expanded}
          onClick={() => setLanguage(lang === 'zh' ? 'en' : 'zh')}
          cornerBadge={lang.toUpperCase()}
        />
        <NavButton
          icon={theme === 'dark' ? Sun : Moon}
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
  icon: Icon, iconSize = 20, label, active = false, expanded, onClick, dot = false, cornerBadge
}: {
  icon: LucideIcon
  iconSize?: number
  label: string
  active?: boolean
  expanded: boolean
  onClick: () => void
  dot?: boolean
  /** Tiny badge over the icon (e.g. current language code). */
  cornerBadge?: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={expanded ? undefined : label}
      className={cn(
        // Stacked card: icon on top, label below, everything centered.
        'w-full rounded-xl flex flex-col items-center justify-center transition-all relative group',
        expanded ? 'gap-1 py-2 px-1' : 'py-2.5',
        active
          ? 'bg-primary/12 text-primary shadow-sm ring-1 ring-primary/15'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <span className="relative flex items-center justify-center">
        <Icon size={iconSize} strokeWidth={active ? 2 : 1.75} />
        {dot && (
          <span className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-red-500 ring-2 ring-sidebar" />
        )}
        {cornerBadge != null && (
          <span className="absolute -right-2.5 -bottom-1.5 px-0.5 text-[8px] font-bold leading-none text-muted-foreground/80">
            {cornerBadge}
          </span>
        )}
      </span>
      {expanded && (
        <span className="text-[10.5px] leading-tight text-center line-clamp-2 max-w-full px-0.5 font-medium">
          {label}
        </span>
      )}
      {!expanded && (
        <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded-md bg-foreground/90 text-background text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
          {label}
        </span>
      )}
    </button>
  )
}
