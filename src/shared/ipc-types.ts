// Shared IPC channel names and type definitions between main and renderer

export const IPC = {
  // Provider / settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_SAVE: 'providers:save',
  PROVIDERS_DELETE: 'providers:delete',
  PROVIDERS_FETCH_MODELS: 'providers:fetch-models',

  // Sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_DELETE: 'sessions:delete',
  SESSIONS_RENAME: 'sessions:rename',
  MESSAGES_LIST: 'messages:list',
  MESSAGES_DELETE: 'messages:delete',          // delete a single message by id
  MESSAGES_DELETE_FROM: 'messages:delete-from', // delete this message + everything created after it (used for regenerate / edit)
  MESSAGES_UPDATE: 'messages:update',           // edit a message's content

  // Agent execution
  AGENT_RUN: 'agent:run',
  AGENT_STOP: 'agent:stop',
  AGENT_PROGRESS: 'agent:progress',   // main → renderer (event)
  AGENT_DONE: 'agent:done',           // main → renderer (event)
  AGENT_ERROR: 'agent:error',         // main → renderer (event)

  // Image generation
  IMAGE_GENERATE: 'image:generate',
  IMAGE_EDIT: 'image:edit',
  IMAGE_OVERWRITE: 'image:overwrite',

  // Video generation
  VIDEO_GENERATE: 'video:generate',
  VIDEO_PROGRESS: 'video:progress',   // main → renderer (event)

  // File operations
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_REVERT_BACKUP: 'file:revert-backup',
  FILE_OPEN_DIALOG: 'file:open-dialog',
  FILE_WRITE_TEMP: 'file:write-temp',
  FILE_SAVE_AS: 'file:save-as',
  FILE_SAVE_TEXT: 'file:save-text',
  SHELL_SHOW_ITEM: 'shell:show-item',

  // Gallery
  GALLERY_LIST: 'gallery:list',
  GALLERY_DELETE: 'gallery:delete',
  GALLERY_BATCH_DELETE: 'gallery:batch-delete',

  // Knowledge base
  KB_SPACES_LIST: 'kb:spaces-list',
  KB_SPACES_SAVE: 'kb:spaces-save',
  KB_SPACES_DELETE: 'kb:spaces-delete',
  KB_PAGES_LIST: 'kb:pages-list',
  KB_PAGES_SAVE: 'kb:pages-save',
  KB_PAGES_DELETE: 'kb:pages-delete',
  KB_IMPORT_FILE: 'kb:import-file',
  KB_IMPORT_PROGRESS: 'kb:import-progress', // main → renderer (event)
  KB_SEARCH: 'kb:search',
  KB_SOURCES_LIST: 'kb:sources-list',
  KB_SOURCES_DELETE: 'kb:sources-delete',
  KB_REINDEX_SPACE: 'kb:reindex-space',

  // Window controls
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',
  WIN_MAXIMIZE_CHANGED: 'win:maximize-changed',

  // App-level (version, updates)
  APP_VERSION: 'app:version',
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',     // main → renderer event

  // Whole-app config backup
  CONFIG_EXPORT: 'config:export',
  CONFIG_IMPORT: 'config:import',

  // Provider connection test
  PROVIDERS_TEST: 'providers:test',

  // MCP servers (Model Context Protocol)
  MCP_SERVERS_LIST: 'mcp:servers-list',
  MCP_SERVERS_SAVE: 'mcp:servers-save',
  MCP_SERVERS_DELETE: 'mcp:servers-delete',
  MCP_SERVERS_TEST: 'mcp:servers-test',
  MCP_TOOLS_LIST: 'mcp:tools-list',

  // Workflow
  WORKFLOWS_LIST: 'workflows:list',
  WORKFLOWS_SAVE: 'workflows:save',
  WORKFLOWS_DELETE: 'workflows:delete',
  WORKFLOW_RUN: 'workflow:run',
  WORKFLOW_STOP: 'workflow:stop',
  WORKFLOW_NODE_STATUS: 'workflow:node-status', // main → renderer (event)
  WORKFLOW_FROM_CHAT: 'workflow:from-chat',
} as const

// Agent progress event payload
export interface AgentProgressEvent {
  sessionId: string
  stepIndex: number
  stepName: string
  toolName?: string
  status: 'running' | 'done' | 'error'
  message?: string
  artifact?: { type: 'image' | 'video'; path: string; thumbnailPath?: string }
}

// Gallery item
export interface GalleryItem {
  id: number
  type: 'image' | 'video'
  filePath: string
  thumbnailPath?: string
  prompt: string
  source: 'chat' | 'workflow'
  sessionId?: string
  workflowId?: string
  modelName?: string
  createdAt: number
}

// MCP server configuration
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** Local subprocess via stdio, or remote SSE/HTTP endpoint. */
  transport: 'stdio' | 'sse'
  // stdio fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  // SSE/HTTP fields
  url?: string
  headers?: Record<string, string>
  /** Optional user-facing notes. */
  description?: string
}

export interface McpToolInfo {
  serverId: string
  serverName: string
  /** Full prefixed tool name as exposed to the agent (e.g. "minimax__web_search"). */
  qualifiedName: string
  /** Original tool name from the server. */
  toolName: string
  description?: string
}

// Provider configuration
export interface ProviderConfig {
  id: string
  name: string
  type: 'openai' | 'anthropic' | 'gemini' | 'custom'
  apiKey: string
  baseUrl?: string
  models: string[]
}

// Global app settings
export interface AppSettings {
  defaultChatModel: string
  defaultChatProviderId: string
  defaultImageModel: string
  defaultImageProviderId: string
  defaultVideoModel: string
  defaultVideoProviderId: string
  defaultEmbeddingModel: string
  defaultEmbeddingProviderId: string
  searchApiKey: string
  searchProvider: 'tavily' | 'serper'
  kbGlobalEnabled: boolean
  kbGlobalSpaceIds: string[]
  dataDirectory: string
}

// Session
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface MessageMeta {
  model?: string
  providerId?: string
  providerName?: string
  durationMs?: number
}

// Message
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCallRecord[]
  attachments?: Attachment[]
  meta?: MessageMeta
  createdAt: number
}

export interface ToolCallRecord {
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  status: 'running' | 'done' | 'error'
  error?: string
}

export interface Attachment {
  type: 'file'
  name: string
  path: string
  mimeType: string
}
