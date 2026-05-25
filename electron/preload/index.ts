import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ScheduledTask, type ScheduledTaskRun, type ScheduledTaskInput, type ScheduledRunCompletedEvent } from '../../src/shared/ipc-types'

// Expose type-safe IPC bridge to renderer
const api = {
  // --- Auth (SuperCode account) ---
  login: (email: string, password: string, remember = true) => ipcRenderer.invoke(IPC.AUTH_LOGIN, email, password, remember),
  logout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAuthState: () => ipcRenderer.invoke(IPC.AUTH_GET_STATE),
  getSavedCredentials: () => ipcRenderer.invoke(IPC.AUTH_GET_SAVED_CREDS) as Promise<{ email: string; password: string } | null>,
  initAccount: () => ipcRenderer.invoke(IPC.SUPERCODE_INIT_ACCOUNT),
  listKeyOptions: () => ipcRenderer.invoke(IPC.ACCOUNT_LIST_KEY_OPTIONS),
  selectPlatformKey: (args: { groupId: number; keyId: number }) => ipcRenderer.invoke(IPC.ACCOUNT_SELECT_KEY, args),
  revealKey: (args: { keyId: number }) => ipcRenderer.invoke(IPC.ACCOUNT_REVEAL_KEY, args),
  createKey: (args: { groupId: number; name?: string }) => ipcRenderer.invoke(IPC.ACCOUNT_CREATE_KEY, args),
  deleteKey: (args: { keyId: number }) => ipcRenderer.invoke(IPC.ACCOUNT_DELETE_KEY, args),
  listAvailableGroups: () => ipcRenderer.invoke(IPC.ACCOUNT_LIST_GROUPS),
  getSubscriptionStatus: () => ipcRenderer.invoke(IPC.ACCOUNT_GET_STATUS),
  // Token Plan key (single per user, lives next to the subscription card)
  getSubscriptionKey: () => ipcRenderer.invoke(IPC.SUBSCRIPTION_KEY_LIST),
  ensureSubscriptionKey: () => ipcRenderer.invoke(IPC.SUBSCRIPTION_KEY_ENSURE),
  deleteSubscriptionKey: (args: { keyId: number }) => ipcRenderer.invoke(IPC.SUBSCRIPTION_KEY_DELETE, args),
  resetSubscriptionKey: () => ipcRenderer.invoke(IPC.SUBSCRIPTION_KEY_RESET),
  onAuthStateChanged: (cb: (state: unknown) => void) => {
    ipcRenderer.on(IPC.AUTH_STATE_CHANGED, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.AUTH_STATE_CHANGED)
  },

  // --- Dashboard (usage analytics) ---
  getDashboardStats: () => ipcRenderer.invoke(IPC.DASHBOARD_STATS),
  getDashboardTrend: (params: unknown) => ipcRenderer.invoke(IPC.DASHBOARD_TREND, params),
  getDashboardModels: (params: unknown) => ipcRenderer.invoke(IPC.DASHBOARD_MODELS, params),
  getDashboardKeysUsage: (params: unknown) => ipcRenderer.invoke(IPC.DASHBOARD_KEYS_USAGE, params),

  // --- Vibe / Build page ---
  vibeListTree: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_LIST_TREE, projectPath),
  vibeReadFile: (filePath: string) => ipcRenderer.invoke(IPC.VIBE_READ_FILE, filePath),
  vibeFileSave: (args: { path: string; content: string }) => ipcRenderer.invoke(IPC.VIBE_FILE_SAVE, args),
  vibeNewProject: (args: { name: string; location?: string }) => ipcRenderer.invoke(IPC.VIBE_NEW_PROJECT, args),
  vibeListRecent: () => ipcRenderer.invoke(IPC.VIBE_LIST_RECENT),
  vibeRemoveRecent: (path: string) => ipcRenderer.invoke(IPC.VIBE_REMOVE_RECENT, path),
  vibeOpenExisting: (path: string) => ipcRenderer.invoke(IPC.VIBE_OPEN_EXISTING, path),
  vibeProjectGet: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_PROJECT_GET, projectPath),
  vibeProjectSetModel: (args: { projectPath: string; providerId: string; modelId: string }) =>
    ipcRenderer.invoke(IPC.VIBE_PROJECT_SET_MODEL, args),
  vibeChat: (args: { projectPath: string; prompt: string; requestId?: string }) =>
    ipcRenderer.invoke(IPC.VIBE_CHAT, args),
  vibeExplore: (args: { projectPath: string; prompt: string; requestId?: string }) =>
    ipcRenderer.invoke(IPC.VIBE_EXPLORE, args),
  vibeBugfix: (args: { projectPath: string; prompt: string; requestId?: string }) =>
    ipcRenderer.invoke(IPC.VIBE_BUGFIX, args),
  vibePropose: (args: { projectPath: string; prompt: string; requestId?: string }) =>
    ipcRenderer.invoke(IPC.VIBE_PROPOSE, args),
  vibeApply: (args: { requestId: string }) => ipcRenderer.invoke(IPC.VIBE_APPLY, args),
  vibeStop: (args: { projectPath: string }) => ipcRenderer.invoke(IPC.VIBE_STOP, args),
  vibeRequestList: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_REQUEST_LIST, projectPath),
  vibeRequestDelete: (id: string) => ipcRenderer.invoke(IPC.VIBE_REQUEST_DELETE, id),
  vibeTaskList: (requestId: string) => ipcRenderer.invoke(IPC.VIBE_TASK_LIST, requestId),
  vibeTaskToggle: (args: { taskId: string; status: 'pending' | 'done' | 'skipped' }) =>
    ipcRenderer.invoke(IPC.VIBE_TASK_TOGGLE, args),
  vibeMessageList: (requestId: string) => ipcRenderer.invoke(IPC.VIBE_MESSAGE_LIST, requestId),
  onVibeProgress: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on(IPC.VIBE_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC.VIBE_PROGRESS, listener)
  },
  onVibeDone: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on(IPC.VIBE_DONE, listener)
    return () => ipcRenderer.removeListener(IPC.VIBE_DONE, listener)
  },
  onVibeError: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on(IPC.VIBE_ERROR, listener)
    return () => ipcRenderer.removeListener(IPC.VIBE_ERROR, listener)
  },

  // --- Settings & Providers ---
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (data: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SET, data),
  resetAllSettings: () => ipcRenderer.invoke(IPC.SETTINGS_RESET),
  listProviders: () => ipcRenderer.invoke(IPC.PROVIDERS_LIST),
  saveProvider: (provider: unknown) => ipcRenderer.invoke(IPC.PROVIDERS_SAVE, provider),
  deleteProvider: (id: string) => ipcRenderer.invoke(IPC.PROVIDERS_DELETE, id),
  fetchModels: (providerId: string) => ipcRenderer.invoke(IPC.PROVIDERS_FETCH_MODELS, providerId),

  // --- Sessions ---
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST),
  createSession: (title?: string) => ipcRenderer.invoke(IPC.SESSIONS_CREATE, title),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.SESSIONS_DELETE, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, title),
  archiveSession: (id: string, archived: boolean) => ipcRenderer.invoke(IPC.SESSIONS_ARCHIVE, id, archived),
  listMessages: (sessionId: string) => ipcRenderer.invoke(IPC.MESSAGES_LIST, sessionId),
  deleteMessage: (messageId: string) => ipcRenderer.invoke(IPC.MESSAGES_DELETE, messageId),
  deleteMessagesFrom: (messageId: string) => ipcRenderer.invoke(IPC.MESSAGES_DELETE_FROM, messageId),
  clearSessionMessages: (sessionId: string) =>
    ipcRenderer.invoke(IPC.MESSAGES_CLEAR_SESSION, sessionId) as Promise<{ ok: boolean; deleted: number }>,
  updateMessage: (messageId: string, content: string) => ipcRenderer.invoke(IPC.MESSAGES_UPDATE, messageId, content),
  searchSessions: (query: string) => ipcRenderer.invoke(IPC.SESSIONS_SEARCH, query),
  exportAllSessions: () => ipcRenderer.invoke(IPC.SESSIONS_EXPORT_ALL),
  importSessions: (opts?: { strategy?: 'merge' | 'replace' }) =>
    ipcRenderer.invoke(IPC.SESSIONS_IMPORT, opts),

  // --- Agent ---
  runAgent: (
    sessionId: string,
    message: string,
    attachments?: unknown[],
    overrides?: { providerId?: string; model?: string; mountedSpaceIds?: string[]; imageSize?: string; imageQuality?: string; imageCount?: number }
  ) => ipcRenderer.invoke(IPC.AGENT_RUN, sessionId, message, attachments, overrides),
  stopAgent: (sessionId: string) => ipcRenderer.invoke(IPC.AGENT_STOP, sessionId),
  onAgentProgress: (cb: (event: unknown) => void) => {
    ipcRenderer.on(IPC.AGENT_PROGRESS, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.AGENT_PROGRESS)
  },
  onAgentDone: (cb: (data: unknown) => void) => {
    ipcRenderer.on(IPC.AGENT_DONE, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.AGENT_DONE)
  },
  onAgentError: (cb: (err: unknown) => void) => {
    ipcRenderer.on(IPC.AGENT_ERROR, (_e, err) => cb(err))
    return () => ipcRenderer.removeAllListeners(IPC.AGENT_ERROR)
  },

  // --- Image ---
  generateImage: (params: unknown) => ipcRenderer.invoke(IPC.IMAGE_GENERATE, params),
  editImage: (params: {
    mode: 'inpaint' | 'text_replace' | 'outpaint' | 'bg_removal'
    imageBase64: string
    maskBase64?: string
    prompt?: string
    size?: string
    sessionId?: string
    galleryNote?: string
  }) => ipcRenderer.invoke(IPC.IMAGE_EDIT, params),
  overwriteImage: (params: { path: string; base64: string }) =>
    ipcRenderer.invoke(IPC.IMAGE_OVERWRITE, params),

  // --- Video ---
  generateVideo: (params: unknown) => ipcRenderer.invoke(IPC.VIDEO_GENERATE, params),
  onVideoProgress: (cb: (event: unknown) => void) => {
    ipcRenderer.on(IPC.VIDEO_PROGRESS, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.VIDEO_PROGRESS)
  },

  // --- File operations ---
  readFile: (filePath: string) => ipcRenderer.invoke(IPC.FILE_READ, filePath),
  writeFile: (params: unknown) => ipcRenderer.invoke(IPC.FILE_WRITE, params),
  revertBackup: (backupPath: string, targetPath: string) =>
    ipcRenderer.invoke(IPC.FILE_REVERT_BACKUP, backupPath, targetPath),
  openFileDialog: (options?: unknown) => ipcRenderer.invoke(IPC.FILE_OPEN_DIALOG, options),
  writeTempFile: (params: { name: string; data: string }) => ipcRenderer.invoke(IPC.FILE_WRITE_TEMP, params),
  saveFileAs: (sourcePath: string, suggestedName?: string) =>
    ipcRenderer.invoke(IPC.FILE_SAVE_AS, sourcePath, suggestedName),
  saveTextAs: (params: { defaultName: string; content: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke(IPC.FILE_SAVE_TEXT, params),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke(IPC.SHELL_SHOW_ITEM, filePath),

  // --- Gallery ---
  listGallery: (filters?: unknown) => ipcRenderer.invoke(IPC.GALLERY_LIST, filters),
  deleteGalleryItem: (id: number) => ipcRenderer.invoke(IPC.GALLERY_DELETE, id),
  batchDeleteGallery: (ids: number[]) => ipcRenderer.invoke(IPC.GALLERY_BATCH_DELETE, ids),
  batchSaveGallery: (ids: number[]) => ipcRenderer.invoke(IPC.GALLERY_BATCH_SAVE, ids),
  importGallery: () => ipcRenderer.invoke(IPC.GALLERY_IMPORT) as Promise<{
    canceled: boolean
    imported: number
    failures: string[]
  }>,

  // --- Knowledge Base ---
  listSpaces: () => ipcRenderer.invoke(IPC.KB_SPACES_LIST),
  saveSpace: (space: unknown) => ipcRenderer.invoke(IPC.KB_SPACES_SAVE, space),
  deleteSpace: (id: string) => ipcRenderer.invoke(IPC.KB_SPACES_DELETE, id),
  listPages: (spaceId: string) => ipcRenderer.invoke(IPC.KB_PAGES_LIST, spaceId),
  savePage: (page: unknown) => ipcRenderer.invoke(IPC.KB_PAGES_SAVE, page),
  deletePage: (id: string) => ipcRenderer.invoke(IPC.KB_PAGES_DELETE, id),
  importFile: (params: unknown) => ipcRenderer.invoke(IPC.KB_IMPORT_FILE, params),
  onKbImportProgress: (cb: (event: unknown) => void) => {
    ipcRenderer.on(IPC.KB_IMPORT_PROGRESS, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.KB_IMPORT_PROGRESS)
  },
  searchKb: (query: string, spaceIds?: string[]) =>
    ipcRenderer.invoke(IPC.KB_SEARCH, query, spaceIds),
  listSources: (spaceId: string) => ipcRenderer.invoke(IPC.KB_SOURCES_LIST, spaceId),
  deleteSource: (sourceId: string) => ipcRenderer.invoke(IPC.KB_SOURCES_DELETE, sourceId),
  reindexSpace: (spaceId: string) => ipcRenderer.invoke(IPC.KB_REINDEX_SPACE, spaceId),

  // --- Window controls ---
  platform: process.platform,
  winMinimize: () => ipcRenderer.send(IPC.WIN_MINIMIZE),
  winMaximize: () => ipcRenderer.send(IPC.WIN_MAXIMIZE),
  winClose: () => ipcRenderer.send(IPC.WIN_CLOSE),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    ipcRenderer.on(IPC.WIN_MAXIMIZE_CHANGED, (_e, v) => cb(v))
    return () => ipcRenderer.removeAllListeners(IPC.WIN_MAXIMIZE_CHANGED)
  },

  // --- App version ---
  appVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),

  // --- Updater (Gitee-backed manual check; toast on startup if outdated) ---
  checkForUpdate: () => ipcRenderer.invoke(IPC.UPDATER_CHECK) as Promise<{
    hasUpdate: boolean
    currentVersion: string
    remoteVersion: string | null
    remoteName: string | null
    body: string | null
    releaseUrl: string
    error?: string
  }>,
  openReleasePage: (url?: string) => ipcRenderer.send(IPC.UPDATER_OPEN_RELEASE, url),
  onUpdateAvailable: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info)
    ipcRenderer.on(IPC.UPDATER_AVAILABLE, listener)
    return () => ipcRenderer.removeListener(IPC.UPDATER_AVAILABLE, listener)
  },

  // --- System integration (auto-launch + Explorer right-click menu) ---
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke(IPC.APP_SET_AUTO_LAUNCH, enabled) as Promise<{ ok: boolean; error?: string }>,
  setShellIntegration: (enabled: boolean) => ipcRenderer.invoke(IPC.APP_SET_SHELL_INTEGRATION, enabled) as Promise<{ ok: boolean; error?: string }>,
  getSystemState: () => ipcRenderer.invoke(IPC.APP_GET_SYSTEM_STATE) as Promise<{
    autoLaunch: boolean
    shellIntegration: boolean
    shellIntegrationSupported: boolean
    storedAutoLaunch: boolean
    storedShellIntegration: boolean
  }>,
  onOpenPathFromShell: (cb: (path: string) => void) => {
    const listener = (_e: unknown, p: string) => cb(p)
    ipcRenderer.on(IPC.APP_OPEN_PATH_FROM_SHELL, listener)
    return () => ipcRenderer.removeListener(IPC.APP_OPEN_PATH_FROM_SHELL, listener)
  },

  // --- Whole-app config export / import ---
  exportConfig: () => ipcRenderer.invoke(IPC.CONFIG_EXPORT),
  importConfig: (opts?: { strategy?: 'merge' | 'replace' }) =>
    ipcRenderer.invoke(IPC.CONFIG_IMPORT, opts),

  // --- Provider connection test ---
  testProvider: (provider: unknown) => ipcRenderer.invoke(IPC.PROVIDERS_TEST, provider),

  // --- Error log ---
  listErrorLog: () => ipcRenderer.invoke(IPC.LOG_LIST),
  clearErrorLog: () => ipcRenderer.invoke(IPC.LOG_CLEAR),
  reportError: (entry: { level: 'error' | 'warn' | 'info'; message: string; stack?: string; context?: Record<string, unknown> }) =>
    ipcRenderer.invoke(IPC.LOG_APPEND, entry),

  // --- Workflow ---
  listWorkflows: () => ipcRenderer.invoke(IPC.WORKFLOWS_LIST),
  saveWorkflow: (workflow: unknown) => ipcRenderer.invoke(IPC.WORKFLOWS_SAVE, workflow),
  deleteWorkflow: (id: string) => ipcRenderer.invoke(IPC.WORKFLOWS_DELETE, id),
  runWorkflow: (workflowId: string, variables?: Record<string, string>) =>
    ipcRenderer.invoke(IPC.WORKFLOW_RUN, workflowId, variables),
  stopWorkflow: (workflowId: string) => ipcRenderer.invoke(IPC.WORKFLOW_STOP, workflowId),
  onWorkflowNodeStatus: (cb: (event: unknown) => void) => {
    ipcRenderer.on(IPC.WORKFLOW_NODE_STATUS, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.WORKFLOW_NODE_STATUS)
  },
  workflowFromChat: (sessionId: string) =>
    ipcRenderer.invoke(IPC.WORKFLOW_FROM_CHAT, sessionId),

  // --- Skills ---
  listSkills: () => ipcRenderer.invoke(IPC.SKILLS_LIST),
  installSkill: (args: { sourceUrl: string; entry: unknown }) => ipcRenderer.invoke(IPC.SKILLS_INSTALL, args),
  uninstallSkill: (id: string) => ipcRenderer.invoke(IPC.SKILLS_UNINSTALL, id),
  setSkillEnabled: (args: { id: string; enabled: boolean }) => ipcRenderer.invoke(IPC.SKILLS_SET_ENABLED, args),
  setSkillScenarios: (args: { id: string; scenarios: ('chat' | 'vibe' | 'video')[] }) =>
    ipcRenderer.invoke(IPC.SKILLS_SET_SCENARIOS, args),
  setSkillAllowScripts: (args: { id: string; allow: boolean }) =>
    ipcRenderer.invoke(IPC.SKILLS_SET_ALLOW_SCRIPTS, args),
  readSkillFile: (args: { id: string; path: string }) =>
    ipcRenderer.invoke(IPC.SKILLS_READ_FILE, args),
  listSkillSources: () => ipcRenderer.invoke(IPC.SKILLS_SOURCES_LIST),
  addSkillSource: (args: { url: string; name: string }) => ipcRenderer.invoke(IPC.SKILLS_SOURCES_ADD, args),
  deleteSkillSource: (url: string) => ipcRenderer.invoke(IPC.SKILLS_SOURCES_DELETE, url),
  setSkillSourceEnabled: (args: { url: string; enabled: boolean }) =>
    ipcRenderer.invoke(IPC.SKILLS_SOURCES_SET_ENABLED, args),
  browseSkillRegistry: (args?: { page?: number; pageSize?: number; keyword?: string }) =>
    ipcRenderer.invoke(IPC.SKILLS_BROWSE, args),

  // --- Terminal (PTY-backed shell in Vibe page) ---
  terminalCreate: (args: { cwd: string; cols: number; rows: number }) =>
    ipcRenderer.invoke(IPC.TERMINAL_CREATE, args) as Promise<{ ok: boolean; id?: string; error?: string }>,
  // fire-and-forget for keystroke latency — don't await the round-trip
  terminalWrite: (args: { id: string; data: string }) => ipcRenderer.send(IPC.TERMINAL_WRITE, args),
  terminalResize: (args: { id: string; cols: number; rows: number }) =>
    ipcRenderer.invoke(IPC.TERMINAL_RESIZE, args),
  terminalDispose: (args: { id: string }) => ipcRenderer.invoke(IPC.TERMINAL_DISPOSE, args),
  onTerminalData: (cb: (event: { id: string; data: string }) => void) => {
    const listener = (_e: unknown, data: { id: string; data: string }) => cb(data)
    ipcRenderer.on(IPC.TERMINAL_DATA, listener)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, listener)
  },
  onTerminalExit: (cb: (event: { id: string; exitCode: number }) => void) => {
    const listener = (_e: unknown, data: { id: string; exitCode: number }) => cb(data)
    ipcRenderer.on(IPC.TERMINAL_EXIT, listener)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, listener)
  },

  // --- Scheduled prompts ---
  listScheduledTasks: () => ipcRenderer.invoke(IPC.SCHEDULER_LIST) as Promise<ScheduledTask[]>,
  getScheduledTask: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_GET, id) as Promise<ScheduledTask | null>,
  createScheduledTask: (input: ScheduledTaskInput) => ipcRenderer.invoke(IPC.SCHEDULER_CREATE, input) as Promise<ScheduledTask>,
  updateScheduledTask: (id: string, input: ScheduledTaskInput) =>
    ipcRenderer.invoke(IPC.SCHEDULER_UPDATE, id, input) as Promise<ScheduledTask>,
  deleteScheduledTask: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_DELETE, id) as Promise<{ ok: boolean }>,
  setScheduledTaskEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.SCHEDULER_SET_ENABLED, id, enabled) as Promise<{ ok: boolean }>,
  triggerScheduledTaskNow: (id: string) => ipcRenderer.invoke(IPC.SCHEDULER_TRIGGER_NOW, id) as Promise<{ ok: boolean }>,
  listScheduledTaskRuns: (taskId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.SCHEDULER_LIST_RUNS, taskId, limit) as Promise<ScheduledTaskRun[]>,
  onScheduledRunCompleted: (cb: (event: ScheduledRunCompletedEvent) => void) => {
    const listener = (_e: unknown, data: ScheduledRunCompletedEvent) => cb(data)
    ipcRenderer.on(IPC.SCHEDULER_RUN_COMPLETED, listener)
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_RUN_COMPLETED, listener)
  },
  onSchedulerFocusTask: (cb: (event: { taskId: string }) => void) => {
    const listener = (_e: unknown, data: { taskId: string }) => cb(data)
    ipcRenderer.on(IPC.SCHEDULER_FOCUS_TASK, listener)
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_FOCUS_TASK, listener)
  },

  // --- MCP servers ---
  listMcpServers: () => ipcRenderer.invoke(IPC.MCP_SERVERS_LIST),
  saveMcpServer: (server: unknown) => ipcRenderer.invoke(IPC.MCP_SERVERS_SAVE, server),
  deleteMcpServer: (id: string) => ipcRenderer.invoke(IPC.MCP_SERVERS_DELETE, id),
  testMcpServer: (server: unknown) => ipcRenderer.invoke(IPC.MCP_SERVERS_TEST, server),
  listMcpTools: () => ipcRenderer.invoke(IPC.MCP_TOOLS_LIST),
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
