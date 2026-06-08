import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { Check, X, FileCheck2, Undo2, RefreshCw } from 'lucide-react'
// Side-effect: configure monaco loader (shared with MonacoFileEditor).
import './setup'
import { cn } from '../../../lib/utils'
import type { GitDiffInfo } from '../../../../../shared/ipc-types'

interface Props {
  projectPath: string
  filePath: string
  isDark: boolean
  /** Bump to force a re-fetch (e.g. after the agent writes more files). */
  refreshToken?: number
  /** Called after a stage/revert mutates git state, so the sidebar can refresh. */
  onAfterMutate?: () => void
}

function langOf(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', md: 'markdown', py: 'python', go: 'go',
    rs: 'rust', java: 'java', rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'cpp',
    sh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql', xml: 'xml',
  }
  return map[ext] ?? 'plaintext'
}

function baseName(p: string): string { return p.split(/[\\/]/).pop() ?? p }

export function MonacoDiffEditor({ projectPath, filePath, isDark, refreshToken, onAfterMutate }: Props) {
  const [diff, setDiff] = useState<GitDiffInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await window.api.vibeGitDiff?.(projectPath, filePath) as GitDiffInfo | undefined
      setDiff(d ?? null)
    } catch {
      setDiff(null)
    } finally {
      setLoading(false)
    }
  }, [projectPath, filePath])

  useEffect(() => { load() }, [load, refreshToken])

  const run = useCallback(async (op: () => Promise<unknown>) => {
    setBusy(true)
    try { await op(); await load(); onAfterMutate?.() }
    finally { setBusy(false) }
  }, [load, onAfterMutate])

  const hunkCount = diff?.hunkCount ?? 0

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-card/50 shrink-0 text-xs">
        <span className="font-medium truncate">{baseName(filePath)}</span>
        <span className="text-muted-foreground/60 text-[11px]">差异（对比已提交版本）</span>
        <div className="flex-1" />
        <button
          onClick={() => run(() => window.api.vibeGitStage!(projectPath, filePath))}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
          title="接受全部改动（暂存该文件）"
        >
          <FileCheck2 size={12} /> 接受全部
        </button>
        <button
          onClick={() => run(() => window.api.vibeGitRevertFile!(projectPath, filePath))}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-40"
          title="还原全部改动（丢弃该文件的改动）"
        >
          <Undo2 size={12} /> 还原全部
        </button>
        <button onClick={() => load()} disabled={busy} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50" title="刷新">
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Per-hunk controls */}
      {hunkCount > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/60 bg-card/30 shrink-0 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 shrink-0">改动块</span>
          {Array.from({ length: hunkCount }, (_, i) => (
            <span key={i} className="inline-flex items-center rounded border border-border/70 overflow-hidden shrink-0">
              <span className="px-1.5 text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
              <button
                onClick={() => run(() => window.api.vibeGitStageHunk!(projectPath, filePath, i))}
                disabled={busy}
                className="px-1 py-0.5 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-40"
                title={`接受块 ${i + 1}（暂存）`}
              >
                <Check size={11} />
              </button>
              <button
                onClick={() => run(() => window.api.vibeGitRevertHunk!(projectPath, filePath, i))}
                disabled={busy}
                className="px-1 py-0.5 text-red-500 hover:bg-red-500/10 disabled:opacity-40 border-l border-border/70"
                title={`还原块 ${i + 1}（丢弃）`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Diff body */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className={cn('h-full flex items-center justify-center text-xs text-muted-foreground gap-2')}>
            <span className="animate-pulse">⏳</span> 正在加载差异…
          </div>
        ) : !diff ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">无法读取差异</div>
        ) : diff.binary ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">二进制文件，无法显示差异</div>
        ) : (
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={langOf(filePath)}
            theme={isDark ? 'vs-dark' : 'light'}
            options={{
              readOnly: true,
              renderSideBySide: true,
              fontSize: 13,
              fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
            }}
          />
        )}
      </div>
    </div>
  )
}
