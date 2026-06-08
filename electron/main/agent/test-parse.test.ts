import { describe, it, expect } from 'vitest'
import { parseTestOutput, detectFramework, stripAnsi } from './test-parse'

describe('stripAnsi', () => {
  it('removes color escape codes', () => {
    expect(stripAnsi('[31mFAIL[0m foo')).toBe('FAIL foo')
  })
})

describe('detectFramework', () => {
  it('detects jest by the "Tests: ... total" summary', () => {
    expect(detectFramework('Tests:       1 failed, 2 passed, 3 total')).toBe('jest')
  })
  it('detects vitest by the "Test Files" / "Tests N passed (M)" lines', () => {
    expect(detectFramework(' Tests  3 passed (3)')).toBe('vitest')
    expect(detectFramework(' Test Files  1 passed (1)')).toBe('vitest')
  })
  it('detects pytest by the ==== summary and FAILED::', () => {
    expect(detectFramework('=========== 1 failed, 2 passed in 0.12s ===========')).toBe('pytest')
    expect(detectFramework('FAILED tests/test_x.py::test_y - assert 1 == 2')).toBe('pytest')
  })
})

describe('parseTestOutput — jest', () => {
  const out = `
PASS  src/util.test.ts
FAIL  src/calc.test.ts
  Calculator
    ✓ adds (2 ms)
    ✕ subtracts (3 ms)

  ● Calculator › subtracts

    expected 1 but got 2

Tests:       1 failed, 2 passed, 3 total
Test Suites: 1 failed, 1 passed, 2 total
`
  it('parses counts and ok=false', () => {
    const r = parseTestOutput(out, 'auto')
    expect(r.framework).toBe('jest')
    expect(r.failed).toBe(1)
    expect(r.passed).toBe(2)
    expect(r.total).toBe(3)
    expect(r.ok).toBe(false)
  })
  it('captures the failing test name', () => {
    const r = parseTestOutput(out)
    const names = r.failures.map(f => f.name)
    expect(names.some(n => n.includes('subtracts'))).toBe(true)
  })
})

describe('parseTestOutput — jest all-green', () => {
  it('ok=true with zero failures', () => {
    const r = parseTestOutput('Tests:       5 passed, 5 total', 'jest')
    expect(r.failed).toBe(0)
    expect(r.passed).toBe(5)
    expect(r.ok).toBe(true)
    expect(r.failures).toHaveLength(0)
  })
})

describe('parseTestOutput — vitest', () => {
  const out = `
 ❯ src/sum.test.ts (3)
   ✓ adds positives
   × adds negatives 1ms
 FAIL  src/sum.test.ts > adds negatives

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
`
  it('parses counts, ok=false, and failure', () => {
    const r = parseTestOutput(out, 'auto')
    expect(r.framework).toBe('vitest')
    expect(r.failed).toBe(1)
    expect(r.passed).toBe(2)
    expect(r.total).toBe(3)
    expect(r.ok).toBe(false)
    expect(r.failures.some(f => f.name.includes('adds negatives'))).toBe(true)
  })
  it('all green (derives failed=0 from total)', () => {
    const r = parseTestOutput(' Tests  4 passed (4)', 'vitest')
    expect(r.failed).toBe(0)
    expect(r.passed).toBe(4)
    expect(r.total).toBe(4)
    expect(r.ok).toBe(true)
  })
})

describe('parseTestOutput — pytest', () => {
  const out = `
tests/test_math.py::test_add PASSED
tests/test_math.py::test_sub FAILED

=================================== FAILURES ===================================
FAILED tests/test_math.py::test_sub - assert 0 == 1
=========================== 1 failed, 1 passed in 0.04s ========================
`
  it('parses counts, ok=false, failure with message', () => {
    const r = parseTestOutput(out, 'auto')
    expect(r.framework).toBe('pytest')
    expect(r.failed).toBe(1)
    expect(r.passed).toBe(1)
    expect(r.total).toBe(2)
    expect(r.ok).toBe(false)
    const f = r.failures.find(x => x.name.includes('test_sub'))
    expect(f).toBeTruthy()
    expect(f?.message).toContain('assert 0 == 1')
  })
  it('counts errors as failures', () => {
    const r = parseTestOutput('==== 2 passed, 1 error in 0.10s ====', 'pytest')
    expect(r.failed).toBe(1)
    expect(r.ok).toBe(false)
  })
  it('all green', () => {
    const r = parseTestOutput('==================== 3 passed in 0.05s ====================', 'pytest')
    expect(r.failed).toBe(0)
    expect(r.passed).toBe(3)
    expect(r.ok).toBe(true)
  })
})

describe('parseTestOutput — unknown', () => {
  it('returns nulls without throwing', () => {
    const r = parseTestOutput('some random build output\nnothing here', 'auto')
    expect(r.framework).toBe('unknown')
    expect(r.ok).toBe(null)
    expect(r.failures).toEqual([])
  })
})
