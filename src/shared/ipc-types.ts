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
  SESSIONS_ARCHIVE: 'sessions:archive',
  SESSIONS_SET_WORKING_DIR: 'sessions:set-working-dir', // pin a per-conversation working directory (opt-in)
  MESSAGES_LIST: 'messages:list',
  MESSAGES_DELETE: 'messages:delete',          // delete a single message by id
  MESSAGES_DELETE_FROM: 'messages:delete-from', // delete this message + everything created after it (used for regenerate / edit)
  MESSAGES_UPDATE: 'messages:update',           // edit a message's content
  MESSAGES_CLEAR_SESSION: 'messages:clear-session', // wipe every message of a session, keep the session row
  SESSIONS_SEARCH: 'sessions:search',           // full-text search across titles + message content
  SESSIONS_EXPORT_ALL: 'sessions:export-all',    // dump every session + its messages to a JSON file
  SESSIONS_IMPORT: 'sessions:import',            // load a previously-exported JSON back in

  // Agent execution
  AGENT_RUN: 'agent:run',
  AGENT_STOP: 'agent:stop',
  AGENT_CLASSIFY_INTENT: 'agent:classify-intent',  // renderer → main (auto-router smart mode)
  AGENT_PROGRESS: 'agent:progress',   // main → renderer (event)
  AGENT_DELTA: 'agent:delta',         // main → renderer (event — streamed assistant text chunks)
  AGENT_DONE: 'agent:done',           // main → renderer (event)
  AGENT_ERROR: 'agent:error',         // main → renderer (event)

  // Image generation
  IMAGE_GENERATE: 'image:generate',
  IMAGE_EDIT: 'image:edit',
  IMAGE_OVERWRITE: 'image:overwrite',

  // Video generation
  VIDEO_GENERATE: 'video:generate',
  VIDEO_CANCEL: 'video:cancel',
  VIDEO_PROGRESS: 'video:progress',   // main → renderer (event)
  /** Persist a renderer-extracted thumbnail for an existing gallery video. */
  VIDEO_SAVE_THUMBNAIL: 'video:save-thumbnail',

  // File operations
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_REVERT_BACKUP: 'file:revert-backup',
  FILE_OPEN_DIALOG: 'file:open-dialog',
  FILE_WRITE_TEMP: 'file:write-temp',
  FILE_APPROVE_PATH: 'file:approve-path',
  FILE_SAVE_AS: 'file:save-as',
  FILE_SAVE_TEXT: 'file:save-text',
  SHELL_SHOW_ITEM: 'shell:show-item',

  // Gallery
  GALLERY_LIST: 'gallery:list',
  GALLERY_SEARCH: 'gallery:search',
  GALLERY_DELETE: 'gallery:delete',
  GALLERY_BATCH_DELETE: 'gallery:batch-delete',
  GALLERY_BATCH_SAVE: 'gallery:batch-save',
  GALLERY_IMPORT: 'gallery:import',

  // Long-term memory (Hermes-style; replaces the vector knowledge base)
  MEMORY_LIST: 'memory:list',
  MEMORY_SAVE: 'memory:save',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_SET_PINNED: 'memory:set-pinned',
  MEMORY_ARCHIVE: 'memory:archive',
  MEMORY_CAPTURE_SESSION: 'memory:capture-session', // renderer → main: 手动从一个会话提炼记忆
  MEMORY_CAPTURED: 'memory:captured',               // main → renderer (event): 自动/手动捕获产出
  MEMORY_IMPORT: 'memory:import',                    // renderer → main: 导入外部记忆资产(.json/.jsonl/.md)
  MEMORY_EXPORT: 'memory:export',                    // renderer → main: 导出全部活跃记忆为 JSON(可再导入)

  // Computer Use arming confirmation (in-app styled dialog via round-trip)
  COMPUTER_USE_CONFIRM: 'computer-use:confirm',           // main → renderer: ask permission { id }
  COMPUTER_USE_CONFIRM_REPLY: 'computer-use:confirm-reply', // renderer → main: { id, ok }

  // Window controls
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE: 'win:close',
  WIN_MAXIMIZE_CHANGED: 'win:maximize-changed',

  // App-level (version)
  APP_VERSION: 'app:version',

  // Updater (GitHub-backed manual + startup version check)
  UPDATER_CHECK: 'updater:check',           // renderer → main (manual button)
  UPDATER_OPEN_RELEASE: 'updater:open',     // renderer → main (open GitHub release page in browser)
  UPDATER_AVAILABLE: 'updater:available',   // main → renderer (event — fires only when remote > current)

  // Remote model.conf — GitHub-hosted recommended default models (managed defaults)
  MODEL_CONF_SYNC: 'model-conf:sync',       // renderer → main (manual refresh)
  MODEL_CONF_APPLIED: 'model-conf:applied', // main → renderer (event — defaults were updated)

  // System integration — OS-level settings (auto-launch + Explorer context menu)
  APP_SET_AUTO_LAUNCH: 'app:set-auto-launch',
  APP_SET_SHELL_INTEGRATION: 'app:set-shell-integration',
  APP_GET_SYSTEM_STATE: 'app:get-system-state',
  /** main → renderer: a file/folder path was passed to the app via
   *  command line (Explorer right-click "Open with SuperStudio") */
  APP_OPEN_PATH_FROM_SHELL: 'app:open-path-from-shell',

  // Error log
  LOG_LIST: 'log:list',
  LOG_CLEAR: 'log:clear',
  LOG_APPEND: 'log:append',           // renderer → main: report a renderer-side error

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

  // Settings reset
  SETTINGS_RESET: 'settings:reset',

  // Auth (SuperCode account)
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_STATE: 'auth:get-state',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_STATE_CHANGED: 'auth:state-changed',   // main → renderer (event)
  AUTH_GET_SAVED_CREDS: 'auth:get-saved-creds',  // pre-fill login form after logout
  ACCOUNT_INIT: 'account:init',

  // Account key management
  ACCOUNT_LIST_KEY_OPTIONS: 'account:list-key-options',
  ACCOUNT_SELECT_KEY: 'account:select-key',
  ACCOUNT_REVEAL_KEY: 'account:reveal-key',
  ACCOUNT_CREATE_KEY: 'account:create-key',
  ACCOUNT_DELETE_KEY: 'account:delete-key',
  ACCOUNT_LIST_GROUPS: 'account:list-groups',
  ACCOUNT_GET_STATUS: 'account:get-status',     // current subscription/token plan status

  // Token Plan (subscription) key management — single key per user, lives
  // alongside the plan info rather than mixed with standalone API keys
  SUBSCRIPTION_KEY_LIST: 'subscription-key:list',
  SUBSCRIPTION_KEY_ENSURE: 'subscription-key:ensure',  // idempotent: create or recover
  SUBSCRIPTION_KEY_DELETE: 'subscription-key:delete',
  SUBSCRIPTION_KEY_RESET: 'subscription-key:reset',    // delete + recreate

  // Dashboard (usage analytics)
  DASHBOARD_STATS: 'dashboard:stats',
  DASHBOARD_TREND: 'dashboard:trend',
  DASHBOARD_MODELS: 'dashboard:models',
  DASHBOARD_KEYS_USAGE: 'dashboard:keys-usage',

  // Vibe / Build page (OpenSpec-style propose → apply workflow)
  // ---- Lifecycle: streamed events ----
  VIBE_PROGRESS: 'vibe:progress',
  VIBE_DONE: 'vibe:done',
  VIBE_ERROR: 'vibe:error',
  VIBE_STOP: 'vibe:stop',
  // ---- Projects ----
  VIBE_LIST_TREE: 'vibe:list-tree',
  VIBE_READ_FILE: 'vibe:read-file',
  VIBE_FILE_SAVE: 'vibe:file-save',
  VIBE_NEW_PROJECT: 'vibe:new-project',
  VIBE_LIST_RECENT: 'vibe:list-recent',
  VIBE_REMOVE_RECENT: 'vibe:remove-recent',
  VIBE_OPEN_EXISTING: 'vibe:open-existing',
  VIBE_PROJECT_GET: 'vibe:project-get',
  VIBE_PROJECT_SET_MODEL: 'vibe:project-set-model',
  // ---- OpenSpec-style workflow ----
  VIBE_CHAT: 'vibe:chat',           // pure chat, no project tools
  VIBE_EXPLORE: 'vibe:explore',     // read-only investigation (read/glob/grep)
  VIBE_BUGFIX: 'vibe:bugfix',       // autonomous fix agent (full tools, no propose step)
  VIBE_PROPOSE: 'vibe:propose',     // decompose clear requirement into structured tasks
  VIBE_RUN: 'vibe:run',             // 统一入口：自动识别意图(可 forceIntent 覆盖)后分派
  VIBE_APPLY: 'vibe:apply',         // execute tasks
  // ---- Requests / tasks / messages ----
  VIBE_REQUEST_LIST: 'vibe:request-list',
  VIBE_REQUEST_LIST_ALL: 'vibe:request-list-all',          // 跨项目所有需求（公司看板）
  VIBE_REQUEST_DELETE: 'vibe:request-delete',
  VIBE_REQUEST_SET_ASSIGNEE: 'vibe:request-set-assignee',  // 指派 AI 员工承接
  VIBE_TASK_SET_ASSIGNEE: 'vibe:task-set-assignee',        // 子任务级手动重派
  VIBE_TASK_SET_DEPS: 'vibe:task-set-deps',                // 子任务依赖（开工前手动增删）
  VIBE_TASK_LIST: 'vibe:task-list',
  VIBE_TASK_TOGGLE: 'vibe:task-toggle',
  VIBE_MESSAGE_LIST: 'vibe:message-list',
  // ---- Git review layer (P0: status/diff/stage/revert/commit + checkpoint rollback) ----
  VIBE_GIT_STATUS: 'vibe:git-status',
  VIBE_GIT_DIFF: 'vibe:git-diff',
  VIBE_GIT_STAGE: 'vibe:git-stage',
  VIBE_GIT_UNSTAGE: 'vibe:git-unstage',
  VIBE_GIT_REVERT_FILE: 'vibe:git-revert-file',
  VIBE_GIT_REVERT_HUNK: 'vibe:git-revert-hunk',
  VIBE_GIT_STAGE_HUNK: 'vibe:git-stage-hunk',
  VIBE_GIT_COMMIT: 'vibe:git-commit',
  VIBE_GIT_LOG: 'vibe:git-log',
  VIBE_GIT_INIT: 'vibe:git-init',
  VIBE_GIT_ROLLBACK: 'vibe:git-rollback',

  // Skills (reusable prompt + tool-whitelist bundles)
  SKILLS_LIST: 'skills:list',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_SET_ENABLED: 'skills:set-enabled',
  SKILLS_SET_SCENARIOS: 'skills:set-scenarios',
  SKILLS_SOURCES_LIST: 'skills:sources-list',
  SKILLS_SOURCES_ADD: 'skills:sources-add',
  SKILLS_SOURCES_DELETE: 'skills:sources-delete',
  SKILLS_SOURCES_SET_ENABLED: 'skills:sources-set-enabled',
  SKILLS_BROWSE: 'skills:browse',
  SKILLS_SET_ALLOW_SCRIPTS: 'skills:set-allow-scripts',
  SKILLS_READ_FILE: 'skills:read-file',
  SKILLS_IMPORT_LOCAL: 'skills:import-local',
  SKILLS_DISCOVER_LOCAL: 'skills:discover-local',   // scan ~/.claude/skills etc. for importable bundles
  SKILLS_EXPORT: 'skills:export',                    // export an installed skill as a re-importable .zip

  // Talent pool (encrypted bundled catalog of agent personas / "招募人才")
  TALENT_BROWSE: 'talent:browse',
  TALENT_GET: 'talent:get',
  TALENT_TRY: 'talent:try',     // 面试试聊：用候选 soul 人格临时对话一轮（不落库）
  TALENT_IMPORT_LOCAL: 'talent:import-local', // 导入外部 soul.md（单文件/目录）→ user_souls
  TALENT_DELETE_USER: 'talent:delete-user',   // 删除一个用户导入的 soul

  // AI company employees (hired souls)
  EMP_LIST: 'emp:list',
  EMP_HIRE: 'emp:hire',
  EMP_FIRE: 'emp:fire',
  EMP_SET_MODEL: 'emp:set-model',
  EMP_SET_DEPT: 'emp:set-dept',
  EMP_SPEND_RANGE: 'emp:spend-range',

  // SSH client: connection CRUD (creds encrypted at rest) + per-exec confirm.
  SSH_LIST: 'ssh:list',
  SSH_SAVE: 'ssh:save',
  SSH_DELETE: 'ssh:delete',
  SSH_TEST: 'ssh:test',
  SSH_IMPORT: 'ssh:import',                       // import a MobaXterm .mxtsessions export
  SSH_EXEC_CONFIRM: 'ssh:exec-confirm',           // main → renderer: ask before a remote exec { id, host, command }
  SSH_EXEC_CONFIRM_REPLY: 'ssh:exec-confirm-reply', // renderer → main: { id, ok }
  // Local script execution gate (run_script tool)
  LOCAL_SCRIPT_CONFIRM: 'local-script:confirm',       // main → renderer: ask before running a local command { id, command, cwd }
  LOCAL_SCRIPT_CONFIRM_REPLY: 'local-script:confirm-reply', // renderer → main: { id, ok }

  // Terminal (PTY-backed shell in Vibe page)
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DISPOSE: 'terminal:dispose',
  TERMINAL_DATA: 'terminal:data',    // main → renderer (event)
  TERMINAL_EXIT: 'terminal:exit',    // main → renderer (event)

  // Scheduled prompts
  SCHEDULER_LIST: 'scheduler:list',
  SCHEDULER_GET: 'scheduler:get',
  SCHEDULER_CREATE: 'scheduler:create',
  SCHEDULER_UPDATE: 'scheduler:update',
  SCHEDULER_DELETE: 'scheduler:delete',
  SCHEDULER_SET_ENABLED: 'scheduler:set-enabled',
  SCHEDULER_TRIGGER_NOW: 'scheduler:trigger-now',
  SCHEDULER_LIST_RUNS: 'scheduler:list-runs',
  SCHEDULER_PREVIEW_NEXT: 'scheduler:preview-next',     // compute the next-fire time for a (kind,value) — live form preview
  SCHEDULER_RUN_STARTED: 'scheduler:run-started',       // main → renderer (event): a task run began
  SCHEDULER_RUN_COMPLETED: 'scheduler:run-completed',   // main → renderer (event)
  SCHEDULER_FOCUS_TASK: 'scheduler:focus-task',         // main → renderer: notification click → open task detail

  // Workflow
  WORKFLOWS_LIST: 'workflows:list',
  WORKFLOWS_SAVE: 'workflows:save',
  WORKFLOWS_DELETE: 'workflows:delete',
  WORKFLOW_RUN: 'workflow:run',
  WORKFLOW_STOP: 'workflow:stop',
  WORKFLOW_NODE_STATUS: 'workflow:node-status', // main → renderer (event)
  WORKFLOW_DONE: 'workflow:done',               // main → renderer (event, terminal)
  WORKFLOW_FROM_CHAT: 'workflow:from-chat',
} as const

