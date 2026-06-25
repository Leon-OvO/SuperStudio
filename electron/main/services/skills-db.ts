import { dbAll, dbGet, dbRun } from '../db/sqlite'
import { removeSkillDir } from './skill-files'
import { getSettings } from './store'

// ============================================================================
// Types — mirrors src/shared/ipc-types Skill* types but kept main-side too
// so this module doesn't have to import renderer-shared code transitively.
// ============================================================================

export type SkillScenario = 'chat' | 'vibe' | 'video'

export interface SkillManifest {
  id: string
  name: string
  description: string
  icon: string
  version: string
  author: string
  systemPrompt: string
  /** null / undefined = all tools allowed; [] = no tools; specific names = whitelist */
  toolWhitelist: string[] | null
  starterPrompts: { label: string; prompt: string }[]
  homepage?: string
  /** Hint to user about which scenarios this skill is designed for. Doesn't
   *  enforce anything — user can still enable it in any scenario. */
  suggestedScenarios: SkillScenario[]
}

export interface InstalledSkill extends SkillManifest {
  enabled: boolean
  enabledScenarios: SkillScenario[]
  sourceUrl: string | null
  installedAt: number
  /** True if shipped with the app — cannot be uninstalled, only disabled. */
  builtin: boolean
  // --- Runtime-skill fields (runtime=true) ---
  /** True = downloaded SKILL.md bundle, loaded progressively. False = legacy
   *  prompt-only skill whose systemPrompt is always injected. */
  runtime: boolean
  /** SkillHub slug — canonical id used to re-fetch / upgrade. */
  slug: string | null
  /** Absolute dir on disk holding the downloaded bundle. */
  installPath: string | null
  /** Cached SKILL.md body (frontmatter stripped). Loaded on demand by load_skill. */
  skillBody: string
  /** Bundle-relative paths of all downloaded files. */
  resourceFiles: string[]
  /** Whether this skill is allowed to run its bundled scripts. */
  allowScripts: boolean
  // --- Lifecycle (v23: auto-induced skills + evolution loop) ---------------
  /** 'active' = loads into runs; 'pending' = awaiting review; 'deprecated' = archived. */
  status: SkillLifecycleStatus
  /** 'manual'(user import) | 'remote'(SkillHub) | 'auto'(induced from conversations). */
  origin: SkillOrigin
  /** When promoted from a kind='skill' memory, the source memory id (supersede link). */
  sourceMemoryId: string | null
  /** Bumped each time the body is refined-on-failure; old SKILL.v<N>.md kept for rollback. */
  inducedVersion: number
  /** Hash of the body — merge-by-hash dedup in the evolution sweep. */
  bodyHash: string | null
  /** Why it was induced (e.g. 'tool-sequence', 'memory-promote', 'manual'). */
  triggerReason: string | null
  /** Session/source the procedure was mined from. */
  inducedFrom: string | null
  /** Usage/trust counters — drive recall ranking, maturity, and SkillOps. */
  timesLoaded: number
  timesSucceeded: number
  timesFailed: number
  lastUsedAt: number | null
  /** Maturity/confidence 0–1 (plasticity↔stability gate). null = no signal yet. */
  confidence: number | null
}

export type SkillLifecycleStatus = 'active' | 'pending' | 'deprecated'
export type SkillOrigin = 'manual' | 'remote' | 'auto'

export interface SkillSource {
  url: string
  name: string
  enabled: boolean
  builtin: boolean
  addedAt: number
}

// ============================================================================
// Skill CRUD
// ============================================================================

interface SkillRow {
  id: string
  name: string
  description: string
  icon: string
  version: string
  author: string
  system_prompt: string
  tool_whitelist: string | null
  starter_prompts: string
  homepage: string | null
  enabled: number
  enabled_scenarios: string
  source_url: string | null
  installed_at: number
  builtin: number
  runtime: number
  slug: string | null
  install_path: string | null
  skill_body: string | null
  resource_files: string | null
  allow_scripts: number
  status: string | null
  origin: string | null
  source_memory_id: string | null
  induced_version: number | null
  body_hash: string | null
  trigger_reason: string | null
  induced_from: string | null
  times_loaded: number | null
  times_succeeded: number | null
  times_failed: number | null
  last_used_at: number | null
  confidence: number | null
}

