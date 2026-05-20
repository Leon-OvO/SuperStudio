import { useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Key, LogOut, ChevronDown, Wallet, Loader2 } from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useUIStore } from '../../stores/ui'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'

/**
 * Top-right user pill: avatar / email / chevron → popover.
 * Contains quick links to Dashboard, Account/Keys settings, and Logout.
 * Inspired by Qoder's top-right account menu.
 */
export function TopBarUser() {
  const { user, isLoggedIn } = useAuthStore()
  const setPage = useUIStore(s => s.setPage)
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(false)
  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Pull balance lazily when popover opens
  useEffect(() => {
    if (!open) return
    setLoadingBalance(true)
    window.api.getDashboardStats?.()
      .then((s: unknown) => {
        const obj = (s ?? {}) as Record<string, unknown>
        const b = obj.balance
        if (typeof b === 'number') setBalance(b)
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoadingBalance(false))
  }, [open])

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        popoverRef.current?.contains(target) ||
        buttonRef.current?.contains(target)
      ) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!isLoggedIn) return null

  const email = user?.email ?? '—'
  const initial = email.slice(0, 1).toUpperCase()

  function go(page: 'dashboard' | 'settings') {
    setPage(page)
    setOpen(false)
  }

  async function handleLogout() {
    setLogoutConfirm(false)
    setOpen(false)
    try {
      await window.api.logout()
      window.location.reload()
    } catch (e) {
      toast.error('退出失败：' + (e as Error).message)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-md transition-colors',
          'hover:bg-foreground/10 text-foreground/80',
          open && 'bg-foreground/10'
        )}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="账号"
      >
        <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
          {initial}
        </div>
        <span className="text-[11px] font-medium max-w-[160px] truncate">{email}</span>
        <ChevronDown
          size={11}
          className={cn('text-foreground/50 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="fixed top-[36px] right-3 z-[100] w-72 rounded-xl border border-border bg-popover shadow-2xl overflow-hidden"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Header — email + balance */}
          <div className="px-4 py-3 bg-gradient-to-b from-primary/5 to-transparent border-b border-border">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{email}</div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Wallet size={10} className="text-emerald-500" />
                  余额：
                  {loadingBalance
                    ? <Loader2 size={9} className="animate-spin" />
                    : balance != null
                      ? <span className="font-mono text-foreground">${balance.toFixed(2)}</span>
                      : <span className="text-muted-foreground/60">—</span>
                  }
                </div>
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="py-1">
            <MenuItem icon={LayoutDashboard} label="仪表盘 · 使用统计"
              hint="查看 Token、消费、Key 用量分布"
              onClick={() => go('dashboard')} />
            <MenuItem icon={Key} label="账号 · API Keys"
              hint="管理 Key、切换平台、查看默认模型"
              onClick={() => go('settings')} />
          </div>

          {/* Logout */}
          <div className="border-t border-border py-1">
            <MenuItem icon={LogOut} label="退出登录" destructive
              onClick={() => setLogoutConfirm(true)} />
          </div>
        </div>
      )}

      {/* Inline logout confirm (avoid native confirm — breaks Electron focus) */}
      {logoutConfirm && (
        <div
          className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLogoutConfirm(false)}
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
              退出后需重新输入账号密码登录。本地的对话记录不会被删除。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setLogoutConfirm(false)} className="btn-secondary text-sm" autoFocus>
                取消
              </button>
              <button
                onClick={handleLogout}
                className="px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-sm hover:bg-destructive/90 transition-colors"
              >
                退出
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function MenuItem({
  icon: Icon, label, hint, destructive, onClick
}: {
  icon: React.ElementType
  label: string
  hint?: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-2 flex items-center gap-3 transition-colors',
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-accent text-foreground'
      )}
    >
      <Icon size={14} className={cn('shrink-0', destructive ? 'text-destructive' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">{hint}</div>}
      </div>
    </button>
  )
}
