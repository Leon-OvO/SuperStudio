import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type ScheduledTask, type ScheduledTaskRun, type ScheduledTaskInput, type ScheduledRunCompletedEvent, type VideoGenerateRequest, type VideoGenerateResult, type VideoProgressEvent } from '../../src/shared/ipc-types'

// Whether the OS will composite a vibrancy/acrylic backdrop behind the window —
// macOS always, Windows only on 11+ (build ≥ 22000). MUST mirror the gating in
// electron/main/index.ts createWindow(), since the renderer goes translucent
// based on this flag and a transparent window with no OS effect = bare desktop.
function vibrancyActive(): boolean {
  if (process.platform === 'darwin') return true
  // Windows acrylic is disabled: backgroundMaterial on a frameless window froze
  // input after dragging across monitors with different DPI on Win11 (a known
  // Electron/Chromium bug). The renderer therefore stays fully opaque on Windows.
  // MUST mirror main/index.ts vibrancyWindowOptions() (now darwin-only).
  return false
}

// Expose type-safe IPC bridge to renderer
const api = {
  // --- Auth (SuperCode account) ---
  login: (email: string, password: string, remember = true) => ipcRenderer.invoke(IPC.AUTH_LOGIN, email, password, remember),
  logout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  getAuthState: () => ipcRenderer.invoke(IPC.AUTH_GET_STATE),
  getSavedCredentials: () => ipcRenderer.invoke(IPC.AUTH_GET_SAVED_CREDS) as Promise<{ email: string; password: string } | null>,
  initAccount: () => ipcRenderer.invoke(IPC.ACCOUNT_INIT),
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
  vibeRun: (args: { projectPath: string; prompt: string; requestId?: string; forceIntent?: 'chat' | 'explore' | 'bugfix' | 'change'; attachments?: Array<{ name: string; path: string; mimeType: string }>; thinkingMode?: 'auto' | 'fast' | 'deep' }) =>
    ipcRenderer.invoke(IPC.VIBE_RUN, args),
  vibeApply: (args: { requestId: string }) => ipcRenderer.invoke(IPC.VIBE_APPLY, args),
  vibeStop: (args: { projectPath: string }) => ipcRenderer.invoke(IPC.VIBE_STOP, args),
  vibeRequestList: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_REQUEST_LIST, projectPath),
  vibeRequestListAll: () => ipcRenderer.invoke(IPC.VIBE_REQUEST_LIST_ALL),
  vibeRequestDelete: (id: string) => ipcRenderer.invoke(IPC.VIBE_REQUEST_DELETE, id),
  vibeRequestSetAssignee: (requestId: string, employeeId: string | null) => ipcRenderer.invoke(IPC.VIBE_REQUEST_SET_ASSIGNEE, { requestId, employeeId }),
  vibeTaskSetAssignee: (taskId: string, employeeId: string | null) => ipcRenderer.invoke(IPC.VIBE_TASK_SET_ASSIGNEE, { taskId, employeeId }),
  vibeTaskSetDeps: (taskId: string, deps: string[]) => ipcRenderer.invoke(IPC.VIBE_TASK_SET_DEPS, { taskId, deps }),
  vibeTaskList: (requestId: string) => ipcRenderer.invoke(IPC.VIBE_TASK_LIST, requestId),
  vibeTaskToggle: (args: { taskId: string; status: 'pending' | 'done' | 'skipped' }) =>
    ipcRenderer.invoke(IPC.VIBE_TASK_TOGGLE, args),
  vibeMessageList: (requestId: string) => ipcRenderer.invoke(IPC.VIBE_MESSAGE_LIST, requestId),
  // --- Git review layer ---
  vibeGitStatus: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_GIT_STATUS, projectPath),
  vibeGitDiff: (projectPath: string, path: string) => ipcRenderer.invoke(IPC.VIBE_GIT_DIFF, { projectPath, path }),
  vibeGitStage: (projectPath: string, path: string) => ipcRenderer.invoke(IPC.VIBE_GIT_STAGE, { projectPath, path }),
  vibeGitUnstage: (projectPath: string, path: string) => ipcRenderer.invoke(IPC.VIBE_GIT_UNSTAGE, { projectPath, path }),
  vibeGitRevertFile: (projectPath: string, path: string) => ipcRenderer.invoke(IPC.VIBE_GIT_REVERT_FILE, { projectPath, path }),
  vibeGitRevertHunk: (projectPath: string, path: string, hunkIndex: number) => ipcRenderer.invoke(IPC.VIBE_GIT_REVERT_HUNK, { projectPath, path, hunkIndex }),
  vibeGitStageHunk: (projectPath: string, path: string, hunkIndex: number) => ipcRenderer.invoke(IPC.VIBE_GIT_STAGE_HUNK, { projectPath, path, hunkIndex }),
  vibeGitCommit: (projectPath: string, message: string, paths?: string[]) => ipcRenderer.invoke(IPC.VIBE_GIT_COMMIT, { projectPath, message, paths }),
  vibeGitLog: (projectPath: string, limit?: number) => ipcRenderer.invoke(IPC.VIBE_GIT_LOG, { projectPath, limit }),
  vibeGitInit: (projectPath: string) => ipcRenderer.invoke(IPC.VIBE_GIT_INIT, projectPath),
  vibeGitRollback: (projectPath: string, checkpointId?: string) => ipcRenderer.invoke(IPC.VIBE_GIT_ROLLBACK, { projectPath, checkpointId }),
  vibeTaskRevert: (taskId: string, projectPath: string) => ipcRenderer.invoke(IPC.VIBE_TASK_REVERT, { taskId, projectPath }),
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
  createSession: (title?: string, opts?: { isScheduled?: boolean; employeeId?: string | null }) =>
    ipcRenderer.invoke(IPC.SESSIONS_CREATE, title, opts),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.SESSIONS_DELETE, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, title),
  archiveSession: (id: string, archived: boolean) => ipcRenderer.invoke(IPC.SESSIONS_ARCHIVE, id, archived),
  setSessionWorkingDir: (id: string, dir: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_SET_WORKING_DIR, id, dir) as Promise<{ ok: boolean; error?: string; workingDir?: string }>,
  setSessionAssignee: (id: string, employeeId: string | null) =>
    ipcRenderer.invoke(IPC.SESSIONS_SET_ASSIGNEE, id, employeeId) as Promise<{ ok: boolean }>,
  setSessionPinned: (id: string, pinned: boolean) =>
    ipcRenderer.invoke(IPC.SESSIONS_SET_PINNED, id, pinned) as Promise<{ ok: boolean }>,
  onSessionsChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on(IPC.SESSIONS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.SESSIONS_CHANGED, listener)
  },
  addGroupMember: (id: string, employeeId: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_ADD_MEMBER, id, employeeId) as Promise<{ ok: boolean; groupEmployeeIds: string[] }>,
  removeGroupMember: (id: string, employeeId: string) =>
    ipcRenderer.invoke(IPC.SESSIONS_REMOVE_MEMBER, id, employeeId) as Promise<{ ok: boolean; groupEmployeeIds: string[] }>,
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
    overrides?: { providerId?: string; model?: string; mountedSpaceIds?: string[]; imageSize?: string; imageQuality?: string; imageCount?: number; computerMode?: boolean; forceImage?: boolean; thinkingMode?: 'auto' | 'fast' | 'deep'; sshDefaultConnIds?: string[]; contextRefs?: import('../../src/shared/ipc-types').ContextRef[] }
  ) => ipcRenderer.invoke(IPC.AGENT_RUN, sessionId, message, attachments, overrides),
  stopAgent: (sessionId: string) => ipcRenderer.invoke(IPC.AGENT_STOP, sessionId),
  // --- Group chat (multi-agent) ---
  groupRun: (sessionId: string, message?: string) =>
    ipcRenderer.invoke(IPC.GROUP_RUN, { sessionId, message }) as Promise<{ started: boolean; speakers?: number; error?: string }>,
  stopGroup: (sessionId: string) => ipcRenderer.invoke(IPC.GROUP_STOP, sessionId),
  classifyIntent: (message: string, providerId: string, model: string) =>
    ipcRenderer.invoke(IPC.AGENT_CLASSIFY_INTENT, { message, providerId, model }) as Promise<string>,
  onAgentProgress: (cb: (event: unknown) => void) => {
    ipcRenderer.on(IPC.AGENT_PROGRESS, (_e, data) => cb(data))
    return () => ipcRenderer.removeAllListeners(IPC.AGENT_PROGRESS)
  },
  onAgentPhase: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on(IPC.AGENT_PHASE, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_PHASE, listener)
  },
  onAgentDelta: (cb: (data: { sessionId: string; messageId: string; delta: string; speakerEmployeeId?: string }) => void) => {
    const listener = (_e: unknown, data: { sessionId: string; messageId: string; delta: string; speakerEmployeeId?: string }) => cb(data)
    ipcRenderer.on(IPC.AGENT_DELTA, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_DELTA, listener)
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
  generateVideo: (params: VideoGenerateRequest) =>
    ipcRenderer.invoke(IPC.VIDEO_GENERATE, params) as Promise<VideoGenerateResult>,
  cancelVideo: (args: { clientJobId: string }) =>
    ipcRenderer.invoke(IPC.VIDEO_CANCEL, args) as Promise<{ ok: boolean }>,
  saveVideoThumbnail: (args: { galleryId: number; base64: string; ext?: 'jpg' | 'png' | 'webp' }) =>
    ipcRenderer.invoke(IPC.VIDEO_SAVE_THUMBNAIL, args) as Promise<{
      ok: boolean; thumbnailPath?: string; error?: string
    }>,
  onVideoProgress: (cb: (event: VideoProgressEvent) => void) => {
    const listener = (_e: unknown, data: VideoProgressEvent) => cb(data)
    ipcRenderer.on(IPC.VIDEO_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC.VIDEO_PROGRESS, listener)
  },

  // --- File operations ---
  readFile: (filePath: string) => ipcRenderer.invoke(IPC.FILE_READ, filePath),
  writeFile: (params: unknown) => ipcRenderer.invoke(IPC.FILE_WRITE, params),
  revertBackup: (backupPath: string, targetPath: string) =>
    ipcRenderer.invoke(IPC.FILE_REVERT_BACKUP, backupPath, targetPath),
  openFileDialog: (options?: unknown) => ipcRenderer.invoke(IPC.FILE_OPEN_DIALOG, options),
  writeTempFile: (params: { name: string; data: string }) => ipcRenderer.invoke(IPC.FILE_WRITE_TEMP, params),
  // Resolve a drag-dropped File's real absolute path. Electron 32+ removed
  // File.path; webUtils.getPathForFile is the supported replacement. Returns ''
  // for in-memory File objects (no disk backing) — callers fall back to writeTempFile.
  getPathForFile: (file: File): string => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  // Allowlist a dropped file's path so its local-file:// preview is served (drag-drop
  // bypasses the picker/paste approval). Await before rendering the thumbnail.
  approvePath: (filePath: string) => ipcRenderer.invoke(IPC.FILE_APPROVE_PATH, filePath),
  saveFileAs: (sourcePath: string, suggestedName?: string) =>
    ipcRenderer.invoke(IPC.FILE_SAVE_AS, sourcePath, suggestedName),
  saveTextAs: (params: { defaultName: string; content: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke(IPC.FILE_SAVE_TEXT, params),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke(IPC.SHELL_SHOW_ITEM, filePath),

  // --- Gallery ---
  listGallery: (filters?: unknown) => ipcRenderer.invoke(IPC.GALLERY_LIST, filters),
  searchGallery: (query: string, limit?: number) => ipcRenderer.invoke(IPC.GALLERY_SEARCH, query, limit),
  deleteGalleryItem: (id: number) => ipcRenderer.invoke(IPC.GALLERY_DELETE, id),
  batchDeleteGallery: (ids: number[]) => ipcRenderer.invoke(IPC.GALLERY_BATCH_DELETE, ids),
  batchSaveGallery: (ids: number[]) => ipcRenderer.invoke(IPC.GALLERY_BATCH_SAVE, ids),
  canvasGenerateOne: (params: { prompt: string; size?: string; quality?: string; n?: number; referenceImagePaths?: string[]; sceneLabel?: string; variantGroupId?: string }) =>
    ipcRenderer.invoke(IPC.CANVAS_GENERATE_ONE, params) as Promise<{ ok: boolean; paths: string[] }>,
  canvasExportGroup: (variantGroupId: string) =>
    ipcRenderer.invoke(IPC.CANVAS_EXPORT_GROUP, variantGroupId) as Promise<{ canceled?: boolean; saved: number; failures?: string[]; targetDir?: string }>,
  canvasExpandPrompt: (params: { prompt: string; referenceImagePaths?: string[] }) =>
    ipcRenderer.invoke(IPC.CANVAS_EXPAND_PROMPT, params) as Promise<{ ok: boolean; text?: string; error?: string }>,
  exportFilesToDir: (paths: string[]) =>
    ipcRenderer.invoke(IPC.FILE_EXPORT_TO_DIR, paths) as Promise<{ canceled?: boolean; saved: number; failures?: string[]; targetDir?: string }>,
  importGallery: () => ipcRenderer.invoke(IPC.GALLERY_IMPORT) as Promise<{
    canceled: boolean
    imported: number
    failures: string[]
  }>,

  // --- Long-term memory ---
  listMemories: (filter?: { kind?: string; scopeKey?: string | null; status?: string; query?: string }) =>
    ipcRenderer.invoke(IPC.MEMORY_LIST, filter),
  saveMemory: (input: unknown) => ipcRenderer.invoke(IPC.MEMORY_SAVE, input),
  deleteMemory: (id: string) => ipcRenderer.invoke(IPC.MEMORY_DELETE, id),
  setMemoryPinned: (id: string, pinned: boolean) => ipcRenderer.invoke(IPC.MEMORY_SET_PINNED, { id, pinned }),
  archiveMemory: (id: string, archived: boolean) => ipcRenderer.invoke(IPC.MEMORY_ARCHIVE, { id, archived }),
  captureSessionMemory: (sessionId: string) => ipcRenderer.invoke(IPC.MEMORY_CAPTURE_SESSION, sessionId),
  importMemories: (paths: string[]) =>
    ipcRenderer.invoke(IPC.MEMORY_IMPORT, paths) as Promise<{ imported: number; skipped: number; errors: string[] }>,
  exportMemories: () =>
    ipcRenderer.invoke(IPC.MEMORY_EXPORT) as Promise<{ canceled: boolean; filePath?: string; count?: number }>,
  onMemoryCaptured: (cb: (info: { count: number; memories: unknown[] }) => void) => {
    const listener = (_e: unknown, info: { count: number; memories: unknown[] }) => cb(info)
    ipcRenderer.on(IPC.MEMORY_CAPTURED, listener)
    return () => ipcRenderer.removeListener(IPC.MEMORY_CAPTURED, listener)
  },

  // --- Computer Use arming confirmation (styled in-app dialog) ---
  onComputerUseConfirm: (cb: (req: { id: string }) => void) => {
    const listener = (_e: unknown, req: { id: string }) => cb(req)
    ipcRenderer.on(IPC.COMPUTER_USE_CONFIRM, listener)
    return () => ipcRenderer.removeListener(IPC.COMPUTER_USE_CONFIRM, listener)
  },
  respondComputerUseConfirm: (id: string, ok: boolean) => ipcRenderer.send(IPC.COMPUTER_USE_CONFIRM_REPLY, { id, ok }),

  // --- Window controls ---
  platform: process.platform,
  vibrancy: vibrancyActive(),
  winMinimize: () => ipcRenderer.send(IPC.WIN_MINIMIZE),
  winMaximize: () => ipcRenderer.send(IPC.WIN_MAXIMIZE),
  winClose: () => ipcRenderer.send(IPC.WIN_CLOSE),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    ipcRenderer.on(IPC.WIN_MAXIMIZE_CHANGED, (_e, v) => cb(v))
    return () => ipcRenderer.removeAllListeners(IPC.WIN_MAXIMIZE_CHANGED)
  },

  // --- App version ---
  appVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),

  // --- Updater (GitHub-backed manual check; toast on startup if outdated) ---
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

  // --- Talent pool (encrypted bundled persona catalog) ---
  browseTalent: (args?: { dept?: string; keyword?: string; page?: number; pageSize?: number }) =>
    ipcRenderer.invoke(IPC.TALENT_BROWSE, args),
  getTalentSoul: (id: string) => ipcRenderer.invoke(IPC.TALENT_GET, id),
  tryTalent: (soulId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    ipcRenderer.invoke(IPC.TALENT_TRY, { soulId, messages }),
  importLocalTalent: (sourcePath: string) =>
    ipcRenderer.invoke(IPC.TALENT_IMPORT_LOCAL, sourcePath) as Promise<{ inserted: number; skipped: number; total: number }>,
  deleteUserSoul: (id: string) => ipcRenderer.invoke(IPC.TALENT_DELETE_USER, id),

  // --- AI company employees ---
  listEmployees: () => ipcRenderer.invoke(IPC.EMP_LIST),
  hireEmployee: (soulId: string) => ipcRenderer.invoke(IPC.EMP_HIRE, soulId),
  fireEmployee: (id: string) => ipcRenderer.invoke(IPC.EMP_FIRE, id),
  setEmployeeModel: (args: { id: string; providerId: string; modelId: string }) => ipcRenderer.invoke(IPC.EMP_SET_MODEL, args),
  setEmployeeDept: (args: { id: string; dept: string }) => ipcRenderer.invoke(IPC.EMP_SET_DEPT, args),
  companySpendRange: (fromMs: number, toMs: number): Promise<Array<{ id: string; cost: number; tokensIn: number; tokensOut: number }>> => ipcRenderer.invoke(IPC.EMP_SPEND_RANGE, { fromMs, toMs }),

  // --- SSH connections (Agent remote execution) ---
  sshListConnections: () => ipcRenderer.invoke(IPC.SSH_LIST),
  /** Credential-free connection summaries for the @-mention picker. */
  sshListMeta: () => ipcRenderer.invoke(IPC.SSH_LIST_META) as Promise<import('../../src/shared/ipc-types').SshConnectionMeta[]>,
  sshSaveConnection: (conn: unknown) => ipcRenderer.invoke(IPC.SSH_SAVE, conn),
  sshDeleteConnection: (id: string) => ipcRenderer.invoke(IPC.SSH_DELETE, id),
  sshTestConnection: (conn: unknown) => ipcRenderer.invoke(IPC.SSH_TEST, conn) as Promise<{ ok: boolean; error?: string }>,
  sshImportConnections: (filePath: string) => ipcRenderer.invoke(IPC.SSH_IMPORT, filePath) as Promise<{ imported: number; duplicates: number; skipped: number; missingKey: number }>,
  onSshExecConfirm: (cb: (req: { id: string; host: string; command: string }) => void) => {
    const listener = (_e: unknown, req: { id: string; host: string; command: string }) => cb(req)
    ipcRenderer.on(IPC.SSH_EXEC_CONFIRM, listener)
    return () => ipcRenderer.removeListener(IPC.SSH_EXEC_CONFIRM, listener)
  },
  respondSshExecConfirm: (id: string, ok: boolean) => ipcRenderer.send(IPC.SSH_EXEC_CONFIRM_REPLY, { id, ok }),

  // --- Local script execution gate (run_script tool) ---
  onLocalScriptConfirm: (cb: (req: { id: string; command: string; cwd: string }) => void) => {
    const listener = (_e: unknown, req: { id: string; command: string; cwd: string }) => cb(req)
    ipcRenderer.on(IPC.LOCAL_SCRIPT_CONFIRM, listener)
    return () => ipcRenderer.removeListener(IPC.LOCAL_SCRIPT_CONFIRM, listener)
  },
  respondLocalScriptConfirm: (id: string, ok: boolean) => ipcRenderer.send(IPC.LOCAL_SCRIPT_CONFIRM_REPLY, { id, ok }),

  // --- Remote model.conf (managed default models from GitHub) ---
  syncModelConf: () => ipcRenderer.invoke(IPC.MODEL_CONF_SYNC) as Promise<{
    ok: boolean
    applied: string[]
    error?: string
  }>,
  onModelConfApplied: (cb: (info: { applied: string[] }) => void) => {
    const listener = (_e: unknown, info: { applied: string[] }) => cb(info)
    ipcRenderer.on(IPC.MODEL_CONF_APPLIED, listener)
    return () => ipcRenderer.removeListener(IPC.MODEL_CONF_APPLIED, listener)
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

  // --- API request log (opt-in diagnostics) ---
  listApiRequestLog: () => ipcRenderer.invoke(IPC.API_LOG_LIST),
  clearApiRequestLog: () => ipcRenderer.invoke(IPC.API_LOG_CLEAR),
  openApiRequestLog: () => ipcRenderer.invoke(IPC.API_LOG_OPEN),

  // --- Workflow ---
  listWorkflows: (opts?: { kind?: string }) => ipcRenderer.invoke(IPC.WORKFLOWS_LIST, opts),
  saveWorkflow: (workflow: unknown) => ipcRenderer.invoke(IPC.WORKFLOWS_SAVE, workflow),
  deleteWorkflow: (id: string) => ipcRenderer.invoke(IPC.WORKFLOWS_DELETE, id),
  runWorkflow: (workflowId: string, variables?: Record<string, string>) =>
    ipcRenderer.invoke(IPC.WORKFLOW_RUN, workflowId, variables),
  stopWorkflow: (workflowId: string) => ipcRenderer.invoke(IPC.WORKFLOW_STOP, workflowId),
  onWorkflowNodeStatus: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(IPC.WORKFLOW_NODE_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.WORKFLOW_NODE_STATUS, listener)
  },
  onWorkflowDone: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(IPC.WORKFLOW_DONE, listener)
    return () => ipcRenderer.removeListener(IPC.WORKFLOW_DONE, listener)
  },
  workflowFromChat: (sessionId: string) =>
    ipcRenderer.invoke(IPC.WORKFLOW_FROM_CHAT, sessionId),

  // --- Skills ---
  listSkills: () => ipcRenderer.invoke(IPC.SKILLS_LIST),
  installSkill: (args: { sourceUrl: string; entry: unknown }) => ipcRenderer.invoke(IPC.SKILLS_INSTALL, args),
  importLocalSkill: (sourcePath: string) => ipcRenderer.invoke(IPC.SKILLS_IMPORT_LOCAL, sourcePath),
  exportSkill: (id: string) =>
    ipcRenderer.invoke(IPC.SKILLS_EXPORT, id) as Promise<{ canceled: boolean; filePath?: string; error?: string }>,
  discoverLocalSkills: (projectPath?: string) => ipcRenderer.invoke(IPC.SKILLS_DISCOVER_LOCAL, { projectPath }),
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
  previewScheduledNext: (scheduleKind: string, scheduleValue: unknown) =>
    ipcRenderer.invoke(IPC.SCHEDULER_PREVIEW_NEXT, { scheduleKind, scheduleValue }) as Promise<{ nextFireAt: number } | { error: string }>,
  onScheduledRunStarted: (cb: (event: { taskId: string; sessionId: string | null }) => void) => {
    const listener = (_e: unknown, data: { taskId: string; sessionId: string | null }) => cb(data)
    ipcRenderer.on(IPC.SCHEDULER_RUN_STARTED, listener)
    return () => ipcRenderer.removeListener(IPC.SCHEDULER_RUN_STARTED, listener)
  },
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