// Per-node status event (main → renderer). `pending` = queued before it starts.
export interface WorkflowNodeStatusEvent {
  workflowId: string
  nodeId: string
  status: 'pending' | 'running' | 'done' | 'error'
  message?: string
}

// Terminal workflow event (main → renderer). Always emitted exactly once per run
// — on success, failure, or stop — so the renderer can reliably leave the
// "running" state instead of inferring it from per-node status.
export interface WorkflowDoneEvent {
  workflowId: string
  status: 'completed' | 'error' | 'stopped'
  error?: string
  /** Node ids that never ran (dropped by a cycle, or skipped by fail-fast/stop). */
  unreached?: string[]
}

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

// Video generation
export interface VideoGenerateRequest {
  /** Client-generated UUID. Echoed back in every progress event so the renderer
   *  can pin updates to the right card. Also serves as the cancel handle. */
  clientJobId: string
  /** Optional one-off provider override — the Video page lets the user pick
   *  any provider's video model, not just the configured default. When unset,
   *  falls back to settings.defaultVideoProviderId / defaultVideoModel. */
  providerOverrideId?: string
  modelOverride?: string
  prompt: string
  /** Things to avoid in the output. Sent as a separate `negative_prompt` field
   *  to providers that support it; ignored otherwise. */
  negativePrompt?: string
  /** Base64-encoded reference / first-frame / last-frame image. Optional. */
  referenceImageBase64?: string
  /** Filename hint for the staged temp file (only used for extension detection). */
  referenceFileName?: string
  /** How the reference image should be used. Maps to provider-specific fields:
   *  first → `image` (standard first frame), last → `last_frame`, reference →
   *  `image_reference` (style guide). Defaults to 'first' if a reference image
   *  is provided without specifying. */
  frameRole?: 'first' | 'last' | 'reference'
  durationSec?: number
  aspect?: '9:16' | '1:1' | '16:9'
  /** Reproducibility seed. Only set when the user locks a seed in the UI; when
   *  omitted the provider randomizes. Whether it's honored depends on the model. */
  seed?: number
}

