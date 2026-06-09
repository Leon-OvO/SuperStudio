import { useEffect, useState, useCallback } from 'react'
import type { SshConnection } from '../../../../shared/ipc-types'
import { SshList } from './SshList'
import { SshForm } from './SshForm'
import { randomId } from '../../lib/id'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

/**
 * SSH connection管理. Mirrors ProviderManager: list ⇄ form state machine, CRUD
 * via the ssh:* IPC. Credentials are encrypted at rest by the main process and
 * are never exposed to the LLM — the agent references a connection by name only.
 */
export function SshManager() {
  const [connections, setConnections] = useState<SshConnection[]>([])
  const [editing, setEditing] = useState<SshConnection | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const dlg = useConfirmDialog()

  const reload = useCallback(async () => {
    try { setConnections((await window.api.sshListConnections()) as SshConnection[]) }
    catch (e) { toast.error('加载 SSH 连接失败：' + (e as Error).message) }
  }, [])

  useEffect(() => { reload() }, [reload])

  async function handleSave(c: SshConnection) {
    await window.api.sshSaveConnection(c)
    setEditing(null)
    await reload()
    toast.success('已保存')
  }

  async function handleDelete(id: string) {
    const ok = await dlg.confirm({ message: '删除该 SSH 连接？', tone: 'danger', confirmLabel: '删除' })
    if (!ok) return
    await window.api.sshDeleteConnection(id)
    await reload()
  }

  async function handleBulkDelete(ids: string[]) {
    if (!ids.length) return
    const ok = await dlg.confirm({ message: `确定删除选中的 ${ids.length} 个 SSH 连接？此操作不可撤销。`, tone: 'danger', confirmLabel: `删除 ${ids.length} 个` })
    if (!ok) return
    for (const id of ids) await window.api.sshDeleteConnection(id)
    await reload()
    toast.success(`已删除 ${ids.length} 个连接`)
  }

  async function handleBulkSetAutoConfirm(ids: string[], value: boolean) {
    // Only touch连接 whose state actually changes, so the confirm count and the
    // saves reflect真实变更数（混合选择时不会把已是目标态的项算进去/重写一遍）。
    const targets = connections.filter(c => ids.includes(c.id) && !!c.autoConfirm !== value)
    if (!targets.length) return
    // Turning免确认 ON is high-risk (bypasses every per-command prompt) → confirm.
    // Turning it OFF restores prompting → safe, no confirm needed.
    if (value) {
      const ok = await dlg.confirm({
        message: `确定对选中的 ${targets.length} 个连接开启「免确认执行」？\n\n开启后，Agent 在这些连接上执行命令（含删除 / 重启 / 改配置等高危操作）将不再逐次弹窗确认。仅在你完全信任相关任务时使用。`,
        tone: 'danger',
        confirmLabel: `开启 ${targets.length} 个`,
      })
      if (!ok) return
    }
    // Connections from SSH_LIST carry decrypted creds; saveSshConnection re-encrypts,
    // so spreading只改 autoConfirm 不会丢密码/私钥。
    for (const c of targets) await window.api.sshSaveConnection({ ...c, autoConfirm: value })
    await reload()
    toast.success(value
      ? `已对 ${targets.length} 个连接开启免确认执行`
      : `已关闭 ${targets.length} 个连接的免确认执行`)
  }

  async function handleDuplicate(c: SshConnection) {
    const copy: SshConnection = { ...c, id: randomId(), name: `${c.name} 副本`, createdAt: undefined }
    await window.api.sshSaveConnection(copy)
    await reload()
    toast.success(`已复制为「${copy.name}」`)
  }

  async function handleImport() {
    const paths = (await window.api.openFileDialog?.({
      properties: ['openFile'],
      filters: [{ name: 'MobaXterm Sessions', extensions: ['mxtsessions'] }, { name: 'All Files', extensions: ['*'] }],
    })) as string[] | undefined
    if (!paths?.[0]) return
    setImporting(true)
    try {
      const r = await window.api.sshImportConnections(paths[0])
      await reload()
      if (r.imported > 0) {
        const extras: string[] = []
        if (r.duplicates) extras.push(`跳过重复 ${r.duplicates}`)
        if (r.skipped) extras.push(`跳过非 SSH ${r.skipped}`)
        if (r.missingKey) extras.push(`${r.missingKey} 个引用了本机找不到的私钥，请在该连接里补全`)
        toast.success(`已导入 ${r.imported} 个 SSH 连接${extras.length ? '（' + extras.join('；') + '）' : ''}。MobaXterm 不导出密码，密码登录的连接请补填密码。`, { duration: 6000 })
      } else {
        toast.error(`未导入任何连接（重复 ${r.duplicates}、非 SSH ${r.skipped}）。`)
      }
    } catch (e) {
      toast.error('导入失败：' + (e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="max-w-3xl">
      {editing !== null ? (
        <SshForm
          initial={editing === 'new' ? null : editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <SshList
          connections={connections}
          onCreate={() => setEditing('new')}
          onEdit={(c) => setEditing(c)}
          onDelete={handleDelete}
          onBulkDelete={handleBulkDelete}
          onBulkSetAutoConfirm={handleBulkSetAutoConfirm}
          onDuplicate={handleDuplicate}
          onImport={handleImport}
          importing={importing}
        />
      )}
      {dlg.element}
    </div>
  )
}
