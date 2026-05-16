import { ipcMain, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import { generateImage } from '../services/image'
import { saveGalleryItem } from '../services/gallery'
import { getSettings } from '../services/store'

type EditMode = 'inpaint' | 'text_replace' | 'outpaint' | 'bg_removal'

const PROMPT_BUILDER: Record<EditMode, (userText: string) => string> = {
  inpaint: (t) => t.trim(),
  text_replace: (t) =>
    `Replace the text inside the masked transparent area with: "${t.trim()}". ` +
    `Preserve the original font family, weight, size, color and surrounding visual style exactly. ` +
    `Do not add any new visual elements; only change the text characters themselves.`,
  outpaint: () =>
    `Extend the existing image naturally to fill the transparent area. ` +
    `Match the original art style, color palette, lighting, perspective and composition exactly. ` +
    `The visible original region must remain unchanged; only the new transparent regions should be generated.`,
  bg_removal: () =>
    `Remove the background entirely while keeping the main subject exactly as it appears. ` +
    `The background must be fully transparent. Do not modify the subject's edges, color or detail.`
}

interface EditParams {
  mode: EditMode
  imageBase64: string
  maskBase64?: string
  prompt?: string
  size?: string
  sessionId?: string
  /** Friendly note saved into the gallery entry; falls back to mode + prompt. */
  galleryNote?: string
}

export function imageEditHandlers(): void {
  ipcMain.handle(IPC.IMAGE_OVERWRITE, (_e, params: { path: string; base64: string }) => {
    if (!params?.path) throw new Error('overwrite: 缺少 path')
    if (!fs.existsSync(params.path)) throw new Error('overwrite: 目标文件不存在 ' + params.path)
    fs.writeFileSync(params.path, Buffer.from(params.base64, 'base64'))
    return { ok: true, path: params.path }
  })

  ipcMain.handle(IPC.IMAGE_EDIT, async (_e, params: EditParams) => {
    const { mode, imageBase64, maskBase64, prompt = '', size, sessionId, galleryNote } = params
    if (mode === 'inpaint' && !prompt.trim()) {
      throw new Error('局部修改需要填写描述')
    }
    if (mode === 'text_replace' && !prompt.trim()) {
      throw new Error('改字模式需要填写新文字内容')
    }

    const settings = getSettings()
    if (!settings.defaultImageProviderId || !settings.defaultImageModel) {
      throw new Error('请先在「设置 → 默认模型」配置图片生成模型')
    }

    // Stage inputs to disk — generateImage expects file paths for the multipart upload
    const tempDir = path.join(app.getPath('userData'), 'temp', 'image-edit')
    fs.mkdirSync(tempDir, { recursive: true })
    const tag = `${mode}-${Date.now()}-${randomUUID().slice(0, 6)}`
    const imagePath = path.join(tempDir, `${tag}-src.png`)
    fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'))

    let maskPath: string | undefined
    if (maskBase64) {
      maskPath = path.join(tempDir, `${tag}-mask.png`)
      fs.writeFileSync(maskPath, Buffer.from(maskBase64, 'base64'))
    }

    const fullPrompt = PROMPT_BUILDER[mode](prompt)
    console.log('[image-edit]', mode, 'prompt=', fullPrompt.slice(0, 80), 'size=', size, 'hasMask=', !!maskPath)

    const result = await generateImage({
      prompt: fullPrompt,
      n: 1,
      size: size || '1024x1024',
      settings,
      referenceImagePaths: [imagePath],
      maskPath,
      // CRITICAL: never silently fall back to text-to-image — that drops the
      // source image and mask entirely, producing an unrelated result.
      noFallback: true
    })

    const out = result.images?.[0]
    if (!out) throw new Error('未生成图片（模型返回空）')

    const noteByMode: Record<EditMode, string> = {
      inpaint: `局部修改：${prompt.slice(0, 60)}`,
      text_replace: `改字：${prompt.slice(0, 60)}`,
      outpaint: `AI 扩图${size ? `（${size}）` : ''}`,
      bg_removal: '一键抠图'
    }
    const galleryId = await saveGalleryItem({
      type: 'image',
      filePath: out.path,
      prompt: galleryNote ?? noteByMode[mode],
      source: 'chat',
      sessionId,
      modelName: settings.defaultImageModel
    })

    return { path: out.path, galleryId }
  })
}
