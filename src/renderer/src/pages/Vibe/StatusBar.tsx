import { GitBranch, AlertCircle, AlertTriangle, Activity, FileCode, Loader2 } from 'lucide-react'
import { useVibeStore } from './store'

/** VS Code–style bottom status bar. Always full width, 22px tall, primary
 *  accent background when a task is running so it doubles as a live indicator. */
export function StatusBar({ providerLabel }: { providerLabel: string | null }) {
  const running = useVibeStore(s => s.running)
  const cursorLine = useVibeStore(s => s.cursorLine)
  const cursorCol = useVibeStore(s => s.cursorCol)
  const language = useVibeStore(s => s.cursorLanguage)
  const projectPath = useVibeStore(s => s.projectPath)
  const branchName = projectPath ? '主分支' : null

  const isRunning = !!running
  const runningLabel: Record<NonNullable<typeof running>, string> = {
    propose: '正在生成提案…',
    apply: '正在应用变更…',
    explore: '正在探索代码…',
    chat: '正在思考…',
    bugfix: '正在分析问题…'
  }

  return (
    <div
      className={[
        'h-[22px] shrink-0 flex items-center text-[11px] select-none border-t border-border',
        isRunning
          ? 'bg-primary text-primary-foreground'
          : 'bg-card/80 text-muted-foreground'
      ].join(' ')}
    >
      {/* Left cluster: branch, running indicator */}
      <div className="flex items-center h-full">
        {branchName && (
          <div className={cellClass(isRunning)} title="当前分支（占位）">
            <GitBranch size={11} />
            <span>{branchName}</span>
          </div>
        )}
        {isRunning ? (
          <div className={cellClass(isRunning) + ' font-medium'}>
            <Loader2 size={11} className="animate-spin" />
            <span>{runningLabel[running!]}</span>
          </div>
        ) : (
          <>
            <div className={cellClass(false)} title="错误（暂未接入）">
              <AlertCircle size={11} />
              <span>0</span>
            </div>
            <div className={cellClass(false)} title="警告（暂未接入）">
              <AlertTriangle size={11} />
              <span>0</span>
            </div>
          </>
        )}
      </div>

      <div className="flex-1" />

      {/* Right cluster: cursor, language, model, encoding */}
      <div className="flex items-center h-full">
        {cursorLine > 0 && (
          <div className={cellClass(isRunning)} title="光标位置">
            <span>行 {cursorLine}，列 {cursorCol}</span>
          </div>
        )}
        {language && (
          <div className={cellClass(isRunning)} title="文件语言">
            <FileCode size={11} />
            <span>{prettyLanguage(language)}</span>
          </div>
        )}
        {providerLabel && (
          <div className={cellClass(isRunning)} title="当前模型">
            <Activity size={11} />
            <span className="truncate max-w-[180px]">{providerLabel}</span>
          </div>
        )}
        <div className={cellClass(isRunning)} title="编码">
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  )
}

function cellClass(isRunning: boolean): string {
  return [
    'flex items-center gap-1.5 h-full px-2.5 transition-colors',
    isRunning
      ? 'hover:bg-primary/80'
      : 'hover:bg-accent/40 hover:text-foreground'
  ].join(' ')
}

function prettyLanguage(id: string): string {
  const map: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON',
    html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    markdown: 'Markdown', python: 'Python', go: 'Go', rust: 'Rust',
    java: 'Java', kotlin: 'Kotlin', ruby: 'Ruby', php: 'PHP',
    c: 'C', cpp: 'C++', shell: 'Shell', yaml: 'YAML',
    sql: 'SQL', xml: 'XML', plaintext: 'Plain Text'
  }
  return map[id] ?? id
}
