/**
 * Timing rules for every brain game (spec 17.3). Pure helpers; the Views feed them measured numbers.
 *
 *  1. Onset is the requestAnimationFrame timestamp of the frame in which the stimulus is first painted; response time is
 *     `event.timeStamp` minus that onset. Never wall-clock time or a timer duration (a scan test enforces it).
 *  2. A trial whose display time deviated by more than 2 frames, or that saw a frame longer than 100 ms, is discarded and
 *     replaced, never scored.
 *  3. A response under 150 ms is not a valid response: an error ("too early"), excluded from RT statistics.
 *  4. No response inside the window is a lapse (a timeout).
 */
export const ANTICIPATION_MS = 150
export const LONG_FRAME_MS = 100
export const MAX_DISPLAY_DEVIATION_FRAMES = 2
/** Frame length to assume until enough frames were measured (60 Hz). */
export const DEFAULT_FRAME_MS = 1000 / 60

export const isAnticipation = (rtMs: number): boolean => rtMs < ANTICIPATION_MS

/** Median frame length from rAF timestamp deltas; ignores stalls and clamps to a sane display range (30-240 Hz). */
export function frameMsFrom(deltas: number[]): number {
  const usable = deltas.filter(delta => delta > 2 && delta < LONG_FRAME_MS).sort((a, b) => a - b)
  if (usable.length < 5) return DEFAULT_FRAME_MS
  const middle = usable[Math.floor(usable.length / 2)]
  return Math.min(1000 / 30, Math.max(1000 / 240, middle))
}

export interface TimingCheck { ok: boolean; reason?: 'long-frame' | 'display-deviation' }

/**
 * Was the trial presented as planned? `plannedDisplayMs` is `null` for a stimulus shown until answered (nothing to compare),
 * `actualDisplayMs` the measured time between onset and the frame in which it was hidden.
 */
export function checkTrialTiming(plannedDisplayMs: number | null, actualDisplayMs: number | null, frameMs: number, longestFrameMs: number): TimingCheck {
  if (longestFrameMs > LONG_FRAME_MS) return { ok: false, reason: 'long-frame' }
  if (plannedDisplayMs !== null && actualDisplayMs !== null && Math.abs(actualDisplayMs - plannedDisplayMs) > MAX_DISPLAY_DEVIATION_FRAMES * frameMs) {
    return { ok: false, reason: 'display-deviation' }
  }
  return { ok: true }
}

/** RT of an input event; both timestamps are on the same high-resolution clock. `null` when the event predates the onset. */
export function rtFromEvent(eventTimeStamp: number, onset: number): number | null {
  const rt = eventTimeStamp - onset
  return rt >= 0 ? rt : null
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function coefficientOfVariation(values: number[]): number | undefined {
  if (values.length < 2) return undefined
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return undefined
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance) / mean
}
