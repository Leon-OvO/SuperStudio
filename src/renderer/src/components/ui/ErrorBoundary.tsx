import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Copy } from 'lucide-react'
import { toast } from './Toast'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  info: string | null
}

/**
 * Catches uncaught React render errors so an exception in one page (e.g. a
 * crash inside ImageEditor) doesn't leave the user staring at a blank window
 * with no recourse. Shows the error + a "Reload" button and a "Copy details"
 * button so users can paste the trace into a bug report.
 *
 * Note: doesn't catch errors in event handlers / async code — those go to
 * `window.addEventListener('error')` / `'unhandledrejection'` which we also
 * surface separately if the user is so unlucky as to hit them.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary] caught render error:', error, info)
    this.setState({ info: info?.componentStack ?? null })
  }

  reset = () => this.setState({ error: null, info: null })

  reload = () => window.location.reload()

  copyDetails = async () => {
    const { error, info } = this.state
    if (!error) return
    const text = [
      `Error: ${error.message}`,
      '',
      'Stack:',
      error.stack ?? '(no stack)',
      '',
      'Component stack:',
      info ?? '(no component stack)'
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success('错误详情已复制到剪贴板')
    } catch (e) {
      console.error('clipboard write failed', e)
      toast.error('复制失败：' + (e as Error).message)
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="fixed inset-0 z-[1000] bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-xl w-full space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
              <AlertTriangle size={20} className="text-destructive" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">界面出错了</h1>
              <p className="text-sm text-muted-foreground">应用内部抛出了未捕获的异常，当前页面无法继续渲染。</p>
            </div>
          </div>

          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {this.state.error.message}
            {this.state.error.stack && (
              <>
                {'\n\n'}
                {this.state.error.stack}
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={this.reload} className="btn-primary">
              <RefreshCw size={13} /> 重新加载
            </button>
            <button onClick={this.reset} className="btn-secondary">
              试着恢复
            </button>
            <button onClick={this.copyDetails} className="btn-secondary">
              <Copy size={13} /> 复制详情
            </button>
          </div>

          <p className="text-xs text-muted-foreground/70">
            如果重新加载后问题再次出现，请把错误详情贴给项目维护者，或在 GitHub 上提 issue。
            本地数据不会因为这次崩溃丢失。
          </p>
        </div>
      </div>
    )
  }
}
