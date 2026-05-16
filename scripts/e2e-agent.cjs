// End-to-end test: boot Electron with a minimal main process that drives
// runAgent against a fake OpenAI-compatible endpoint.
//
//   node scripts/e2e-agent.cjs
//
// Spawns electron, points it at a temp userData dir, seeds a provider + settings
// against a localhost mock, calls runAgent, and prints every IPC event / log.

const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')

const projectRoot = path.resolve(__dirname, '..')

// --- 1. Mock OpenAI server ---------------------------------------------------
let requests = 0
const server = http.createServer((req, res) => {
  requests++
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    console.log(`[mock] ${req.method} ${req.url} body=${body.length}b`)

    if (req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'mock-model' }
      const chunks = [
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`,
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '你好,这是 e2e mock 的应答。' } }] })}\n\n`,
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n'
      ]
      let i = 0
      const send = () => {
        if (i >= chunks.length) { res.end(); return }
        res.write(chunks[i++])
        setTimeout(send, 10)
      }
      send()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const baseURL = `http://127.0.0.1:${port}/v1`
  console.log(`[harness] mock server: ${baseURL}`)

  // --- 2. Launch electron with test entry -----------------------------------
  const electronBin = path.join(projectRoot, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron')
  const testEntry = path.join(__dirname, 'e2e-electron-entry.cjs')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.E2E_MOCK_BASE = baseURL
  env.E2E_USER_DATA = path.join(require('os').tmpdir(), 'superstudio-e2e-' + Date.now())

  console.log(`[harness] userData: ${env.E2E_USER_DATA}`)
  console.log(`[harness] spawning electron…`)

  const child = spawn(electronBin, [testEntry], {
    cwd: projectRoot,
    env,
    stdio: 'inherit'
  })

  child.on('exit', (code) => {
    console.log(`[harness] electron exited code=${code}, total HTTP requests to mock: ${requests}`)
    server.close()
    process.exit(code ?? 0)
  })

  // Safety timeout
  setTimeout(() => {
    console.error('[harness] timeout 30s, killing')
    child.kill('SIGKILL')
  }, 30000)
})
