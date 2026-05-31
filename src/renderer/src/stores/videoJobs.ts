import { create } from 'zustand'
import type { VideoProgressEvent, VideoGenerateRequest } from '../../../shared/ipc-types'
import { estimateVideoEta } from '../../../shared/video-eta'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface VideoJob {
  id: string             // clientJobId
  status: JobStatus
  prompt: string
  model: string
  aspect: '9:16' | '1:1' | '16:9'
  durationSec: number
  elapsedSeconds: number
  /** Seconds the provider+model is expected to take total. Used as the denominator
   *  for the fake progress bar — there's no real percent from the API. */
  etaSeconds: number
  /** Optional preview-only URL for the staged reference image (object URL). */
  referencePreviewUrl?: string
  errorMessage?: string
  /** Set once the job is finished and the file has been saved to gallery. */
  galleryId?: number
  videoPath?: string
  createdAt: number
}

interface SubmitParams {
  prompt: string
  /** Things to avoid in the output. Sent to main as a separate field — *not*
   *  concatenated into the prompt — so providers can wire it to their actual
   *  negative_prompt input. */
  negativePrompt?: string
  /** Provider the user picked on the Video page. Forwarded to main as a
   *  one-off override; when omitted, main falls back to settings.default. */
  providerId?: string
  model: string
  aspect: '9:16' | '1:1' | '16:9'
  durationSec: number
  /** Raw image File (from <input type="file"> or DnD). Will be read as base64. */
  reference?: File | null
  /** Only meaningful when `reference` is set. Defaults to 'first' downstream. */
  frameRole?: 'first' | 'last' | 'reference'
  /** Per-model ETA hint from main; if omitted we use a conservative default
   *  and let the progress event overwrite it as soon as it arrives. */
  initialEtaSeconds?: number
  /** Reproducibility seed. Only pass when the user has locked one — otherwise
   *  leave undefined so the provider randomizes. */
  seed?: number
}

interface VideoJobsState {
  jobs: VideoJob[]                                // most recent first
  /** Monotonically increments on every state change. Pages that show "history"
   *  pulled from the gallery can subscribe to this to reload after a job lands. */
  galleryEpoch: number

  submit: (params: SubmitParams) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => void
  clearFinished: () => void

