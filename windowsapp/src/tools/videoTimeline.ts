import type { RecordingMeta, RecordingSample } from '../../../shared/recordingMeta'

/**
 * Maps between three clocks:
 *   market time (IST-as-UTC seconds, what trades are stamped with),
 *   wall time (Unix ms, from the computer's clock), and
 *   video time (seconds into the file; paused spans are not in the file).
 * Inputs come from the `.rec.json` saved beside each recording.
 */

export interface Span { startMs: number; endMs: number }

/** Paused spans in wall time, from the recorded events. A pause that never resumed runs to the stop. */
export function pausedSpans(meta: Pick<RecordingMeta, 'events' | 'wallStartMs' | 'wallStopMs'>): Span[] {
  const spans: Span[] = []
  let since: number | null = null
  for (const e of meta.events) {
    if (e.t === 'pause' && since === null) since = e.wallMs
    else if (e.t === 'resume' && since !== null) { spans.push({ startMs: since, endMs: Math.max(since, e.wallMs) }); since = null }
  }
  if (since !== null) spans.push({ startMs: since, endMs: Math.max(since, meta.wallStopMs ?? since) })
  return spans
}

/** Length of the video file in seconds. Falls back to stop - start - paused when not stored. */
export function videoDurationSec(meta: RecordingMeta): number {
  if (typeof meta.videoDurationMs === 'number' && meta.videoDurationMs >= 0) return meta.videoDurationMs / 1000
  const stop = meta.wallStopMs ?? meta.samples[meta.samples.length - 1]?.wallMs ?? meta.wallStartMs
  const paused = pausedSpans(meta).reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  return Math.max(0, (stop - meta.wallStartMs - paused) / 1000)
}

/**
 * Seconds into the video for a wall time. A moment inside a pause maps to the pause point.
 * The result can be below 0 or above the duration when the wall time is outside the recording;
 * use `isWallRecorded` to tell, or clamp.
 */
export function wallToVideoSec(meta: Pick<RecordingMeta, 'events' | 'wallStartMs' | 'wallStopMs'>, wallMs: number): number {
  let pausedBefore = 0
  for (const s of pausedSpans(meta)) {
    if (wallMs <= s.startMs) break
    pausedBefore += Math.min(wallMs, s.endMs) - s.startMs
  }
  return (wallMs - meta.wallStartMs - pausedBefore) / 1000
}

/** True when the wall time is inside the recording and not inside a paused span. */
export function isWallRecorded(meta: Pick<RecordingMeta, 'events' | 'wallStartMs' | 'wallStopMs'>, wallMs: number): boolean {
  if (wallMs < meta.wallStartMs) return false
  if (meta.wallStopMs !== null && wallMs > meta.wallStopMs) return false
  return !pausedSpans(meta).some(s => wallMs > s.startMs && wallMs < s.endMs)
}

export interface MarketClock {
  /** Wall time (ms) when the session first reached `marketTime`, or null if it never did while sampled. */
  wallAt(marketTime: number): number | null
  firstMarket: number
  lastMarket: number
  firstWallMs: number
  lastWallMs: number
}

/**
 * Builds the market-time → wall-time map for one session from its samples.
 * Market time is made non-decreasing first (a repeated or backwards reading is held at the
 * highest value seen), then the map interpolates linearly between samples.
 */
export function buildMarketClock(samples: RecordingSample[], sessionId: string): MarketClock | null {
  const own = samples
    .filter(s => s.sessionId === sessionId && Number.isFinite(s.marketTime) && Number.isFinite(s.wallMs))
    .sort((a, b) => a.wallMs - b.wallMs)
  if (own.length === 0) return null
  const wall: number[] = []
  const market: number[] = []
  let high = -Infinity
  for (const s of own) {
    high = Math.max(high, s.marketTime)
    wall.push(s.wallMs)
    market.push(high)
  }
  const n = wall.length
  return {
    firstMarket: market[0],
    lastMarket: market[n - 1],
    firstWallMs: wall[0],
    lastWallMs: wall[n - 1],
    wallAt(m: number): number | null {
      if (!Number.isFinite(m) || m < market[0] || m > market[n - 1]) return null
      // First sample whose market time has reached m.
      let lo = 0
      let hi = n - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (market[mid] >= m) hi = mid
        else lo = mid + 1
      }
      if (lo === 0 || market[lo] === m) return wall[lo]
      const m0 = market[lo - 1]
      const m1 = market[lo]
      return wall[lo - 1] + ((m - m0) / (m1 - m0)) * (wall[lo] - wall[lo - 1])
    },
  }
}
