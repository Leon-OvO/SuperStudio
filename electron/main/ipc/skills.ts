import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import {
  listInstalledSkills, installSkill, installRuntimeSkill, uninstallSkill, setSkillEnabled,
  setSkillScenarios, setSkillAllowScripts, getInstalledSkill, listSkillSources,
  addSkillSource, deleteSkillSource, setSkillSourceEnabled, ensureBuiltinSource,
  type SkillScenario
} from '../services/skills-db'
import { fetchRegistry, fetchManifest, ensureBundledInstalled, type RegistryEntry, type FetchedRegistry, type BrowseParams } from '../services/skills-registry'
import { downloadSkillBundle, parseSkillMd, readSkillResource } from '../services/skill-files'

export function skillsHandlers(): void {
  // First-run seed of the builtin registry source + the bundled skill set
  // (auto-installs them as uninstallable built-ins so they show up in the
  // "Installed" tab on first launch).
  ensureBuiltinSource()
  ensureBundledInstalled()

  // --- Installed skills ---
  ipcMain.handle(IPC.SKILLS_LIST, () => listInstalledSkills())

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
