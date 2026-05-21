import { TerminalSquare, ScrollText, AlertCircle, Bug, X } from 'lucide-react'
import { useVibeStore } from './store'

type PanelTab = 'terminal' | 'output' | 'problems' | 'debug'

interface TabDef {
  id: PanelTab
  label: string
  icon: React.ReactNode
}

const TABS: TabDef[] = [
  { id: 'terminal', label: '终端', icon: <TerminalSquare size={11} /> },
  { id: 'output', label: '输出', icon: <ScrollText size={11} /> },
  { id: 'problems', label: '问题', icon: <AlertCircle size={11} /> },
  { id: 'debug', label: '调试控制台', icon: <Bug size={11} /> }
]

/** VS Code–style tab strip for the bottom panel. Mirrors the editor tab look
 *  but lower-profile (22px) since these are tools, not documents. The actual
 *  panel content (terminal / output / etc) is rendered by the parent — this
 *  component only owns the chrome. */
export function PanelTabs({ onClose }: { onClose: () => void }) {
  const panelTab = useVibeStore(s => s.panelTab)
  const setPanelTab = useVibeStore(s => s.setPanelTab)

  return (
    <div className="h-7 shrink-0 flex items-center border-b border-border bg-card/60">
      <div className="flex items-center h-full">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setPanelTab(t.id)}
            className={[
              'h-full px-3 text-[11px] flex items-center gap-1.5 border-b-2 transition-colors uppercase tracking-wide',
              panelTab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground/80 hover:text-foreground'
            ].join(' ')}
            title={t.label}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <button
        onClick={onClose}
        className="p-1.5 mr-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
        title="关闭面板 (Ctrl+`)"
      >
        <X size={12} />
      </button>
    </div>
  )
}