  /** Wired by the page on mount — internal to the store. */
  ingestProgress: (event: VideoProgressEvent) => void
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = reader.result as string
      // strip "data:image/png;base64," prefix — main expects raw base64
      const comma = data.indexOf(',')
      resolve(comma >= 0 ? data.slice(comma + 1) : data)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

function genId(): string {
  // Prefer the platform UUID; fall back to a timestamp+random combo for older
  // Electron builds that don't expose crypto.randomUUID in the renderer.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `vj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const useVideoJobsStore = create<VideoJobsState>((set, get) => ({
  jobs: [],
  galleryEpoch: 0,

  submit: async (params) => {
    const id = genId()
    let referenceImageBase64: string | undefined
    let referenceFileName: string | undefined
    let referencePreviewUrl: string | undefined
    if (params.reference) {
      try {
        referenceImageBase64 = await fileToBase64(params.reference)
        referenceFileName = params.reference.name
        referencePreviewUrl = URL.createObjectURL(params.reference)
      } catch (e) {
        // Treat reference-read failure as a submit failure — surface it on a
        // failed job card rather than swallowing it silently.
        set(s => ({
          jobs: [{
            id, status: 'failed', prompt: params.prompt, model: params.model,
            aspect: params.aspect, durationSec: params.durationSec,
            elapsedSeconds: 0, etaSeconds: 0,
            errorMessage: '参考图读取失败：' + (e as Error).message,
            createdAt: Date.now()
          }, ...s.jobs]
        }))
        return
      }
    }

    const job: VideoJob = {
      id,
      status: 'queued',
      prompt: params.prompt,
      model: params.model,
      aspect: params.aspect,
      durationSec: params.durationSec,
      elapsedSeconds: 0,
      etaSeconds: params.initialEtaSeconds ?? estimateVideoEta(params.model, params.durationSec),
      referencePreviewUrl,
      createdAt: Date.now()
    }
    set(s => ({ jobs: [job, ...s.jobs] }))

    const req: VideoGenerateRequest = {
      clientJobId: id,
      providerOverrideId: params.providerId,
      modelOverride: params.model,
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      referenceImageBase64,
      referenceFileName,
      frameRole: referenceImageBase64 ? (params.frameRole ?? 'first') : undefined,
      durationSec: params.durationSec,
      aspect: params.aspect,
      seed: params.seed
    }

    try {
      const res = await window.api.generateVideo(req)
      if (res.ok && res.path) {
        // Success — drop the in-memory job (the gallery now owns the artifact)
        // and bump the epoch so the page reloads its history.
        set(s => ({
          jobs: s.jobs.filter(j => j.id !== id),
          galleryEpoch: s.galleryEpoch + 1
        }))
      } else {
        const canceled = res.canceled === true
        set(s => ({
          jobs: s.jobs.map(j => j.id === id
            ? { ...j, status: canceled ? 'canceled' : 'failed', errorMessage: res.error || (canceled ? '已取消' : '生成失败') }
            : j)
        }))
      }
    } catch (e) {
      set(s => ({
        jobs: s.jobs.map(j => j.id === id
          ? { ...j, status: 'failed', errorMessage: (e as Error).message }
          : j)
      }))
    } finally {
      if (referencePreviewUrl) {
        // The preview URL stays valid until the job card is removed; if we
        // failed, leave it so the user can still see what they submitted.
        const stillThere = get().jobs.find(j => j.id === id)
        if (!stillThere) URL.revokeObjectURL(referencePreviewUrl)
      }
    }
  },

  cancel: async (id) => {
    // Optimistic: gray the card immediately even though the main-side abort
    // may take a beat to propagate through the polling loop.
    set(s => ({
      jobs: s.jobs.map(j => j.id === id && (j.status === 'queued' || j.status === 'running')
        ? { ...j, status: 'canceled', errorMessage: '已取消' }
        : j)
    }))
    try {
      await window.api.cancelVideo({ clientJobId: id })
    } catch {
      // Best-effort. The in-flight `submit` promise will also resolve with
      // canceled=true once the main-side rejection unwinds.
    }
  },

  remove: (id) => set(s => {
    const job = s.jobs.find(j => j.id === id)
    if (job?.referencePreviewUrl) URL.revokeObjectURL(job.referencePreviewUrl)
    return { jobs: s.jobs.filter(j => j.id !== id) }
  }),

  clearFinished: () => set(s => {
    for (const j of s.jobs) {
      if (j.status !== 'queued' && j.status !== 'running' && j.referencePreviewUrl) {
        URL.revokeObjectURL(j.referencePreviewUrl)
      }
    }
    return { jobs: s.jobs.filter(j => j.status === 'queued' || j.status === 'running') }
  }),

  ingestProgress: (event) => set(s => ({
    jobs: s.jobs.map(j => {
      if (j.id !== event.clientJobId) return j
      // Map main-side status to our renderer status. 'submitting' / 'queued' /
      // 'running' / 'downloading' all show as the running card; terminal
      // statuses flow through submit()'s response handler instead.
      const status: JobStatus =
        event.status === 'submitting' || event.status === 'queued' ? 'queued'
        : event.status === 'running' || event.status === 'downloading' ? 'running'
        : j.status
      return {
        ...j,
        status,
        elapsedSeconds: event.elapsedSeconds,
        etaSeconds: event.etaSeconds ?? j.etaSeconds
      }
    })
  }))
}))

/** Subscribe to main-side progress events. Call once at app bootstrap (or page
 *  mount); returns the unsubscribe function. */
export function subscribeVideoProgress(): () => void {
  return window.api.onVideoProgress((event) => {
    useVideoJobsStore.getState().ingestProgress(event)
  })
}
