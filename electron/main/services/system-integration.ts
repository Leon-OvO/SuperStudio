import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execFileP = promisify(execFile)

// ---------------------------------------------------------------------------
// Auto-launch on OS login
//
// Electron's app.setLoginItemSettings is cross-platform (Win/macOS).
// On Linux it's a no-op (autostart needs a .desktop file under
// ~/.config/autostart/ which we don't ship here).
// ---------------------------------------------------------------------------

export function setAutoLaunch(enabled: boolean): void {
  try {
    // Pin the path explicitly — Electron's default uses argv[0] which can be
    // wrong after the user moves the .exe. getPath('exe') always reflects
    // where we're running from right now.
    const exePath = app.getPath('exe')
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.platform === 'win32' ? exePath : undefined,
      // No --hidden flag: we want the user to see the window on login.
    })
    console.log(`[system] autoLaunch ${enabled ? 'enabled' : 'disabled'} (exe: ${exePath})`)
  } catch (e) {
    console.warn('[system] setAutoLaunch failed:', (e as Error).message)
  }
}

export function getAutoLaunchState(): boolean {
  try {
    return !!app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Windows Explorer right-click "Open with SuperStudio"
//
// We write per-user (HKCU) registry entries via reg.exe — no admin needed.
// The command is `"<exe>" "%1"` so the path the user right-clicked on is
// passed verbatim as the second argv. The main process picks it up via the
// `second-instance` event (see index.ts) and routes it to the Vibe page.
//
// Three locations cover the three Explorer contexts:
//   *                              files
//   Directory                      a folder selected in the tree
//   Directory\Background           empty space inside an open folder
// ---------------------------------------------------------------------------

const SHELL_KEY_NAME = 'SuperStudio'
const SHELL_MENU_LABEL = '用 SuperStudio 打开'

interface RegLocation {
  /** Registry key path under HKCU */
  path: string
  /** Optional %V substitution — Directory\Background needs %V instead of %1
   *  because %1 doesn't expand to the directory path in that context. */
  argPlaceholder: '%1' | '%V'
}

const SHELL_LOCATIONS: RegLocation[] = [
  { path: `Software\\Classes\\*\\shell\\${SHELL_KEY_NAME}`, argPlaceholder: '%1' },
  { path: `Software\\Classes\\Directory\\shell\\${SHELL_KEY_NAME}`, argPlaceholder: '%1' },
  { path: `Software\\Classes\\Directory\\Background\\shell\\${SHELL_KEY_NAME}`, argPlaceholder: '%V' }
]

function isShellIntegrationSupported(): boolean {
  return process.platform === 'win32'
}

/**
 * Resolve the path to the icon we want Explorer to show next to the menu
 * entry. We prefer a real .ico file (sharper at all DPIs, matches the
 * installer icon) over extracting it from the .exe — and critically in dev
 * mode the .exe is electron.exe, whose icon is the wrong logo.
 *
 * Production: electron-builder copies build/icon.ico → resources/icon.ico
 *             via the `extraResources` entry in package.json.
 * Dev:        we walk up from electron/main/services to the repo root and
 *             read build/icon.ico directly.
 */
function resolveShellIconPath(): string {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'icon.ico'))
  } else {
    // __dirname at runtime is .../out/main (after electron-vite bundles main).
    // The repo root is two levels up.
    candidates.push(path.join(__dirname, '../../build/icon.ico'))
    candidates.push(path.join(app.getAppPath(), 'build/icon.ico'))
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  // Last-ditch fallback: the .exe itself (Windows can extract its embedded
  // icon). In packaged builds this still looks correct since electron-builder
  // burns icon.ico into the .exe; in dev it surfaces the Electron logo, which
  // is the bug we're trying to avoid — but at least nothing is broken.
  return app.getPath('exe')
}

async function regAdd(keyPath: string, value: string, data: string, name = ''): Promise<void> {
  // reg.exe add "HKCU\..." /v <name> /t REG_SZ /d "<data>" /f
  // For default (unnamed) values pass /ve instead of /v <name>.
  const args = ['add', `HKCU\\${keyPath}`]
  if (name) args.push('/v', name)
  else args.push('/ve')
  args.push('/t', value, '/d', data, '/f')
  await execFileP('reg', args, { windowsHide: true })
}

