/**
 * Mirrors the DB state of a Vibe request to OpenSpec-compatible markdown
 * artifacts on disk, so the work is git-trackable and readable from the
 * existing `opsx:*` skills.
 *
 *   <projectPath>/openspec/changes/<slug>/proposal.md
 *   <projectPath>/openspec/changes/<slug>/tasks.md
 *
 * One-way sync only — DB is source of truth; we never read .md back.
 */

import fs from 'fs'
import path from 'path'
import type { VibeTaskRow } from './vibe-db'

function changesDir(projectPath: string, slug: string): string {
  return path.join(projectPath, 'openspec', 'changes', slug)
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function writeProposalMd(args: {
  projectPath: string
  slug: string
  title: string
  summary: string
}): void {
  const dir = changesDir(args.projectPath, args.slug)
  ensureDir(dir)
  const body = `# ${args.title}

## Why
${args.summary || '(待补充)'}

## What changes
此变更的具体内容详见同目录下的 tasks.md。

## Impact
- 影响范围：需在实施过程中确认
- Affected specs: (待补充)
- Affected code: (实施过程中按需更新)
`
  fs.writeFileSync(path.join(dir, 'proposal.md'), body, 'utf8')
}

export function writeTasksMd(args: {
  projectPath: string
  slug: string
  tasks: VibeTaskRow[]
}): void {
  const dir = changesDir(args.projectPath, args.slug)
  ensureDir(dir)

  const lines: string[] = []
  lines.push('# 实施任务')
  lines.push('')
  lines.push('## 1. 任务列表')
  lines.push('')
  for (const t of args.tasks) {
    const marker =
      t.status === 'done' ? 'x' :
      t.status === 'running' ? '~' :
      t.status === 'error' ? '!' :
      t.status === 'skipped' ? '-' :
      ' '
    lines.push(`- [${marker}] 1.${t.ord} ${t.title}`)
    if (t.description?.trim()) {
      // Indented description so OpenSpec / human readers see the context
      for (const dl of t.description.trim().split(/\r?\n/)) {
        lines.push(`  ${dl}`)
      }
    }
    if (t.status === 'error' && t.error_text) {
      lines.push(`  > ⚠️ ${t.error_text}`)
    }
  }
  lines.push('')
  fs.writeFileSync(path.join(dir, 'tasks.md'), lines.join('\n'), 'utf8')
}
