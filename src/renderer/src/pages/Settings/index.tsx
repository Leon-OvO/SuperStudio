import { useEffect, useState } from 'react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { ProviderList } from './ProviderList'
import { ProviderForm } from './ProviderForm'
import { GlobalSettings } from './GlobalSettings'
import { McpServers } from './McpServers'
import { About } from './About'

type Tab = 'providers' | 'defaults' | 'search' | 'kb' | 'mcp' | 'about'

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [exportRunning, setExportRunning] = useState(false)
  const [importRunning, setImportRunning] = useState(false)

  useEffect(() => { reload() }, [])

  async function reload() {
    const [p, s] = await Promise.all([
      window.api.listProviders(),
      window.api.getSettings()
    ])
    setProviders(p)
    setSettings(s)
  }

  async function handleSaveProvider(p: ProviderConfig) {
    await window.api.saveProvider(p)
    setEditing(null)
    setCreating(false)
    await reload()
  }

  async function handleDeleteProvider(id: string) {
    if (!confirm('确定删除该提供商？')) return
    await window.api.deleteProvider(id)
    await reload()
  }

  async function handleSaveSettings(updated: AppSettings) {
    await window.api.setSettings(updated)
    setSettings(updated)
  }

  async function handleExportConfig() {
    setExportRunning(true)
    try {
      const result = await window.api.exportConfig?.()
      if (result?.filePath) {
        alert('已导出到 ' + result.filePath)
      }
    } catch (e) {
      alert('导出失败：' + (e as Error).message)
    } finally {
      setExportRunning(false)
    }
  }

  async function handleImportConfig() {
    setImportRunning(true)
    try {
      const result = await window.api.importConfig?.()
      if (result?.canceled) return
      if (result?.error) { alert('导入失败：' + result.error); return }
      if (result?.imported) {
        await reload()
        alert(
          `配置已导入：${result.imported.providers} 个提供商，` +
          `${result.imported.mcp} 个 MCP 服务器，` +
          `${result.imported.settings ? '应用设置已恢复' : '无应用设置'}。\n\n` +
          `提示：API Key 是用源机器的密钥加密的，导入后请到「提供商」里逐个重新填写。`
        )
      }
    } catch (e) {
      alert('导入失败：' + (e as Error).message)
    } finally {
      setImportRunning(false)
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-border bg-sidebar p-2 space-y-1 flex flex-col">
        <TabButton active={tab === 'providers'} onClick={() => setTab('providers')}>提供商</TabButton>
        <TabButton active={tab === 'defaults'} onClick={() => setTab('defaults')}>默认模型</TabButton>
        <TabButton active={tab === 'search'} onClick={() => setTab('search')}>网络搜索</TabButton>
        <TabButton active={tab === 'kb'} onClick={() => setTab('kb')}>知识库</TabButton>
        <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP 服务器</TabButton>
        <div className="flex-1" />
        <TabButton active={tab === 'about'} onClick={() => setTab('about')}>关于 & 更新</TabButton>
      </aside>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'providers' && (
          <>
            {(editing || creating) ? (
              <ProviderForm
                initial={editing}
                onSave={handleSaveProvider}
                onCancel={() => { setEditing(null); setCreating(false) }}
              />
            ) : (
              <ProviderList
                providers={providers}
                onEdit={setEditing}
                onDelete={handleDeleteProvider}
                onCreate={() => setCreating(true)}
              />
            )}
          </>
        )}
        {tab === 'mcp' && <McpServers />}
        {tab === 'about' && (
          <About
            onExportData={handleExportConfig}
            onImportData={handleImportConfig}
            exportRunning={exportRunning}
            importRunning={importRunning}
          />
        )}
        {(tab === 'defaults' || tab === 'search' || tab === 'kb') && settings && (
          <GlobalSettings
            tab={tab}
            settings={settings}
            providers={providers}
            onSave={handleSaveSettings}
          />
        )}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-3 py-2 rounded-md text-sm transition-colors ' +
        (active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
      }
    >
      {children}
    </button>
  )
}
