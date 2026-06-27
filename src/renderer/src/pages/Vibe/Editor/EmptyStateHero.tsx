import { useState } from 'react'
import { Loader2, Sparkles, FolderOpen } from 'lucide-react'
import { VibeComposer, type VibeMode } from '../Composer'
import { type ThinkingMode } from '../../../components/ThinkingModePicker'
import type { ComposerAttachment } from '../../../lib/attachments'
import type { VibeIntent } from '../../../../../shared/ipc-types'

interface Props {
  hasProject: boolean
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  /** Unified send: auto-detect intent unless forceIntent given (manual lock). */
  onRun: (prompt: string, requestId?: string, forceIntent?: VibeIntent, attachments?: ComposerAttachment[], thinkingMode?: ThinkingMode, forceSkillIds?: string[]) => void
  onStop?: () => void
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

export function EmptyStateHero({ hasProject, running, onRun, onStop }: Props) {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<VibeMode>('auto')
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('auto')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])

  function submit(forceSkillIds?: string[]) {
    const t = input.trim()
    if ((!t && attachments.length === 0) || running) return
    onRun(t, undefined, mode === 'auto' ? undefined : mode, attachments.length ? attachments : undefined, thinkingMode === 'auto' ? undefined : thinkingMode, forceSkillIds)
    setInput('')
    setAttachments([])
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

      <VibeComposer
        value={input}
        onChange={setInput}
        mode={mode}
        onModeChange={setMode}
        thinkingMode={thinkingMode}
        onThinkingModeChange={setThinkingMode}
        running={running}
        onSubmit={submit}
        onStop={onStop}
        autoFocus
        minHeight={100}
        maxHeight={300}
        autoPlaceholder="比如：加一个深色模式切换按钮 / 这段代码怎么工作 / 保存点了没反应…"
        attachments={attachments}
        setAttachments={setAttachments}
      />

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
