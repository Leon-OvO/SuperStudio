import { create } from 'zustand'
import type { EmployeeInfo } from '../../../shared/ipc-types'

/**
 * Shared employee roster — single source of truth so every consumer (Workbench
 * tab badge, Company sub-views, the IDE's request-assignee dropdown) sees the
 * same list and refreshes together. Previously each site called listEmployees()
 * in its own useEffect([],[]), so a hire/fire didn't propagate to the long-lived
 * IDE until it remounted.
 */
interface EmployeesState {
  employees: EmployeeInfo[]
  loaded: boolean
  refresh: () => Promise<void>
  hire: (soulId: string) => Promise<EmployeeInfo | null>
  fire: (id: string) => Promise<void>
  setModel: (id: string, providerId: string, modelId: string) => Promise<void>
}

export const useEmployeesStore = create<EmployeesState>((set, get) => ({
  employees: [],
  loaded: false,
  refresh: async () => {
    try {
      const list = await window.api.listEmployees() as EmployeeInfo[]
      set({ employees: list, loaded: true })
    } catch { /* keep previous list */ }
  },
  hire: async (soulId) => {
    let emp: EmployeeInfo | null = null
    try { emp = await window.api.hireEmployee(soulId) as EmployeeInfo } catch { /* surface via caller */ throw new Error('录用失败') }
    await get().refresh()
    return emp
  },
  fire: async (id) => {
    await window.api.fireEmployee(id)
    await get().refresh()
  },
  setModel: async (id, providerId, modelId) => {
    await window.api.setEmployeeModel({ id, providerId, modelId })
    await get().refresh()
  }
}))
