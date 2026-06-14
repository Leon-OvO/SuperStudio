import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

const groups: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    title: '全局',
    items: [
      { keys: [MOD, 'N'], label: '新建对话' },
      { keys: [MOD, 'K'], label: '打开命令面板（搜索对话 / 跳转页面）' },
      { keys: [MOD, '/'], label: '显示这个快捷键面板' },
      { keys: [MOD, ','], label: '打开设置' },
      { keys: [MOD, '1'], label: '切到对话' },
      { keys: [MOD, '2'], label: '切到工作流' },
      { keys: [MOD, '3'], label: '切到画廊' },
      { keys: [MOD, '4'], label: '切到知识库' }
    ]
  },
  {
    title: '对话',
    items: [
      { keys: ['Enter'], label: '发送消息' },
      { keys: ['Shift', 'Enter'], label: '换行' },
      { keys: ['Ctrl/Cmd', 'V'], label: '粘贴图片附件' },
      { keys: ['Esc'], label: '关闭弹窗 / 退出编辑' }
    ]
  },
  {
    title: '画廊 / 图片预览',
    items: [
      { keys: ['←'], label: '上一张' },
      { keys: ['→'], label: '下一张' },
      { keys: [MOD, 'C'], label: '复制当前图片' },
      { keys: ['Esc'], label: '关闭预览' }
    ]
  },
  {
    title: '知识库 / 工作流',
    items: [
      { keys: [MOD, 'Z'], label: '画布撤销（编辑模式中）' },
      { keys: [MOD, 'S'], label: '保存（部分场景）' }
    ]
  }
]

export function ShortcutsHelp({ open, onClose }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[300] bg-black/55 backdrop-blur-sm flex items-center justify-center p-4 animate-overlay-in" onClick={onClose}>
      <div
        className="bg-popover border border-border rounded-xl shadow-2xl w-[640px] max-w-full max-h-[80vh] overflow-y-auto animate-dialog-in"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-base font-semibold">键盘快捷键</h2>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60">
            <X size={16} />
          </button>
        </header>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {groups.map(g => (
            <section key={g.title}>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">{g.title}</h3>
              <ul className="space-y-1.5 text-sm">
                {g.items.map((it, i) => (
                  <li key={i} className="flex items-center justify-between gap-3">
                    <span className="text-foreground/85">{it.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {it.keys.map((k, j) => (
                        <kbd key={j} className="px-1.5 py-0.5 rounded border border-border bg-muted/50 text-[11px] font-mono shadow-sm min-w-[24px] text-center">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border text-[11px] text-muted-foreground/70">
          按 <kbd className="px-1 py-0.5 rounded bg-muted/50 border border-border font-mono">Esc</kbd> 关闭面板
        </div>
      </div>
    </div>
  )
}