function rowToSkill(r: SkillRow): InstalledSkill {
  let toolWhitelist: string[] | null = null
  if (r.tool_whitelist) {
    try { toolWhitelist = JSON.parse(r.tool_whitelist) } catch { toolWhitelist = null }
  }
  let starterPrompts: { label: string; prompt: string }[] = []
  try { starterPrompts = JSON.parse(r.starter_prompts) } catch { /* keep empty */ }
  let enabledScenarios: SkillScenario[] = []
  try { enabledScenarios = JSON.parse(r.enabled_scenarios) } catch { /* keep empty */ }
  let resourceFiles: string[] = []
  if (r.resource_files) {
    try { resourceFiles = JSON.parse(r.resource_files) } catch { /* keep empty */ }
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    version: r.version,
    author: r.author,
    systemPrompt: r.system_prompt,
    toolWhitelist,
    starterPrompts,
    homepage: r.homepage ?? undefined,
    enabled: !!r.enabled,
    enabledScenarios,
    sourceUrl: r.source_url,
    installedAt: r.installed_at,
    builtin: !!r.builtin,
    // No suggested-scenario column at row level — the registry tells us this
    // at install time; we mirror it into enabledScenarios as the default.
    suggestedScenarios: enabledScenarios,
    runtime: !!r.runtime,
    slug: r.slug,
    installPath: r.install_path,
    skillBody: r.skill_body ?? '',
    resourceFiles,
    allowScripts: r.allow_scripts == null ? true : !!r.allow_scripts,
    status: (r.status as SkillLifecycleStatus) || 'active',
    origin: (r.origin as SkillOrigin) || 'manual',
    sourceMemoryId: r.source_memory_id ?? null,
    inducedVersion: r.induced_version ?? 1,
    bodyHash: r.body_hash ?? null,
    triggerReason: r.trigger_reason ?? null,
    inducedFrom: r.induced_from ?? null,
    timesLoaded: r.times_loaded ?? 0,
    timesSucceeded: r.times_succeeded ?? 0,
    timesFailed: r.times_failed ?? 0,
    lastUsedAt: r.last_used_at ?? null,
    confidence: r.confidence ?? null
  }
}

export function listInstalledSkills(): InstalledSkill[] {
  const rows = dbAll<SkillRow>('SELECT * FROM skills ORDER BY installed_at DESC')
  return rows.map(rowToSkill)
}

export function getInstalledSkill(id: string): InstalledSkill | null {
  const row = dbGet<SkillRow>('SELECT * FROM skills WHERE id = ?', [id])
  return row ? rowToSkill(row) : null
}

/**
 * Install or upgrade a skill. If a skill with the same id already exists, it
 * is overwritten (treat install-on-installed as an upgrade) while preserving
 * the user's enable / scenario choices.
 */
