import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import { listGallery, searchGalleryImages, deleteGalleryItem, batchDeleteGallery, saveGalleryItem } from '../services/gallery'
import { generateText } from 'ai'
import { generateImage } from '../services/image'
import { compressImageToFit, DEFAULT_MAX_IMAGE_BYTES } from '../services/image-compress'
import { createLLMClient } from '../services/llm'
import { getSettings } from '../services/store'
import { dbAll } from '../db/sqlite'
import fs from 'fs'
import path from 'path'

/** MIME for an image path (used when feeding reference images to a vision model). */
function mimeForImage(p: string): string {
  const ext = (p.split('.').pop() || '').toLowerCase()
  return ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'bmp' ? 'image/bmp'
    : 'image/jpeg'
}

/** Library asset kinds keyed by lowercase file extension (no dot). */
const KIND_BY_EXT: Record<string, 'image' | 'video' | 'audio'> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio',
}

export function galleryHandlers(): void {
  ipcMain.handle(IPC.GALLERY_LIST, (_e, filters) => listGallery(filters))
  ipcMain.handle(IPC.GALLERY_SEARCH, (_e, query: string, limit?: number) => searchGalleryImages(query || '', limit ?? 40))
  ipcMain.handle(IPC.GALLERY_DELETE, (_e, id: number) => {
    deleteGalleryItem(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.GALLERY_BATCH_DELETE, (_e, ids: number[]) => {
    batchDeleteGallery(ids)
    return { ok: true, deleted: ids.length }
  })

  /**
   * Copy every selected gallery item into a user-chosen folder. On name
   * collisions we append " (1)", " (2)", … so existing files are never
   * overwritten.
   */
  ipcMain.handle(IPC.GALLERY_BATCH_SAVE, async (e, ids: number[]) => {
    if (!Array.isArray(ids) || ids.length === 0) return { canceled: true, saved: 0 }
    const win = BrowserWindow.fromWebContents(e.sender)
    const dlg = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (dlg.canceled || !dlg.filePaths[0]) return { canceled: true, saved: 0 }
    const targetDir = dlg.filePaths[0]

    const placeholders = ids.map(() => '?').join(',')
    const rows = dbAll<{ file_path: string }>(
      `SELECT file_path FROM gallery WHERE id IN (${placeholders})`,
      ids
    )

    let saved = 0
    const failures: string[] = []
    for (const r of rows) {
      const src = r.file_path
      if (!src || !fs.existsSync(src)) { failures.push(src); continue }
      const base = path.basename(src)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let dest = path.join(targetDir, base)
      let n = 1
      while (fs.existsSync(dest)) {
        dest = path.join(targetDir, `${stem} (${n})${ext}`)
        n++
      }
      try { fs.copyFileSync(src, dest); saved++ } catch { failures.push(src) }
    }
    return { canceled: false, saved, failures, targetDir }
  })

  // 画布「右键微调重生单张」：用同样的参考图 + 微调后的参数再生成，存进素材库（source=canvas）。
  ipcMain.handle(IPC.CANVAS_GENERATE_ONE, async (_e, params: {
    prompt: string; size?: string; quality?: string; n?: number
    referenceImagePaths?: string[]; sceneLabel?: string; variantGroupId?: string
  }) => {
    const settings = getSettings()
    if (!settings.defaultImageProviderId || !settings.defaultImageModel) {
      throw new Error('请先在「设置 → 模型」配置默认图片模型')
    }
    if (!String(params.prompt || '').trim()) throw new Error('提示词不能为空')
    const result = await generateImage({
      prompt: params.prompt,
      n: Math.min(Math.max(Number(params.n) || 1, 1), 4),
      size: params.size || '1024x1024',
      quality: params.quality === 'hd' ? 'hd' : undefined,
      referenceImagePaths: params.referenceImagePaths?.length ? params.referenceImagePaths : undefined,
      settings
    })
    const paths: string[] = []
    for (const img of result.images) {
      await saveGalleryItem({
        type: 'image', filePath: img.path, prompt: params.prompt, source: 'canvas',
        modelName: settings.defaultImageModel, variantGroupId: params.variantGroupId, sceneLabel: params.sceneLabel
      })
      paths.push(img.path)
    }
    return { ok: true, paths }
  })

  // 画布「提示词扩写」：用默认对话模型把简短想法补成更具画面感的图像提示词。
  // 带参考图时（图卡自身 / 参考组的多张图）走多模态消息，让模型「看图」后再扩写，
  // 否则模型只会回「我需要看到图片」。需要默认对话模型具备视觉能力。
  ipcMain.handle(IPC.CANVAS_EXPAND_PROMPT, async (_e, params: { prompt: string; referenceImagePaths?: string[] }) => {
    const settings = getSettings()
    const providerId = settings.defaultChatProviderId
    const model = settings.defaultChatModel
    if (!providerId || !model) return { ok: false, error: '请先在「设置 → 模型」配置默认对话模型' }
    const input = String(params?.prompt || '').trim()
    if (!input) return { ok: false, error: '提示词不能为空' }

    // Read up to 6 reference images for the vision pass. Oversized photos are
    // auto-compressed to fit; only those that truly can't be compressed are skipped.
    const imageParts: Array<{ type: 'image'; image: Buffer; mimeType: string }> = []
    for (const p of (params?.referenceImagePaths || []).slice(0, 6)) {
      try {
        if (!p || !fs.existsSync(p)) continue
        let data: Buffer = fs.readFileSync(p)
        let mime = mimeForImage(p)
        if (data.length > DEFAULT_MAX_IMAGE_BYTES) {
          try {
            const r = compressImageToFit(data, DEFAULT_MAX_IMAGE_BYTES, '参考图')
            if (r.compressed) { data = r.data; mime = r.mime }
          } catch { continue } // 真的压缩不动 → 跳过这张参考图
        }
        imageParts.push({ type: 'image', image: data, mimeType: mime })
      } catch { /* skip unreadable */ }
    }
    const hasImages = imageParts.length > 0

    const system = hasImages
      ? '你是 AI 图像生成的提示词专家。你会看到用户提供的一张或多张参考图。请结合参考图里的实际内容，把用户的简短想法扩写成一段具体、有画面感的中文图像生成提示词：说明要生成的画面如何运用这些参考（例如让模特换上参考中的服装、置入某种场景等），并补充风格、光线、构图、镜头、材质、色彩、氛围与画质等细节，但必须忠于用户原意、不改变核心主题。直接输出扩写后的提示词正文即可，不要解释、不要加引号、不要分点或编号。'
      : '你是 AI 图像生成的提示词专家。把用户给的简短想法扩写成一段更具体、更有画面感的中文图像提示词：补充主体细节、风格、光线、构图、镜头、材质、色彩、氛围与画质等，但必须忠于原意、不改变核心主题，也不要加入与原意冲突的元素。直接输出扩写后的提示词正文即可，不要解释、不要加引号、不要分点或编号。'

    try {
      const llm = createLLMClient(providerId, model)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 45000)
      try {
        const { text } = await generateText({
          model: llm,
          system,
          messages: [{ role: 'user', content: hasImages ? [{ type: 'text', text: input }, ...imageParts] : input }],
          maxTokens: 500,
          abortSignal: controller.signal
        })
        const out = text.trim()
        return out ? { ok: true, text: out } : { ok: false, error: '扩写失败（模型返回空）' }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 按场景一键导出一个变体组：文件名用「场景标签-序号」，便于电商按用途归档。
  ipcMain.handle(IPC.CANVAS_EXPORT_GROUP, async (e, variantGroupId: string) => {
    if (!variantGroupId) return { canceled: true, saved: 0 }
    const win = BrowserWindow.fromWebContents(e.sender)
    const dlg = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (dlg.canceled || !dlg.filePaths[0]) return { canceled: true, saved: 0 }
    const targetDir = dlg.filePaths[0]
    const rows = dbAll<{ file_path: string; scene_label: string | null }>(
      `SELECT file_path, scene_label FROM gallery WHERE variant_group_id = ? ORDER BY created_at ASC`,
      [variantGroupId]
    )
    const counters: Record<string, number> = {}
    let saved = 0
    const failures: string[] = []
    for (const r of rows) {
      const src = r.file_path
      if (!src || !fs.existsSync(src)) { failures.push(src); continue }
      const ext = path.extname(src) || '.png'
      const label = (r.scene_label || '场景').replace(/[\\/:*?"<>|]/g, '_')
      counters[label] = (counters[label] || 0) + 1
      let dest = path.join(targetDir, `${label}-${counters[label]}${ext}`)
      let k = 1
      while (fs.existsSync(dest)) { dest = path.join(targetDir, `${label}-${counters[label]}_${k}${ext}`); k++ }
      try { fs.copyFileSync(src, dest); saved++ } catch { failures.push(src) }
    }
    return { canceled: false, saved, failures, targetDir }
  })

  /**
   * Import local files into the library. Each picked file is copied into
   * gallery/{images,videos,audio} under a fresh UUID name so the library owns
   * its copy — deleting a library entry never touches the user's original.
   */
  ipcMain.handle(IPC.GALLERY_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有素材', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
        { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
      ],
    }
    const dlg = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true, imported: 0, failures: [] }

    const baseDir = getSettings().dataDirectory || app.getPath('userData')
    let imported = 0
    const failures: string[] = []
    for (const src of dlg.filePaths) {
      const ext = path.extname(src).slice(1).toLowerCase()
      const kind = KIND_BY_EXT[ext]
      if (!kind) { failures.push(src); continue }
      const subdir = kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio'
      const dir = path.join(baseDir, 'gallery', subdir)
      try {
        fs.mkdirSync(dir, { recursive: true })
        const dest = path.join(dir, `${randomUUID()}.${ext}`)
        fs.copyFileSync(src, dest)
        await saveGalleryItem({
          type: kind,
          filePath: dest,
          prompt: path.basename(src),
          source: 'import',
        })
        imported++
      } catch {
        failures.push(src)
      }
    }
    return { canceled: false, imported, failures }
  })
}