async function regDelete(keyPath: string): Promise<void> {
  // /f forces deletion without confirmation. Missing key returns non-zero,
  // which we swallow — idempotent disable shouldn't fail on absent keys.
  try {
    await execFileP('reg', ['delete', `HKCU\\${keyPath}`, '/f'], { windowsHide: true })
  } catch (e) {
    const msg = (e as Error).message || ''
    if (!/cannot find|unable to find|0x2|ERROR: The system was unable/i.test(msg)) {
      console.warn(`[system] reg delete ${keyPath} failed:`, msg)
    }
  }
}

async function regQueryExists(keyPath: string): Promise<boolean> {
  try {
    await execFileP('reg', ['query', `HKCU\\${keyPath}`], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function setShellIntegration(enabled: boolean): Promise<void> {
  if (!isShellIntegrationSupported()) {
    console.log('[system] shellIntegration skipped — only Windows is supported')
    return
  }

  if (!enabled) {
    for (const loc of SHELL_LOCATIONS) {
      await regDelete(loc.path)
    }
    console.log('[system] shellIntegration disabled — removed Explorer context-menu entries')
    return
  }

  const exePath = app.getPath('exe')
  const iconPath = resolveShellIconPath()
  // Quote both the exe path and the arg placeholder so paths with spaces work.
  for (const loc of SHELL_LOCATIONS) {
    const command = `"${exePath}" "${loc.argPlaceholder}"`
    try {
      // Set the menu label as the default value of the shell key
      await regAdd(loc.path, 'REG_SZ', SHELL_MENU_LABEL)
      // Icon — point at the real icon.ico when possible so we don't inherit
      // electron.exe's logo in dev. Falls back to the .exe if the ico is
      // missing for any reason.
      await regAdd(loc.path, 'REG_SZ', iconPath, 'Icon')
      // Command lives in a sub-key called "command", with default value = the cmd line
      await regAdd(`${loc.path}\\command`, 'REG_SZ', command)
    } catch (e) {
      console.warn(`[system] reg add ${loc.path} failed:`, (e as Error).message)
    }
  }
  console.log(`[system] shellIntegration enabled — exe: ${exePath}, icon: ${iconPath}`)
}

export async function getShellIntegrationState(): Promise<boolean> {
  if (!isShellIntegrationSupported()) return false
  // We treat the first location's command sub-key as the canary — if it's
  // there, the user has the integration installed. We don't verify every key
  // because partial state would be weird and we always (un)install all three.
  return regQueryExists(`${SHELL_LOCATIONS[0].path}\\command`)
}

// ---------------------------------------------------------------------------
// Unified state snapshot for the Settings UI
// ---------------------------------------------------------------------------

export async function getSystemState(): Promise<{
  autoLaunch: boolean
  shellIntegration: boolean
  shellIntegrationSupported: boolean
}> {
  return {
    autoLaunch: getAutoLaunchState(),
    shellIntegration: await getShellIntegrationState(),
    shellIntegrationSupported: isShellIntegrationSupported()
  }
}

// ---------------------------------------------------------------------------
// Argv parsing — extract the path the user right-clicked on in Explorer
//
// Windows passes the path as `"C:\path\to\thing"` argv after the .exe path.
// Electron sometimes inserts its own flags (--inspect=…, --remote-debugging-port,
// etc.) so we skip anything that starts with `-` and pick the first surviving
// arg that actually exists on disk.
// ---------------------------------------------------------------------------

// Type lives in src/shared/ipc-types.ts so the renderer can import it too;
// re-exported here so existing main-side imports keep working.
import type { ShellOpenTarget } from '../../../src/shared/ipc-types'
export type { ShellOpenTarget }

export function findPathArg(argv: string[]): ShellOpenTarget | null {
  // Skip argv[0] (electron exe) and any leading flags
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('-')) continue
    try {
      if (!fs.existsSync(a)) continue
      const stat = fs.statSync(a)
      if (stat.isDirectory()) {
        return { path: a, kind: 'dir' }
      }
      if (stat.isFile()) {
        return { path: a, kind: 'file', parent: path.dirname(a) }
      }
    } catch { /* ignore */ }
  }
  return null
}