export function installSkill(manifest: SkillManifest, sourceUrl: string, builtin = false): InstalledSkill {
  const existing = getInstalledSkill(manifest.id)
  const enabled = existing ? (existing.enabled ? 1 : 0) : 1
  // First install seeds enabledScenarios from manifest's suggestion list;
  // upgrades preserve whatever the user already had.
  const enabledScenarios = existing
    ? JSON.stringify(existing.enabledScenarios)
    : JSON.stringify(manifest.suggestedScenarios)
  const installedAt = existing ? existing.installedAt : Date.now()
  // Once a skill is marked builtin, keep it that way across upgrades — even
  // if a future call forgets to pass the flag. Prevents accidental demotion.
  const builtinFlag = (existing?.builtin || builtin) ? 1 : 0
  dbRun(
    `INSERT OR REPLACE INTO skills
       (id, name, description, icon, version, author, system_prompt,
        tool_whitelist, starter_prompts, homepage, enabled, enabled_scenarios,
        source_url, installed_at, builtin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      manifest.id,
      manifest.name,
      manifest.description,
      manifest.icon,
      manifest.version,
      manifest.author,
      manifest.systemPrompt,
      manifest.toolWhitelist ? JSON.stringify(manifest.toolWhitelist) : null,
      JSON.stringify(manifest.starterPrompts ?? []),
      manifest.homepage ?? null,
      enabled,
      enabledScenarios,
      sourceUrl,
      installedAt,
      builtinFlag
    ]
  )
  const after = getInstalledSkill(manifest.id)
  if (!after) throw new Error(`installSkill: row missing after insert for ${manifest.id}`)
  return after
}

export interface RuntimeSkillParams {
  id: string
  slug: string
  name: string
  description: string
  icon: string
  version: string
  author: string
  homepage?: string
  /** SKILL.md body with frontmatter stripped. */
  skillBody: string
  /** Bundle-relative file paths. */
  resourceFiles: string[]
  /** Absolute install dir on disk. */
  installPath: string
  sourceUrl: string
  suggestedScenarios: SkillScenario[]
}

/**
 * Install or upgrade a runtime skill (downloaded SKILL.md bundle). Like
 * installSkill it upserts and preserves the user's enable / scenario /
 * allow-scripts choices on upgrade.
 */
export function installRuntimeSkill(p: RuntimeSkillParams): InstalledSkill {
  const existing = getInstalledSkill(p.id)
  const enabled = existing ? (existing.enabled ? 1 : 0) : 1
  const enabledScenarios = existing
    ? JSON.stringify(existing.enabledScenarios)
    : JSON.stringify(p.suggestedScenarios)
  const installedAt = existing ? existing.installedAt : Date.now()
  const builtinFlag = existing?.builtin ? 1 : 0
  // First install defaults allow_scripts ON (user opted into script execution);
  // upgrades preserve whatever the user set.
  const allowScripts = existing ? (existing.allowScripts ? 1 : 0) : 1
  dbRun(
    `INSERT OR REPLACE INTO skills
       (id, name, description, icon, version, author, system_prompt,
        tool_whitelist, starter_prompts, homepage, enabled, enabled_scenarios,
        source_url, installed_at, builtin,
        runtime, slug, install_path, skill_body, resource_files, allow_scripts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.id, p.name, p.description, p.icon, p.version, p.author, '',
      null, '[]', p.homepage ?? null, enabled, enabledScenarios,
      p.sourceUrl, installedAt, builtinFlag,
      1, p.slug, p.installPath, p.skillBody, JSON.stringify(p.resourceFiles), allowScripts
    ]
  )
  const after = getInstalledSkill(p.id)
  if (!after) throw new Error(`installRuntimeSkill: row missing after insert for ${p.id}`)
  return after
}

