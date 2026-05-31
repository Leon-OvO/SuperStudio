import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const ZH: Dict = {
  // Sidebar
  'nav.chat': '对话',
  'nav.vibe': '构建',
  'nav.workflow': '工作流',
  'nav.gallery': '素材库',
  'nav.video': '视频',
  'nav.knowledge': '知识库',
  'nav.skills': '技能',
  'nav.scheduler': '定时',
  'nav.settings': '设置',
  'nav.themeLight': '切换亮色',
  'nav.themeDark': '切换暗色',
  'nav.languageSwitch': '切换语言',
  'nav.collapse': '收起菜单',
  'nav.expand': '展开菜单',

  // About
  'about.title': 'SuperStudio',
  'about.tagline': '本地优先的 AI 桌面工作台',
  'about.version': '版本',
  'about.platform': '平台',
  'about.website': '官网',
  'about.loading': '加载中…',
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
  'welcome.beginUsing': '开始使用',

  // Video
  'video.title': '视频生成',
  'video.model': '模型',
  'video.reference': '参考图 / 首帧',
  'video.frameFirst': '首帧',
  'video.frameLast': '尾帧',
  'video.frameStyle': '风格参考',
  'video.prompt': '提示词',
  'video.negative': '负面提示词',
  'video.aspect': '画面比例',
  'video.duration': '时长',
  'video.advanced': '高级参数',
  'video.generate': '生成视频',
  'video.tasks': '任务',
  'video.refresh': '刷新',
  'video.sectionActive': '进行中',
  'video.sectionFailed': '未完成',
  'video.sectionHistory': '历史',
  'video.empty': '填好左侧参数，点击「生成视频」开始',

  // Gallery
  'gallery.filterAll': '全部',
  'gallery.filterImage': '图片',
  'gallery.filterVideo': '视频',
  'gallery.filterAudio': '音频',
  'gallery.searchPlaceholder': '搜索素材…',
  'gallery.sourceAll': '全部来源',
  'gallery.sourceChat': '对话',
  'gallery.sourceWorkflow': '工作流',
  'gallery.sourceImport': '导入',
  'gallery.import': '导入',
  'gallery.importing': '导入中…',
  'gallery.selectAll': '全选',
  'gallery.deselectAll': '取消全选',
  'gallery.useAsReference': '用作参考图',
  'gallery.saveToFolder': '保存到文件夹',
  'gallery.deleteSelected': '删除选中',
  'gallery.loading': '加载中…',
  'gallery.emptySearch': '未找到匹配的内容',
  'gallery.emptyAudio': '暂无音频，点击「导入」添加，或用支持音频的工具生成。',
  'gallery.emptyVideo': '暂无视频，去「对话」「工作流」生成，或点击「导入」添加。',
  'gallery.emptyImage': '暂无图片，去「对话」「工作流」生成，或点击「导入」添加。',
  'gallery.emptyAll': '暂无素材，去「对话」「工作流」生成，或点击「导入」添加本地文件。',
  'gallery.edit': '编辑',
  'gallery.copy': '复制',
  'gallery.saveAs': '另存为',
  'gallery.revealInFolder': '文件夹中显示',
  'gallery.delete': '删除',

  // Knowledge
  'kb.newSpace': '新建空间',
  'kb.searchPlaceholder': '语义搜索…',
  'kb.tabPages': '页面',
  'kb.tabFiles': '文件',
  'kb.newPage': '新建页面',
  'kb.importFile': '导入文件',
  'kb.importing': '导入中…',
  'kb.globalContext': '作为全局上下文',
  'kb.backToList': '返回列表',
  'kb.noResults': '没有匹配的结果。',
  'kb.emptyPages': '暂无页面，点上方「新建页面」开始。',
  'kb.emptySources': '暂无导入文件，点上方「导入文件」开始。',
  'kb.editorEmptyPage': '选择或新建一个页面开始编辑。',
  'kb.editorEmptySpace': '请先在左侧选择一个知识空间。',
  'kb.pageTitlePlaceholder': '页面标题',
  'kb.modeEdit': '编辑',
  'kb.modePreview': '预览',

  // Skills
  'skills.title': '技能中心',
  'skills.tabInstalled': '已安装',
  'skills.tabBrowse': '发现',
  'skills.tabSources': '源',
  'skills.mySkills': '我的技能',
  'skills.searchInstalledPlaceholder': '搜索已安装…',
  'skills.emptyInstalledTitle': '还没安装任何技能',
  'skills.emptyInstalledMessage': '点上方「发现」浏览推荐技能，或在「源」里添加自定义仓库。',
  'skills.recommended': '推荐技能',
  'skills.searchPlaceholder': '搜索技能…',
  'skills.refresh': '刷新',
  'skills.browseEmptyTitle': '暂无可用技能',
  'skills.browseEmptyMessage': '检查源是否启用，或添加你自己的仓库。',
  'skills.install': '安装',
  'skills.installed': '已安装',
  'skills.sourcesTitle': '技能源',
  'skills.addSource': '添加源',

  // Scheduler
  'sched.title': '定时任务',
  'sched.notifyBots': '通知机器人',
  'sched.newTask': '新建任务',
  'sched.loading': '加载中…',
  'sched.paused': '已暂停',
  'sched.startFromTemplate': '从模板开始',

  // Workflow
  'wf.newWorkflow': '新建工作流',
  'wf.save': '保存',
  'wf.run': '运行',
  'wf.stop': '停止',
  'wf.fillVariables': '填写工作流变量',
  'wf.cancel': '取消',
  'wf.startRun': '开始运行',
  'wf.tabNodes': '节点',
  'wf.tabTemplates': '模板',

  // Settings tabs
  'settings.tabAccount': '账号',
  'settings.tabGlobal': '全局',
  'settings.tabWebSearch': '网络搜索',
  'settings.tabKnowledgeBase': '知识库',
  'settings.tabMcpServers': 'MCP 服务器',
  'settings.tabAbout': '关于 & 更新',

  // Chat header
  'chatHeader.noSession': '未选择对话',
  'chatHeader.untitled': '未命名对话',
  'chatHeader.renameTitle': '点击重命名对话',
  'chatHeader.saveTitle': '保存 (Enter)',
  'chatHeader.cancelTitle': '取消 (Esc)',
  'chatHeader.export': '导出',
  'chatHeader.exportTitle': '导出当前对话',
  'chatHeader.saveAsWorkflow': '保存为工作流',
  'chatHeader.saveAsWorkflowTitle': '把当前对话转换为可视化工作流'
}

