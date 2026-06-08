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
  /** URL the updater fetches to detect a new version. May be a raw JSON file
   *  ({ version }) OR an HTML page embedding a
   *  `<script type="application/json" id="dwork-update-manifest">` JSON block
   *  (version / name / notes / mandatory / minVersion / downloads). The running
   *  app's version is compared against `version`. Empty = no update check. */
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
    // DWork 专属：版本检测与下载统一走自有更新站 dwork.op.dianhun.cn。
    // updateVersionUrl 指向落地页本身，页面 <head> 内嵌
    // <script id="dwork-update-manifest"> JSON 清单，由 checkUpdate 解析比对。
    updateVersionUrl: 'http://dwork.op.dianhun.cn/',
    updateReleasesUrl: 'http://dwork.op.dianhun.cn/#download',
  },
}

export const BRAND: Brand = BRANDS[FLAVOR]
