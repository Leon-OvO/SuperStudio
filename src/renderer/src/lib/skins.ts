import type { Skin } from '../stores/ui'
import { IS_DWORK } from '@shared/flavor'

/**
 * Skin catalog — the 5 universal palettes + DWork's exclusive one. Shared by the
 * Settings → 皮肤 preview grid and the TitleBar quick-switch dropdown so both
 * stay in sync. Each card/swatch paints itself with the target palette so the
 * user previews it without applying first.
 */
export interface SkinOption {
  id: Skin
  label: string
  description: string
  swatches: { bg: string; surface: string; primary: string; accent: string }
  base: 'light' | 'dark'
}

export const SKIN_OPTIONS: SkinOption[] = [
  {
    id: 'classic',
    label: '经典',
    description: '默认浅色 — 靛蓝主调，柔和米白底，对长时间阅读友好。',
    swatches: { bg: 'hsl(220 20% 98%)', surface: 'hsl(220 16% 97%)', primary: 'hsl(243 75% 59%)', accent: 'hsl(220 14% 93%)' },
    base: 'light'
  },
  {
    id: 'warm',
    label: '米黄',
    description: '暖色系 — 米黄牛皮纸底，赤陶主调，像纸笔阅读的氛围。',
    swatches: { bg: 'hsl(40 40% 96%)', surface: 'hsl(40 45% 93%)', primary: 'hsl(22 75% 48%)', accent: 'hsl(38 35% 88%)' },
    base: 'light'
  },
  {
    id: 'cold',
    label: '极地蓝',
    description: '深色系 — 海军底色 + 冰蓝主调，冷静专注，夜间长时使用更轻松。',
    swatches: { bg: 'hsl(222 35% 8%)', surface: 'hsl(222 38% 6%)', primary: 'hsl(198 90% 60%)', accent: 'hsl(215 28% 21%)' },
    base: 'dark'
  },
  {
    id: 'twilight',
    label: '暮光紫',
    description: '深色系 — 梅紫底色 + 紫罗兰主调，柔和不刺眼，氛围感更强。',
    swatches: { bg: 'hsl(270 25% 10%)', surface: 'hsl(270 28% 8%)', primary: 'hsl(280 80% 68%)', accent: 'hsl(270 18% 22%)' },
    base: 'dark'
  },
  {
    id: 'terminal',
    label: '终端',
    description: '深色系 — 近黑炭底 + 磷光绿主调，仿 SSH 终端，专为深夜长时控制台操作而生。',
    swatches: { bg: 'hsl(150 10% 6%)', surface: 'hsl(150 12% 4%)', primary: 'hsl(142 70% 50%)', accent: 'hsl(152 9% 19%)' },
    base: 'dark'
  }
]

// DWork's exclusive default skin — white-dominant with #FF8921 orange accent.
// Only offered in the DWork flavor; prepended so it's the first/primary option.
export const DWORK_SKIN: SkinOption = {
  id: 'dwork',
  label: 'DWork',
  description: 'DWork 默认 — 纯白主调 + 暖橙 (#FF8921) 点缀，简洁明亮。',
  swatches: { bg: 'hsl(0 0% 100%)', surface: 'hsl(28 44% 97%)', primary: 'hsl(28 100% 56%)', accent: 'hsl(28 100% 92%)' },
  base: 'light'
}

export const VISIBLE_SKINS: SkinOption[] = IS_DWORK ? [DWORK_SKIN, ...SKIN_OPTIONS] : SKIN_OPTIONS
