import { describe, it, expect } from 'vitest'
import { modelContextWindow, DEFAULT_CONTEXT_TOKENS, computeCost, priceModel } from './model-pricing'

describe('modelContextWindow', () => {
  it('matches families by longest-style prefix', () => {
    expect(modelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(modelContextWindow('gpt-4o-2024-08-06')).toBe(128_000)
    expect(modelContextWindow('gemini-1.5-pro')).toBe(2_000_000)
    expect(modelContextWindow('gpt-4.1-mini')).toBe(1_000_000)
  })
  it('falls back to default for unknown models', () => {
    expect(modelContextWindow('totally-unknown-model')).toBe(DEFAULT_CONTEXT_TOKENS)
    expect(modelContextWindow(undefined)).toBe(DEFAULT_CONTEXT_TOKENS)
  })
})

describe('computeCost / priceModel (regression)', () => {
  it('prices a known model and returns null for unknown', () => {
    expect(priceModel('gpt-4o')).toEqual({ input: 2.5, output: 10 })
    expect(priceModel('nope')).toBeNull()
    expect(computeCost('gpt-4o', 1_000_000, 0)).toBeCloseTo(2.5, 5)
    expect(computeCost('nope', 100, 100)).toBeNull()
  })
})
