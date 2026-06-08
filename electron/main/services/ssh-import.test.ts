import { describe, it, expect, vi } from 'vitest'

// app.getPath is only used for _DesktopDir_ resolution; stub it so the module
// loads under vitest (no real Electron app).
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { parseMobaXterm } from './ssh-import'

const SAMPLE = [
  '[Bookmarks]',
  'SubRep=',
  'ImgNum=41',
  'web1=#109#0%1.2.3.4%22%[root]%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%0%15%236,236,236%30,30,30%180,180,192%0%-1%-1%E:\\SSH-Logs%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0#0# #-1',
  'keyed (ubuntu)=#109#0%5.6.7.8%2222%ubuntu%%-1%-1%%%%%0%0%0%E:\\mykey.pem%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%0%15%x%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0#0# #-1',
  'rdpbox=#91#4%9.9.9.9%3389%[Administrator]%0%-1%-1%-1%-1%0#MobaFont%10#0# #-1',
  '[Bookmarks_1]',
  'SubRep=root\\prod',
  'ImgNum=41',
  'grouped=#109#0%10.0.0.1%22%admin%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10#0# #-1',
  '',
].join('\n')

describe('parseMobaXterm', () => {
  const { sessions, skipped } = parseMobaXterm(Buffer.from(SAMPLE, 'utf8'))

  it('imports only SSH (type 109) sessions and skips RDP (91)', () => {
    expect(sessions.map(s => s.host)).toEqual(['1.2.3.4', '5.6.7.8', '10.0.0.1'])
    expect(skipped).toBe(1) // the RDP entry
  })

  it('captures the MobaXterm subfolder (SubRep leaf) as group', () => {
    expect(sessions[0].group).toBeUndefined()      // [Bookmarks] root → ungrouped
    expect(sessions[2]).toMatchObject({ host: '10.0.0.1', group: 'prod' }) // [Bookmarks_1] SubRep=root\prod
  })

  it('parses host/port/username and strips [..] brackets', () => {
    const web1 = sessions[0]
    expect(web1).toMatchObject({ host: '1.2.3.4', port: 22, username: 'root', authType: 'password' })
    expect(web1.privateKey).toBeUndefined()
  })

  it('detects a non-default port and key-file reference', () => {
    const keyed = sessions[1]
    expect(keyed).toMatchObject({ host: '5.6.7.8', port: 2222, username: 'ubuntu', authType: 'privateKey' })
    // file doesn't exist in test env → no key body, but the path is remembered
    expect(keyed.privateKey).toBeUndefined()
    expect(keyed.keyHint).toBe('E:\\mykey.pem')
  })
})
