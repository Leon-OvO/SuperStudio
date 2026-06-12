import { useState } from 'react'
import { ArrowLeft, Loader2, Check, AlertCircle, FolderOpen } from 'lucide-react'
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
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.api.sshTestConnection(build())
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid()) return
    setSaving(true)
    try { await onSave(build()) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
      <button type="button" onClick={onCancel} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} /> 返回
      </button>
      <h2 className="text-lg font-semibold">{initial ? '编辑 SSH 连接' : '添加 SSH 连接'}</h2>

      <Field label="名称（Agent 用它引用此连接）">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：web1" className="input" />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="主机 / IP">
            <input value={host} onChange={e => setHost(e.target.value)} placeholder="例如：1.2.3.4 或 example.com" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Field>
        </div>
        <Field label="端口">
          <input value={port} onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="22" className="input" />
        </Field>
      </div>

      <Field label="用户名">
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="例如：root" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </Field>

      <Field label="分组（可选，用于列表归类）">
        <input value={group} onChange={e => setGroup(e.target.value)} placeholder="例如：生产 / tokeng / 香港节点" className="input" />
      </Field>

      <Field label="认证方式">
        <Select<SshConnection['authType']>
          value={authType}
          onChange={setAuthType}
          options={[
            { value: 'password', label: '密码' },
            { value: 'privateKey', label: '私钥' },
          ]}
          size="md"
          className="w-full [&>span]:w-full"
        />
      </Field>

      {authType === 'password' ? (
        <Field label="密码">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="远程登录密码" className="input" autoComplete="off" />
        </Field>
      ) : (
        <>
          <Field label="私钥（PEM）">
            <div className="space-y-2">
              <textarea
                value={privateKey}
                onChange={e => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="input font-mono text-xs h-28 resize-y"
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
              />
              <button type="button" onClick={pickKeyFile} className="btn-secondary flex items-center gap-1.5">
                <FolderOpen size={14} /> 从文件选择…
              </button>
            </div>
          </Field>
          <Field label="私钥口令（可选）">
            <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="私钥若有口令则填写" className="input" autoComplete="off" />
          </Field>
        </>
      )}

      <Field label="sudo 密码（可选）">
        <input type="password" value={sudoPassword} onChange={e => setSudoPassword(e.target.value)} placeholder="执行 sudo 命令时自动输入；留空则用登录密码" className="input" autoComplete="off" />
        <span className="block text-[11px] text-muted-foreground mt-1 leading-relaxed">
          需要 <b>sudo</b>（如 <code>sudo su - root -c "…"</code>）且服务器要求密码时，Agent 会自动输入这里的密码。
          密码登录的连接留空即可（默认用登录密码）；密钥登录或 sudo 密码与登录密码不同的，在此填写。
        </span>
      </Field>

      <div className="rounded-md border border-border p-2.5 space-y-2.5">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary shrink-0"
            checked={becomeRoot}
            onChange={e => setBecomeRoot(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">登录后用 sudo 切换用户执行</span>
            <span className="block text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              适合「普通用户密钥登录、目标账号不能直接登录」的机器：开启后此连接上<b>每条命令都自动以下方目标用户运行</b>
              （`sudo su - 目标用户` + 自动输入上面的 sudo 密码），Agent 无需自己加 sudo。需先填好「sudo 密码」。
            </span>
          </span>
        </label>
        {becomeRoot && (
          <div className="pl-7">
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">目标用户</label>
            <input
              value={becomeUser}
              onChange={e => setBecomeUser(e.target.value)}
              placeholder="root（留空即 root）"
              className="input max-w-[220px]"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
            />
            <span className="block text-[11px] text-muted-foreground/70 mt-1">
              切换到的账号，默认 <code>root</code>；也可填 <code>deploy</code> / <code>www-data</code> 等。
            </span>
          </div>
        )}
      </div>

      <label className={cn(
        'flex items-start gap-2.5 cursor-pointer rounded-md border p-2.5 transition-colors',
        autoConfirm ? 'border-amber-500/50 bg-amber-500/[0.06]' : 'border-border'
      )}>
        <input
          type="checkbox"
          className="mt-0.5 accent-primary shrink-0"
          checked={autoConfirm}
          onChange={e => setAutoConfirm(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">免确认执行（不弹窗，自动执行）</span>
          <span className="block text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            ⚠️ 勾选后，Agent 在此连接上执行命令<b>不再逐次弹窗确认</b>，包括删除 / 重启 / 改配置等高危操作。
            仅在你完全信任相关任务时开启；默认关闭，关闭时每条新命令仍会弹窗请你确认。
          </span>
        </span>
      </label>

      {testResult && (
        <div className={cn(
          'rounded-md p-2.5 text-xs flex items-start gap-2 border',
          testResult.ok
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
            : 'bg-destructive/10 border-destructive/30 text-destructive'
        )}>
          {testResult.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <div className="flex-1">{testResult.ok ? '连接成功' : testResult.error}</div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={14} className="animate-spin" /> : '保存'}
        </button>
        <button type="button" onClick={handleTest} disabled={testing} className="btn-secondary">
          {testing ? <Loader2 size={14} className="animate-spin" /> : '测试连接'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">取消</button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">{label}</label>
      {children}
    </div>
  )
}
