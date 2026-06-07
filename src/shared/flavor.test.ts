import { describe, it, expect } from 'vitest'
import { FLAVOR, ACCOUNT_MODE, IS_DWORK } from './flavor'
import { BRAND } from './brand'

// No FLAVOR define is injected in the vitest (node) environment, so the
// typeof-guarded fallback must resolve to the superstudio defaults. This both
// documents the fallback contract and guards against an accidental change that
// would flip the default flavor.
describe('flavor', () => {
  it('falls back to superstudio when __APP_FLAVOR__ is not injected', () => {
    expect(FLAVOR).toBe('superstudio')
    expect(ACCOUNT_MODE).toBe('hosted')
    expect(IS_DWORK).toBe(false)
  })
})

describe('brand', () => {
  it('resolves a complete brand for the active flavor', () => {
    expect(BRAND.id).toBe(FLAVOR)
    const required = [
      'productName',
      'appId',
      'displayName',
      'tagline',
      'copyright',
      'defaultSkin',
      'dataNamespace',
    ] as const
    for (const k of required) expect(BRAND[k]).toBeTruthy()
  })

  it('superstudio brand keeps the classic default skin and app id', () => {
    expect(BRAND.defaultSkin).toBe('classic')
    expect(BRAND.appId).toBe('com.superstudio.app')
  })

  it('keeps the brand table free of hard-coded proprietary URLs', () => {
    // Account/relay links live in the brand-links stub (overlay-provided), not
    // in the core brand table — so this stays empty in core.
    expect(BRAND.websiteUrl).toBe('')
  })
})
