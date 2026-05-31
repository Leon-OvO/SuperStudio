import { ipcMain, app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { IPC, type VideoGenerateRequest, type VideoGenerateResult } from '../../../src/shared/ipc-types'
import { generateVideo } from '../services/video'
import { saveGalleryItem, updateGalleryThumbnail } from '../services/gallery'
import { getSettings } from '../services/store'

/**
 * Map of in-flight job → AbortController so the renderer can cancel a long
 * generation by clientJobId. Entries are removed in the handler's `finally`,
 * so a stale id is at worst a harmless no-op for the canceller.
 */
const inflightControllers = new Map<string, AbortController>()

const ALLOWED_REF_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])

function stageReference(base64: string, suggestedName?: string): string {
  const dir = path.join(app.getPath('userData'), 'temp', 'video-ref')
  fs.mkdirSync(dir, { recursive: true })
  // Trust the caller's extension only if it's an image we know the API accepts;
  // otherwise default to .png so the multipart upload doesn't get rejected.
  const ext = (suggestedName?.split('.').pop() ?? 'png').toLowerCase()
  const safeExt = ALLOWED_REF_EXT.has(ext) ? ext : 'png'
  const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 6)}.${safeExt}`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

export function videoHandlers(): void {
  ipcMain.handle(IPC.VIDEO_GENERATE, async (e, params: VideoGenerateRequest): Promise<VideoGenerateResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'No window context for video generation' }

    const { clientJobId, providerOverrideId, modelOverride, prompt, negativePrompt, referenceImageBase64, referenceFileName, frameRole, durationSec, aspect, seed } = params
    if (!clientJobId) return { ok: false, error: 'clientJobId is required' }
    if (!prompt?.trim()) return { ok: false, error: '请输入提示词' }

    const settings = getSettings()
    // The Video page may have picked a different provider/model than the
    // configured default — substitute before checking, so a user with no
    // global default but a one-off pick can still generate.
    const effectiveProviderId = providerOverrideId || settings.defaultVideoProviderId
    const effectiveModel = modelOverride || settings.defaultVideoModel
    if (!effectiveProviderId || !effectiveModel) {
      return { ok: false, error: '请先在「设置 → 默认模型」配置视频生成模型，或在左侧选择一个模型' }
    }

    // Refuse duplicate submissions for the same id — defensive against double
    // clicks racing through the IPC layer.
    if (inflightControllers.has(clientJobId)) {
      return { ok: false, error: 'Job already in flight for this id' }
    }

    const controller = new AbortController()
    inflightControllers.set(clientJobId, controller)

    let referenceImagePath: string | undefined
    try {
      if (referenceImageBase64) {
        referenceImagePath = stageReference(referenceImageBase64, referenceFileName)
      }

      const result = await generateVideo({
        prompt: prompt.trim(),
        negativePrompt,
        referenceImagePath,
        frameRole,
        aspect,
        seed,
        duration: durationSec,
        settings: {
          defaultVideoProviderId: effectiveProviderId,
          defaultVideoModel: effectiveModel,
          dataDirectory: settings.dataDirectory
        },
        win,
        sessionId: clientJobId,
        clientJobId,
        abortSignal: controller.signal
      })

      if (!result.path) {
        return { ok: false, error: result.error || '未生成视频（模型返回空）' }
      }

      // Note: aspect is a UI-only hint right now — most providers infer it
      // from the reference image or model preset. Stored in the gallery prompt
      // suffix so it surfaces in the history without a schema change.
      const galleryNote = aspect ? `${prompt.trim()}  ·  ${aspect} · ${durationSec ?? 5}s` : prompt.trim()
      const galleryId = await saveGalleryItem({
        type: 'video',
        filePath: result.path,
        prompt: galleryNote,
        source: 'workflow',
        modelName: effectiveModel
      })

      return { ok: true, path: result.path, galleryId }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      const canceled = controller.signal.aborted || /中断|abort/i.test(msg)
      return { ok: false, error: canceled ? '已取消' : msg, canceled }
    } finally {
      inflightControllers.delete(clientJobId)
      // Best-effort cleanup of the staged reference file. Failure is harmless —
      // the OS temp sweep will catch it later.
      if (referenceImagePath) {
        try { fs.unlinkSync(referenceImagePath) } catch { /* ignore */ }
      }
    }
  })

  ipcMain.handle(IPC.VIDEO_CANCEL, (_e, args: { clientJobId: string }): { ok: boolean } => {
    const controller = inflightControllers.get(args.clientJobId)
    if (!controller) return { ok: false }
    controller.abort()
    return { ok: true }
  })

  // Renderer extracts the first frame of a saved gallery video using HTML5
  // <video> + canvas (no native ffmpeg dependency), then ships the base64
  // image over here so we can persist it next to the video and update the
  // gallery row's thumbnail_path. Best-effort — failure is logged and the
  // gallery just keeps showing the icon placeholder.
  ipcMain.handle(IPC.VIDEO_SAVE_THUMBNAIL, async (_e, args: {
    galleryId: number
    base64: string
    ext?: 'jpg' | 'png' | 'webp'
  }): Promise<{ ok: boolean; thumbnailPath?: string; error?: string }> => {
    try {
      if (!args.galleryId || !args.base64) {
        return { ok: false, error: 'galleryId and base64 are required' }
      }
      const ext = args.ext === 'png' || args.ext === 'webp' ? args.ext : 'jpg'
      // Anchor the thumbnail under the SAME root the video was written to
      // (downloadVideo honors settings.dataDirectory). Hardcoding userData here
      // would orphan every thumbnail whenever the user has a custom data dir.
      const baseDir = getSettings().dataDirectory || app.getPath('userData')
      const dir = path.join(baseDir, 'gallery', 'videos', 'thumbs')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${args.galleryId}.${ext}`)
      fs.writeFileSync(file, Buffer.from(args.base64, 'base64'))
      const updated = updateGalleryThumbnail(args.galleryId, file)
      if (!updated) {
        // Row already gone — clean up the orphan we just wrote.
        try { fs.unlinkSync(file) } catch { /* ignore */ }
        return { ok: false, error: 'Gallery item no longer exists' }
      }
      return { ok: true, thumbnailPath: file }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
