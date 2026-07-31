import { useEffect, useState } from 'react'
import { Cpu, ChevronDown } from 'lucide-react'
import {
  RUNTIME_ADAPTERS_READY,
  type DetectedRuntime,
  type RuntimeKind,
  type SessionRuntime,
} from '../../../shared/ipc-types'
import { Select, type SelectOption } from './ui/Select'

/** 「跟随全局默认」在下拉里用这个哨兵值表示（Select 的 value 不能是 null）。 */
const FOLLOW = '__follow__'
type PickerValue = SessionRuntime | typeof FOLLOW

interface Props {
  /** 当前会话的引擎覆盖；null/undefined = 跟随全局默认。 */
  value: SessionRuntime | null | undefined
  onChange: (runtime: SessionRuntime | null) => void
  disabled?: boolean
}

const LABEL: Record<SessionRuntime, string> = {
  builtin: '内置',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
}

/** 切到外部 CLI 后确实不透传的东西——静默失能最坑人，直接写在选项里。 */
const CLI_CAVEAT = '附件 / 群聊 / 员工人设 / 思考模式不生效；生图与技能已接入'

/**
 * 引擎（Agent 运行时）选择器，挂在输入框底栏 —— 让「这轮由谁来答」随时可见、随时可换。
 *
 * 作用域是**本会话**：写代码的会话想用 Claude Code、聊天出图的会话想用内置引擎，
 * 全局一刀切不够用。未选 = 跟随设置里的全局默认。
 */
export function RuntimePicker({ value, onChange, disabled }: Props) {
  const [runtimes, setRuntimes] = useState<DetectedRuntime[]>([])
  const [globalDefault, setGlobalDefault] = useState<RuntimeKind | null>(null)

  useEffect(() => {
    let alive = true
    window.api.runtimeList().then(r => {
      if (alive && r.ok && r.runtimes) setRuntimes(r.runtimes)
    }).catch(() => {})
    window.api.runtimeGetDefault().then(r => {
      if (alive && r.ok) setGlobalDefault(r.chosen ?? null)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const followLabel = globalDefault ? LABEL[globalDefault] : LABEL.builtin
  const options: SelectOption<PickerValue>[] = [
    { value: FOLLOW, label: '跟随全局', hint: `当前：${followLabel}` },
    { value: 'builtin', label: '内置引擎（自研）', hint: '技能 / 记忆 / 生图 / MCP 全在' },
    ...RUNTIME_ADAPTERS_READY.map<SelectOption<PickerValue>>(kind => {
      const found = runtimes.find(r => r.kind === kind)
      const available = !!found?.available
      return {
        value: kind,
        label: LABEL[kind],
        hint: available ? CLI_CAVEAT : '未安装',
        disabled: !available,
      }
    }),
  ]

  const current: PickerValue = value ?? FOLLOW
  // 芯片上只显示「实际生效的那个」，别让用户为了知道现在是谁再点开一次。
  const effective: SessionRuntime = value ?? globalDefault ?? 'builtin'

  return (
    <Select
      value={current}
      onChange={v => onChange(v === FOLLOW ? null : (v as SessionRuntime))}
      options={options}
      disabled={disabled}
      placement="top"
      popoverWidth={248}
      title="本对话使用的引擎"
      trigger={({ open }) => (
        <span
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all
            ${open
              ? 'bg-muted text-foreground ring-1 ring-ring/40'
              : 'bg-muted/40 text-foreground/80 hover:bg-muted/70 hover:text-foreground'}
            ${effective !== 'builtin' ? '!text-primary' : ''}`}
          title={
            effective === 'builtin'
              ? '引擎：内置（自研）—— 技能 / 记忆 / 生图 / MCP 全在'
              : `引擎：${LABEL[effective]} —— ${CLI_CAVEAT}`
          }
        >
          <Cpu size={11} className="shrink-0" />
          <span className="truncate">引擎·{LABEL[effective]}</span>
          <ChevronDown size={11} className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      )}
    />
  )
}
