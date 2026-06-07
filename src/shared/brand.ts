// Per-flavor brand identity. The single source of truth for product name,
// packaging ids, user-facing strings, default skin and data-namespace.
//
// Core (deliverable) code MUST read brand values from here rather than
// hard-coding "SuperStudio". Adding a new white-label customer = adding one
// entry to BRANDS + its FLAVOR, with no edits to page code.
//
// NOTE: keep this file free of proprietary URLs (no supercode.help). The
// SuperStudio flavor's commercial links live in the proprietary overlay, not
// in the deliverable core brand table.

import { FLAVOR, type Flavor } from './flavor'

export interface Brand {
  /** Matches the active FLAVOR. */
  id: Flavor
  /** electron-builder productName + installer/app name. */
  productName: string
  /** electron-builder appId / Windows AppUserModelId. */
  appId: string
  /** User-facing display name (titlebar, about page). */
  displayName: string
  /** Short tagline shown on the about page. */
  tagline: string
  /** Public website shown in the about page (empty = hidden). */
  websiteUrl: string
  /** Copyright line for packaging. */
  copyright: string
  /** Skin id applied as the default on first run for this flavor. */
  defaultSkin: string
  /** Namespace prefix for data files / store keys so installs of different
   *  flavors never read or overwrite each other's data. */
  dataNamespace: string
  /** Raw URL of a package.json (or version file) used to detect updates by
   *  comparing its `version` with the running app. Empty = no update check. */
  updateVersionUrl?: string
  /** Releases page opened when the user clicks "download new version". */
  updateReleasesUrl?: string
}

const BRANDS: Record<Flavor, Brand> = {
  superstudio: {
    id: 'superstudio',
    productName: 'SuperStudio',
    appId: 'com.superstudio.app',
    displayName: 'SuperStudio',
    tagline: '本地优先的 AI 桌面工作台',
    websiteUrl: '',
    copyright: 'Copyright © 2026 SuperStudio',
    defaultSkin: 'classic',
    dataNamespace: 'superstudio',
  },
  dwork: {
    id: 'dwork',
    productName: 'DWork',
    appId: 'com.dwork.app',
    displayName: 'DWork',
    tagline: 'AI 工作台',
    websiteUrl: '',
    copyright: 'Copyright © 2026 DWork',
    defaultSkin: 'dwork',
    dataNamespace: 'dwork',
    updateVersionUrl: 'http://git.op.dianhun.cn/dejianxiang/DWork/raw/main/package.json',
    updateReleasesUrl: 'http://git.op.dianhun.cn/dejianxiang/DWork/releases',
  },
}

export const BRAND: Brand = BRANDS[FLAVOR]