const EN: Dict = {
  'nav.chat': 'Chat',
  'nav.vibe': 'Build',
  'nav.workflow': 'Workflow',
  'nav.gallery': 'Asset Library',
  'nav.video': 'Video',
  'nav.knowledge': 'Knowledge',
  'nav.skills': 'Skills',
  'nav.scheduler': 'Scheduler',
  'nav.settings': 'Settings',
  'nav.themeLight': 'Switch to light',
  'nav.themeDark': 'Switch to dark',
  'nav.languageSwitch': 'Switch language',
  'nav.collapse': 'Collapse menu',
  'nav.expand': 'Expand menu',

  'about.title': 'SuperStudio',
  'about.tagline': 'A local-first AI desktop workspace',
  'about.version': 'Version',
  'about.platform': 'Platform',
  'about.website': 'Website',
  'about.loading': 'Loading…',
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
  'welcome.beginUsing': 'Begin using',

  // Video
  'video.title': 'Video Generation',
  'video.model': 'Model',
  'video.reference': 'Reference / First Frame',
  'video.frameFirst': 'First frame',
  'video.frameLast': 'Last frame',
  'video.frameStyle': 'Style ref',
  'video.prompt': 'Prompt',
  'video.negative': 'Negative prompt',
  'video.aspect': 'Aspect ratio',
  'video.duration': 'Duration',
  'video.advanced': 'Advanced',
  'video.generate': 'Generate video',
  'video.tasks': 'Tasks',
  'video.refresh': 'Refresh',
  'video.sectionActive': 'In progress',
  'video.sectionFailed': 'Unfinished',
  'video.sectionHistory': 'History',
  'video.empty': 'Fill in the parameters on the left and click "Generate video" to start',

  // Gallery
  'gallery.filterAll': 'All',
  'gallery.filterImage': 'Images',
  'gallery.filterVideo': 'Videos',
  'gallery.filterAudio': 'Audio',
  'gallery.searchPlaceholder': 'Search assets…',
  'gallery.sourceAll': 'All sources',
  'gallery.sourceChat': 'Chat',
  'gallery.sourceWorkflow': 'Workflow',
  'gallery.sourceImport': 'Import',
  'gallery.import': 'Import',
  'gallery.importing': 'Importing…',
  'gallery.selectAll': 'Select all',
  'gallery.deselectAll': 'Deselect all',
  'gallery.useAsReference': 'Use as reference',
  'gallery.saveToFolder': 'Save to folder',
  'gallery.deleteSelected': 'Delete selected',
  'gallery.loading': 'Loading…',
  'gallery.emptySearch': 'No matching results found',
  'gallery.emptyAudio': 'No audio yet. Click "Import" to add files, or generate some with an audio-capable tool.',
  'gallery.emptyVideo': 'No videos yet. Generate them in Chat or Workflow, or click "Import" to add files.',
  'gallery.emptyImage': 'No images yet. Generate them in Chat or Workflow, or click "Import" to add files.',
  'gallery.emptyAll': 'No assets yet. Generate them in Chat or Workflow, or click "Import" to add local files.',
  'gallery.edit': 'Edit',
  'gallery.copy': 'Copy',
  'gallery.saveAs': 'Save as',
  'gallery.revealInFolder': 'Reveal in folder',
  'gallery.delete': 'Delete',

  // Knowledge
  'kb.newSpace': 'New Space',
  'kb.searchPlaceholder': 'Semantic search…',
  'kb.tabPages': 'Pages',
  'kb.tabFiles': 'Files',
  'kb.newPage': 'New Page',
  'kb.importFile': 'Import File',
  'kb.importing': 'Importing…',
  'kb.globalContext': 'Use as global context',
  'kb.backToList': 'Back to list',
  'kb.noResults': 'No matching results.',
  'kb.emptyPages': 'No pages yet. Click "New Page" above to start.',
  'kb.emptySources': 'No imported files yet. Click "Import File" above to start.',
  'kb.editorEmptyPage': 'Select or create a page to start editing.',
  'kb.editorEmptySpace': 'Select a knowledge space on the left first.',
  'kb.pageTitlePlaceholder': 'Page title',
  'kb.modeEdit': 'Edit',
  'kb.modePreview': 'Preview',

  // Skills
  'skills.title': 'Skills',
  'skills.tabInstalled': 'Installed',
  'skills.tabBrowse': 'Discover',
  'skills.tabSources': 'Sources',
  'skills.mySkills': 'My Skills',
  'skills.searchInstalledPlaceholder': 'Search installed…',
  'skills.emptyInstalledTitle': 'No skills installed yet',
  'skills.emptyInstalledMessage': 'Open "Discover" above to browse recommended skills, or add a custom repository under "Sources".',
  'skills.recommended': 'Recommended',
  'skills.searchPlaceholder': 'Search skills…',
  'skills.refresh': 'Refresh',
  'skills.browseEmptyTitle': 'No skills available',
  'skills.browseEmptyMessage': 'Check that a source is enabled, or add your own repository.',
  'skills.install': 'Install',
  'skills.installed': 'Installed',
  'skills.sourcesTitle': 'Skill Sources',
  'skills.addSource': 'Add Source',

  // Scheduler
  'sched.title': 'Scheduled Tasks',
  'sched.notifyBots': 'Notification Bots',
  'sched.newTask': 'New Task',
  'sched.loading': 'Loading…',
  'sched.paused': 'Paused',
  'sched.startFromTemplate': 'Start from a Template',

  // Workflow
  'wf.newWorkflow': 'New Workflow',
  'wf.save': 'Save',
  'wf.run': 'Run',
  'wf.stop': 'Stop',
  'wf.fillVariables': 'Fill in Workflow Variables',
  'wf.cancel': 'Cancel',
  'wf.startRun': 'Start Run',
  'wf.tabNodes': 'Nodes',
  'wf.tabTemplates': 'Templates',

  // Settings tabs
  'settings.tabAccount': 'Account',
  'settings.tabGlobal': 'General',
  'settings.tabWebSearch': 'Web Search',
  'settings.tabKnowledgeBase': 'Knowledge Base',
  'settings.tabMcpServers': 'MCP Servers',
  'settings.tabAbout': 'About & Updates',

  // Chat header
  'chatHeader.noSession': 'No conversation selected',
  'chatHeader.untitled': 'Untitled conversation',
  'chatHeader.renameTitle': 'Click to rename conversation',
  'chatHeader.saveTitle': 'Save (Enter)',
  'chatHeader.cancelTitle': 'Cancel (Esc)',
  'chatHeader.export': 'Export',
  'chatHeader.exportTitle': 'Export current conversation',
  'chatHeader.saveAsWorkflow': 'Save as Workflow',
  'chatHeader.saveAsWorkflowTitle': 'Convert this conversation into a visual workflow'
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
