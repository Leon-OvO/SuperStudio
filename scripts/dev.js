// Launch electron-vite dev with ELECTRON_RUN_AS_NODE fully removed from the env.
// Some IDE terminals (e.g. VS Code's extension host) set ELECTRON_RUN_AS_NODE=1,
// which makes Electron behave as Node and crashes our main process at startup.
const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const bin = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

const child = spawn(bin, ['dev'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

child.on('exit', code => process.exit(code ?? 0))
