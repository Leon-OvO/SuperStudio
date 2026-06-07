import { useState } from 'react'
import type { ProviderConfig } from '../../../../shared/ipc-types'
import { ProviderList } from './ProviderList'
import { ProviderForm } from './ProviderForm'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

/**
 * BYOK account page — local AI provider management. Users add/edit/delete their
 * own providers (API URL + key + models). This is the deliverable replacement
 * for the supercode AccountTab; it reuses the existing ProviderList +
 * ProviderForm and the local provider-CRUD IPC (no account backend).
 */
export function ProviderManager({
  providers,
  onRefresh,
}: {
  providers: ProviderConfig[]
  onRefresh: () => void | Promise<void>
}) {
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const dlg = useConfirmDialog()

  async function handleSave(p: ProviderConfig) {
    await window.api.saveProvider(p)
    setEditing(null)
    await onRefresh()
    toast.success('已保存')
  }

  async function handleDelete(id: string) {
    const ok = await dlg.confirm({
      message: '删除该提供商？关联的默认模型设置会被清空。',
      tone: 'danger',
      confirmLabel: '删除',
    })
    if (!ok) return
    await window.api.deleteProvider(id)
    await onRefresh()
  }

  return (
    <div className="max-w-3xl">
      {editing !== null ? (
        <ProviderForm
          initial={editing === 'new' ? null : editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <ProviderList
          providers={providers}
          onCreate={() => setEditing('new')}
          onEdit={(p) => setEditing(p)}
          onDelete={handleDelete}
        />
      )}
      {dlg.element}
    </div>
  )
}
