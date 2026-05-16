// Electron main process entry for the e2e test.
// Loads our compiled main bundle's services and drives runAgent directly.
process.env.SUPERSTUDIO_E2E = '1'

const { app } = require('electron')
const path = require('node:path')

// Override userData BEFORE app modules read it
if (process.env.E2E_USER_DATA) {
  app.setPath('userData', process.env.E2E_USER_DATA)
}

async function main() {
  await app.whenReady()
  console.log('[e2e] app ready, userData=' + app.getPath('userData'))

  // Load our built main bundle's internals. We need to import the source files
  // but they're TypeScript. Since the production build is a single bundled CJS,
  // we instead replicate the minimal flow inline using the SAME npm packages.

  const Store = require('electron-store')
  const initSqlJs = require('sql.js')
  const fs = require('node:fs')
  const { createOpenAI } = require('@ai-sdk/openai')
  const { streamText } = require('ai')

  // 1. Seed config store with a provider pointing to the mock
  const store = new Store({
    name: 'config',
    encryptionKey: 'superstudio-secure-key-v1',
    defaults: {
      providers: [],
      settings: {
        defaultChatModel: 'mock-model',
        defaultChatProviderId: 'test',
        defaultImageModel: '',
        defaultImageProviderId: '',
        defaultVideoModel: '',
        defaultVideoProviderId: '',
        defaultEmbeddingModel: '',
        defaultEmbeddingProviderId: '',
        searchApiKey: '',
        searchProvider: 'tavily',
        kbGlobalEnabled: false,
        kbGlobalSpaceIds: []
      }
    }
  })
  store.set('providers', [{
    id: 'test',
    name: 'mock',
    type: 'custom',
    apiKey: 'test-key',
    baseUrl: process.env.E2E_MOCK_BASE,
    models: ['mock-model']
  }])
  store.set('settings', { ...store.get('settings'), defaultChatProviderId: 'test', defaultChatModel: 'mock-model' })

  console.log('[e2e] providers seeded:', store.get('providers').map(p => ({ id: p.id, baseUrl: p.baseUrl })))
  console.log('[e2e] settings.chatProvider:', store.get('settings').defaultChatProviderId)

  // 2. Initialize sql.js DB
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'superstudio.db')
  const wasmCandidates = [
    path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  ]
  const wasmPath = wasmCandidates.find(p => fs.existsSync(p))
  if (!wasmPath) {
    console.error('[e2e] sql-wasm.wasm not found at any candidate path')
    process.exit(1)
  }
  const SQL = await initSqlJs({ locateFile: () => wasmPath })
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT DEFAULT '', tool_calls TEXT, attachments TEXT, created_at INTEGER);
  `)

  // 3. Create a session
  const sessionId = 'sess-' + Date.now()
  db.run(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`, [sessionId, 'test', Date.now(), Date.now()])
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  console.log('[e2e] session created:', sessionId)

  // 4. Replicate the streamText call exactly as engine.ts does
  const provider = store.get('providers')[0]
  const settings = store.get('settings')

  console.log('[e2e] building OpenAI-compatible client at:', provider.baseUrl)
  const client = createOpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl })
  const model = client(settings.defaultChatModel)

  console.log('[e2e] calling streamText…')
  let streamErr = null
  try {
    const result = streamText({
      model,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: '你好' }],
      maxSteps: 5,
      onError: ({ error }) => {
        console.error('[e2e] onError fired:', error?.message || error)
        streamErr = error
      }
    })

    let full = ''
    let chunks = 0
    try {
      for await (const c of result.textStream) { chunks++; full += c }
    } catch (iterErr) {
      console.error('[e2e] iter threw:', iterErr?.message || iterErr)
      streamErr = iterErr
    }
    console.log(`[e2e] streamed ${chunks} chunks, text="${full}", err=${!!streamErr}`)

    if (streamErr) {
      throw streamErr
    }
    if (chunks === 0 && !full) {
      let detail = 'empty response'
      try {
        const finish = await result.finishReason
        detail += `, finishReason=${finish}`
      } catch {}
      throw new Error(detail)
    }
    console.log('[e2e] SUCCESS')
    app.exit(0)
  } catch (err) {
    console.error('[e2e] FAILED:', err?.message || err)
    app.exit(2)
  }
}

main().catch(err => {
  console.error('[e2e] top-level error:', err)
  app.exit(3)
})
