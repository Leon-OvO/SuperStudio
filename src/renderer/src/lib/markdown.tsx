import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { cn } from './utils'

interface MarkdownProps {
  content: string
  /** Smaller code padding / tighter spacing when rendered inside a chat bubble. */
  compact?: boolean
  className?: string
}

/**
 * Themed Markdown renderer powered by `react-markdown` + `remark-gfm`.
 * Supports tables, task lists, strikethrough, and proper inline/block code.
 * Code blocks expose a per-block copy button.
 */
export function Markdown({ content, compact = false, className }: MarkdownProps) {
  return (
    <div className={cn('markdown-body break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headings
          h1: ({ children }) => <h1 className="text-2xl font-bold mt-3 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-semibold mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-semibold mt-2 mb-1.5">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-semibold mt-2 mb-1">{children}</h4>,

          // Paragraphs / text
          p:  ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em:     ({ children }) => <em className="italic">{children}</em>,
          del:    ({ children }) => <del className="text-muted-foreground">{children}</del>,

          // Lists
          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
          li: ({ children, ...props }) => {
            // GFM task lists render with an <input type="checkbox">; style it tighter
            const isTask = (props as { checked?: boolean | null }).checked != null
            return <li className={cn(isTask && 'list-none -ml-5 flex items-start gap-1.5')}>{children}</li>
          },

          // Blockquote
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-border/80 pl-4 py-1 my-2 italic text-muted-foreground">
              {children}
            </blockquote>
          ),

          // Links — always open externally
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
              {children}
            </a>
          ),

          // Tables (GFM)
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          th:    ({ children }) => <th className="border-b border-border px-3 py-1.5 text-left font-medium">{children}</th>,
          td:    ({ children }) => <td className="border-t border-border/40 px-3 py-1.5">{children}</td>,

          // Horizontal rule
          hr: () => <hr className="border-border my-3" />,

          // Images — render inside a constrained container so they don't blow up the bubble
          img: ({ src, alt }) => (
            <img src={src} alt={alt || ''} className="max-w-full max-h-[400px] rounded-md my-2" />
          ),

          // Code: distinguish inline vs block. `<pre>` wraps fenced code so we identify
          // blocks by the parent context — `inline` is provided by react-markdown.
          code: (props) => {
            const { className: codeClass, children } = props as {
              className?: string
              children?: React.ReactNode
              inline?: boolean
            }
            // react-markdown v9+ removed the `inline` prop; infer instead by language fence
            const text = String(children ?? '').replace(/\n$/, '')
            const langMatch = /language-(\w+)/.exec(codeClass || '')
            const isBlock = !!langMatch || text.includes('\n')
            if (!isBlock) {
              return (
                <code className="px-1 py-0.5 rounded bg-muted text-[0.9em] font-mono break-words">
                  {children}
                </code>
              )
            }
            return <CodeBlock language={langMatch?.[1] ?? ''} code={text} compact={compact} />
          },
          // Suppress react-markdown's default <pre> wrapper since CodeBlock provides its own
          pre: ({ children }) => <>{children}</>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** Code block with a per-block copy button revealed on hover. */
function CodeBlock({ language, code, compact }: { language: string; code: string; compact: boolean }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.error('[markdown] copy failed:', e)
    }
  }
  return (
    <div className="group my-3 rounded-lg border border-border bg-muted/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border/60 text-xs text-muted-foreground select-none">
        <span className="font-mono">{language || 'text'}</span>
        <button
          onClick={copy}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 rounded transition-all',
            'opacity-60 hover:opacity-100 hover:bg-accent',
            copied && '!opacity-100 text-green-600'
          )}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={cn('overflow-x-auto', compact ? 'p-2.5' : 'p-3')}>
        <code className="font-mono text-sm leading-relaxed text-foreground/90 whitespace-pre">
          {code}
        </code>
      </pre>
    </div>
  )
}

/**
 * Backward-compatible function form — kept so existing call sites that did
 * `{renderMarkdown(text)}` keep working without imports churn.
 */
export function renderMarkdown(content: string): React.ReactNode {
  return <Markdown content={content} />
}
