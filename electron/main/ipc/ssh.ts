import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import type { SshConnection } from '../../../src/shared/ipc-types'
import { getSshConnections, saveSshConnection, deleteSshConnection, listSshMeta } from '../services/store'
import { testSshConnection } from '../services/ssh-service'
import { revokeSshTrust } from '../services/ssh-guard'
import { importMobaXtermFile } from '../services/ssh-import'

export function sshHandlers(): void {
  ipcMain.handle(IPC.SSH_LIST, () => getSshConnections())

  // Credential-free list for the @-mention picker — never returns secrets.
  ipcMain.handle(IPC.SSH_LIST_META, () => listSshMeta())

  ipcMain.handle(IPC.SSH_SAVE, (_e, conn: SshConnection) => {
    saveSshConnection(conn)
    revokeSshTrust(conn.id) // editing creds/host re-requires confirmation
    return { ok: true }
  })

  ipcMain.handle(IPC.SSH_DELETE, (_e, id: string) => {
    deleteSshConnection(id)
    revokeSshTrust(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.SSH_TEST, (_e, conn: SshConnection) => testSshConnection(conn))

  // Import a MobaXterm .mxtsessions export → SSH connections (deduped by host:port:user).
  ipcMain.handle(IPC.SSH_IMPORT, (_e, filePath: string) =>
    importMobaXtermFile(filePath, getSshConnections(), saveSshConnection, () => randomUUID()))
}