export interface VideoGenerateResult {
  ok: boolean
  galleryId?: number
  path?: string
  error?: string
  /** True when the failure was caused by the user clicking cancel. */
  canceled?: boolean
}

export interface VideoProgressEvent {
  clientJobId: string
  /** Provider-side job id, only known after the initial submit succeeds. */
  jobId?: string
  status: 'submitting' | 'queued' | 'running' | 'downloading' | 'succeeded' | 'failed'
  elapsedSeconds: number
  /** Best-effort total seconds we expect this job to take (model-specific). */
  etaSeconds?: number
  message?: string
}

// Gallery item
export interface GalleryItem {
  id: number
  type: 'image' | 'video' | 'audio'
  filePath: string
  thumbnailPath?: string
  prompt: string
  source: 'chat' | 'workflow' | 'import'
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
  /** Where the provider came from. 'manual' = user-added (BYOK); an account
   *  overlay may set its own marker. Open string so core needs no brand enum. */
  source?: string
  /** Upstream platform (e.g. "Anthropic", "OpenAI") for grouping/labeling
   *  in pickers. Only set for account-managed providers. */
  platform?: string
  /** Capability flag: this provider's endpoint ALSO speaks Anthropic-native
   *  /v1/messages, so Claude models can be auto-routed there. Set by whichever
   *  layer knows the endpoint (e.g. an account overlay) — core never infers it
   *  from a brand string. */
  anthropicNative?: boolean
  /** Compatibility mode for strict / minimal gateways: send the simplest possible
   *  request — skip Anthropic prompt caching, the cache-control system-message
   *  restructuring, and extended-thinking options. Some relays return an empty
   *  200 when they don't support those enhancements; this makes them work. */
  relayCompat?: boolean
}


