/**
 * Per-model price table (USD per **1M tokens**, input / output).
 *
 * Matching is done by best-prefix on lowercased model id, so variants like
 * `claude-sonnet-4-5-20250929`, `claude-3-5-sonnet-latest`, `gpt-4o-2024-08-06`
 * all hit the right entry. Unknown models return `null` and the UI shows
 * tokens only.
 *
 * Prices reflect public list pricing as of early 2026. They're a best-effort
 * estimate; treat the displayed cost as an indicator, not an invoice.
 */

interface Price {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
}

/** Ordered longest-prefix first so specific variants win over generic ones. */
const TABLE: Array<[prefix: string, price: Price]> = [
  // ─── Anthropic ─────────────────────────────────────────────────────────
  ['claude-opus-4',       { input: 15,   output: 75   }],
  ['claude-opus-3',       { input: 15,   output: 75   }],
  ['claude-sonnet-4',     { input: 3,    output: 15   }],
  ['claude-3-7-sonnet',   { input: 3,    output: 15   }],
  ['claude-3-5-sonnet',   { input: 3,    output: 15   }],
  ['claude-3-sonnet',     { input: 3,    output: 15   }],
  ['claude-haiku-4',      { input: 1,    output: 5    }],
  ['claude-3-5-haiku',    { input: 0.8,  output: 4    }],
  ['claude-3-haiku',      { input: 0.25, output: 1.25 }],

  // ─── OpenAI ────────────────────────────────────────────────────────────
  ['gpt-5',               { input: 1.25, output: 10   }],
  ['gpt-4.1-mini',        { input: 0.4,  output: 1.6  }],
  ['gpt-4.1-nano',        { input: 0.1,  output: 0.4  }],
  ['gpt-4.1',             { input: 2,    output: 8    }],
  ['gpt-4o-mini',         { input: 0.15, output: 0.6  }],
  ['gpt-4o',              { input: 2.5,  output: 10   }],
  ['o1-mini',             { input: 1.1,  output: 4.4  }],
  ['o1-preview',          { input: 15,   output: 60   }],
  ['o1',                  { input: 15,   output: 60   }],
  ['o3-mini',             { input: 1.1,  output: 4.4  }],
  ['o3',                  { input: 2,    output: 8    }],
  ['o4-mini',             { input: 1.1,  output: 4.4  }],
  ['gpt-3.5-turbo',       { input: 0.5,  output: 1.5  }],

  // ─── Google Gemini ─────────────────────────────────────────────────────
  ['gemini-2.5-pro',      { input: 1.25, output: 10   }],
  ['gemini-2.5-flash',    { input: 0.3,  output: 2.5  }],
  ['gemini-2.0-pro',      { input: 1.25, output: 5    }],
  ['gemini-2.0-flash',    { input: 0.1,  output: 0.4  }],
  ['gemini-1.5-pro',      { input: 1.25, output: 5    }],
  ['gemini-1.5-flash',    { input: 0.075, output: 0.3 }],

  // ─── DeepSeek ──────────────────────────────────────────────────────────
  ['deepseek-reasoner',   { input: 0.55, output: 2.19 }],
  ['deepseek-chat',       { input: 0.27, output: 1.1  }],
  ['deepseek-v3',         { input: 0.27, output: 1.1  }],
  ['deepseek-r1',         { input: 0.55, output: 2.19 }],

  // ─── Qwen ──────────────────────────────────────────────────────────────
  ['qwen3-max',           { input: 6,    output: 18   }],
  ['qwen3-plus',          { input: 0.8,  output: 2    }],
  ['qwen-max',            { input: 1.6,  output: 6.4  }],
  ['qwen-plus',           { input: 0.4,  output: 1.2  }],
  ['qwen-turbo',          { input: 0.05, output: 0.2  }],
  ['qwen-long',           { input: 0.5,  output: 2    }],

  // ─── Moonshot / Kimi ───────────────────────────────────────────────────
  ['kimi-k2',             { input: 1,    output: 3    }],
  ['moonshot-v1-128k',    { input: 8,    output: 8    }],
  ['moonshot-v1-32k',     { input: 3,    output: 3    }],
  ['moonshot-v1-8k',      { input: 1.5,  output: 1.5  }],

  // ─── xAI Grok ──────────────────────────────────────────────────────────
  ['grok-3-mini',         { input: 0.3,  output: 0.5  }],
  ['grok-3',              { input: 3,    output: 15   }],
  ['grok-2',              { input: 2,    output: 10   }]
]

export function priceModel(modelId: string | null | undefined): Price | null {
  if (!modelId) return null
  const id = modelId.toLowerCase()
  // Longest-prefix-first: TABLE is ordered already.
  for (const [prefix, price] of TABLE) {
    if (id.includes(prefix)) return price
  }
  return null
}

/**
 * Cost in USD given a model id and token counts. Returns `null` for unknown
 * models — callers should show tokens only in that case.
 */
export function computeCost(
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number
): number | null {
  const p = priceModel(modelId)
  if (!p) return null
  // Guard against NaN/Infinity from upstream usage objects — undefined usage
  // arrives as NaN through arithmetic, then sneaks into the DB and renders as
  // "—" placeholder rows. Coerce to 0 (the safe fallback) instead.
  const safeIn = Number.isFinite(inputTokens) ? inputTokens : 0
  const safeOut = Number.isFinite(outputTokens) ? outputTokens : 0
  const cost = (safeIn / 1_000_000) * p.input + (safeOut / 1_000_000) * p.output
  return Number.isFinite(cost) ? cost : null
}
