import { useState } from 'react'
import { Loader2, Check, AlertCircle, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import type { SshConnection } from '../../../../shared/ipc-types'
import { randomId } from '../../lib/id'
import { Select } from '../../components/ui/Select'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'

interface Props {
  initial: SshConnection | null
  onSave: (c: SshConnection) => void | Promise<void>
  onCancel: () => void
}

export function SshForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name || '')
  const [host, setHost] = useState(initial?.host || '')
  const [port, setPort] = useState<string>(String(initial?.port || 22))
  const [username, setUsername] = useState(initial?.username || '')
  const [group, setGroup] = useState(initial?.group || '')
  const [authType, setAuthType] = useState<SshConnection['authType']>(initial?.authType || 'password')
  const [password, setPassword] = useState(initial?.password || '')
  const [privateKey, setPrivateKey] = useState(initial?.privateKey || '')
  const [passphrase, setPassphrase] = useState(initial?.passphrase || '')
  const [sudoPassword, setSudoPassword] = useState(initial?.sudoPassword || '')
  const [becomeRoot, setBecomeRoot] = useState(initial?.becomeRoot ?? false)
  const [becomeUser, setBecomeUser] = useState(initial?.becomeUser || '')
  const [autoConfirm, setAutoConfirm] = useState(initial?.autoConfirm ?? false)
  // Advanced (sudo / become / 免确认) — collapsed by default; auto-open when editing
  // a connection that already uses any of them.
  const [advOpen, setAdvOpen] = useState(!!(initial?.sudoPassword || initial?.becomeRoot || initial?.autoConfirm))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  function build(): SshConnection {
    return {
      id: initial?.id || randomId(),
      name: name.trim(),
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      username: username.trim(),
      authType,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'privateKey' ? privateKey : undefined,
      passphrase: authType === 'privateKey' && passphrase ? passphrase : undefined,
      sudoPassword: sudoPassword || undefined,
      becomeRoot: becomeRoot || undefined,
      becomeUser: becomeRoot ? (becomeUser.trim() || undefined) : undefined,
      group: group.trim() || undefined,
      autoConfirm,
      createdAt: initial?.createdAt,
    }
  }

  function valid(): boolean {
    if (!name.trim() || !host.trim() || !username.trim()) { toast.error('名称、主机、用户名不能为空'); return false }
    if (authType === 'password' && !password) { toast.error('请填写密码'); return false }
    if (authType === 'privateKey' && !privateKey.trim()) { toast.error('请填写或选择私钥'); return false }
    return true
  }

  async function pickKeyFile() {
    const paths = await window.api.openFileDialog?.({ properties: ['openFile'] }) as string[] | undefined
    if (!paths?.[0]) return
    try {
      const res = await window.api.readFile(paths[0]) as { content: string }
      if (res?.content) setPrivateKey(res.content)
    } catch (e) {
      toast.error('读取私钥失败：' + (e as Error).message)
    }
  }

  async function handleTest() {
    if (!valid()) return
    setTesting(true); setTestResult(null)
    try { setTestResult(await window.api.sshTestConnection(build())) }
    catch (e) { setTestResult({ ok: false, error: (e as Error).message }) }
    finally { setTesting(false) }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid()) return
    setSaving(true)
    try { await onSave(build()) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h2 className="text-base font-semibold">{initial ? '编辑 SSH 连接' : '添加 SSH 连接'}</h2>

      <Field label="名称">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：web1（Agent 用它引用此连接）" className="input" />
      </Field>

      <div className="grid grid-cols-3 gap-2.5">
        <div className="col-span-2">
          <Field label="主机 / IP">
            <input value={host} onChange={e => setHost(e.target.value)} placeholder="1.2.3.4 或 example.com" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Field>
        </div>
        <Field label="端口">
          <input value={port} onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="22" className="input" />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="用户名">
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="root" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </Field>
        <Field label="分组（可选）">
          <input value={group} onChange={e => setGroup(e.target.value)} placeholder="生产/web 或 香港节点" className="input" title="用 / 分隔可建多级文件夹，如 生产/web/A组" />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Field label="认证方式">
          <Select<SshConnection['authType']>
            value={authType}
            onChange={setAuthType}
            options={[{ value: 'password', label: '密码' }, { value: 'privateKey', label: '私钥' }]}
            size="md"
            className="w-full [&>span]:w-full"
          />
        </Field>
        <div className="col-span-2">
          {authType === 'password' ? (
            <Field label="密码">
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="远程登录密码" className="input" autoComplete="off" />
            </Field>
          ) : (
            <Field label="私钥口令（可选）">
              <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="私钥若有口令则填写" className="input" autoComplete="off" />
            </Field>
          )}
        </div>
      </div>

      {authType === 'privateKey' && (
        <Field label="私钥（PEM）">
          <textarea
            value={privateKey}
            onChange={e => setPrivateKey(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            className="input font-mono text-xs h-20 resize-y"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
          />
          <button type="button" onClick={pickKeyFile} className="mt-1.5 text-xs flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <FolderOpen size={13} /> 从文件选择…
          </button>
        </Field>
      )}

      {/* Advanced — sudo 密码 / 切换用户 / 免确认（默认收起，省空间） */}
      <div className="rounded-md border border-border">
        <button type="button" onClick={() => setAdvOpen(o => !o)}
          className="w-full flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium text-foreground/80 hover:text-foreground">
          {advOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          高级（sudo · 切换用户 · 免确认执行）
          {!advOpen && (becomeRoot || autoConfirm || sudoPassword) && <span className="ml-1 text-[10px] text-amber-500">已配置</span>}
        </button>
        {advOpen && (
          <div className="px-2.5 pb-2.5 space-y-2.5 border-t border-border pt-2.5">
            <Field label="sudo 密码（可选）">
              <input type="password" value={sudoPassword} onChange={e => setSudoPassword(e.target.value)}
                placeholder="执行 sudo 时自动输入；留空用登录密码" className="input" autoComplete="off"
                title="需要 sudo 且服务器要求密码时，Agent 自动输入这里的密码。密码登录留空即可（默认用登录密码）；密钥登录或 sudo 密码与登录密码不同时填写。" />
            </Field>

            <label className="flex items-center gap-2.5 cursor-pointer" title="适合「普通用户密钥登录、目标账号不能直接登录」的机器：开启后每条命令都自动 sudo su - 目标用户 运行，Agent 无需自己加 sudo。需先填 sudo 密码。">
              <input type="checkbox" className="accent-primary shrink-0" checked={becomeRoot} onChange={e => setBecomeRoot(e.target.checked)} />
              <span className="text-sm">登录后用 sudo 切换用户执行</span>
              {becomeRoot && (
                <input value={becomeUser} onChange={e => setBecomeUser(e.target.value)} placeholder="root"
                  className="input h-7 max-w-[140px] ml-auto" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  onClick={e => e.stopPropagation()} title="目标账号，默认 root；也可填 deploy / www-data 等" />
              )}
            </label>

            <label className={cn('flex items-start gap-2.5 cursor-pointer rounded-md border p-2 transition-colors',
              autoConfirm ? 'border-amber-500/50 bg-amber-500/[0.06]' : 'border-border')}>
              <input type="checkbox" className="mt-0.5 accent-primary shrink-0" checked={autoConfirm} onChange={e => setAutoConfirm(e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-sm">免确认执行（不弹窗，自动执行）</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">⚠️ 开启后此连接上执行命令不再逐次确认（含删除/重启等高危）。仅在完全信任时开启。</span>
              </span>
            </label>
          </div>
        )}
      </div>

      {testResult && (
        <div className={cn('rounded-md p-2 text-xs flex items-start gap-2 border',
          testResult.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400' : 'bg-destructive/10 border-destructive/30 text-destructive')}>
          {testResult.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <div className="flex-1">{testResult.ok ? '连接成功' : testResult.error}</div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={14} className="animate-spin" /> : '保存'}
        </button>
        <button type="button" onClick={handleTest} disabled={testing} className="btn-secondary">
          {testing ? <Loader2 size={14} className="animate-spin" /> : '测试连接'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary ml-auto">取消</button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
