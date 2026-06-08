import { useEffect, useState } from 'react'
import type { ProviderConfig, AppSettings } from '../../../../shared/ipc-types'
import { ACCOUNT_MODE } from '@shared/flavor'
import { getAccountUI } from '../../lib/account-ui'
import { GlobalSettings } from './GlobalSettings'
import { PluginsTab } from './PluginsTab'
import { McpServers } from './McpServers'
import { About } from './About'
import { ProviderManager } from './ProviderManager'
import { SshManager } from './SshManager'
import { SystemTab } from './SystemTab'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'
import { useT } from '../../lib/i18n'

// 'system' is the parent tab that now bundles 模型 / 自动切换模型 / 构建 as
// sub-sections (see SystemTab). The standalone 'defaults' / 'auto-model' /
// 'build' tabs are gone from the sidebar.
type Tab = 'account' | 'system' | 'search' | 'kb' | 'mcp' | 'ssh' | 'plugins' | 'about'

export function SettingsPage() {
  const t = useT()
  const [tab, setTab] = useState<Tab>('account')
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [exportRunning, setExportRunning] = useState(false)
  const [importRunning, setImportRunning] = useState(false)
  const [chatExportRunning, setChatExportRunning] = useState(false)
  const [chatImportRunning, setChatImportRunning] = useState(false)
  const dlg = useConfirmDialog()

  useEffect(() => { reload() }, [])

  async function reload() {
    const [p, s] = await Promise.all([
      window.api.listProviders(),
      window.api.getSettings()
    ])
    setProviders(p)
    setSettings(s)

    // Defensive Token Plan sync (supercode flavor only): AccountTab triggers
    // ensureSubscriptionKey on its own mount, but a user who opens Settings →
    // 模型 directly wouldn't pick up a Token Plan activated after last login.
    // Idempotent. BYOK has no account backend, so it's skipped entirely.
    if (ACCOUNT_MODE === 'hosted') {
      try {
        const status = await window.api.getSubscriptionStatus?.()
        if (status && status.status === 'active') {
          await window.api.ensureSubscriptionKey?.()
          const fresh = await window.api.listProviders()
          setProviders(fresh)
        }
      } catch (e) {
        console.warn('[settings] Token Plan auto-sync skipped:', (e as Error).message)
      }
    }
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
        toast.success('已导出到 ' + result.filePath)
      }
    } catch (e) {
      toast.error('导出失败：' + (e as Error).message)
    } finally {
      setExportRunning(false)
    }
  }

  async function handleExportChats() {
    setChatExportRunning(true)
    try {
      const result = await window.api.exportAllSessions?.()
      if (result?.canceled) return
      if (result?.filePath) {
        toast.success(`已导出 ${result.sessionCount} 个对话 / ${result.messageCount} 条消息到：\n${result.filePath}`)
      }
    } catch (e) {
      toast.error('导出失败：' + (e as Error).message)
    } finally {
      setChatExportRunning(false)
    }
  }

  async function handleImportChats(strategy: 'merge' | 'replace' = 'merge') {
    if (strategy === 'replace' && !(await dlg.confirm({
      message: '确定要替换吗？本机现有的所有对话和消息都会被清空，仅保留导入文件里的内容。',
      tone: 'danger',
      confirmLabel: '替换'
    }))) return
    setChatImportRunning(true)
    try {
      const result = await window.api.importSessions?.({ strategy })
      if (result?.canceled) return
      if (result?.error) { toast.error('导入失败：' + result.error); return }
      toast.success(
        `对话已${strategy === 'replace' ? '替换式' : '合并式'}导入：\n` +
        `· 新增 ${result.sessionsAdded ?? 0} 个对话` +
        (result.sessionsSkipped ? `（跳过已存在的 ${result.sessionsSkipped} 个）` : '') + `\n` +
        `· 新增 ${result.messagesAdded ?? 0} 条消息\n\n` +
        `提示：附件文件本身没有打包到导出文件里，只保留了路径引用；如果源机器上对应文件已不存在，相关附件会无法预览。`,
        { duration: 6000 }
      )
      window.dispatchEvent(new CustomEvent('app:chats-reloaded'))
    } catch (e) {
      toast.error('导入失败：' + (e as Error).message)
    } finally {
      setChatImportRunning(false)
    }
  }

  async function handleImportConfig(strategy: 'merge' | 'replace' = 'merge') {
    if (strategy === 'replace' && !(await dlg.confirm({
      message: '确定要替换吗？本机现有提供商和 MCP 服务器都会被删除，导入文件里没有的条目将丢失。',
      tone: 'danger',
      confirmLabel: '替换'
    }))) return

    setImportRunning(true)
    try {
      const result = await window.api.importConfig?.({ strategy })
      if (result?.canceled) return
      if (result?.error) { toast.error('导入失败：' + result.error); return }
      if (result?.imported) {
        await reload()
        toast.success(
          `配置已${strategy === 'replace' ? '替换式' : '合并式'}导入：\n` +
          `· ${result.imported.providers} 个提供商\n` +
          `· ${result.imported.mcp} 个 MCP 服务器\n` +
          `· ${result.imported.settings ? '应用设置已恢复' : '未带应用设置'}\n\n` +
          `提示：API Key 是用源机器的密钥加密的，导入后请到「提供商」里逐个重新填写。`,
          { duration: 6000 }
        )
      }
    } catch (e) {
      toast.error('导入失败：' + (e as Error).message)
    } finally {
      setImportRunning(false)
    }
  }

  return (
    <div className="flex h-full">
      <aside className="w-48 shrink-0 border-r border-border bg-sidebar p-2 space-y-1 flex flex-col">
        <TabButton active={tab === 'account'} onClick={() => setTab('account')}>{ACCOUNT_MODE === 'hosted' ? t('settings.tabAccount') : 'API 提供商'}</TabButton>
        <TabButton active={tab === 'system'} onClick={() => setTab('system')}>{t('settings.tabGlobal')}</TabButton>
        <TabButton active={tab === 'search'} onClick={() => setTab('search')}>{t('settings.tabWebSearch')}</TabButton>
        <TabButton active={tab === 'kb'} onClick={() => setTab('kb')}>{t('settings.tabKnowledgeBase')}</TabButton>
        <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>{t('settings.tabMcpServers')}</TabButton>
        <TabButton active={tab === 'ssh'} onClick={() => setTab('ssh')}>SSH 连接</TabButton>
        <TabButton active={tab === 'plugins'} onClick={() => setTab('plugins')}>{t('settings.tabPlugins')}</TabButton>
        <div className="flex-1" />
        <TabButton active={tab === 'about'} onClick={() => setTab('about')}>{t('settings.tabAbout')}</TabButton>
      </aside>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'account' && (() => {
          // supercode flavor renders the overlay-registered AccountTab; BYOK
          // (no registration) falls back to the local provider manager.
          const AccountTabComponent = getAccountUI().AccountTabComponent
          return ACCOUNT_MODE === 'hosted' && AccountTabComponent
            ? <AccountTabComponent onProvidersRefresh={reload} />
            : <ProviderManager providers={providers} onRefresh={reload} />
        })()}
        {tab === 'mcp' && <McpServers />}
        {tab === 'ssh' && <SshManager />}
        {tab === 'plugins' && settings && <PluginsTab settings={settings} onSave={handleSaveSettings} />}
        {tab === 'system' && (
          <SystemTab
            settings={settings}
            providers={providers}
            onSave={handleSaveSettings}
            onProvidersRefresh={reload}
          />
        )}
        {tab === 'about' && (
          <About
            onExportData={handleExportConfig}
            onImportData={(strategy) => handleImportConfig(strategy)}
            exportRunning={exportRunning}
            importRunning={importRunning}
            onExportChats={handleExportChats}
            onImportChats={handleImportChats}
            chatExportRunning={chatExportRunning}
            chatImportRunning={chatImportRunning}
          />
        )}
        {(tab === 'search' || tab === 'kb') && settings && (
          <GlobalSettings
            tab={tab}
            settings={settings}
            providers={providers}
            onSave={handleSaveSettings}
            onProvidersRefresh={reload}
          />
        )}
      </div>
      {dlg.element}
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
