import { describe, it, expect } from 'vitest'
import { levelOf, nextLevel, levelProgress } from './company-levels'

describe('company-levels', () => {
  it('levelOf maps completed count to the right tier', () => {
    expect(levelOf(0).name).toBe('实习')
    expect(levelOf(1).name).toBe('初级')
    expect(levelOf(2).name).toBe('初级')
    expect(levelOf(3).name).toBe('资深')
    expect(levelOf(6).name).toBe('专家')
    expect(levelOf(99).name).toBe('专家')
  })
  it('nextLevel returns the upcoming tier, null at the top', () => {
    expect(nextLevel(0)?.name).toBe('初级')
    expect(nextLevel(3)?.name).toBe('专家')
    expect(nextLevel(6)).toBeNull()
  })
  it('levelProgress is 0-100 and 100 when maxed', () => {
    expect(levelProgress(0)).toBe(0)        // 0/1 into 初级
    expect(levelProgress(6)).toBe(100)      // maxed
    expect(levelProgress(4)).toBeGreaterThan(0) // between 资深(3) and 专家(6)
    expect(levelProgress(4)).toBeLessThan(100)
  })
})
