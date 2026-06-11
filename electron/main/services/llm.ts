import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { LanguageModel, streamText, experimental_wrapLanguageModel as wrapLanguageModel, type LanguageModelV1Middleware } from 'ai'
import { Agent } from 'undici'
import { getProviders, getSettings } from './store'
import type { ProviderConfig } from '../../../src/shared/ipc-types'

// ---------------------------------------------------------------------------
// Hardened fetch for LLM calls (mitigates frequent `read ECONNRESET` against
// relay gateways like api.supercode.help). Two levers:
//   1. A tuned undici Agent for DIRECT (no-proxy) connections: close idle
//      keep-alive sockets fast so we never reuse a half-dead socket the relay
//      already closed (the classic ECONNRESET source), and tolerate long
//      first-byte / long streaming bodies. When a proxy IS active we do NOT
//      override the dispatcher — the global ProxyAgent installed in proxy.ts
//      must stay in effect, so proxied users keep working.
//   2. Connection-error retry with backoff on top of the AI SDK's own retry,
//      so a brief reset window doesn't fail the whole turn.
// ---------------------------------------------------------------------------
let directLlmAgent: Agent | null = null
function getDirectAgent(): Agent {
  if (!directLlmAgent) {
    directLlmAgent = new Agent({
      connect: { timeout: 30_000 },     // TCP+TLS connect ceiling
      keepAliveTimeout: 4_000,          // drop idle sockets quickly → avoid stale reuse
      keepAliveMaxTimeout: 10_000,
      headersTimeout: 300_000,          // long first-byte (model queue / thinking) is fine
      bodyTimeout: 0                    // streaming bodies have no fixed length — never time out
    })
  }
  return directLlmAgent
}

const CONN_ERR_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|fetch failed|terminated|socket hang up|other side closed|network/i
function isConnError(e: unknown): boolean {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (err?.name === 'AbortError') return false  // user cancelled — never retry
  const blob = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
  return CONN_ERR_RE.test(blob)
}

/** Custom fetch handed to every LLM provider below. */
export const llmFetch: typeof fetch = async (input, init) => {
  const proxyOn = (getSettings().proxyMode ?? 'off') !== 'off'
  // Inject the tuned dispatcher only when NOT proxied; proxied requests fall
  // through to the global ProxyAgent (no `dispatcher` key).
  const opts = (proxyOn ? init : { ...init, dispatcher: getDirectAgent() }) as RequestInit
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(input, opts)
    } catch (e) {
      lastErr = e
      if (!isConnError(e) || attempt === 2) throw e
      await new Promise(r => setTimeout(r, 600 * 2 ** attempt))  // 600ms, 1.2s
    }
  }
  throw lastErr
}