export function uninstallSkill(id: string): void {
  // Refuse to delete built-in skills — they're shipped with the app and the
  // UI hides the uninstall button for them, so reaching this is either a bug
  // or a malicious renderer.
  const existing = getInstalledSkill(id)
  if (existing?.builtin) throw new Error('内置技能不可卸载，仅可禁用')
  dbRun('DELETE FROM skills WHERE id = ?', [id])
  // Drop the on-disk bundle for runtime skills (no-op for legacy skills).
  if (existing?.runtime) removeSkillDir(id)
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  // Mirror the uninstall guard: built-in skills can't be disabled because the
  // app relies on some of them to function correctly (e.g. opsx workflow).
  // The UI hides the toggle, so reaching this either means a stale renderer
  // or a malicious caller — either way, refuse loudly.
  if (!enabled) {
    const existing = getInstalledSkill(id)
    if (existing?.builtin) throw new Error('内置技能不可禁用')
  }
  dbRun('UPDATE skills SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id])
}

export function setSkillScenarios(id: string, scenarios: SkillScenario[]): void {
  dbRun('UPDATE skills SET enabled_scenarios = ? WHERE id = ?', [JSON.stringify(scenarios), id])
}

export function setSkillAllowScripts(id: string, allow: boolean): void {
  dbRun('UPDATE skills SET allow_scripts = ? WHERE id = ?', [allow ? 1 : 0, id])
}

/**
 * Resolve which skills should be applied for a given scenario. Used by
 * agent code at request time to gather prompt fragments + tool whitelists.
 */
/** Default cap on how many AUTO-induced skills load into a single run. Fights the
 *  documented "skill shadowing" degradation as the auto-library grows. */
const DEFAULT_AUTO_SKILL_CAP = 12

export function getActiveSkillsForScenario(scenario: SkillScenario): InstalledSkill[] {
  const all = listInstalledSkills().filter(s => s.enabled && s.enabledScenarios.includes(scenario))
  // Auto-induced skills must be 'active' to enter a run; 'pending'(待审) and
  // 'deprecated'(停用) stay listed in the UI but never load — manual/remote skills
  // are unaffected (their status defaults to 'active').
  const eligible = all.filter(s => s.origin !== 'auto' || s.status === 'active')
  const auto = eligible.filter(s => s.origin === 'auto')
  const cap = Math.max(0, getSettings().skillMaxAutoActive ?? DEFAULT_AUTO_SKILL_CAP)
  if (auto.length <= cap) return eligible
  // Keep only the top-k auto skills by trust (confidence + net success).
  const trust = (s: InstalledSkill) => (s.confidence ?? 0.5) * 10 + s.timesSucceeded - s.timesFailed
  const keep = new Set(
    auto.slice().sort((a, b) => trust(b) - trust(a)).slice(0, cap).map(s => s.id)
  )
  return eligible.filter(s => s.origin !== 'auto' || keep.has(s.id))
}

// ============================================================================
// Lifecycle + usage signals (v23) — auto-induced skill evolution loop
// ============================================================================

/** Stamp induced-skill lifecycle fields after installRuntimeSkill writes the row. */
export function markInducedSkill(id: string, f: {
  origin?: SkillOrigin
  status?: SkillLifecycleStatus
  sourceMemoryId?: string | null
  bodyHash?: string | null
  triggerReason?: string | null
  inducedFrom?: string | null
  confidence?: number | null
}): void {
  dbRun(
    `UPDATE skills SET
       origin = COALESCE(?, origin),
       status = COALESCE(?, status),
       source_memory_id = COALESCE(?, source_memory_id),
       body_hash = COALESCE(?, body_hash),
       trigger_reason = COALESCE(?, trigger_reason),
       induced_from = COALESCE(?, induced_from),
       confidence = COALESCE(?, confidence)
     WHERE id = ?`,
    [f.origin ?? null, f.status ?? null, f.sourceMemoryId ?? null, f.bodyHash ?? null,
     f.triggerReason ?? null, f.inducedFrom ?? null, f.confidence ?? null, id]
  )
}

export function setSkillStatus(id: string, status: SkillLifecycleStatus): void {
  dbRun(`UPDATE skills SET status = ? WHERE id = ?`, [status, id])
}

/** Record that a skill was consulted (load_skill) this run — A1/A2 signal trail. */
export function recordSkillLoad(id: string, sessionId: string | null): void {
  const now = Date.now()
  dbRun(`UPDATE skills SET times_loaded = times_loaded + 1, last_used_at = ? WHERE id = ?`, [now, id])
  dbRun(`INSERT INTO skill_events (skill_id, session_id, ts, kind, artifacts) VALUES (?, ?, ?, 'load', 0)`,
    [id, sessionId, now])
}

/** Record the run outcome for a consulted skill + recompute smoothed confidence. */
export function recordSkillOutcome(id: string, success: boolean, artifacts: number, sessionId: string | null): void {
  const now = Date.now()
  if (success) dbRun(`UPDATE skills SET times_succeeded = times_succeeded + 1 WHERE id = ?`, [id])
  else dbRun(`UPDATE skills SET times_failed = times_failed + 1 WHERE id = ?`, [id])
  dbRun(`INSERT INTO skill_events (skill_id, session_id, ts, kind, artifacts) VALUES (?, ?, ?, ?, ?)`,
    [id, sessionId, now, success ? 'success' : 'fail', artifacts])
  const row = dbGet<{ s: number; f: number }>(
    `SELECT times_succeeded AS s, times_failed AS f FROM skills WHERE id = ?`, [id]
  )
  if (row) {
    // Laplace-smoothed success rate as the maturity/confidence score.
    const conf = (row.s + 1) / (row.s + row.f + 2)
    dbRun(`UPDATE skills SET confidence = ? WHERE id = ?`, [conf, id])
  }
}

export function listAutoSkills(): InstalledSkill[] {
  return listInstalledSkills().filter(s => s.origin === 'auto')
}

export function getSkillByBodyHash(hash: string): InstalledSkill | null {
  const row = dbGet<SkillRow>(`SELECT * FROM skills WHERE body_hash = ? LIMIT 1`, [hash])
  return row ? rowToSkill(row) : null
}

/** Refine-on-failure: replace the body, bump the version, refresh the hash, and
 *  reset the failure counter (we just addressed those failures) so the evolution
 *  sweep won't re-refine from the same stale trace until NEW failures accrue. */
export function updateInducedBody(id: string, newBody: string, bodyHash: string): void {
  dbRun(
    `UPDATE skills SET skill_body = ?, body_hash = ?, induced_version = induced_version + 1, times_failed = 0 WHERE id = ?`,
    [newBody, bodyHash, id]
  )
}

// ============================================================================
// Skill sources (registry URLs)
// ============================================================================

interface SourceRow {
  url: string
  name: string
  enabled: number
  builtin: number
  added_at: number
}

function rowToSource(r: SourceRow): SkillSource {
  return {
    url: r.url,
    name: r.name,
    enabled: !!r.enabled,
    builtin: !!r.builtin,
    addedAt: r.added_at
  }
}

export function listSkillSources(): SkillSource[] {
  return dbAll<SourceRow>('SELECT * FROM skill_sources ORDER BY builtin DESC, added_at ASC').map(rowToSource)
}

export function addSkillSource(url: string, name: string, builtin = false): void {
  dbRun(
    `INSERT OR IGNORE INTO skill_sources (url, name, enabled, builtin, added_at)
     VALUES (?, ?, 1, ?, ?)`,
    [url, name, builtin ? 1 : 0, Date.now()]
  )
}

export function deleteSkillSource(url: string): void {
  // Refuse to delete builtin sources at the DB layer — caller should error out.
  dbRun('DELETE FROM skill_sources WHERE url = ? AND builtin = 0', [url])
}

export function setSkillSourceEnabled(url: string, enabled: boolean): void {
  dbRun('UPDATE skill_sources SET enabled = ? WHERE url = ?', [enabled ? 1 : 0, url])
}

/**
 * Seed the built-in source on first launch. Idempotent. The URL points at the
 * public manifest JSON in this project's GitHub repo — users can disable it
 * but not delete it.
 */
// SkillHub paginated list endpoint. Larger pageSize because we only fetch
// once per browse — 50 items is enough to fill the gallery without scrolling
// being slow. The order=score sort surfaces the most-installed skills first.
export const BUILTIN_SKILL_SOURCE_URL = 'https://api.skillhub.cn/api/skills?page=1&pageSize=50&sortBy=score&order=desc'

export function ensureBuiltinSource(): void {
  const existing = dbGet<SourceRow>('SELECT * FROM skill_sources WHERE url = ?', [BUILTIN_SKILL_SOURCE_URL])
  if (existing) return
  // Migrate any pre-existing official builtin row (older URLs) to the new one.
  dbRun(`DELETE FROM skill_sources WHERE builtin = 1`)
  addSkillSource(BUILTIN_SKILL_SOURCE_URL, 'SkillHub 官方', true)
}