/** Current subscription / token plan status, as surfaced to the renderer */
export interface TokenPlanInfo {
  planType: string                                    // 'lite' | 'pro' | 'max' | ...
  periodStart: number | null                          // unix ms
  periodEnd: number | null                            // unix ms
  quotaOpusEquivalent: number                         // total allowance (0 = unset)
  usedOpusEquivalent: number                          // used so far
  usedRawTotal: number                                // raw token count
  breakdownByModel: { model: string; used: number }[]
  autoRenew: boolean
  status: string                                      // 'active' | 'expired' | ...
}

// Auto model routing
export type AutoModelIntent = 'vision' | 'code' | 'math' | 'creative' | 'quick' | 'default'
export type AutoModelRoutes = Record<AutoModelIntent, string>  // intent → "providerId::modelId"

// Global app settings
export interface AppSettings {
  defaultChatModel: string
  defaultChatProviderId: string
  defaultImageModel: string
  defaultImageProviderId: string
  /** Default image-generation rules, applied to every image turn (per-turn row can
   *  override). Mirrors the renderer's ImageParams (Chat/ChatHeader). */
  defaultImageRules?: {
    resolution: '1K' | '2K' | '4K'
    quality: 'standard' | 'hd'
    ratio: string
    count: 1 | 2 | 3 | 4
  }
  defaultVideoModel: string
  defaultVideoProviderId: string
  defaultEmbeddingModel: string
  defaultEmbeddingProviderId: string
  searchApiKey: string
  searchProvider: 'tavily' | 'serper' | 'searxng' | 'bing' | 'baidu' | 'sogou' | 'ddg' | 'google'
  /** Self-hosted SearXNG instance URL, e.g. https://searx.example.com.
   *  Only used when searchProvider === 'searxng'. */
  searxngUrl?: string
  /** Show the hidden Chromium window used to scrape search engines. Default
   *  false; flip on to watch/debug why a scraped engine returns nothing. */
  searchBrowserVisible?: boolean
  kbGlobalEnabled: boolean
  kbGlobalSpaceIds: string[]
  /** Auto-capture long-term memories from conversations / company work. */
  memoryAutoCapture?: boolean
  /** Master switch for Computer Use (let the agent control mouse/keyboard/screen). Default off. */
  computerUseEnabled?: boolean
  /** Privacy curtain ("伪锁屏"): during a Computer Use run, cover all screens with a
   *  black, capture-excluded window so onlookers can't see what the agent is doing —
   *  while the session stays unlocked so screenshots + input keep working. Default off. */
  computerUsePrivacyCurtain?: boolean
  dataDirectory: string
  // Auto model routing
  autoModelEnabled: boolean
  autoModelMode: 'standard' | 'smart'
  autoModelRoutes: Partial<AutoModelRoutes>
  autoModelSmartModel: string  // "providerId::modelId" for the classifier

