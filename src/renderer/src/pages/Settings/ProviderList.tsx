import { Plus, Edit2, Trash2 } from 'lucide-react'
import type { ProviderConfig } from '../../../../shared/ipc-types'

interface Props {
  providers: ProviderConfig[]
  onEdit: (p: ProviderConfig) => void
  onDelete: (id: string) => void
  onCreate: () => void
}

export function ProviderList({ providers, onEdit, onDelete, onCreate }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">AI 提供商</h2>
          <p className="text-sm text-muted-foreground">为每个提供商配置 API 密钥和可用模型。</p>
        </div>
        <button
          onClick={onCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors"
        >
          <Plus size={14} />
          添加提供商
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
          尚未配置任何提供商，点击「添加提供商」开始。
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map(p => (
            <div key={p.id} className="border border-border rounded-lg p-4 flex items-center justify-between bg-card shadow-sm">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">{p.type}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 truncate">
                  {p.baseUrl || '默认端点'} · {p.models.length} 个模型
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  密钥：{maskKey(p.apiKey)}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-3">
                <button
                  onClick={() => onEdit(p)}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded"
                  title="编辑"
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => onDelete(p.id)}
                  className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-accent rounded"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function maskKey(key: string): string {
  if (!key) return '（空）'
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}
