import { useEffect, useState } from 'react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { ProviderList } from './ProviderList'
import { ProviderForm } from './ProviderForm'
import { GlobalSettings } from './GlobalSettings'
import { McpServers } from './McpServers'

type Tab = 'providers' | 'defaults' | 'search' | 'kb' | 'mcp'

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [creating, setCreating] = useState(false)

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

  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-border bg-sidebar p-2 space-y-1">
        <TabButton active={tab === 'providers'} onClick={() => setTab('providers')}>提供商</TabButton>
        <TabButton active={tab === 'defaults'} onClick={() => setTab('defaults')}>默认模型</TabButton>
        <TabButton active={tab === 'search'} onClick={() => setTab('search')}>网络搜索</TabButton>
        <TabButton active={tab === 'kb'} onClick={() => setTab('kb')}>知识库</TabButton>
        <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP 服务器</TabButton>
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
        {tab !== 'providers' && tab !== 'mcp' && settings && (
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
