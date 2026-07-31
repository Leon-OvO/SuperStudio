import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Cpu, Check, Download } from 'lucide-react'
import { SettingsGroup } from '../../components/ui/SettingsList'
import { toast } from '../../components/ui/Toast'
import type { DetectedRuntime, RuntimeKind } from '../../../../shared/ipc-types'
import { RUNTIME_ADAPTERS_READY } from '../../../../shared/ipc-types'

/**
 * 「选一个 agent 运行时」面板（pc-runtime-discovery / PRD §9.6）。
 * 探测本机装了哪些 AI 编程工具（Claude Code / Codex / OpenCode），选一个作默认；可刷新、可随时切换。
 * 自成一体、可复用——设置页与新手引导步骤都用它。文案中性（不露内部术语）。
 */

interface Supported {
  kind: RuntimeKind
  displayName: string
}

export function RuntimePanel(): JSX.Element {
  const [runtimes, setRuntimes] = useState<DetectedRuntime[] | null>(null)
  const [supported, setSupported] = useState<Supported[]>([])
  const [chosen, setChosen] = useState<RuntimeKind | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // 'builtin' 哨兵表示正在切回内置自研引擎（chosen=null）。
  const [saving, setSaving] = useState<RuntimeKind | 'builtin' | null>(null)

  const load = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    try {
      const r = refresh ? await window.api.runtimeRefresh() : await window.api.runtimeList()
      if (r.supported) setSupported(r.supported)
      if (r.ok && r.runtimes) setRuntimes(r.runtimes)
      else if (!r.ok) toast.error(r.error || '探测运行时失败')
      const d = await window.api.runtimeGetDefault()
      if (d.ok) setChosen(d.chosen)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      if (refresh) setRefreshing(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // kind=null → 切回内置自研引擎。
  async function select(kind: RuntimeKind | null): Promise<void> {
    setSaving(kind ?? 'builtin')
    try {
      const r = await window.api.runtimeSetDefault(kind)
      if (!r.ok) throw new Error(r.error || '保存失败')
      setChosen(r.chosen ?? kind)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const byKind = new Map((runtimes ?? []).map((r) => [r.kind, r]))
  const rows = supported.map((s) => ({ ...s, det: byKind.get(s.kind) ?? null }))
  const detectedCount = (runtimes ?? []).filter((r) => r.available).length
  // 「可用」= 已安装且有可执行适配器（能真正被 runCloudTask 起）。
  const usableCount = (runtimes ?? []).filter((r) => r.available && RUNTIME_ADAPTERS_READY.includes(r.kind)).length
  const total = supported.length

  return (
    <div className="space-y-3 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Cpu className="w-4 h-4" /> Agent 运行时
        </h2>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          默认使用 SuperStudio <strong>内置自研引擎</strong>（技能、记忆、MCP 等能力全部可用）。也可改用这台电脑上的一款 AI
          编程工具（如 Claude Code、Codex）来跑复杂的活——但注意：<strong>选用外部运行时后，对话改由它自带的工具循环执行，内置的技能 /
          记忆 / MCP 不再生效</strong>。装了多个可随时切换，也能随时切回内置引擎。
        </p>
      </div>

      {/* 计数 + 刷新 */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-muted-foreground">
          {loading ? '正在探测本机…' : `${usableCount} / ${total} 个可用`}
        </span>
        <button
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
          title="重新探测（装好新工具后点这里）"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* 内置自研引擎：默认选项，永远置顶，可一键切回 */}
          <SettingsGroup footnote="内置引擎随应用更新，无需在本机另装任何工具。">
            <button
              disabled={saving !== null}
              onClick={() => void select(null)}
              className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/40 disabled:cursor-not-allowed"
            >
              <span className="w-2 h-2 rounded-full shrink-0 bg-green-500" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                  <span>内置引擎（自研）</span>
                  <span className="text-[11px] font-normal text-green-600">默认</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  SuperStudio 自带对话引擎，技能 / 记忆 / MCP 等能力全部可用。
                </p>
              </div>
              {saving === 'builtin' ? (
                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-muted-foreground" />
              ) : chosen === null ? (
                <Check className="w-4 h-4 shrink-0 text-primary" />
              ) : (
                <span className="w-4 h-4 shrink-0 rounded-full border border-border" aria-hidden />
              )}
            </button>
          </SettingsGroup>

          {detectedCount === 0 ? (
        // 一个都没检测到：安装引导，不空屏
        <SettingsGroup footnote="装好后回来点「刷新」即可出现在列表里。">
          <div className="px-4 py-6 flex flex-col items-center gap-2 text-center">
            <Download className="w-6 h-6 text-muted-foreground" />
            <div className="text-sm font-medium">还没检测到可用的运行时</div>
            <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
              先安装一款 AI 编程工具（如 Claude Code、Codex 或 OpenCode）到这台电脑，它就会作为「运行时」出现在这里。
            </p>
          </div>
        </SettingsGroup>
      ) : (
        <SettingsGroup
          footnote={
            chosen
              ? `当前使用：${supported.find((s) => s.kind === chosen)?.displayName ?? chosen} · 内置技能 / 记忆 / MCP 交由它自身处理 · 可随时切回内置引擎`
              : '当前使用内置引擎；选一款外部运行时即改由它执行（内置技能 / 记忆 / MCP 将不再生效）。'
          }
        >
          {rows.map((row) => {
            const avail = !!row.det?.available
            const ready = RUNTIME_ADAPTERS_READY.includes(row.kind) // 有可执行适配器
            const selectable = avail && ready
            const isChosen = chosen === row.kind
            // 状态标签：可用 / 即将支持(装了但适配器未就绪) / 未安装
            const statusLabel = !avail ? '未安装' : ready ? '可用' : '即将支持'
            const statusColor = selectable ? 'text-green-600' : 'text-muted-foreground'
            const desc = !avail
              ? '未在本机找到，安装后点「刷新」'
              : ready
                ? row.det?.execPath ?? ''
                : '已安装，适配器即将支持（暂不可选）'
            return (
              <button
                key={row.kind}
                disabled={!selectable || saving !== null}
                onClick={() => void select(row.kind)}
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/40 disabled:cursor-not-allowed"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${selectable ? 'bg-green-500' : avail ? 'bg-amber-400' : 'bg-muted-foreground/30'}`}
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                    <span className={avail ? '' : 'text-muted-foreground'}>{row.displayName}</span>
                    {row.det?.version && (
                      <span className="text-[11px] text-muted-foreground font-normal">v{row.det.version}</span>
                    )}
                    <span className={`text-[11px] font-normal ${statusColor}`}>{statusLabel}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{desc}</p>
                </div>
                {saving === row.kind ? (
                  <Loader2 className="w-4 h-4 animate-spin shrink-0 text-muted-foreground" />
                ) : isChosen ? (
                  <Check className="w-4 h-4 shrink-0 text-primary" />
                ) : selectable ? (
                  <span className="w-4 h-4 shrink-0 rounded-full border border-border" aria-hidden />
                ) : null}
              </button>
            )
          })}
        </SettingsGroup>
          )}
        </>
      )}
    </div>
  )
}
