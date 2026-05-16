// Variant: verify the engine surfaces a 401 / connection error properly.
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')

const projectRoot = path.resolve(__dirname, '..')

const server = http.createServer((req, res) => {
  console.log(`[mock] ${req.method} ${req.url}`)
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'Invalid API key (mock)', type: 'auth_error' } }))
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const baseURL = `http://127.0.0.1:${port}/v1`
  console.log(`[harness] mock at ${baseURL}, will return 401`)

  const electronBin = path.join(projectRoot, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.E2E_MOCK_BASE = baseURL
  env.E2E_USER_DATA = path.join(require('os').tmpdir(), 'superstudio-e2e-err-' + Date.now())
  env.E2E_EXPECT_ERROR = '1'

  const child = spawn(electronBin, [path.join(__dirname, 'e2e-electron-entry.cjs')], {
    cwd: projectRoot, env, stdio: 'inherit'
  })
  child.on('exit', code => { server.close(); process.exit(code === 2 ? 0 : 1) })
  setTimeout(() => { child.kill('SIGKILL') }, 30000)
})
