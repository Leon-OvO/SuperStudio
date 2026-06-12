import { useEffect, useRef, useState } from 'react'
import { Send, Loader2, Sparkles, FolderOpen, MessageSquare, Search, Bug, Wrench, Wand2 } from 'lucide-react'
import { Select } from '../../../components/ui/Select'
import type { VibeIntent } from '../../../../../shared/ipc-types'

interface Props {
  hasProject: boolean
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  /** Unified send: auto-detect intent unless forceIntent given (manual lock). */
  onRun: (prompt: string, requestId?: string, forceIntent?: VibeIntent) => void
}

const INTENT_META: Record<VibeIntent, {
  label: string
  Icon: typeof MessageSquare
  hint: string
  color: string  // tailwind text color for active state
  bg: string     // tailwind bg color for active state
}> = {
  chat:    { label: '对话',     Icon: MessageSquare, hint: '随便聊聊，不读项目文件', color: 'text-slate-700 dark:text-slate-200', bg: 'bg-slate-500/15 border-slate-500/40' },
  explore: { label: '探索',     Icon: Search,        hint: '让 AI 读代码、回答问题（只读）', color: 'text-sky-700 dark:text-sky-300', bg: 'bg-sky-500/15 border-sky-500/40' },
  bugfix:  { label: '修复 BUG', Icon: Bug,           hint: '描述 bug，AI 自动定位并修复', color: 'text-rose-700 dark:text-rose-300', bg: 'bg-rose-500/15 border-rose-500/40' },
  change:  { label: '新需求',   Icon: Wrench,        hint: '把需求拆成任务列表，逐个实施', color: 'text-primary', bg: 'bg-primary/15 border-primary/40' }
}

const EXAMPLES: Record<VibeIntent, string[]> = {
  chat: [
    'CSS Grid 和 Flex 适合什么场景？',
    '帮我推荐 5 个 React 状态管理库',
  ],
  explore: [
    '这个项目是干嘛的？',
    'index.html 为什么没有 viewport meta？',
    '哪里设置了页面背景色？',
  ],
  bugfix: [
    '点击登录按钮没反应，控制台报 undefined',
    '页面在移动端样式错位',
  ],
  change: [
    '给页面加一个深色模式切换按钮',
    '把所有 var 改成 let / const',
    '为 index.html 加 SEO meta 标签',
  ]
}

export function EmptyStateHero({ hasProject, running, onRun }: Props) {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'auto' | VibeIntent>('auto')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'
  }, [input])

  function submit() {
    const t = input.trim()
    if (!t || running) return
    onRun(t, undefined, mode === 'auto' ? undefined : mode)
    setInput('')
  }

  if (!hasProject) {
    return (
      <div className="max-w-md text-center space-y-4">
        <div className="w-16 h-16 mx-auto rounded-full bg-muted/40 flex items-center justify-center">
          <FolderOpen size={28} className="text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-semibold">还没有打开项目</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            从顶部「未打开项目 ▾」下拉里选「打开本地文件夹」或「新建项目」开始
          </p>
        </div>
      </div>
    )
  }

  const isRunning = running !== null
  // Flatten a few examples across intents for the auto-mode starter list.
  const STARTER = [...EXAMPLES.change.slice(0, 2), EXAMPLES.bugfix[0], EXAMPLES.explore[0]]

  return (
    <div className="max-w-2xl w-full space-y-5">
      <div className="text-center space-y-2">
        <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
          <Sparkles size={24} className="text-primary" />
        </div>
        <h3 className="text-lg font-semibold">说出你的需求</h3>
        <p className="text-xs text-muted-foreground">
          AI 自动判断该聊天 / 探索代码 / 修复 BUG / 拆解成任务 —— 也可手动锁定模式
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">模式</span>
          <Select
            value={mode}
            onChange={v => setMode(v as 'auto' | VibeIntent)}
            disabled={isRunning}
            popoverWidth={180}
            options={[
              { value: 'auto', label: '自动识别', icon: <Wand2 size={13} /> },
              { value: 'chat', label: `${INTENT_META.chat.label}（不读项目）` },
              { value: 'explore', label: `${INTENT_META.explore.label}（只读代码）` },
              { value: 'bugfix', label: `${INTENT_META.bugfix.label}（自动定位修复）` },
              { value: 'change', label: `${INTENT_META.change.label}（拆成任务）` }
            ]}
          />
          <span className="text-[11px] text-muted-foreground ml-auto">{mode === 'auto' ? 'AI 自动判断' : `已锁定：${INTENT_META[mode].label}`}</span>
        </div>

        <textarea
          ref={taRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={5}
          disabled={isRunning}
          placeholder={
            mode === 'auto'    ? '比如：加一个深色模式切换按钮 / 这段代码怎么工作 / 保存点了没反应…' :
            mode === 'chat'    ? '随便聊点什么…' :
            mode === 'explore' ? '问 AI 关于这个项目的任何问题…' :
            mode === 'bugfix'  ? '描述 BUG：症状、复现步骤、报错信息…' :
                                 '描述你要做的改动，AI 会拆解成可执行任务…'
          }
          className="w-full resize-none rounded-xl bg-card border border-border px-4 py-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 disabled:opacity-50 min-h-[120px] shadow-sm"
          style={{ maxHeight: '300px' }}
          autoFocus
        />
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground/60">
            Enter 发送 · ⇧Enter 换行
          </div>
          <button
            onClick={submit}
            disabled={!input.trim() || isRunning}
            className="flex items-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isRunning
              ? <><Loader2 size={13} className="animate-spin" /> 运行中…</>
              : <><Send size={13} /> {mode === 'auto' ? '发送' : INTENT_META[mode].label}</>
            }
          </button>
        </div>
      </div>

      {running && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-primary/5 px-3 py-2 rounded-lg border border-primary/20">
          <Loader2 size={12} className="animate-spin text-primary shrink-0" />
          {running === 'chat'    ? 'AI 正在回复…' :
           running === 'explore' ? 'AI 正在探索项目并回答你的问题…' :
           running === 'bugfix'  ? 'AI 正在定位并修复问题…' :
           running === 'propose' ? 'AI 正在分析需求并生成任务列表（10-30 秒）…' :
                                   'AI 正在执行任务…'}
        </div>
      )}

      <div className="text-xs text-muted-foreground/70 space-y-1.5 pt-3 border-t border-border/50">
        <div className="flex items-center gap-1.5 text-muted-foreground/80">
          <Sparkles size={11} /> 试试：
        </div>
        <div className="space-y-1">
          {STARTER.map(ex => (
            <button
              key={ex}
              onClick={() => setInput(ex)}
              disabled={isRunning}
              className="block text-left w-full px-3 py-1.5 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50"
            >
              · {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
