import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import { getSshConnection, getSettings } from './store'

/**
 * Safety gate for agent-driven SSH command execution. Two policies:
 *
 *  • sshReadonlyNoConfirm = true (default): classify each command. READ-ONLY
 *    commands (ls/cat/grep/…) run with NO popup; WRITE/dangerous commands (rm/mv/
 *    redirects/installs/…) are confirmed EACH time. This is per-command — a later
 *    write still prompts even after earlier commands ran.
 *  • sshReadonlyNoConfirm = false: legacy "trust on first use, per connection" —
 *    the first command on a connection confirms, then that connection is trusted
 *    for the rest of this app run.
 *
 * Per-connection `autoConfirm` (in the SSH connection config) overrides both and
 * never prompts. Restarting the app clears the trust set.
 */

const trusted = new Set<string>()

// ── Read-only command classification ───────────────────────────────────────
// Default-to-WRITE: only commands we recognise as read-only skip confirmation.

/** Pure read-only binaries (no write side effects when used normally). */
const READ_BINS = new Set([
  'ls', 'll', 'dir', 'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zgrep', 'zcat',
  'find', 'locate', 'which', 'whereis', 'type', 'command', 'stat', 'file', 'wc', 'du', 'df', 'tree', 'readlink',
  'realpath', 'dirname', 'basename', 'pwd', 'cd', 'echo', 'printf', 'date', 'cal', 'uptime', 'whoami', 'id',
  'hostname', 'uname', 'hostnamectl', 'arch', 'nproc', 'free', 'vmstat', 'iostat', 'ps', 'pgrep', 'pstree',
  'env', 'printenv', 'history', 'lsof', 'netstat', 'ss', 'ip', 'ifconfig', 'route', 'arp', 'dig', 'nslookup',
  'host', 'getent', 'cut', 'sort', 'uniq', 'tr', 'column', 'fold', 'fmt', 'xxd', 'hexdump', 'od', 'strings',
  'sha256sum', 'sha1sum', 'md5sum', 'cksum', 'cmp', 'diff', 'comm', 'jq', 'yq', 'sed', 'awk', 'true', 'test',
  'lscpu', 'lsblk', 'lsusb', 'lspci', 'mount', 'who', 'w', 'last', 'groups', 'tty', 'stty', 'seq', 'expr',
])

/** Binaries that are read-only ONLY for specific subcommands (else assume write). */
const SUBCMD_READ: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'ls-files', 'blame', 'config', 'cat-file', 'tag', 'shortlog', 'reflog', 'whatchanged', 'grep', 'count-objects', 'ls-remote']),
  docker: new Set(['ps', 'images', 'image', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history', 'search', 'system']),
  systemctl: new Set(['status', 'list-units', 'list-unit-files', 'list-timers', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'show-environment', 'get-default']),
  npm: new Set(['ls', 'list', 'view', 'outdated', 'audit', 'ping', 'root', 'prefix', 'config', 'doctor', 'why', 'search', 'fund']),
  yarn: new Set(['list', 'info', 'why', 'outdated', 'audit']),
  pnpm: new Set(['ls', 'list', 'outdated', 'audit', 'why']),
  kubectl: new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions', 'config', 'cluster-info', 'auth']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'search']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'search']),
  apt: new Set(['list', 'show', 'search', 'policy']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'deps']),
}

/** Tokens that make a command WRITE/dangerous wherever they appear. */
const DANGEROUS = /\b(rm|rmdir|unlink|mv|cp|rsync|scp|dd|mkfs|fdisk|parted|shred|truncate|chmod|chown|chgrp|setfacl|ln|touch|mkdir|tee|sponge|kill|pkill|killall|reboot|shutdown|halt|poweroff|init|crontab|at|useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd|swapon|swapoff|iptables|nft|ufw|firewall-cmd|setenforce|modprobe|insmod|rmmod|wget|curl)\b/

/** Best-effort: is `command` read-only (safe to run without a confirm popup)? */
export function isReadOnlyCommand(command: string): boolean {
  const c = (command || '').trim()
  if (!c) return false
  // File redirects (>, >>, 2> …) write to disk — but NOT fd-dups like 2>&1 / >&2.
  if (/(^|\s)\d*>>?\s*(?!&)/.test(c)) return false
  if (/\bsed\b[^|;&]*\s-i\b/.test(c) || /\bperl\b[^|;&]*\s-i\b/.test(c)) return false // in-place edit
  if (DANGEROUS.test(c)) return false
  // Every &&/||/;/| segment's leading binary (after sudo + env-assigns) must be read-only.
  const segments = c.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  if (!segments.length) return false
  return segments.every(seg => {
    let toks = seg.replace(/^sudo\s+(-\S+\s+)*/, '').split(/\s+/).filter(Boolean)
    let i = 0
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] || '')) i++ // skip FOO=bar env assigns
    const bin = (toks[i] || '').split('/').pop() || ''
    if (bin === 'cd' || bin === '') return true
    const sub = SUBCMD_READ[bin]
    if (sub) return sub.has((toks[i + 1] || '').toLowerCase())
    return READ_BINS.has(bin)
  })
}

/** Ask the renderer to show the styled confirm dialog and await the answer.
 *  Resolve the main window dynamically to avoid a static import cycle with
 *  ../index (same approach as memory.ts). */
async function askConfirm(host: string, command: string, write: boolean): Promise<boolean> {
  let win: BrowserWindow | null = null
  try { win = (await import('../index')).getMainWindow() } catch { win = null }
  if (!win) return false // no UI to confirm with → deny
  return new Promise((resolve) => {
    const id = randomUUID()
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(IPC.SSH_EXEC_CONFIRM_REPLY, onReply)
      clearTimeout(timer)
      resolve(ok)
    }
    const onReply = (_e: unknown, payload: { id: string; ok: boolean }): void => {
      if (payload?.id === id) finish(!!payload.ok)
    }
    ipcMain.on(IPC.SSH_EXEC_CONFIRM_REPLY, onReply)
    const timer = setTimeout(() => finish(false), 60_000) // no answer in 60s → decline
    win.webContents.send(IPC.SSH_EXEC_CONFIRM, { id, host, command, write })
  })
}

/** Returns true if the agent may run `command` on this connection. */
export async function confirmSshExec(connId: string, host: string, command: string): Promise<boolean> {
  // Per-connection opt-in: never prompt.
  try { if (getSshConnection(connId)?.autoConfirm) return true } catch { /* fall through */ }

  let readonlyMode = true
  try { readonlyMode = getSettings().sshReadonlyNoConfirm !== false } catch { /* default on */ }

  if (readonlyMode) {
    // Read-only → no popup; write/dangerous → confirm EACH time (no trust cache).
    if (isReadOnlyCommand(command)) return true
    return askConfirm(host, command, true)
  }

  // Legacy: trust on first use, per connection.
  if (trusted.has(connId)) return true
  const ok = await askConfirm(host, command, false)
  if (ok) trusted.add(connId)
  return ok
}

/** Drop trust for a connection (e.g. when it's deleted/edited). */
export function revokeSshTrust(connId: string): void {
  trusted.delete(connId)
}
