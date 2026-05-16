// Integration test: verify Vercel AI SDK + our config actually fires an HTTP request.
// Spins up a fake OpenAI-compatible endpoint and points the client at it.

import http from 'node:http'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'

let requestCount = 0
let lastBody = null

const server = http.createServer((req, res) => {
  requestCount++
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    lastBody = body
    console.log(`[mock] ${req.method} ${req.url} (${body.length} bytes)`)

    // Simulate OpenAI chat completion streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    })
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'gpt-4o-mini' }
    const chunks = [
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '!' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '我能帮你' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n'
    ]
    let i = 0
    const send = () => {
      if (i >= chunks.length) { res.end(); return }
      res.write(chunks[i++])
      setTimeout(send, 20)
    }
    send()
  })
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseURL = `http://127.0.0.1:${port}/v1`
console.log(`[test] mock server on ${baseURL}`)

try {
  const client = createOpenAI({ apiKey: 'test-key', baseURL })
  const model = client('gpt-4o-mini')

  console.log('[test] calling streamText…')
  const result = streamText({
    model,
    messages: [{ role: 'user', content: '你好' }],
    maxSteps: 20,
    tools: {
      web_search: tool({
        description: 'Search the web',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ results: [`mock result for ${query}`] })
      })
    }
  })

  let fullText = ''
  let chunks = 0
  for await (const c of result.textStream) {
    fullText += c
    chunks++
  }
  console.log(`[test] received ${chunks} chunks, total text: "${fullText}"`)
  console.log(`[test] HTTP requests to mock server: ${requestCount}`)
  if (lastBody) {
    const parsed = JSON.parse(lastBody)
    console.log('[test] request body model:', parsed.model)
    console.log('[test] request body messages:', JSON.stringify(parsed.messages))
    console.log('[test] request body tools length:', parsed.tools?.length || 0)
    console.log('[test] request body stream:', parsed.stream)
  }
} catch (err) {
  console.error('[test] streamText error:', err)
  console.error(err.stack)
} finally {
  server.close()
}
