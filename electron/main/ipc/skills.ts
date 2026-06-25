import { ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import { IPC } from '../../../src/shared/ipc-types'
import {
  listInstalledSkills, installSkill, installRuntimeSkill, uninstallSkill, setSkillEnabled,
  setSkillScenarios, setSkillAllowScripts, getInstalledSkill, listSkillSources,
  addSkillSource, deleteSkillSource, setSkillSourceEnabled, ensureBuiltinSource,
  setSkillStatus, type SkillScenario, type SkillLifecycleStatus
} from '../services/skills-db'
import { induceFromSessionManual } from '../services/skill-induction'
import { startSkillOps } from '../services/skill-evolution'
import { fetchRegistry, fetchManifest, ensureBundledInstalled, type RegistryEntry, type FetchedRegistry, type BrowseParams } from '../services/skills-registry'
import { downloadSkillBundle, importLocalSkillBundle, parseSkillMd, readSkillResource, buildSkillExportZip, buildSkillsExportZip } from '../services/skill-files'
import { discoverLocalSkills } from '../services/skill-discover'

export function skillsHandlers(): void {
  // First-run seed of the builtin registry source + the bundled skill set
  // (auto-installs them as uninstallable built-ins so they show up in the
  // "Installed" tab on first launch).
  ensureBuiltinSource()
  ensureBundledInstalled()
  // Auto-skill evolution sweep (deprecate/merge/promote/refine) — startup + interval.
  startSkillOps()

  // --- Installed skills ---
  ipcMain.handle(IPC.SKILLS_LIST, () => listInstalledSkills())

  // 对话自动学习：手动「把这次对话变成技能」。Returns {ok, skill?, error?} with a
  // precise reason on failure (model-not-configured / 闲聊 / 已存在 …).
  ipcMain.handle(IPC.SKILLS_INDUCE_SESSION, (_e, sessionId: string) => induceFromSessionManual(sessionId))

  // 审核：采纳(active) / 待审(pending) / 停用(deprecated)。
  ipcMain.handle(IPC.SKILLS_SET_STATUS, (_e, args: { id: string; status: SkillLifecycleStatus }) => {
    setSkillStatus(args.id, args.status)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_e, args: { sourceUrl: string; entry: RegistryEntry }) => {
    const { entry, sourceUrl } = args
    // SkillHub entries carry a `slug` → install as a real runtime skill:
    // download the SKILL.md bundle to disk and cache the parsed body.
    if (entry.slug) {
      const bundle = await downloadSkillBundle(entry.slug, entry.id, entry.version)
      const parsed = parseSkillMd(bundle.skillMd)
      return installRuntimeSkill({
        id: entry.id,
        slug: entry.slug,
        name: entry.name || parsed.name,
        description: parsed.description || entry.description,
        icon: entry.icon ?? '🧩',
        version: entry.version ?? '0.0.0',
        author: entry.author ?? '',
        homepage: entry.homepage,
        skillBody: parsed.body,
        resourceFiles: bundle.files,
        installPath: bundle.installPath,
        sourceUrl,
        suggestedScenarios: entry.suggestedScenarios ?? ['chat', 'vibe']
      })
    }
    // Legacy flat-registry entry — prompt-only skill from a manifest.
    const manifest = await fetchManifest(entry)
    return installSkill(manifest, sourceUrl)
  })

  // Import a skill bundle from a local folder (offline / self-authored skills).
  // Copies the bundle to disk and installs it as a runtime skill, same as a
  // SkillHub download but with no slug (can't be re-fetched, only re-imported).
  ipcMain.handle(IPC.SKILLS_IMPORT_LOCAL, async (_e, sourcePath: string) => {
    const bundle = importLocalSkillBundle(sourcePath)
    const parsed = parseSkillMd(bundle.skillMd)
    return installRuntimeSkill({
      id: bundle.id,
      slug: '',
      name: parsed.name || bundle.name,
      description: parsed.description || '',
      icon: '🧩',
      version: '0.0.0',
      author: '',
      homepage: undefined,
      skillBody: parsed.body,
      resourceFiles: bundle.files,
      installPath: bundle.installPath,
      sourceUrl: 'local',
      suggestedScenarios: ['chat', 'vibe']
    })
  })

  // Auto-discover importable local skill bundles (~/.claude/skills, the open
  // project's .claude/skills, and a custom folder). Read-only scan.
  ipcMain.handle(IPC.SKILLS_DISCOVER_LOCAL, (_e, args?: { projectPath?: string }) => {
    return discoverLocalSkills(args?.projectPath)
  })

  // Export an installed skill as a re-importable .zip bundle (round-trips via
  // SKILLS_IMPORT_LOCAL, which now accepts .zip).
  ipcMain.handle(IPC.SKILLS_EXPORT, async (e, skillId: string) => {
    const skill = getInstalledSkill(skillId)
    if (!skill) return { canceled: true, error: '技能不存在' }
    const win = BrowserWindow.fromWebContents(e.sender)
    const safe = (skill.name || skill.id).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'skill'
    const opts = { defaultPath: `${safe}-${skill.version || '0.0.0'}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] }
    const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (dlg.canceled || !dlg.filePath) return { canceled: true }
    try {
      fs.writeFileSync(dlg.filePath, buildSkillExportZip(skill))
      return { canceled: false, filePath: dlg.filePath }
    } catch (err) {
      return { canceled: true, error: (err as Error).message }
    }
  })

  // Export many skills at once into ONE combined .zip (per-skill subfolders) —
  // for backing up / migrating / sharing a whole set (e.g. all auto-learned
  // skills). One save dialog instead of N. Skips any missing ids.
  ipcMain.handle(IPC.SKILLS_EXPORT_BATCH, async (e, ids: string[]) => {
    const skills = (ids ?? []).map(getInstalledSkill).filter((s): s is NonNullable<typeof s> => !!s)
    if (!skills.length) return { canceled: true, error: '没有可导出的技能' }
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().slice(0, 10)
    const opts = { defaultPath: `skills-${skills.length}-${stamp}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] }
    const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (dlg.canceled || !dlg.filePath) return { canceled: true }
    try {
      fs.writeFileSync(dlg.filePath, buildSkillsExportZip(skills))
      return { canceled: false, filePath: dlg.filePath, count: skills.length }
    } catch (err) {
      return { canceled: true, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.SKILLS_UNINSTALL, (_e, id: string) => {
    uninstallSkill(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_SET_ENABLED, (_e, args: { id: string; enabled: boolean }) => {
    setSkillEnabled(args.id, args.enabled)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_SET_SCENARIOS, (_e, args: { id: string; scenarios: SkillScenario[] }) => {
    setSkillScenarios(args.id, args.scenarios)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_SET_ALLOW_SCRIPTS, (_e, args: { id: string; allow: boolean }) => {
    setSkillAllowScripts(args.id, args.allow)
    return { ok: true }
  })

  // Read a bundled resource file of an installed runtime skill (for preview).
  // Path-traversal is guarded inside readSkillResource.
  ipcMain.handle(IPC.SKILLS_READ_FILE, (_e, args: { id: string; path: string }) => {
    const skill = getInstalledSkill(args.id)
    if (!skill) return { error: `未找到技能 "${args.id}"` }
    try {
      return { content: readSkillResource(args.id, args.path) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // --- Registry sources ---
  ipcMain.handle(IPC.SKILLS_SOURCES_LIST, () => listSkillSources())

  ipcMain.handle(IPC.SKILLS_SOURCES_ADD, (_e, args: { url: string; name: string }) => {
    addSkillSource(args.url, args.name, false)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_SOURCES_DELETE, (_e, url: string) => {
    deleteSkillSource(url)
    return { ok: true }
  })

  ipcMain.handle(IPC.SKILLS_SOURCES_SET_ENABLED, (_e, args: { url: string; enabled: boolean }) => {
    setSkillSourceEnabled(args.url, args.enabled)
    return { ok: true }
  })

  // --- Browse — fetch one page from each enabled source ---
  // Bundled skills are excluded: they auto-install as built-ins and live in
  // the "Installed" tab. Pagination + search are server-side for SkillHub
  // and client-side for flat-file sources (see fetchRegistry).
  ipcMain.handle(IPC.SKILLS_BROWSE, async (_e, args?: Partial<BrowseParams>): Promise<{ registries: FetchedRegistry[] }> => {
    const params: BrowseParams = {
      page: Math.max(1, args?.page ?? 1),
      pageSize: Math.min(100, Math.max(1, args?.pageSize ?? 24)),
      keyword: (args?.keyword ?? '').trim()
    }
    const sources = listSkillSources().filter(s => s.enabled)
    const registries = await Promise.all(sources.map(s => fetchRegistry(s.url, params)))
    return { registries }
  })
}