  // Vibecoding "Build" page — recent project directories (newest first, capped at 10)
  buildRecentProjectDirs: string[]

  /** When true, the Build page auto-triggers `apply` right after `propose` finishes
   *  decomposing a 新需求 — no need to manually click 执行剩余任务. */
  vibeAutoApply: boolean

  /** Timeout (ms) for the Build page's `code_bash` / `code_test` tools. Defaults
   *  to 300_000 (5 min) so install/build/test commands fit; the old hard-coded
   *  30s truncated them. */
  vibeBashTimeoutMs?: number

  /** Master switch for the chat agent's `run_script` tool (run local python/bat/
   *  sh/node scripts). Default ON — the agent runs scripts without friction.
   *  Set false to hide the tool entirely. */
  localScriptsEnabled?: boolean
  /** When true, every new (command, cwd) pops a confirm dialog before running.
   *  Default OFF — scripts run without per-command prompts. Opt-in for caution. */
  localScriptsConfirmEachRun?: boolean
  /** Timeout (ms) for `run_script`. Default 300_000 (5 min). */
  localScriptsTimeoutMs?: number
  /** Extra folder to scan for importable local skill bundles (auto-discovery). */
  skillDiscoverDir?: string

  /** Launch SuperStudio at OS login. Default false — opt-in. */
  autoLaunch: boolean
  /** Register the "用 SuperStudio 打开" Windows Explorer right-click entry
   *  for files and folders. Default true on Windows; no-op on macOS/Linux.
   *  Files open in the editor, folders open as Vibe projects. */
  shellIntegrationEnabled: boolean
  /** Which page to show on app startup. Applied once per session after login,
   *  and only if nothing else (e.g. shell-open) has navigated away from the
   *  hard-coded default first. */
  startupPage: 'chat' | 'vibe'
  /** Minimize the window to the system tray (hide from taskbar) instead of a
   *  normal taskbar minimize. Default ON; toggle in 设置 → 全局 → 系统. */
  minimizeToTray?: boolean

  /** Globally-configured notification bots (DingTalk / Feishu / WeChat Work),
   *  selectable per scheduled task. URLs and secrets are encrypted at rest. */
  webhookBots: WebhookBot[]

  /** Global outbound proxy mode.
   *  - off: direct connection (default)
   *  - system: BrowserWindow/net.fetch follow OS proxy; undici fetch follows HTTPS_PROXY/HTTP_PROXY env
   *  - custom: http://proxyHost:proxyPort applied everywhere */
  proxyMode?: ProxyMode
  /** Custom proxy host, e.g. '127.0.0.1'. Only used when proxyMode === 'custom'. */
  proxyHost?: string
  /** Custom proxy port, e.g. 7890. Only used when proxyMode === 'custom'. */
  proxyPort?: number

  /** When true, the agent persists a full per-run trace (system prompt, messages,
   *  tool list, raw response, usage) under userData/agent-traces for debugging a
   *  bad run. Off by default — traces may contain prompt/KB content, so they
   *  stay local and are never sent to the renderer. */
  debugTrace?: boolean

  /** 对话/工作台里 Anthropic 模型的扩展思考(extended thinking)策略：
   *  - 'auto'  沿用模型/网关默认（默认值，行为不变）
   *  - 'fast'  关闭扩展思考，让 Opus 这类模型直接出答案（最快，简单任务推荐）
   *  - 'deep'  给足思考预算换更强推理（更慢）
   *  仅对原生 anthropic provider 生效。 */
  chatThinkingMode?: 'auto' | 'fast' | 'deep'

  /** Internal bookkeeping for the remote model.conf "managed default" mechanism.
   *  Snapshot of the default model NAMES last pushed by model.conf. A field is
   *  only re-applied from a newer model.conf when the current value still equals
   *  this snapshot (i.e. the user hasn't manually picked their own model). Once
   *  the user changes a default in Settings, it diverges from this snapshot and
   *  model.conf stops touching it. Not shown in any UI. */
  appliedModelConf?: RemoteModelConf
}

export type ProxyMode = 'off' | 'system' | 'custom'

/** Shape of the GitHub-hosted `model.conf` (parsed as JSON). All fields are
 *  optional model NAMES — the client resolves which logged-in provider serves
 *  the model, so providerIds are intentionally NOT part of this contract. */
