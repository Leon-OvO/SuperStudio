import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import {
  listInstalledSkills, installSkill, uninstallSkill, setSkillEnabled,
  setSkillScenarios, listSkillSources, addSkillSource, deleteSkillSource,
  setSkillSourceEnabled, ensureBuiltinSource, type SkillScenario
} from '../services/skills-db'
import { fetchRegistry, fetchManifest, ensureBundledInstalled, type RegistryEntry, type FetchedRegistry, type BrowseParams } from '../services/skills-registry'

export function skillsHandlers(): void {
  // First-run seed of the builtin registry source + the bundled skill set
  // (auto-installs them as uninstallable built-ins so they show up in the
  // "Installed" tab on first launch).
  ensureBuiltinSource()
  ensureBundledInstalled()

  // --- Installed skills ---
  ipcMain.handle(IPC.SKILLS_LIST, () => listInstalledSkills())

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_e, args: { sourceUrl: string; entry: RegistryEntry }) => {
    const manifest = await fetchManifest(args.entry)
    return installSkill(manifest, args.sourceUrl)
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
