import { ipcMain } from 'electron'
import { generateText } from 'ai'
import { IPC } from '../../../src/shared/ipc-types'
import { browseCatalog, getSoul } from '../services/talent-pool'
import { resolveEmployeeModel } from '../services/employees-db'
import { createLLMClient } from '../services/llm'
import { importLocalTalents } from '../services/talent-files'
import { deleteUserSoul } from '../services/user-souls-db'
import { refreshUserSouls } from '../services/talent-source'

export function talentHandlers(): void {
  ipcMain.handle(IPC.TALENT_BROWSE, (_e, args?: { dept?: string; keyword?: string; page?: number; pageSize?: number }) =>
    browseCatalog(args ?? {}))

  ipcMain.handle(IPC.TALENT_GET, (_e, id: string) => getSoul(id))

  // 导入外部 soul.md（用户主动选择的文件/目录，已经过 openFileDialog 放行）→ user_souls。
  ipcMain.handle(IPC.TALENT_IMPORT_LOCAL, (_e, sourcePath: string) => {
    const res = importLocalTalents(sourcePath)
    refreshUserSouls()  // 让人才市场免重启即可见新导入
    return res
  })

  ipcMain.handle(IPC.TALENT_DELETE_USER, (_e, id: string) => {
    deleteUserSoul(id)
    refreshUserSouls()
    return { ok: true }
  })

  // 面试试聊：拿候选人的 soul 人格 + 推荐模型临时跑一轮多轮对话，结果不持久化。
  // 让用户在录用前真实测试这个角色的回答风格/能力。
  ipcMain.handle(IPC.TALENT_TRY, async (_e, args: { soulId: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ text?: string; model?: string; error?: string }> => {
    const soul = getSoul(args.soulId)
    if (!soul) return { error: '人才不存在' }
    const { providerId, modelId } = resolveEmployeeModel(soul.recModel)
    if (!providerId || !modelId) return { error: '尚未配置可用的模型，请先在「设置 → 提供商」添加。' }
    try {
      const model = createLLMClient(providerId, modelId)
      const { text } = await generateText({
        model,
        system: soul.systemPrompt,
        messages: (args.messages || []).slice(-10),  // cap context for a quick test
        maxTokens: 800
      })
      return { text, model: modelId }
    } catch (e) {
      return { error: (e as Error).message || '试聊失败' }
    }
  })
}