export interface RemoteModelConf {
  defaultChatModel?: string
  defaultImageModel?: string
  defaultVideoModel?: string
  defaultEmbeddingModel?: string
}

/** Snapshot of OS-level toggle state, read back from the actual platform — so
 *  the UI can show what's really registered even if the store is out of sync
 *  (e.g. user moved the app .exe). */
export interface SystemIntegrationState {
  /** True if Electron reports the app is registered to start at login. */
  autoLaunch: boolean
  /** True if the registry keys for the right-click "open with" entry exist. */
  shellIntegration: boolean
  /** Whether shell-integration is supported on the current platform.
   *  Currently only Windows; macOS/Linux fall back to no-op. */
  shellIntegrationSupported: boolean
}

/** Payload of APP_OPEN_PATH_FROM_SHELL. Sent by main after parsing argv
 *  from Explorer's right-click "用 SuperStudio 打开". The renderer routes
 *  files into the editor (using `parent` as the project root) and folders
 *  as Vibe projects. */
export interface ShellOpenTarget {
  path: string
  kind: 'file' | 'dir'
  /** For files: the parent directory, used as the project root. */
  parent?: string
}

// Vibe / Build page types
export interface VibeProgressEvent {
  projectPath: string
  requestId?: string
  taskId?: string
  /** Logical message kind streamed to the renderer */
  type: 'text' | 'tool_use' | 'tool_result' | 'system' | 'task_status' | 'request_ready'
  /** assistant text chunk */
  text?: string
  /** tool name when type === 'tool_use' / 'tool_result' */
  toolName?: string
  /** short, human-readable preview of tool args (e.g. file path) */
  toolArgsPreview?: string
  /** truncated tool result excerpt */
  toolResultPreview?: string
  /** true when tool_result represents an error */
  isError?: boolean
  /** task status updates (type === 'task_status') */
  taskStatus?: 'pending' | 'running' | 'done' | 'error' | 'skipped'
}

export type VibeRequestStatus = 'draft' | 'proposed' | 'applying' | 'done' | 'archived'
export type VibeRequestKind = 'explore' | 'change' | 'bugfix' | 'chat'
/** Mode the user picked in the input bar — 1:1 mapping to the IPC channel called */
export type VibeIntent = 'chat' | 'explore' | 'bugfix' | 'change'
export type VibeTaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface VibeRequestInfo {
  id: string
  projectPath: string
  slug: string
  title: string
  summary: string
  status: VibeRequestStatus
  kind: VibeRequestKind
  createdAt: number
  /** AI-company employee承接该需求；null = 未指派。 */
  assigneeEmployeeId?: string | null
  /** 子任务进度卷积（仅 listAll 看板路径带）。 */
  taskRollup?: { total: number; done: number; running: number; error: number }
}

export interface VibeTaskInfo {
  id: string
  requestId: string
  ord: number
  title: string
  description: string
  status: VibeTaskStatus
  errorText: string | null
  startedAt: number | null
  finishedAt: number | null
  /** 子任务级承接员工；null = 用 request 级默认承接人或默认模型。 */
  assigneeEmployeeId: string | null
  /** 前置任务 id 列表（必须先完成）；空 = 无依赖，可并行。 */
  deps: string[]
}

export interface VibeMessageInfo {
  id: string
  requestId: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName: string | null
  toolArgs: string | null
  isError: boolean
  taskId: string | null
  createdAt: number
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  model?: string | null
}

export interface VibeProjectInfo {
  path: string
  name: string
  providerId: string | null
  modelId: string | null
  createdAt: number
  lastOpenedAt: number
}

export interface FileTreeNode {
  name: string
  /** absolute path */
  path: string
  isDir: boolean
  /** populated for directories only */
  children?: FileTreeNode[]
}

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

// Git review layer (Vibe) — mirrors electron/main/services/git-service.ts
export interface GitFileChange {
  path: string
  index: string
  working: string
  kind: 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'
  staged: boolean
}
export interface GitStatusInfo {
  gitAvailable: boolean
  isRepo: boolean
  root: string
  files: GitFileChange[]
  hasCheckpoint: boolean
}
export interface GitDiffInfo {
  path: string
  original: string
  modified: string
  patch: string
  hunkCount: number
  binary: boolean
}
export interface GitCommitInfo { hash: string; message: string; date: string; author: string }

// Skills — reusable prompt + tool-whitelist bundles
export type SkillScenario = 'chat' | 'vibe' | 'video'

export interface SkillStarterPrompt {
  label: string
  prompt: string
}

export interface SkillManifestInfo {
  id: string
  name: string
  description: string
  icon: string
  version: string
  author: string
  systemPrompt: string
  /** null = all tools allowed; [] = no tools; specific names = whitelist */
  toolWhitelist: string[] | null
  starterPrompts: SkillStarterPrompt[]
  homepage?: string
  suggestedScenarios: SkillScenario[]
}

