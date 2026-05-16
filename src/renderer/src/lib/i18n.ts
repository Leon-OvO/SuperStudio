import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const ZH: Dict = {
  // Sidebar
  'nav.chat': '对话',
  'nav.workflow': '工作流',
  'nav.gallery': '画廊',
  'nav.knowledge': '知识库',
  'nav.settings': '设置',
  'nav.themeLight': '切换亮色',
  'nav.themeDark': '切换暗色',
  'nav.languageSwitch': '切换语言',

  // About
  'about.title': 'SuperStudio',
  'about.tagline': '本地优先的 AI 桌面工作台',
  'about.version': '版本',
  'about.platform': '平台',
  'about.repo': '仓库',
  'about.loading': '加载中…',
  'about.autoUpdate': '自动更新',
  'about.checkNow': '立即检查',
  'about.dataBackup': '数据备份',
  'about.exportConfig': '导出配置',
  'about.importMerge': '合并导入',
  'about.importReplace': '替换导入',
  'about.errorLog': '错误日志',
  'about.expand': '展开查看',
  'about.collapse': '收起',
  'about.refresh': '刷新',
  'about.copy': '复制',
  'about.clear': '清空',

  // Welcome
  'welcome.title': '欢迎使用 SuperStudio',
  'welcome.dismiss': '稍后再配',
  'welcome.stepStart': '开始',
  'welcome.stepProvider': '提供商',
  'welcome.stepModel': '默认模型',
  'welcome.stepDone': '完成',
  'welcome.start': '开始',
  'welcome.prev': '上一步',
  'welcome.next': '下一步',
  'welcome.finish': '完成',
  'welcome.beginUsing': '开始使用'
}

const EN: Dict = {
  'nav.chat': 'Chat',
  'nav.workflow': 'Workflow',
  'nav.gallery': 'Gallery',
  'nav.knowledge': 'Knowledge',
  'nav.settings': 'Settings',
  'nav.themeLight': 'Switch to light',
  'nav.themeDark': 'Switch to dark',
  'nav.languageSwitch': 'Switch language',

  'about.title': 'SuperStudio',
  'about.tagline': 'A local-first AI desktop workspace',
  'about.version': 'Version',
  'about.platform': 'Platform',
  'about.repo': 'Repository',
  'about.loading': 'Loading…',
  'about.autoUpdate': 'Auto-update',
  'about.checkNow': 'Check now',
  'about.dataBackup': 'Data backup',
  'about.exportConfig': 'Export config',
  'about.importMerge': 'Merge import',
  'about.importReplace': 'Replace import',
  'about.errorLog': 'Error log',
  'about.expand': 'Expand',
  'about.collapse': 'Collapse',
  'about.refresh': 'Refresh',
  'about.copy': 'Copy',
  'about.clear': 'Clear',

  'welcome.title': 'Welcome to SuperStudio',
  'welcome.dismiss': 'Configure later',
  'welcome.stepStart': 'Start',
  'welcome.stepProvider': 'Provider',
  'welcome.stepModel': 'Default model',
  'welcome.stepDone': 'Done',
  'welcome.start': 'Start',
  'welcome.prev': 'Back',
  'welcome.next': 'Next',
  'welcome.finish': 'Finish',
  'welcome.beginUsing': 'Begin using'
}

const RESOURCES: Record<Lang, Dict> = { zh: ZH, en: EN }

const LANG_KEY = 'ss-lang'
const initial: Lang = (typeof localStorage !== 'undefined' && (localStorage.getItem(LANG_KEY) as Lang)) || 'zh'

let current: Lang = initial
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function getSnapshot(): Lang { return current }

export function setLanguage(lang: Lang): void {
  if (lang === current) return
  current = lang
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore */ }
  listeners.forEach(cb => cb())
}

export function getLanguage(): Lang { return current }

/** Reactive language hook — components re-render on language change. */
export function useLanguage(): Lang {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Translate a key. Missing keys fall through to the zh value, then the key itself. */
export function t(key: string, lang?: Lang): string {
  const dict = RESOURCES[lang ?? current]
  return dict[key] ?? ZH[key] ?? key
}

/** Hook variant that re-renders on language change. */
export function useT(): (key: string) => string {
  const lang = useLanguage()
  return (key: string) => t(key, lang)
}
