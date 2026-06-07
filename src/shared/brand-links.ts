// PROPRIETARY-VALUED STUB (file-override model).
//
// In this (SuperStudio) repo it carries the real account links/copy, FLAVOR-
// guarded so a dwork build shows none. At the split, the deliverable core ships
// an ALL-EMPTY version of this file; the proprietary overlay overwrites it with
// the SuperStudio values. Core/customer UI reads these and simply hides the link
// / shows neutral copy when empty.
//
// Keeping user-facing account URLs/copy here (not inline in About/MenuBar/
// ChatModelSetup) means those core components carry no brand strings.

import { FLAVOR } from './flavor'

export const BRAND_LINKS = {
  /** Public website shown in About / MenuBar. Empty → link hidden. */
  websiteUrl: FLAVOR === 'superstudio' ? 'https://www.supercode.help' : '',
  /** Onboarding hint when no providers are configured. Empty → neutral copy. */
  accountHintZh:
    FLAVOR === 'superstudio'
      ? '登录账号后会自动同步官方 Token Plan，或在「设置 → 账号」中手动添加 OpenAI / Anthropic / Gemini 等第三方 Key。'
      : '',
}