export interface InstalledSkillInfo extends SkillManifestInfo {
  enabled: boolean
  enabledScenarios: SkillScenario[]
  sourceUrl: string | null
  installedAt: number
  /** True for skills that ship with the app — UI hides the uninstall action. */
  builtin: boolean
  /** True = downloaded SKILL.md bundle, loaded progressively. False = legacy
   *  prompt-only skill whose systemPrompt is always injected. */
  runtime: boolean
  /** SkillHub slug — canonical id used to re-fetch / upgrade. */
  slug: string | null
  /** Absolute dir on disk holding the downloaded bundle. */
  installPath: string | null
  /** Cached SKILL.md body (frontmatter stripped). */
  skillBody: string
  /** Bundle-relative paths of all downloaded files. */
  resourceFiles: string[]
  /** Whether this skill is allowed to run its bundled scripts. */
  allowScripts: boolean
}

export interface SkillSourceInfo {
  url: string
  name: string
  enabled: boolean
  builtin: boolean
  addedAt: number
}

/** A skill bundle found on disk by auto-discovery (mirrors skill-discover.ts). */
export interface DiscoveredSkillInfo {
  name: string
  description: string
  path: string
  source: 'claude' | 'project' | 'custom'
  fileCount: number
  alreadyImported: boolean
}

export interface SkillRegistryEntryInfo {
  id: string
  name: string
  description: string
  icon?: string
  version?: string
  author?: string
  homepage?: string
  suggestedScenarios?: SkillScenario[]
  manifestUrl?: string
  manifest?: SkillManifestInfo
  /** SkillHub slug — present → install as a runtime skill (download bundle). */
  slug?: string
}

export interface FetchedRegistryInfo {
  sourceUrl: string
  entries: SkillRegistryEntryInfo[]
  /** Server-reported total across all pages; null if the registry doesn't paginate. */
  total: number | null
  error?: string
}

// SuperCode auth
export interface AccountUser {
  id: number
  email: string
  username?: string
  balance?: number
}

/** One API key entry as returned to the renderer (key value already masked) */
export interface StoredKeyInfo {
  id: number
  groupId: number
  platform: string
  groupName: string
  keyMasked: string
}

/** Active group available for creating a key */
export interface AvailableGroupInfo {
  id: number
  name: string
  platform: string
  status: string
}

/** All available keys for one platform/group, with current selection */
export interface GroupKeyOptions {
  groupId: number
  groupName: string
  platform: string
  keys: { id: number; name: string; keyMasked: string; status: string }[]
  selectedKeyId: number | null
}

/** Token-Plan key state for the AccountTab's 当前套餐 section.
 *  At most one key per subscription — `key` is null until created. */
export interface SubscriptionKeyView {
  /** The group the user's plan is bound to (anthropic / openai / ...).
   *  Null if no subscription yet. */
  group: { id: number; name: string; platform: string } | null
  /** The user's single Token Plan key (masked). Null if not yet created. */
  key: { id: number; name: string; keyMasked: string; status: string } | null
}

export interface AuthState {
  isLoggedIn: boolean
  user: AccountUser | null
  keyId: number | null
  keyValue: string       // masked — first key, kept for backward compat
  allKeys?: StoredKeyInfo[]
}

// Session
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 1 = archived (hidden from default list); 0 / undefined = active */
  archived?: number
  /** 1 = this session is the dedicated channel for a scheduled task.
   *  SessionList renders these under a separate "📅 定时" group; deleting
   *  one auto-pauses the owning task. */
  isScheduled?: number
  /** Sum of cost_usd across all messages in this session (0 if none priced). */
  totalCostUsd?: number
  totalInputTokens?: number
  totalOutputTokens?: number
  /** Opt-in working directory for this conversation (absolute path). When set,
   *  the agent default-saves new files here, treats it as an approved root
   *  (whole subtree read/write), and can list_dir its contents. '' / undefined
   *  = unset → desktop-default behavior. */
  workingDir?: string
}

// Scheduled prompts
export type ScheduleKind = 'daily' | 'weekly' | 'monthly' | 'interval' | 'once'

/** Discriminated union mirroring schedule_kind. Time is always "HH:MM" local. */
export type ScheduleValue =
  | { time: string }                                    // daily
  | { days: number[]; time: string }                    // weekly — days: 0=Sun..6=Sat
  | { day: number; time: string }                       // monthly — day: 1..31, skip months without it
  | { everyMinutes: number }                            // interval — every N minutes
  | { date: string; time: string }                      // once — date: "YYYY-MM-DD" local, fires once then auto-pauses

export type ScheduledRunStatus = 'success' | 'failed' | 'aborted_no_window'

/** Supported group-chat bots for scheduled-task result notifications. */
export type WebhookBotType = 'dingtalk' | 'feishu' | 'wechat_work'

/** A globally-configured notification bot, reusable across scheduled tasks. */
export interface WebhookBot {
  id: string
  type: WebhookBotType
  /** User-facing label shown in the task form picker. */
  name: string
  /** Full webhook URL including the access_token / key query param. */
  url: string
  /** Optional 加签 secret (DingTalk / Feishu "加签" security mode). Empty = off.
   *  WeChat Work has no signing, so this is ignored there. */
  secret?: string
  enabled: boolean
}

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  scheduleValue: ScheduleValue
  sessionId: string | null
  /** Optional model override — when null, uses the default chat model. */
  providerId: string | null
  model: string | null
  /** When set, the run's result is pushed to this WebhookBot (by id). */
  webhookBotId: string | null
  /** When true, the timed run drives the desktop (电脑操控 / computer-use) instead
   *  of a plain chat reply. Unattended → auto-armed; needs the global switch on. */
  computerMode: boolean
  enabled: boolean
  lastFiredAt: number | null
  nextFireAt: number
  consecutiveFailures: number
  createdAt: number
  updatedAt: number
}

