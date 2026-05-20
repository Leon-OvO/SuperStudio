import { useEffect, useRef } from 'react'
import Editor, { type Monaco } from '@monaco-editor/react'
import type * as MonacoNS from 'monaco-editor'
// Side-effect: configures monaco loader to use the bundled module + Vite workers
import './setup'

interface Props {
  /** Absolute file path — used to derive Monaco language */
  filePath: string
  /** Current content (controlled) */
  value: string
  /** Called when user edits */
  onChange: (next: string) => void
  /** Called on Ctrl+S */
  onSave: () => void
  theme?: 'vs-dark' | 'light'
}

/** Derive Monaco's language id from a file extension. Falls back to plaintext. */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'cpp',
    sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', xml: 'xml', vue: 'html', svelte: 'html'
  }
  return map[ext] ?? 'plaintext'
}

export function MonacoFileEditor({ filePath, value, onChange, onSave, theme = 'vs-dark' }: Props) {
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef(onSave)
  useEffect(() => { saveRef.current = onSave }, [onSave])

  function handleMount(editor: MonacoNS.editor.IStandaloneCodeEditor, monaco: Monaco) {
    editorRef.current = editor
    // Ctrl+S / Cmd+S → onSave
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
  }

  return (
    <Editor
      path={filePath}
      language={detectLanguage(filePath)}
      value={value}
      theme={theme}
      onMount={handleMount}
      onChange={(v) => onChange(v ?? '')}
      loading={
        <div className="flex items-center justify-center h-full bg-muted/20 text-xs text-muted-foreground gap-2">
          <span className="animate-pulse">⏳</span>
          正在加载编辑器…
        </div>
      }
      options={{
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
        // VS Code–style minimap on the right for quick navigation, matching
        // the MessagesMinimap we added to the conversation panel.
        minimap: {
          enabled: true,
          renderCharacters: false,
          maxColumn: 80,
          size: 'proportional',
          showSlider: 'always'
        },
        // Make scrollbars obvious — the default 14px+auto-hide is too subtle
        // on dense files. Match the prominence of .scrollbar-prominent in the
        // chat panel: always-visible track + a chunky thumb.
        scrollbar: {
          vertical: 'visible',
          horizontal: 'visible',
          verticalScrollbarSize: 14,
          horizontalScrollbarSize: 12,
          verticalSliderSize: 14,
          horizontalSliderSize: 12,
          useShadows: true,
          alwaysConsumeMouseWheel: false
        },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        insertSpaces: true,
        automaticLayout: true,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        wordWrap: 'on',
        padding: { top: 8 }
      }}
    />
  )
}
