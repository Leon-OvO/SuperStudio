import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../../src/shared/ipc-types'

// Expose type-safe IPC bridge to renderer
const api = {
  // --- Settings & Providers ---
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (data: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SET, data),
  listProviders: () => ipcRenderer.invoke(IPC.PROVIDERS_LIST),
  saveProvider: (provider: unknown) => ipcRenderer.invoke(IPC.PROVIDERS_SAVE, provider),
  deleteProvider: (id: string) => ipcRenderer.invoke(IPC.PROVIDERS_DELETE, id),
  fetchModels: (providerId: string) => ipcRenderer.invoke(IPC.PROVIDERS_FETCH_MODELS, providerId),

  // --- Sessions ---
  listSessions: () => ipcRenderer.invoke(IPC.SESSIONS_LIST),
  createSession: (title?: string) => ipcRenderer.invoke(IPC.SESSIONS_CREATE, title),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.SESSIONS_DELETE, id),
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, title),
  listMessages: (sessionId: string) => ipcRenderer.invoke(IPC.MESSAGES_LIST, sessionId),
  deleteMessage: (messageId: string) => ipcRenderer.invoke(IPC.MESSAGES_DELETE, messageId),
  deleteMessagesFrom: (messageId: string) => ipcRenderer.invoke(IPC.MESSAGES_DELETE_FROM, messageId),
  updateMessage: (messageId: string, content: string) => ipcRenderer.invoke(IPC.MESSAGES_UPDATE, messageId, content),

  // --- Agent ---
  runAgent: (
    sessionId: string,
    message: string,
    attachments?: unknown[],
    overrides?: { providerId?: string; model?: string; mountedSpaceIds?: string[] }
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

  // --- App version + auto-update ---
  appVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),
  checkForUpdates: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.UPDATE_STATUS),
  onUpdateStatus: (cb: (status: unknown) => void) => {
    ipcRenderer.on(IPC.UPDATE_STATUS, (_e, status) => cb(status))
    return () => ipcRenderer.removeAllListeners(IPC.UPDATE_STATUS)
  },

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

  // --- MCP servers ---
  listMcpServers: () => ipcRenderer.invoke(IPC.MCP_SERVERS_LIST),
  saveMcpServer: (server: unknown) => ipcRenderer.invoke(IPC.MCP_SERVERS_SAVE, server),
  deleteMcpServer: (id: string) => ipcRenderer.invoke(IPC.MCP_SERVERS_DELETE, id),
  testMcpServer: (server: unknown) => ipcRenderer.invoke(IPC.MCP_SERVERS_TEST, server),
  listMcpTools: () => ipcRenderer.invoke(IPC.MCP_TOOLS_LIST),
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
