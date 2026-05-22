import { spawn } from 'child_process'

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a shell command and capture stdout+stderr. Shared by the Vibe agent's
 * `code_bash` tool and the skill-runtime `bash` tool.
 *
 * - Windows spawns `cmd.exe /c`, others `/bin/sh -c`.
 * - Inherits `process.env` so the user's PATH/PROXY work.
 * - Killed on timeout or when `abortSignal` fires.
 * - Output is capped at 50 KB per stream to keep tool results bounded.
 */
export function runShell(
  command: string,
  cwd: string,
  abortSignal: AbortSignal,
  timeoutMs = 30_000
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const proc = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
      cwd, env: process.env, windowsHide: true
    })
    let stdout = ''; let stderr = ''; let timedOut = false
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeoutMs)
    const onAbort = () => proc.kill('SIGKILL')
    abortSignal.addEventListener('abort', onAbort, { once: true })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      abortSignal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout: stdout.slice(0, 50_000), stderr: stderr.slice(0, 50_000), timedOut })
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ code: -1, stdout, stderr: err.message, timedOut })
    })
  })
}