export function createLLMClient(providerId: string, modelId: string): LanguageModel {
  const providers = getProviders()
  const provider = providers.find(p => p.id === providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  return buildModel(provider, modelId)
}

// ---------------------------------------------------------------------------
// Zero-config protocol auto-detection
// ---------------------------------------------------------------------------

/** A model that speaks the Anthropic Messages API (the Claude family). */
export function isClaudeModel(modelId: string): boolean {
  return /claude/i.test(modelId)
}

/** Whether this provider's endpoint is known to ALSO speak Anthropic-native
 *  /v1/messages, so we can safely auto-route Claude models there. This is a
 *  declared capability (`anthropicNative`) — set by whichever layer configured
 *  the provider and knows its endpoint. Core never infers it from a brand/host
 *  string. Arbitrary OpenAI-compatible endpoints stay on /chat/completions,
 *  since blindly switching them to /v1/messages would 404. */
function relaySpeaksAnthropic(provider: ProviderConfig): boolean {
  if (!provider.baseUrl) return false
  return provider.anthropicNative === true
}

/** The wire protocol actually used for (provider, model). Auto-upgrades Claude
 *  models on an Anthropic-capable relay from the OpenAI-compatible shim
 *  (/v1/chat/completions) to the Anthropic-native protocol (/v1/messages) — a
 *  direct passthrough with SSE ping keepalives that is far less prone to
 *  ECONNRESET. Everything else keeps its declared protocol. Exported so the
 *  engine/vibe can gate prompt-caching + thinking on the SAME effective protocol. */
export function effectiveProtocol(provider: ProviderConfig, modelId: string): 'anthropic' | 'openai' | 'gemini' {
  if (provider.type === 'anthropic') return 'anthropic'
  if (provider.type === 'gemini') return 'gemini'
  if (isClaudeModel(modelId) && relaySpeaksAnthropic(provider)) return 'anthropic'
  return 'openai'
}

// Newer top-tier models (Opus 4.x+, Fable 5) REJECT `temperature` outright
// ("`temperature` is deprecated for this model"). The AI SDK v4 injects
// temperature:0 by default (see ai/dist prepareCallSettings), and this app never
// sets one, so every request carries temperature:0 → a hard 400. Strip it via
// middleware for those models; they use their own default sampling. Sonnet /
// Haiku still accept temperature:0, so we leave them untouched (keeps determinism
// + classify's explicit temperature:0).
const stripTemperatureMiddleware: LanguageModelV1Middleware = {
  transformParams: async ({ params }) => ({ ...params, temperature: undefined })
}
function modelRejectsTemperature(modelId: string): boolean {
  return /opus|fable/i.test(modelId)  // Opus 4.x+ / Fable 5; extend here if more models follow
}
/** Wrap a built model so it drops `temperature` when the model rejects it.
 *  Applies on every protocol path (anthropic-native AND openai-compatible), since
 *  the same model can route either way depending on the provider. */
function stripTemperatureIfRejected(model: LanguageModel, modelId: string): LanguageModel {
  return modelRejectsTemperature(modelId)
    ? wrapLanguageModel({ model, middleware: stripTemperatureMiddleware })
    : model
}

// Some relays/gateways emit an Anthropic `reasoning-signature` (the thinking
// block's signature) with NO preceding reasoning content. The AI SDK then throws
// `InvalidStreamPart: reasoning-signature without reasoning` and aborts the WHOLE
// turn (user sees nothing). Drop the orphan signature so the stream survives.
// No-op for well-behaved endpoints: real reasoning always precedes its signature,
// so `sawReasoning` is true and the signature passes through untouched.
const tolerateOrphanReasoningSignature: LanguageModelV1Middleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream()
    let sawReasoning = false
    return {
      ...rest,
      stream: stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'reasoning') sawReasoning = true
          if (part.type === 'reasoning-signature' && !sawReasoning) return // drop orphan
          controller.enqueue(part)
        }
      }))
    }
  }
}

/** Normalize a provider baseURL so it ends with an API version segment. The SDKs
 *  POST `{baseURL}/messages` (Anthropic) or `{baseURL}/chat/completions` (OpenAI), so
 *  a gateway configured as `https://host` (no /v1) gets hit at `/messages` /
 *  `/chat/completions` — many gateways then return an empty 200. Append `/v1` when no
 *  `/vN` segment is present; leave `…/v1` (supercode etc.) and empty (SDK default)
 *  untouched. Tolerates users who omit the `/v1` suffix. */
export function withApiVersion(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  const b = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/.test(b) ? b : `${b}/v1`
}

/** Build an Anthropic-native client, stripping `temperature` for models that
 *  reject it. baseURL lets a relay (supercode) serve /v1/messages. */
function buildAnthropicModel(provider: ProviderConfig, modelId: string): LanguageModel {
  const client = createAnthropic({ apiKey: provider.apiKey, baseURL: withApiVersion(provider.baseUrl), fetch: llmFetch })
  const model = client(modelId as Parameters<typeof client>[0])
  // Always tolerate orphan reasoning-signatures (relay robustness); strip
  // temperature only for models that reject it.
  const middleware: LanguageModelV1Middleware[] = [tolerateOrphanReasoningSignature]
  if (modelRejectsTemperature(modelId)) middleware.push(stripTemperatureMiddleware)
  return wrapLanguageModel({ model, middleware })
}

