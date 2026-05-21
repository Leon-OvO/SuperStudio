import { useEffect, useRef, useState } from 'react'
import {
  FilePlus, FolderInput, Save, Settings as SettingsIcon, X,
  Undo2, Redo2, Scissors, ClipboardCopy, ClipboardPaste, Search, Replace as ReplaceIcon,
  CopyPlus, ArrowUp, ArrowDown, MousePointer2,
  Eye, EyeOff, Folder, TerminalSquare, Sun, Moon, Command, Globe,
  MessageSquare, Compass, Bug, Lightbulb, Play, Square,
  HelpCircle, Keyboard, Info
} from 'lucide-react'
import { Menu, MenuItem, MenuSeparator, MenuLabel } from './Menu'
import { ProjectPill } from './ProjectPill'
import { ModelPicker } from '../ModelPicker'
import { useUIStore } from '../../../stores/ui'
import { runEditorCommand } from '../Editor/active-editor'
import type { OpenTab } from '../store'

type MenuId = 'file' | 'edit' | 'selection' | 'view' | 'run' | 'terminal' | 'help'

interface Props {
  // Project / model
  projectPath: string | null
  providerId: string | null
  modelId: string | null
  onSwitchProject: (path: string) => void
  onOpenExisting: () => void
  onNewProject: () => void
  onRemoveRecent: (path: string) => Promise<void>
  onModelChange: (providerId: string, modelId: string) => void

  // File menu — save targets the active tab
  openTabs: OpenTab[]
  activeTabKey: string | null
  onSaveActive: () => void
  onSaveAll: () => void
  onCloseTab: (key: string) => void
  onCloseProject: () => void

  // View menu state
  sidebarOpen: boolean
  sidebarActivity: 'requests' | 'files'
  showTerminal: boolean
  showPreview: boolean
  onToggleSidebar: () => void
  onShowActivity: (a: 'requests' | 'files') => void
  onToggleTerminal: () => void
  onTogglePreview: () => void

  // Run menu — Vibe actions (need an active prompt input; menu items focus the
  // hero/request input by dispatching a custom event the page listens to).
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  hasActiveRequest: boolean
  onRunIntent: (kind: 'chat' | 'explore' | 'bugfix' | 'propose') => void
  onApply: () => void
  onStop: () => void
}

