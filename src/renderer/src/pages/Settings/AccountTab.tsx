import { useState, useEffect, useCallback, useRef } from 'react'
import {
  RefreshCw, LogOut, Loader2, Key, ChevronDown, Copy, Plus, Check, Trash2,
  Sparkles, ExternalLink, AlertCircle
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { CreateKeyDialog } from './CreateKeyDialog'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'
import type { AuthState, GroupKeyOptions, TokenPlanInfo, SubscriptionKeyView } from '../../../../shared/ipc-types'

interface Props {
  /** Notify parent after keys/providers change so it can re-fetch its provider list. */
  onProvidersRefresh?: () => Promise<void> | void
}

export function AccountTab({ onProvidersRefresh }: Props = {}) {
  const { user, setAuthState } = useAuthStore()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createDialogDefaultGroup, setCreateDialogDefaultGroup] = useState<number | undefined>()
  const [resetting, setResetting] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [resetError, setResetError] = useState('')
  const [keyOptions, setKeyOptions] = useState<GroupKeyOptions[]>([])
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [switchingGroup, setSwitchingGroup] = useState<number | null>(null)
  const [openDropdown, setOpenDropdown] = useState<number | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [subscription, setSubscription] = useState<TokenPlanInfo | null>(null)
  const [loadingPlans, setLoadingPlans] = useState(false)
  const [plansError, setPlansError] = useState<string | null>(null)
  const [subKey, setSubKey] = useState<SubscriptionKeyView>({ group: null, key: null })
  const [loadingSubKey, setLoadingSubKey] = useState(false)
  const [subKeyBusy, setSubKeyBusy] = useState<'create' | 'reset' | 'delete' | null>(null)
  const [autoCreating, setAutoCreating] = useState(false)
  const [autoCreateError, setAutoCreateError] = useState<string | null>(null)
  // Only auto-create once per mount — otherwise a failure or empty-key result
  // would re-trigger the loop every render.
  const autoCreatedRef = useRef(false)
  const dlg = useConfirmDialog()

  const loadKeyOptions = useCallback(async () => {
    setLoadingOptions(true)
    try {
      const opts = await window.api.listKeyOptions?.() as GroupKeyOptions[] | undefined
      setKeyOptions(opts ?? [])
    } finally {
      setLoadingOptions(false)
    }
  }, [])

  const loadPlans = useCallback(async () => {
    setLoadingPlans(true)
    setPlansError(null)
    try {
      const status = await window.api.getSubscriptionStatus?.() as TokenPlanInfo | null | undefined
      setSubscription(status ?? null)
    } catch (e) {
      setPlansError((e as Error).message || '获取套餐失败')
    } finally {
      setLoadingPlans(false)
    }
  }, [])

  const loadSubKey = useCallback(async () => {
    setLoadingSubKey(true)
    try {
      const view = await window.api.getSubscriptionKey?.() as SubscriptionKeyView | undefined
      setSubKey(view ?? { group: null, key: null })
    } catch (e) {
      console.warn('[account] loadSubKey failed:', (e as Error).message)
      setSubKey({ group: null, key: null })
    } finally {
      setLoadingSubKey(false)
    }
  }, [])

  useEffect(() => { loadKeyOptions(); loadPlans(); loadSubKey() }, [loadKeyOptions, loadPlans, loadSubKey])

  // Auto-create the Token Plan key when the user has an active subscription
  // but no subscription key exists yet — happens for users who logged in
  // before subscribing, or whose plans changed on supercode.help after first
  // setup. Without this they'd hit Settings → 模型 with no usable provider for
  // their plan and not know they need to click anything to bootstrap it.
  //
  // Uses SUBSCRIPTION_KEY_ENSURE which is idempotent and enforces the
  // single-key cap — safe to fire whenever subscription.status === 'active'
  // and subKey.key is null.
  useEffect(() => {
    if (autoCreatedRef.current) return
    if (loadingPlans || loadingSubKey || autoCreating) return
    if (!subscription || subscription.status !== 'active') return
    if (subKey.key) return  // already exists, nothing to do

    autoCreatedRef.current = true
    setAutoCreating(true)
    setAutoCreateError(null)
    ;(async () => {
      try {
        const view = await window.api.ensureSubscriptionKey?.() as SubscriptionKeyView
        setSubKey(view ?? { group: null, key: null })
        await loadKeyOptions()
        await onProvidersRefresh?.()
        toast.success('已根据当前套餐自动创建 Token Plan Key')
      } catch (e) {
        const msg = (e as Error).message || '自动创建失败'
        console.error('[account] auto-create token plan key failed:', msg)
        setAutoCreateError(msg)
      } finally {
        setAutoCreating(false)
      }
    })()
  }, [subscription, subKey, loadingPlans, loadingSubKey, autoCreating,
      loadKeyOptions, onProvidersRefresh])

  async function handleResetKeys() {
    if (!(await dlg.confirm('重置后将重新拉取所有平台的 Key，是否继续？'))) return
    setResetting(true)
    setResetError('')
    try {
      const state = await window.api.initAccount() as AuthState
      setAuthState(state)
      await loadKeyOptions()
      await loadPlans()
      await loadSubKey()
      await onProvidersRefresh?.()
    } catch (e) {
      setResetError((e as Error).message || '重置失败')
    } finally {
      setResetting(false)
    }
  }

  // Retry the auto-create flow after a failure. Resets the per-mount guard so
  // the effect can re-run; clearing autoCreateError makes the loading state
  // visible again immediately while we wait for ensureSubscriptionKey() to
  // resolve.
  async function retryAutoCreate() {
    autoCreatedRef.current = false
    setAutoCreateError(null)
    setAutoCreating(true)
    try {
      const view = await window.api.ensureSubscriptionKey?.() as SubscriptionKeyView
      setSubKey(view ?? { group: null, key: null })
      await loadKeyOptions()
      await onProvidersRefresh?.()
      toast.success('已根据当前套餐自动创建 Token Plan Key')
    } catch (e) {
      const msg = (e as Error).message || '自动创建失败'
      console.error('[account] retry auto-create failed:', msg)
      setAutoCreateError(msg)
      autoCreatedRef.current = true
    } finally {
      setAutoCreating(false)
    }
  }

  // ---- Token Plan key actions (single key per user) ----
  async function handleCreateSubKey() {
    setSubKeyBusy('create')
    setAutoCreateError(null)
    try {
      const view = await window.api.ensureSubscriptionKey?.() as SubscriptionKeyView
      setSubKey(view ?? { group: null, key: null })
      await loadKeyOptions()
      await onProvidersRefresh?.()
      toast.success('Token Plan Key 已创建')
    } catch (e) {
      toast.error('创建失败：' + (e as Error).message)
    } finally {
      setSubKeyBusy(null)
    }
  }

  async function handleResetSubKey() {
    if (!(await dlg.confirm({
      message: '重置会先删除当前 Token Plan Key 再创建新的，旧的 Key 立即失效。继续？',
      tone: 'danger',
      confirmLabel: '重置'
    }))) return
    setSubKeyBusy('reset')
    try {
      const view = await window.api.resetSubscriptionKey?.() as SubscriptionKeyView
      setSubKey(view ?? { group: null, key: null })
      await loadKeyOptions()
      await onProvidersRefresh?.()
      toast.success('Token Plan Key 已重置')
    } catch (e) {
      toast.error('重置失败：' + (e as Error).message)
    } finally {
      setSubKeyBusy(null)
    }
  }

  async function handleDeleteSubKey() {
    if (!subKey.key) return
    if (!(await dlg.confirm({
      message: `确定删除 Token Plan Key？删除后将无法在「设置 → 模型」中使用对应的套餐供应商，需要重新创建。`,
      tone: 'danger',
      confirmLabel: '删除'
    }))) return
    setSubKeyBusy('delete')
    try {
      await window.api.deleteSubscriptionKey?.({ keyId: subKey.key.id })
      setSubKey({ group: null, key: null })
      await loadKeyOptions()
      await onProvidersRefresh?.()
      toast.success('Token Plan Key 已删除')
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message)
    } finally {
      setSubKeyBusy(null)
    }
  }

  async function handleSelectKey(groupId: number, keyId: number) {
    setSwitchingGroup(groupId)
    setOpenDropdown(null)
    try {
      const state = await window.api.selectPlatformKey?.({ groupId, keyId }) as AuthState
      if (state) setAuthState(state)
      setKeyOptions(prev => prev.map(g =>
        g.groupId === groupId ? { ...g, selectedKeyId: keyId } : g
      ))
    } catch (e) {
      toast.error('切换失败：' + (e as Error).message)
    } finally {
      setSwitchingGroup(null)
    }
  }

  async function handleDeleteKey(keyId: number, keyName: string) {
    if (!(await dlg.confirm({
      message: `确定删除 Key「${keyName}」？此操作不可恢复。`,
      tone: 'danger',
      confirmLabel: '删除'
    }))) return
    try {
      await window.api.deleteKey?.({ keyId })
      await loadKeyOptions()
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message)
    }
  }

  async function handleCopyKey(keyId: number) {
    try {
      const res = await window.api.revealKey?.({ keyId }) as { key: string }
      if (!res?.key) throw new Error('未返回 Key')
      await navigator.clipboard.writeText(res.key)
      setCopiedKeyId(keyId)
      setTimeout(() => setCopiedKeyId(prev => prev === keyId ? null : prev), 1500)
    } catch (e) {
      toast.error('复制失败：' + (e as Error).message)
    }
  }

  function openCreateDialog(defaultGroupId?: number) {
    setCreateDialogDefaultGroup(defaultGroupId)
    setCreateDialogOpen(true)
  }

  async function handleLogoutConfirmed() {
    setLogoutConfirmOpen(false)
    setLoggingOut(true)
    try {
      await window.api.logout()
      // Hard reload the renderer — guarantees a clean state for the login form
      window.location.reload()
    } catch (e) {
      toast.error('退出失败：' + (e as Error).message)
      setLoggingOut(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl" onClick={() => setOpenDropdown(null)}>
      <h2 className="text-lg font-semibold">账号</h2>

      {/* User info */}
      <section className="border border-border rounded-lg p-4 space-y-2 bg-card">
        <h3 className="text-sm font-medium text-muted-foreground">用户信息</h3>
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground w-16">邮箱</span>
            <span className="font-medium">{user?.email || '—'}</span>
          </div>
          {user?.username && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground w-16">用户名</span>
              <span className="font-medium">{user.username}</span>
            </div>
          )}
        </div>
      </section>

      {/* Token Plans — what you bought, quota usage, supported models */}
      <section className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Sparkles size={13} className="text-primary" />
            当前套餐
          </h3>
          <button
            onClick={loadPlans}
            disabled={loadingPlans}
            className="btn-secondary text-xs flex items-center gap-1.5"
            title="重新拉取套餐信息"
          >
            {loadingPlans ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            刷新
          </button>
        </div>

        {loadingPlans && !subscription ? (
          <div className="px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> 加载中…
          </div>
        ) : plansError ? (
          <div className="px-4 py-4 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <div>
              {plansError}
              <button onClick={loadPlans} className="ml-2 underline hover:text-amber-600">重试</button>
            </div>
          </div>
        ) : !subscription ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            尚未订阅任何套餐 — <a href="https://www.supercode.help" target="_blank" rel="noreferrer" className="text-primary hover:underline">前往订阅 <ExternalLink size={10} className="inline -mt-0.5" /></a>
          </div>
        ) : (
          <TokenPlanCard
            plan={subscription}
            subKey={subKey}
            subKeyBusy={subKeyBusy}
            autoCreating={autoCreating}
            autoCreateError={autoCreateError}
            copiedKeyId={copiedKeyId}
            onCreate={handleCreateSubKey}
            onReset={handleResetSubKey}
            onDelete={handleDeleteSubKey}
            onCopy={handleCopyKey}
            onRetryAutoCreate={retryAutoCreate}
          />
        )}
      </section>

      {/* API Keys — per-platform with switcher + create + copy */}
      {/* NOTE: no `overflow-hidden` here — the per-row「切换」dropdown is absolutely
          positioned (top-full) and would be clipped by it. The section's children
          carry no corner-reaching backgrounds, so rounding still looks identical. */}
      <section className="border border-border rounded-lg bg-card">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Key size={13} />
            API Keys
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => openCreateDialog()}
              className="btn-secondary text-xs flex items-center gap-1.5"
              title="新建 Key（可选任意分组）"
            >
              <Plus size={12} /> 新建 Key
            </button>
            <button
              onClick={handleResetKeys}
              disabled={resetting || loadingOptions}
              className="btn-secondary text-xs flex items-center gap-1.5"
              title="重新获取所有平台的 Key 并自动补齐缺失的"
            >
              {resetting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              重置全部
            </button>
          </div>
        </div>

        {loadingOptions ? (
          <div className="px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> 加载中…
          </div>
        ) : keyOptions.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            暂无独立 API Key — 可点击「新建 Key」创建按需付费的 Key
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {keyOptions.map(group => {
              const activeKey = group.selectedKeyId
                ? group.keys.find(k => k.id === group.selectedKeyId) ?? group.keys[0]
                : group.keys[0]
              const isSwitching = switchingGroup === group.groupId
              const isOpen = openDropdown === group.groupId
              const hasMultiple = group.keys.length > 1

              return (
                <div key={group.groupId} className="px-4 py-3 flex items-center gap-2">
                  {/* Platform info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium truncate">{group.groupName}</span>
                      <span className="text-[10px] uppercase text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded shrink-0">
                        {group.platform}
                      </span>
                      {hasMultiple && (
                        <span className="text-[10px] text-muted-foreground/60 shrink-0">
                          {group.keys.length} 个 Key
                        </span>
                      )}
                    </div>
                    {activeKey && (
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {activeKey.name} · {activeKey.keyMasked}
                      </div>
                    )}
                  </div>

                  {/* Copy active key */}
                  {activeKey && (
                    <button
                      onClick={() => handleCopyKey(activeKey.id)}
                      className="btn-secondary text-xs px-2"
                      title="复制完整 Key 到剪贴板"
                    >
                      {copiedKeyId === activeKey.id
                        ? <><Check size={11} className="text-green-600" /> 已复制</>
                        : <><Copy size={11} /> 复制</>
                      }
                    </button>
                  )}

                  {/* Create new key — opens dialog with this group preselected */}
                  <button
                    onClick={() => openCreateDialog(group.groupId)}
                    className="btn-secondary text-xs px-2"
                    title="新建 Key（可选择其他分组）"
                  >
                    <Plus size={11} /> 新建
                  </button>

                  {/* Switcher — only shown when multiple keys exist */}
                  {hasMultiple && (
                    <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setOpenDropdown(isOpen ? null : group.groupId)}
                        disabled={isSwitching}
                        className="btn-secondary text-xs flex items-center gap-1"
                      >
                        {isSwitching
                          ? <Loader2 size={11} className="animate-spin" />
                          : <>切换 <ChevronDown size={11} className={isOpen ? 'rotate-180 transition-transform' : 'transition-transform'} /></>
                        }
                      </button>

                      {isOpen && (
                        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-border bg-card shadow-lg py-1">
                          {group.keys.map(k => {
                            const isActive = activeKey?.id === k.id
                            return (
                              <div key={k.id} className="px-2">
                                <button
                                  onClick={() => !isActive && handleSelectKey(group.groupId, k.id)}
                                  className={`w-full text-left px-2 py-2 text-xs rounded flex items-start gap-2 transition-colors ${
                                    isActive
                                      ? 'bg-primary/10 text-primary cursor-default'
                                      : 'hover:bg-accent text-foreground'
                                  }`}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium truncate">{k.name}</div>
                                    <div className="font-mono text-muted-foreground truncate">{k.keyMasked}</div>
                                    {isActive && <div className="text-[10px] text-primary/70 mt-0.5">当前使用</div>}
                                  </div>
                                  <span
                                    role="button"
                                    onClick={(e) => { e.stopPropagation(); handleCopyKey(k.id) }}
                                    className="shrink-0 p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                                    title="复制此 Key"
                                  >
                                    {copiedKeyId === k.id
                                      ? <Check size={11} className="text-green-600" />
                                      : <Copy size={11} />
                                    }
                                  </span>
                                  {!isActive && (
                                    <span
                                      role="button"
                                      onClick={(e) => { e.stopPropagation(); handleDeleteKey(k.id, k.name) }}
                                      className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                                      title="删除此 Key"
                                    >
                                      <Trash2 size={11} />
                                    </span>
                                  )}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {resetError && (
          <p className="text-xs text-destructive px-4 pb-3">{resetError}</p>
        )}
      </section>

      {/* Logout */}
      <section className="pt-2">
        <button
          onClick={() => setLogoutConfirmOpen(true)}
          disabled={loggingOut}
          className="flex items-center gap-2 px-4 py-2 rounded-md border border-destructive/40 text-destructive text-sm hover:bg-destructive/5 transition-colors disabled:opacity-50"
        >
          {loggingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
          退出登录
        </button>
      </section>

      <CreateKeyDialog
        open={createDialogOpen}
        defaultGroupId={createDialogDefaultGroup}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={loadKeyOptions}
      />

      {/* Inline logout confirmation — avoids native confirm() which leaves
          input focus broken in Electron's renderer after dismissal */}
      {dlg.element}

      {logoutConfirmOpen && (
        <div
          className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLogoutConfirmOpen(false)}
        >
          <div
            className="bg-popover border border-border rounded-xl shadow-2xl w-[400px] max-w-full p-5 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold flex items-center gap-2">
              <LogOut size={16} className="text-destructive" />
              确认退出登录？
            </h3>
            <p className="text-sm text-muted-foreground">
              退出后需要重新输入账号密码登录。本地的对话记录不会被删除。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setLogoutConfirmOpen(false)}
                className="btn-secondary text-sm"
                autoFocus
              >
                取消
              </button>
              <button
                onClick={handleLogoutConfirmed}
                className="px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-sm hover:bg-destructive/90 transition-colors"
              >
                退出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Token Plan card — current subscription status from /api/v1/subscription/me
// ============================================================================

function formatQuotaNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

function formatDateRange(start: number | null, end: number | null): string {
  const fmt = (ts: number) => new Date(ts).toLocaleDateString()
  if (start && end) return `${fmt(start)} → ${fmt(end)}`
  if (end) return `至 ${fmt(end)}`
  if (start) return `自 ${fmt(start)}`
  return '—'
}

interface TokenPlanCardProps {
  plan: TokenPlanInfo
  subKey: SubscriptionKeyView
  subKeyBusy: 'create' | 'reset' | 'delete' | null
  autoCreating: boolean
  autoCreateError: string | null
  copiedKeyId: number | null
  onCreate: () => void
  onReset: () => void
  onDelete: () => void
  onCopy: (keyId: number) => void
  onRetryAutoCreate: () => void
}

function TokenPlanCard({
  plan, subKey, subKeyBusy, autoCreating, autoCreateError, copiedKeyId,
  onCreate, onReset, onDelete, onCopy, onRetryAutoCreate
}: TokenPlanCardProps) {
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const hasQuota = plan.quotaOpusEquivalent > 0
  const usedPct = hasQuota ? Math.min(100, (plan.usedOpusEquivalent / plan.quotaOpusEquivalent) * 100) : 0
  const barColor =
    usedPct >= 90 ? 'bg-destructive'
    : usedPct >= 70 ? 'bg-amber-500'
    : 'bg-primary'
  const isExpiringSoon = plan.periodEnd != null && (plan.periodEnd - Date.now()) < 7 * 24 * 3600 * 1000
  const isActive = plan.status === 'active'
  const busy = subKeyBusy !== null || autoCreating

  return (
    <div className="px-4 py-3 space-y-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold uppercase tracking-wide">{plan.planType}</span>
            {!isActive && (
              <span className="text-[10px] uppercase text-amber-700 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded shrink-0">
                {plan.status}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
              plan.autoRenew
                ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10'
                : 'text-muted-foreground bg-muted/60'
            }`}>
              {plan.autoRenew ? '自动续费' : '到期失效'}
            </span>
          </div>
          <div className={`text-[11px] mt-0.5 ${isExpiringSoon ? 'text-amber-600' : 'text-muted-foreground/70'}`}>
            {formatDateRange(plan.periodStart, plan.periodEnd)}
            {isExpiringSoon && ' · 即将到期'}
          </div>
        </div>
        <a
          href="https://www.supercode.help"
          target="_blank"
          rel="noreferrer"
          className="btn-secondary text-xs flex items-center gap-1 shrink-0"
          title="去 SuperCode 查看 / 续费"
        >
          续费 <ExternalLink size={10} />
        </a>
      </div>

      {hasQuota ? (
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted-foreground">
              {formatQuotaNumber(plan.usedOpusEquivalent)} / {formatQuotaNumber(plan.quotaOpusEquivalent)} Opus-equiv
            </span>
            <span className={`font-mono ${usedPct >= 90 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {usedPct.toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
            <div className={`h-full ${barColor} transition-all`} style={{ width: `${usedPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground/70">未设置配额上限</div>
      )}

      <div className="text-[10px] text-muted-foreground/60">
        原始用量：{formatQuotaNumber(plan.usedRawTotal)} tokens
      </div>

      {plan.breakdownByModel.length > 0 && (
        <div>
          <button
            onClick={() => setBreakdownOpen(v => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            分模型用量
            <ChevronDown size={10} className={breakdownOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {breakdownOpen && (
            <div className="mt-1.5 space-y-1">
              {plan.breakdownByModel.map(b => (
                <div key={b.model} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-muted-foreground truncate">{b.model}</span>
                  <span className="text-muted-foreground/70 shrink-0 ml-2">{formatQuotaNumber(b.used)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Token Plan Key — at most one per user. Lives here (not mixed with API
          Keys) so it's clear it's tied to the subscription. */}
      <div className="pt-2 mt-1 border-t border-border/40">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <Key size={11} /> Token Plan Key
          </span>
          {subKey.key && (
            <div className="flex gap-1">
              <button
                onClick={() => subKey.key && onCopy(subKey.key.id)}
                disabled={busy}
                className="btn-secondary text-[11px] px-2 py-0.5 flex items-center gap-1"
                title="复制完整 Key"
              >
                {copiedKeyId === subKey.key.id
                  ? <><Check size={10} className="text-green-600" /> 已复制</>
                  : <><Copy size={10} /> 复制</>
                }
              </button>
              <button
                onClick={onReset}
                disabled={busy}
                className="btn-secondary text-[11px] px-2 py-0.5 flex items-center gap-1"
                title="删除当前 Key 并创建新的"
              >
                {subKeyBusy === 'reset'
                  ? <Loader2 size={10} className="animate-spin" />
                  : <RefreshCw size={10} />
                } 重置
              </button>
              <button
                onClick={onDelete}
                disabled={busy}
                className="btn-secondary text-[11px] px-2 py-0.5 flex items-center gap-1 hover:border-destructive/40 hover:text-destructive"
                title="删除 Token Plan Key"
              >
                {subKeyBusy === 'delete'
                  ? <Loader2 size={10} className="animate-spin" />
                  : <Trash2 size={10} />
                } 删除
              </button>
            </div>
          )}
        </div>

        {subKey.key ? (
          <div className="text-[11px] font-mono text-muted-foreground bg-muted/30 rounded px-2 py-1.5 truncate">
            {subKey.key.keyMasked}
            {subKey.group && (
              <span className="ml-2 text-[10px] uppercase text-muted-foreground/60">
                · {subKey.group.platform}
              </span>
            )}
          </div>
        ) : autoCreating || subKeyBusy === 'create' ? (
          <div className="text-[11px] flex items-center gap-2 text-muted-foreground bg-muted/30 rounded px-2 py-1.5">
            <Loader2 size={11} className="animate-spin" /> 正在为当前套餐创建 Key…
          </div>
        ) : isActive ? (
          <div className="space-y-1.5">
            {autoCreateError && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                <AlertCircle size={11} className="shrink-0 mt-0.5" />
                <div className="flex-1">
                  自动创建失败：{autoCreateError}
                  <button onClick={onRetryAutoCreate} className="ml-2 underline hover:text-amber-600">重试</button>
                </div>
              </div>
            )}
            <button
              onClick={onCreate}
              disabled={busy}
              className="btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"
            >
              <Plus size={10} /> 创建 Token Plan Key
            </button>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground/70">
            订阅未激活，无法创建 Token Plan Key
          </div>
        )}
      </div>
    </div>
  )
}
