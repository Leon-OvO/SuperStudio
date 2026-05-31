/**
 * Single source of truth for the video-generation ETA heuristic.
 *
 * No OpenAI-compat video endpoint returns a real progress percent, so the UI
 * fakes one against an expected wall-time. Both the main process (which emits
 * `etaSeconds` on progress events) and the renderer (which shows a pre-submit
 * estimate on the Generate button and the initial job-card denominator) MUST
 * agree on this number — otherwise the progress bar jumps the instant the first
 * real event arrives. Keep this the only place that knows the multipliers.
 */

/** Multiplier × requested duration (seconds). Numbers come from observed
 *  wall-time per provider; tune as more models are hooked up. */
function multiplierFor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('sora')) return 25
  if (m.includes('pixverse')) return 14
  if (m.includes('vidu')) return 16
  if (m.includes('kling') && m.includes('std')) return 12
  if (m.includes('kling')) return 18
  return 18
}

/** Rough ETA in seconds for a model + requested clip duration. */
export function estimateVideoEta(model: string, durationSec: number): number {
  return Math.max(45, Math.round(multiplierFor(model) * Math.max(1, durationSec)))
}
