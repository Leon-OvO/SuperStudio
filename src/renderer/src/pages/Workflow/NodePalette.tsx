import { Plus, LayoutTemplate } from 'lucide-react'
import { useState } from 'react'
import { NODE_DEFINITIONS, WORKFLOW_TEMPLATES, type NodeKind, type WorkflowTemplate } from './nodes'
import { useT } from '../../lib/i18n'

interface Props {
  onAdd: (kind: NodeKind) => void
  onLoadTemplate: (template: WorkflowTemplate) => void
}

export function NodePalette({ onAdd, onLoadTemplate }: Props) {
  const kinds = Object.keys(NODE_DEFINITIONS) as NodeKind[]
  const [tab, setTab] = useState<'nodes' | 'templates'>('nodes')
  const t = useT()

  return (
    <div className="border-t border-border flex flex-col max-h-[45%]">
      <div className="flex border-b border-border text-xs">
        <button
          onClick={() => setTab('nodes')}
          className={`flex-1 px-3 py-1.5 transition-colors ${tab === 'nodes' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
        >
          {t('wf.tabNodes')}
        </button>
        <button
          onClick={() => setTab('templates')}
          className={`flex-1 px-3 py-1.5 transition-colors flex items-center justify-center gap-1 ${tab === 'templates' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
        >
          <LayoutTemplate size={11} /> {t('wf.tabTemplates')}
        </button>
      </div>
      <div className="overflow-y-auto p-2 space-y-0.5">
        {tab === 'nodes' ? kinds.map(k => (
          <button
            key={k}
            onClick={() => onAdd(k)}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <Plus size={11} />
            <span className="truncate">{NODE_DEFINITIONS[k].label}</span>
          </button>
        )) : WORKFLOW_TEMPLATES.map(t => (
          <button
            key={t.id}
            onClick={() => onLoadTemplate(t)}
            className="w-full flex flex-col items-start px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors"
          >
            <span className="font-medium text-foreground">{t.name}</span>
            <span className="text-muted-foreground line-clamp-2 text-left mt-0.5">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
