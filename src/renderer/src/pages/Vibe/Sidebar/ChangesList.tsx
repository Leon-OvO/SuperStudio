import { GitCommit, RotateCcw, RefreshCw, Plus, Minus, Undo2, GitBranchPlus } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useInputDialog } from '../../../components/ui/InputDialog'
import { useConfirmDialog } from '../../../components/ui/ConfirmDialog'
import type { GitStatusInfo, GitFileChange } from '../../../../../shared/ipc-types'

interface Props {
  status: GitStatusInfo | null
  onOpenDiff: (path: string) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onRevertFile: (path: string) => void
  onCommit: (message: string) => void
  onRollback: () => void
  onInit: () => void
  onRefresh: () => void
}

const KIND_STYLE: Record<GitFileChange['kind'], { label: string; cls: string }> = {
  M: { label: 'M', cls: 'text-amber-500' },
  A: { label: 'A', cls: 'text-emerald-500' },
  D: { label: 'D', cls: 'text-red-500' },
  R: { label: 'R', cls: 'text-sky-500' },
  C: { label: 'C', cls: 'text-sky-500' },
  U: { label: 'U', cls: 'text-red-500' },
  '?': { label: 'U', cls: 'text-emerald-400' },
}

function baseName(p: string): string { return p.split('/').pop() ?? p }
function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function ChangesList({
  status, onOpenDiff, onStage, onUnstage, onRevertFile, onCommit, onRollback, onInit, onRefresh,
}: Props) {
  const input = useInputDialog()
  const confirm = useConfirmDialog()

  async function handleCommit() {
    const msg = await input.ask({
      title: '提交更改',
      description: '把当前改动提交到 git 历史。若已暂存部分文件，则只提交已暂存的；否则提交全部。',
      placeholder: '提交说明，例如：实现登录表单',
      defaultValue: 'AI 改动',
      confirmLabel: '提交',
      validate: v => v.trim() ? null : '请填写提交说明',
    })
    if (msg) onCommit(msg.trim())
  }

  async function handleRevert(path: string) {
    if (await confirm.confirm({ message: `放弃「${baseName(path)}」的改动？此操作不可撤销。`, tone: 'danger' })) {
      onRevertFile(path)
    }
  }

  async function handleRollback() {
    if (await confirm.confirm({ message: '回滚到本次 AI 改动之前？运行后新增的文件会被删除、被改的文件会还原。', tone: 'danger' })) {
      onRollback()
    }
  }

  // ── Empty / unavailable states ──────────────────────────────────────────
  if (!status) {
    return <Shell><div className="p-3 text-xs text-muted-foreground">加载中…</div></Shell>
  }
  if (!status.gitAvailable) {
    return (
      <Shell>
        <div className="p-3 text-xs text-muted-foreground leading-relaxed">
          未检测到 <b>git</b>，无法启用改动评审。安装 git 后重启即可使用「逐文件 / 逐块审阅 + 一键回滚」。
          <div className="mt-1 text-muted-foreground/70">（不影响 AI 正常改代码。）</div>
        </div>
      </Shell>
    )
  }
  if (!status.isRepo) {
    return (
      <Shell>
        <div className="p-3 text-xs text-muted-foreground leading-relaxed space-y-2">
          <div>该项目还不是 git 仓库，暂无法审阅 / 回滚 AI 的改动。</div>
          <button
            onClick={onInit}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90"
          >
            <GitBranchPlus size={12} /> 启用版本快照（git init）
          </button>
        </div>
        {input.element}
        {confirm.element}
      </Shell>
    )
  }

  const staged = status.files.filter(f => f.staged)
  const unstaged = status.files.filter(f => !f.staged || (f.working !== ' ' && f.working !== ''))
  const total = status.files.length

  return (
    <Shell
      header={
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wide">更改</span>
          {total > 0 && <span className="text-[10px] px-1 rounded bg-muted-foreground/15 tabular-nums">{total}</span>}
          <div className="flex-1" />
          <IconBtn title="刷新" onClick={onRefresh}><RefreshCw size={12} /></IconBtn>
          <IconBtn title="提交" onClick={handleCommit} disabled={total === 0}><GitCommit size={13} /></IconBtn>
          {status.hasCheckpoint && (
            <IconBtn title="回滚到本次改动前" onClick={handleRollback}><RotateCcw size={13} /></IconBtn>
          )}
        </div>
      }
    >
      {total === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">没有未提交的改动。</div>
      ) : (
        <div className="overflow-y-auto flex-1">
          {staged.length > 0 && (
            <Group title="暂存的更改" count={staged.length}>
              {staged.map(f => (
                <Row key={'s:' + f.path} f={f} onOpen={() => onOpenDiff(f.path)}
                  actions={[
                    { title: '取消暂存', icon: <Minus size={12} />, onClick: () => onUnstage(f.path) },
                    { title: '放弃改动', icon: <Undo2 size={12} />, onClick: () => handleRevert(f.path), danger: true },
                  ]} />
              ))}
            </Group>
          )}
          <Group title="更改" count={unstaged.length}>
            {unstaged.map(f => (
              <Row key={'u:' + f.path} f={f} onOpen={() => onOpenDiff(f.path)}
                actions={[
                  { title: '放弃改动', icon: <Undo2 size={12} />, onClick: () => handleRevert(f.path), danger: true },
                  { title: '暂存', icon: <Plus size={12} />, onClick: () => onStage(f.path) },
                ]} />
            ))}
          </Group>
        </div>
      )}
      {input.element}
      {confirm.element}
    </Shell>
  )
}

function Shell({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-9 px-2.5 flex items-center border-b border-border/60 shrink-0">
        {header ?? <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wide">更改</span>}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1">
        {title} <span className="tabular-nums">{count}</span>
      </div>
      {children}
    </div>
  )
}

interface RowAction { title: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }
function Row({ f, onOpen, actions }: { f: GitFileChange; onOpen: () => void; actions: RowAction[] }) {
  const ks = KIND_STYLE[f.kind]
  const dir = dirName(f.path)
  return (
    <div
      onClick={onOpen}
      className="group flex items-center gap-1.5 px-2.5 h-6 text-xs cursor-pointer hover:bg-accent/40"
      title={f.path}
    >
      <span className="truncate flex-1 min-w-0">
        {baseName(f.path)}
        {dir && <span className="ml-1.5 text-[10px] text-muted-foreground/50 truncate">{dir}</span>}
      </span>
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        {actions.map((a, i) => (
          <button
            key={i}
            onClick={e => { e.stopPropagation(); a.onClick() }}
            className={cn('p-0.5 rounded hover:bg-foreground/10', a.danger ? 'text-red-500/80 hover:text-red-500' : 'text-muted-foreground hover:text-foreground')}
            title={a.title}
          >
            {a.icon}
          </button>
        ))}
      </span>
      <span className={cn('w-3 text-center font-bold shrink-0', ks.cls)}>{ks.label}</span>
    </div>
  )
}

function IconBtn({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
