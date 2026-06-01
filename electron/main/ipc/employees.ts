import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { listEmployees, hireEmployee, fireEmployee, setEmployeeModel, setEmployeeDept, getCompanySpendRange } from '../services/employees-db'

export function employeeHandlers(): void {
  ipcMain.handle(IPC.EMP_LIST, () => listEmployees())
  ipcMain.handle(IPC.EMP_SPEND_RANGE, (_e, args: { fromMs: number; toMs: number }) => getCompanySpendRange(args.fromMs, args.toMs))
  ipcMain.handle(IPC.EMP_HIRE, (_e, soulId: string) => hireEmployee(soulId))
  ipcMain.handle(IPC.EMP_FIRE, (_e, id: string) => { fireEmployee(id); return { ok: true } })
  ipcMain.handle(IPC.EMP_SET_MODEL, (_e, args: { id: string; providerId: string; modelId: string }) => {
    setEmployeeModel(args.id, args.providerId, args.modelId); return { ok: true }
  })
  ipcMain.handle(IPC.EMP_SET_DEPT, (_e, args: { id: string; dept: string }) => {
    setEmployeeDept(args.id, args.dept); return { ok: true }
  })
}