export interface ScheduledTaskRun {
  id: string
  taskId: string
  firedAt: number
  status: ScheduledRunStatus
  durationMs: number | null
  cost: number | null
  error: string | null
  messageId: string | null
}

/** Input shape for create / update. Server fills in id / next_fire_at / timestamps. */
export interface ScheduledTaskInput {
  name: string
  prompt: string
  scheduleKind: ScheduleKind
  scheduleValue: ScheduleValue
  providerId?: string | null
  model?: string | null
  webhookBotId?: string | null
  computerMode?: boolean
  enabled?: boolean
}

/** Event payload pushed from main to renderer when a scheduled run begins. */
export interface ScheduledRunStartedEvent {
  taskId: string
  sessionId: string | null
}

/** Event payload pushed from main to renderer right after a scheduled run finishes. */
export interface ScheduledRunCompletedEvent {
  taskId: string
  sessionId: string | null
  status: ScheduledRunStatus
}

export interface MessageMeta {
  model?: string
  providerId?: string
  providerName?: string
  durationMs?: number
  autoRoutedModel?: boolean
  autoRoutedIntent?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Diagnostic info captured on the assistant turn — surfaced in exported
   *  JSON to make stuck/abort cases reproducible without console access. */
  debug?: {
    /** Text chunks pulled from result.textStream before completion / abort. */
    chunkCount?: number
    /** ai-sdk's finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' | 'unknown'. */
    finishReason?: string
    /** Stream interruption error message (mid-stream ECONNRESET, etc.). */
    streamErr?: string
    /** Total tool invocations executed during this turn. */
    toolCallCount?: number
    /** Total wall-clock spent in the streamText loop (turn duration excl. DB writes). */
    streamMs?: number
  }
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

/** Payload recorded by the `ask_user` tool (both args and result use this shape).
 *  Rendered as a clickable choice card in the chat. */
export interface AskUserPayload {
  question: string
  options: Array<{ label: string; description: string | null }>
  allowCustom: boolean
}

export interface Attachment {
  type: 'file'
  name: string
  path: string
  mimeType: string
}

// ── SSH client: a saved connection the Agent can run commands on ────────────

/** A saved SSH connection. Credentials (password/privateKey/passphrase) are
 *  encrypted at rest via safeStorage and NEVER passed into the LLM context —
 *  the agent references a connection only by `name`. */
export interface SshConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  /** Password fed to `sudo` when a command prompts for it (non-interactive sudo).
   *  Optional — falls back to `password` (login password) when empty. Needed for
   *  key-auth connections, or when the sudo password differs from the login one.
   *  Encrypted at rest like the other secrets. */
  sudoPassword?: string
  /** Run EVERY command on this connection as root via `sudo su - root` (for boxes
   *  where you log in as a normal user with a key and root can't be SSH'd into
   *  directly). The sudo prompt is auto-answered with sudoPassword/password. The
   *  model's command is wrapped transparently — it need not prefix sudo itself. */
  becomeRoot?: boolean
  /** Optional folder/group for list organization (e.g. a MobaXterm subfolder). */
  group?: string
  /** When true, the Agent runs commands on this connection WITHOUT the per-run
   *  confirmation popup. Default false (off) — every command prompts first. */
  autoConfirm?: boolean
  /** Unix ms; set on first save. Used for the "recently added" sort. */
  createdAt?: number
}

// ── AI Company: talent pool (souls) + employees ─────────────────────────────

export type EmployeeDept = 'engineering' | 'design' | 'product' | 'marketing' | 'qa' | 'data' | 'game'

/** One hireable persona from the bundled encrypted catalog (sources/ souls). */
export interface TalentEntry {
  id: string            // `${pack}/${localId}`
  source: string        // pack name
  name: string
  description: string
  dept: EmployeeDept | string
  tools: string[]
  /** Recommended model family from the soul frontmatter (opus/sonnet/haiku/…). */
  recModel: string
  systemPrompt: string  // the soul persona body
  /** True for souls the user imported from an external soul.md (user_souls table),
   *  vs the bundled encrypted catalog. Drives the "导入" badge + delete affordance. */
  imported?: boolean
}

export interface TalentBrowseResult {
  entries: TalentEntry[]
  total: number
  /** Per-dept counts across the WHOLE catalog (for filter chips). */
  deptCounts: Record<string, number>
}

export interface EmployeeStats {
  assigned: number
  done: number
  out: number
  rate: number
  /** Computed live (sum of vibe_messages.cost_usd attributed to this employee —
   *  by sub-task assignee when known, else request assignee); not persisted. */
  cost?: number
  /** Computed live alongside `cost`: total input/output tokens attributed to
   *  this employee. Not persisted in the stats JSON. */
  tokensIn?: number
  tokensOut?: number
}

/** A hired soul = employee in the user's AI company. */
export interface EmployeeInfo {
  id: string
  companyId: string
  soulId: string
  name: string
  dept: EmployeeDept | string
  avatar?: string
  providerId: string
  modelId: string
  status: 'idle' | 'busy'
  stats: EmployeeStats
  hiredAt: number
}