export function MenuBar(props: Props) {
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { theme, toggleTheme, setPage } = useUIStore()

  // Close any open menu when the user clicks outside the whole menubar row.
  useEffect(() => {
    if (!openMenu) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenu])

  function toggle(id: MenuId) { setOpenMenu(o => (o === id ? null : id)) }
  function close() { setOpenMenu(null) }

  // Saving requires an active *file* tab with dirty content.
  const activeTab = props.openTabs.find(t => t.key === props.activeTabKey)
  const activeIsDirty = activeTab?.kind === 'file' && activeTab.dirty
  const hasAnyDirty = props.openTabs.some(t => t.kind === 'file' && t.dirty)

  return (
    <div
      ref={rootRef}
      className="flex items-center h-9 px-2 gap-0.5 shrink-0 border-b border-border bg-card/60"
    >
      {/* ─── Menus (left) ─── */}
      <Menu title="文件" open={openMenu === 'file'} onToggle={() => toggle('file')} onClose={close}>
        <MenuItem icon={<FilePlus size={12} />} label="新建项目..." shortcut="Ctrl+Shift+N" onClick={props.onNewProject} />
        <MenuItem icon={<FolderInput size={12} />} label="打开本地文件夹..." shortcut="Ctrl+O" onClick={props.onOpenExisting} />
        <MenuSeparator />
        <MenuItem
          icon={<Save size={12} />}
          label="保存"
          shortcut="Ctrl+S"
          disabled={!activeIsDirty}
          onClick={props.onSaveActive}
        />
        <MenuItem
          icon={<Save size={12} />}
          label="全部保存"
          shortcut="Ctrl+K S"
          disabled={!hasAnyDirty}
          onClick={props.onSaveAll}
        />
        <MenuSeparator />
        <MenuItem
          icon={<X size={12} />}
          label="关闭标签"
          shortcut="Ctrl+W"
          disabled={!props.activeTabKey}
          onClick={() => props.activeTabKey && props.onCloseTab(props.activeTabKey)}
        />
        <MenuItem
          label="关闭项目"
          disabled={!props.projectPath}
          onClick={props.onCloseProject}
          icon={<Folder size={12} />}
        />
        <MenuSeparator />
        <MenuItem
          icon={<SettingsIcon size={12} />}
          label="偏好设置"
          shortcut="Ctrl+,"
          onClick={() => setPage('settings')}
        />
      </Menu>

      <Menu title="编辑" open={openMenu === 'edit'} onToggle={() => toggle('edit')} onClose={close}>
        <MenuItem icon={<Undo2 size={12} />} label="撤销" shortcut="Ctrl+Z" onClick={() => runEditorCommand('undo')} />
        <MenuItem icon={<Redo2 size={12} />} label="重做" shortcut="Ctrl+Y" onClick={() => runEditorCommand('redo')} />
        <MenuSeparator />
        <MenuItem icon={<Scissors size={12} />} label="剪切" shortcut="Ctrl+X" onClick={() => runEditorCommand('editor.action.clipboardCutAction')} />
        <MenuItem icon={<ClipboardCopy size={12} />} label="复制" shortcut="Ctrl+C" onClick={() => runEditorCommand('editor.action.clipboardCopyAction')} />
        <MenuItem icon={<ClipboardPaste size={12} />} label="粘贴" shortcut="Ctrl+V" onClick={() => runEditorCommand('editor.action.clipboardPasteAction')} />
        <MenuSeparator />
        <MenuItem icon={<Search size={12} />} label="查找" shortcut="Ctrl+F" onClick={() => runEditorCommand('actions.find')} />
        <MenuItem icon={<ReplaceIcon size={12} />} label="替换" shortcut="Ctrl+H" onClick={() => runEditorCommand('editor.action.startFindReplaceAction')} />
      </Menu>

      <Menu title="选择" open={openMenu === 'selection'} onToggle={() => toggle('selection')} onClose={close}>
        <MenuItem icon={<MousePointer2 size={12} />} label="全选" shortcut="Ctrl+A" onClick={() => runEditorCommand('editor.action.selectAll')} />
        <MenuItem icon={<CopyPlus size={12} />} label="复制行（向下）" shortcut="Shift+Alt+↓" onClick={() => runEditorCommand('editor.action.copyLinesDownAction')} />
        <MenuItem icon={<ArrowUp size={12} />} label="移动行（上移）" shortcut="Alt+↑" onClick={() => runEditorCommand('editor.action.moveLinesUpAction')} />
        <MenuItem icon={<ArrowDown size={12} />} label="移动行（下移）" shortcut="Alt+↓" onClick={() => runEditorCommand('editor.action.moveLinesDownAction')} />
      </Menu>

      <Menu title="视图" open={openMenu === 'view'} onToggle={() => toggle('view')} onClose={close}>
        <MenuItem
          icon={<Command size={12} />}
          label="命令面板..."
          shortcut="Ctrl+K"
          onClick={() => window.dispatchEvent(new CustomEvent('app:open-palette'))}
        />
        <MenuSeparator />
        <MenuLabel label="侧栏" />
        <MenuItem
          icon={<Folder size={12} />}
          label={`${props.sidebarOpen ? '隐藏' : '显示'}侧栏`}
          shortcut="Ctrl+B"
          onClick={props.onToggleSidebar}
        />
        <MenuItem
          icon={<Folder size={12} />}
          label="对话面板"
          onClick={() => props.onShowActivity('requests')}
        />
        <MenuItem
          icon={<Folder size={12} />}
          label="文件浏览器"
          onClick={() => props.onShowActivity('files')}
        />
        <MenuSeparator />
        <MenuLabel label="面板" />
        <MenuItem
          icon={<TerminalSquare size={12} />}
          label={`${props.showTerminal ? '隐藏' : '显示'}终端`}
          shortcut="Ctrl+`"
          onClick={props.onToggleTerminal}
        />
        <MenuItem
          icon={props.showPreview ? <Eye size={12} /> : <EyeOff size={12} />}
          label={`${props.showPreview ? '隐藏' : '显示'}预览面板`}
          onClick={props.onTogglePreview}
        />
        <MenuSeparator />
        <MenuItem
          icon={theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
          label={`切换为${theme === 'dark' ? '浅色' : '深色'}主题`}
          onClick={toggleTheme}
        />
      </Menu>

      <Menu title="运行" open={openMenu === 'run'} onToggle={() => toggle('run')} onClose={close}>
        <MenuLabel label="对话模式" />
        <MenuItem
          icon={<MessageSquare size={12} />}
          label="对话"
          disabled={!!props.running}
          onClick={() => props.onRunIntent('chat')}
        />
        <MenuItem
          icon={<Compass size={12} />}
          label="探索"
          disabled={!!props.running}
          onClick={() => props.onRunIntent('explore')}
        />
        <MenuItem
          icon={<Bug size={12} />}
          label="修复"
          disabled={!!props.running}
          onClick={() => props.onRunIntent('bugfix')}
        />
        <MenuItem
          icon={<Lightbulb size={12} />}
          label="提案"
          disabled={!!props.running}
          onClick={() => props.onRunIntent('propose')}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Play size={12} />}
          label="应用变更"
          disabled={!props.hasActiveRequest || !!props.running}
          onClick={props.onApply}
        />
        <MenuItem
          icon={<Square size={12} />}
          label="停止"
          shortcut="Esc"
          disabled={!props.running}
          danger
          onClick={props.onStop}
        />
      </Menu>

      <Menu title="终端" open={openMenu === 'terminal'} onToggle={() => toggle('terminal')} onClose={close}>
        <MenuItem
          icon={<TerminalSquare size={12} />}
          label={props.showTerminal ? '隐藏终端' : '新建终端'}
          shortcut="Ctrl+`"
          disabled={!props.projectPath}
          onClick={props.onToggleTerminal}
        />
      </Menu>

      <Menu title="帮助" open={openMenu === 'help'} onToggle={() => toggle('help')} onClose={close}>
        <MenuItem
          icon={<Keyboard size={12} />}
          label="键盘快捷键参考"
          shortcut="Ctrl+/"
          onClick={() => window.dispatchEvent(new CustomEvent('app:open-shortcuts'))}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Globe size={12} />}
          label="官方网站"
          onClick={() => window.open('https://www.supercode.help', '_blank')}
        />
        <MenuItem
          icon={<Info size={12} />}
          label="关于"
          onClick={() => setPage('settings')}
        />
        <MenuItem icon={<HelpCircle size={12} />} label="文档" onClick={() => window.open('https://www.supercode.help', '_blank')} />
      </Menu>

      {/* ─── Center: command-center project pill ─── */}
      <div className="flex-1 flex justify-center px-4">
        <ProjectPill
          projectPath={props.projectPath}
          onSwitchProject={props.onSwitchProject}
          onOpenExisting={props.onOpenExisting}
          onNewProject={props.onNewProject}
          onRemoveRecent={props.onRemoveRecent}
        />
      </div>

      {/* ─── Right: model picker (still inline — it's tied to the project) ─── */}
      <ModelPicker
        projectPath={props.projectPath}
        providerId={props.providerId}
        modelId={props.modelId}
        onChange={props.onModelChange}
      />
    </div>
  )
}