export function buildModel(provider: ProviderConfig, modelId: string): LanguageModel {
  // Auto-route a Claude model on an Anthropic-capable relay to the native
  // protocol, even when the provider was configured as OpenAI-compatible. The
  // OpenAI-compat baseURL (…/v1) is exactly what createAnthropic needs — it
  // appends /messages → …/v1/messages. No user configuration required.
  if (provider.type !== 'anthropic' && effectiveProtocol(provider, modelId) === 'anthropic') {
    return buildAnthropicModel(provider, modelId)
  }

  // Compat mode (per-provider): use the SDK's 'compatible' profile so it does NOT
  // append `stream_options: { include_usage: true }`. Strict gateways / subscription
  // relays whose upstream rejects that field can return 502/empty; turning it off
  // sends the simplest request. Costs token-usage accounting, hence opt-in.
  const openaiCompat: 'strict' | 'compatible' = provider.relayCompat ? 'compatible' : 'strict'
  // Disable OpenAI "strict" function calling (structured outputs for tools). For
  // reasoning models (o1/o3/gpt-5.x) the SDK turns this ON by default, stamping
  // every tool with `strict:true` + `additionalProperties:false`. Strict schemas
  // require `required` to list EVERY property — but our tools use optional params,
  // so the upstream rejects them with a 400 (relays surface it as 502). With
  // maxRetries the whole turn then hangs and the user sees "无响应". Non-reasoning
  // models never get strict tools, so forcing it off is a no-op for them and the
  // exact fix for gpt-5.x. We still get normal function calling, just not the
  // schema-strict variant (which the chat agent doesn't rely on).
  const openaiModelSettings = { structuredOutputs: false as const }
  switch (provider.type) {
    case 'openai': {
      // `strict` makes the SDK send `stream_options: { include_usage: true }`,
      // without which streaming responses don't carry token counts.
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: withApiVersion(provider.baseUrl),
        compatibility: openaiCompat,
        fetch: llmFetch
      })
      return stripTemperatureIfRejected(client(modelId, openaiModelSettings), modelId)
    }
    case 'custom': {
      // Same as 'openai' — most modern OpenAI-compatible proxies (OpenRouter,
      // Together, Groq, aggregator gateways, etc.) honor `stream_options` and
      // need it on to return usage. Compat mode drops it for picky upstreams.
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: withApiVersion(provider.baseUrl) || 'https://api.openai.com/v1',
        compatibility: openaiCompat,
        fetch: llmFetch
      })
      return stripTemperatureIfRejected(client(modelId, openaiModelSettings), modelId)
    }
    case 'anthropic': {
      // baseURL lets users point at an Anthropic-native gateway that serves
      // /v1/messages (with SSE ping keepalives) instead of only
      // api.anthropic.com. Empty → SDK default.
      return buildAnthropicModel(provider, modelId)
    }
    case 'gemini': {
      const client = createGoogleGenerativeAI({ apiKey: provider.apiKey, fetch: llmFetch })
      return client(modelId)
    }
    default:
      throw new Error(`Unknown provider type: ${provider.type}`)
  }
}

export type ThinkingMode = 'auto' | 'fast' | 'deep'

/**
 * Extra streamText() options that control Anthropic extended thinking.
 *
 * 背景：Opus 4.8 这类模型会在出正文前先跑一大段「思考」(reasoning)。本应用的流式
 * 管道现在会把思考实时显示出来，但用户若只想要快答案、不想等思考，可在设置里切到
 * 「快速」。这里把设置映射成 @ai-sdk/anthropic 的 providerOptions：
 *   - fast → thinking.disabled    显式关闭扩展思考，Opus 直接答（最快）
 *   - deep → thinking.enabled     给足思考预算，换更强推理（更慢、且需放大 maxTokens
 *                                  以容纳 budget，否则 Anthropic 会因 budget≥max 报错）
 *   - auto → 不动（沿用模型/网关默认行为）
 * 仅对原生 anthropic provider 生效；其它 provider 一律返回空对象（无副作用）。
 */
type ThinkStreamOpts = Pick<Parameters<typeof streamText>[0], 'providerOptions' | 'maxTokens'>

export function thinkingStreamOpts(
  providerType: string | undefined,
  mode: ThinkingMode | undefined,
  model?: string
): ThinkStreamOpts {
  if (providerType !== 'anthropic') return {}
  // Output-token ceiling. Many turns truncate long writes (HTML/report/code) at a
  // small provider default; raise it — but ONLY for models we KNOW accept a large
  // cap (Opus-4 / Sonnet-4). Allowlist not denylist: a too-high max_tokens ERRORS
  // (Claude 3.x / Haiku cap at 4k-8k), so anything else keeps provider defaults =
  // zero regression. 24000 is the value the deep branch already shipped on these
  // models (proven-safe, well under their real cap) — big lift over the ~4k default
  // without risking rejection. Anthropic-scoped; other providers' truncation is
  // surfaced via the finishReason='length' marker instead.
  const big = /(?:opus|sonnet)-4/i.test(model || '')
  const cap = big ? 24000 : undefined
  if (mode === 'fast') {
    return { providerOptions: { anthropic: { thinking: { type: 'disabled' } } }, ...(cap ? { maxTokens: cap } : {}) }
  }
  if (mode === 'deep') {
    // maxTokens MUST exceed budgetTokens or Anthropic errors; keep the old 24000
    // floor for legacy models, 32000 for capable ones so thinking never eats the answer.
    return { providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 } } }, maxTokens: cap ?? 24000 }
  }
  return cap ? { maxTokens: cap } : {} // auto
}
