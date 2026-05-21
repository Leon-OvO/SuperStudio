import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useUIStore } from '../../../stores/ui'

interface Props {
  projectPath: string
}

function pickFontFamily(): string {
  if (navigator.platform.startsWith('Win')) return 'Consolas, "Cascadia Mono", monospace'
  if (navigator.platform.startsWith('Mac')) return 'Menlo, "SF Mono", monospace'
  return '"DejaVu Sans Mono", monospace'
}

function makeTheme(isDark: boolean): Record<string, string> {
  return isDark
    ? {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#264f78'
      }
    : {
        background: '#ffffff',
        foreground: '#171717',
        cursor: '#171717',
        cursorAccent: '#ffffff',
        selectionBackground: '#add6ff'
      }
}

export function TerminalPanel({ projectPath }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDark = useUIStore(u => u.theme === 'dark')
  const [bootError, setBootError] = useState<string | null>(null)

  // Lifecycle: create xterm + spawn PTY tied to projectPath. Re-runs when path changes.
  useEffect(() => {
    if (!containerRef.current || !projectPath) return
    let disposed = false

    const term = new Terminal({
      fontFamily: pickFontFamily(),
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: makeTheme(isDark)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    // Initial sizing — wait one frame so the container has measured dimensions
    requestAnimationFrame(async () => {
      if (disposed) return
      try { fit.fit() } catch { /* container not laid out yet */ }
      const cols = term.cols
      const rows = term.rows
      const res = await window.api.terminalCreate({ cwd: projectPath, cols, rows })
      if (disposed) return
      if (!res?.ok || !res.id) {
        const msg = res?.error || '终端启动失败 — node-pty 未安装或加载失败'
        setBootError(msg)
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`)
        return
      }
      ptyIdRef.current = res.id

      // Pipe keystrokes → PTY (fire-and-forget for low latency)
      term.onData(data => {
        if (ptyIdRef.current) window.api.terminalWrite({ id: ptyIdRef.current, data })
      })
      // Pipe PTY data → xterm (filter by our own id)
      const offData = window.api.onTerminalData(({ id, data }) => {
        if (id === ptyIdRef.current) term.write(data)
      })
      const offExit = window.api.onTerminalExit(({ id, exitCode }) => {
        if (id !== ptyIdRef.current) return
        term.write(`\r\n\x1b[2m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
        ptyIdRef.current = null
      })
      // Stash cleanups on the term for the unmount path to find
      ;(term as Terminal & { _ssCleanups?: Array<() => void> })._ssCleanups = [offData, offExit]
    })

    termRef.current = term
    fitRef.current = fit

    // Container resize → fit() → notify PTY (debounced)
    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        if (disposed) return
        try { fit.fit() } catch { /* not laid out */ }
        const id = ptyIdRef.current
        if (id) {
          window.api.terminalResize({ id, cols: term.cols, rows: term.rows }).catch(() => { /* dead session */ })
        }
      }, 80)
    })
    ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      const cleanups = (term as Terminal & { _ssCleanups?: Array<() => void> })._ssCleanups
      cleanups?.forEach(fn => { try { fn() } catch { /* ignore */ } })
      if (ptyIdRef.current) {
        window.api.terminalDispose({ id: ptyIdRef.current }).catch(() => { /* ignore */ })
        ptyIdRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [projectPath])

  // Theme reactive — swap colors without disposing the PTY
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = makeTheme(isDark)
    }
  }, [isDark])

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 ss-xterm-host"
        style={{ padding: '4px 8px', background: isDark ? '#0a0a0a' : '#ffffff' }}
      />
      {bootError && (
        <div className="px-3 py-1 text-[11px] bg-destructive/10 text-destructive border-t border-border">
          {bootError}
        </div>
      )}
    </div>
  )
}
