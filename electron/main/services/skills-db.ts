import { dbAll, dbGet, dbRun } from '../db/sqlite'

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
}

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
    suggestedScenarios: enabledScenarios
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

export function uninstallSkill(id: string): void {
  // Refuse to delete built-in skills — they're shipped with the app and the
  // UI hides the uninstall button for them, so reaching this is either a bug
  // or a malicious renderer.
  const existing = getInstalledSkill(id)
  if (existing?.builtin) throw new Error('内置技能不可卸载，仅可禁用')
  dbRun('DELETE FROM skills WHERE id = ?', [id])
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

/**
 * Resolve which skills should be applied for a given scenario. Used by
 * agent code at request time to gather prompt fragments + tool whitelists.
 */
export function getActiveSkillsForScenario(scenario: SkillScenario): InstalledSkill[] {
  return listInstalledSkills().filter(s => s.enabled && s.enabledScenarios.includes(scenario))
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
