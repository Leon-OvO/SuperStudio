import { useState, useEffect } from 'react'
import { Loader2, Sparkles, Check, Info } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAuthStore } from '../../stores/auth'
import type { AuthState } from '../../../../shared/ipc-types'

type Phase = 'login' | 'setup' | 'done'

const SETUP_STEPS = ['验证身份…', '获取 API Key…', '拉取模型列表…', '完成']

interface InitResult extends AuthState {
  hasLegacyProviders?: boolean
}

export function LoginScreen() {
  const { setAuthState, setInitializing } = useAuthStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loading, setLoading] = useState(false)

  const [phase, setPhase] = useState<Phase>('login')
  const [setupStep, setSetupStep] = useState(0)   // 0-based index into SETUP_STEPS
  const [setupError, setSetupError] = useState('')
  const [hasLegacyProviders, setHasLegacyProviders] = useState(false)
  const [pendingAuthState, setPendingAuthState] = useState<AuthState | null>(null)

  // Pre-fill email/password from the last successful login (if the user had
  // 保持登录 enabled). After an explicit logout we keep the saved creds around
  // so the form starts populated — matches the user's expectation of the box.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const creds = await window.api.getSavedCredentials?.()
        if (cancelled || !creds) return
        setEmail(creds.email)
        setPassword(creds.password)
        setRemember(true)
      } catch {
        // No saved creds is the normal case — silent.
      }
    })()
    return () => { cancelled = true }
  }, [])

  function validate(): boolean {
    let ok = true
    if (!email.trim()) { setEmailError('请输入邮箱'); ok = false } else setEmailError('')
    if (!password) { setPasswordError('请输入密码'); ok = false } else setPasswordError('')
    return ok
  }

  async function handleLogin() {
    if (!validate()) return
    setLoginError('')
    setLoading(true)
    try {
      await window.api.login(email.trim(), password, remember)
      setPhase('setup')
      await runSetup()
    } catch (e) {
      setLoginError((e as Error).message || '登录失败，请检查邮箱和密码')
    } finally {
      setLoading(false)
    }
  }

  async function runSetup() {
    setSetupError('')
    setSetupStep(0)
    try {
      setSetupStep(1)
      await new Promise(r => setTimeout(r, 300))
      setSetupStep(2)
      const result = await window.api.initAccount() as InitResult
      setSetupStep(3)
      await new Promise(r => setTimeout(r, 400))
      setPhase('done')
      if (result.hasLegacyProviders) {
        setHasLegacyProviders(true)
        setPendingAuthState(result)
      } else {
        await new Promise(r => setTimeout(r, 600))
        setAuthState(result)
        setInitializing(false)
      }
    } catch (e) {
      setSetupError((e as Error).message || '初始化失败')
    }
  }

  function handleDismissMigrationNotice() {
    if (pendingAuthState) {
      setAuthState(pendingAuthState)
      setInitializing(false)
    }
  }

  if (phase === 'setup' || phase === 'done') {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-[380px] space-y-6 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
            {phase === 'done'
              ? <Check size={28} className="text-primary" />
              : <Loader2 size={28} className="text-primary animate-spin" />
            }
          </div>

          <div className="space-y-3">
            {SETUP_STEPS.map((label, i) => (
              <div key={i} className={cn(
                'flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-all',
                setupStep > i
                  ? 'bg-primary/10 text-primary'
                  : setupStep === i
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground'
              )}>
                <span className="w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[10px]">
                  {setupStep > i ? <Check size={10} /> : i + 1}
                </span>
                {label}
              </div>
            ))}
          </div>

          {phase === 'done' && hasLegacyProviders && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-left space-y-3">
              <div className="flex items-start gap-2">
                <Info size={15} className="text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm text-foreground/80 space-y-1">
                  <p className="font-medium text-foreground">检测到旧提供商配置</p>
                  <p>你之前手动添加的 API 提供商配置仍保留在本地，对话时仍可在模型选择器中使用。今后请通过 SuperCode 账号统一管理模型访问。</p>
                </div>
              </div>
              <button
                onClick={handleDismissMigrationNotice}
                className="btn-primary w-full"
              >
                知道了，进入应用
              </button>
            </div>
          )}

          {setupError && (
            <div className="space-y-3">
              <p className="text-sm text-destructive">{setupError}</p>
              <button
                onClick={runSetup}
                className="btn-primary w-full"
              >
                重试
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center p-4">
      <div className="w-[380px] space-y-6">
        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-primary flex items-center justify-center">
            <Sparkles size={20} className="text-primary-foreground" />
          </div>
          <h1 className="text-xl font-semibold">SuperStudio</h1>
          <p className="text-sm text-muted-foreground">登录你的 SuperCode 账号开始使用</p>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
              placeholder="you@example.com"
              className={cn('input', emailError && 'border-destructive')}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              disabled={loading}
              autoFocus
            />
            {emailError && <p className="text-xs text-destructive">{emailError}</p>}
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium">密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
              placeholder="••••••••"
              className={cn('input', passwordError && 'border-destructive')}
              autoComplete="current-password"
              disabled={loading}
            />
            {passwordError && <p className="text-xs text-destructive">{passwordError}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              disabled={loading}
              className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
            />
            <span className="text-muted-foreground">保持登录</span>
          </label>

          {loginError && (
            <p className="text-sm text-destructive text-center">{loginError}</p>
          )}

          <button
            onClick={handleLogin}
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            登录
          </button>
        </div>

        <p className="text-xs text-center text-muted-foreground">
          还没有账号？访问{' '}
          <button
            onClick={() => window.open?.('https://www.supercode.help', '_blank')}
            className="text-primary hover:underline"
          >
            supercode.help
          </button>{' '}
          注册
        </p>
      </div>
    </div>
  )
}
