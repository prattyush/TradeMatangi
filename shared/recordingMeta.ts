/**
 * Metadata saved beside every screen recording (`<video name>.rec.json`).
 *
 * The recording itself carries no clock: MediaRecorder drops paused time, and a replay's
 * market time has no fixed relation to wall time. This file records, once a second, which
 * market time each visible session was at, plus when the recording started, paused,
 * resumed and stopped. The desktop Video Maker uses it to find a trade's place in the video.
 *
 * Everything here is pure and defensive: recording metadata must never affect trading or
 * the recording itself, so `sample()` swallows errors from the clock callback.
 */

export const RECORDING_META_VERSION = 1

export type RecordingSource = 'website' | 'desktop'

/** What the app reports about one session each time it is sampled. */
export interface RecordingClockSession {
  sessionId: string
  sessionType: string
  symbol: string
  /** Trading date, YYYY-MM-DD. */
  date: string
  /** Market time as Unix seconds in the IST-as-UTC convention, or null when not known yet. */
  marketTime: number | null
  /** Candle interval the user trades on, in seconds. */
  candleSeconds?: number
  /** Replay pacing as stored on the session (wall seconds per market second). */
  replaySpeed?: number
  stepwise?: boolean
}

export type RecordingClock = () => RecordingClockSession[]

export interface RecordingEvent { t: 'start' | 'pause' | 'resume' | 'stop'; wallMs: number }
export interface RecordingSample { wallMs: number; sessionId: string; marketTime: number }
export interface RecordingSessionInfo {
  sessionId: string
  sessionType: string
  symbol: string
  date: string
  candleSeconds?: number
  replaySpeed?: number
  stepwise?: boolean
}

export interface RecordingMeta {
  version: number
  source: RecordingSource
  /** Name of the video file this describes. */
  videoFile: string
  /** Wall clock (Unix ms, true UTC) when the recorder started. */
  wallStartMs: number
  wallStopMs: number | null
  /** Length of the video: recording time minus paused time. */
  videoDurationMs: number | null
  events: RecordingEvent[]
  sessions: RecordingSessionInfo[]
  samples: RecordingSample[]
}

/** Keeps the file to a sane size if a recording runs for many hours. */
export const MAX_RECORDING_SAMPLES = 40_000

export function metaFileName(videoFile: string): string {
  return videoFile.replace(/\.webm$/i, '') + '.rec.json'
}

export class RecordingMetaRecorder {
  private readonly now: () => number
  private readonly source: RecordingSource
  private readonly videoFile: string
  private wallStartMs = 0
  private wallStopMs: number | null = null
  private paused = false
  private pausedSince = 0
  private pausedTotalMs = 0
  private started = false
  private readonly events: RecordingEvent[] = []
  private readonly sessions = new Map<string, RecordingSessionInfo>()
  private samples: RecordingSample[] = []

  constructor(opts: { now?: () => number; source: RecordingSource; videoFile: string }) {
    this.now = opts.now ?? Date.now
    this.source = opts.source
    this.videoFile = opts.videoFile
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.wallStartMs = this.now()
    this.events.push({ t: 'start', wallMs: this.wallStartMs })
  }

  pause(): void {
    if (!this.started || this.paused || this.wallStopMs !== null) return
    this.paused = true
    this.pausedSince = this.now()
    this.events.push({ t: 'pause', wallMs: this.pausedSince })
  }

  resume(): void {
    if (!this.started || !this.paused || this.wallStopMs !== null) return
    const at = this.now()
    this.paused = false
    this.pausedTotalMs += Math.max(0, at - this.pausedSince)
    this.events.push({ t: 'resume', wallMs: at })
  }

  /** Records the sessions the app currently shows. Never throws. */
  sample(read: RecordingClock | undefined): void {
    if (!this.started || this.wallStopMs !== null || !read) return
    try {
      const wallMs = this.now()
      for (const s of read() ?? []) {
        if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue
        this.rememberSession(s)
        const t = s.marketTime
        if (typeof t !== 'number' || !Number.isFinite(t)) continue
        if (this.samples.length >= MAX_RECORDING_SAMPLES) this.samples = thin(this.samples)
        this.samples.push({ wallMs, sessionId: s.sessionId, marketTime: t })
      }
    } catch {
      // The clock is best-effort; a failure only leaves a gap in the samples.
    }
  }

  stop(): void {
    if (!this.started || this.wallStopMs !== null) return
    if (this.paused) this.resume()
    this.wallStopMs = this.now()
    this.events.push({ t: 'stop', wallMs: this.wallStopMs })
  }

  toJSON(): RecordingMeta {
    const stop = this.wallStopMs
    return {
      version: RECORDING_META_VERSION,
      source: this.source,
      videoFile: this.videoFile,
      wallStartMs: this.wallStartMs,
      wallStopMs: stop,
      videoDurationMs: stop === null ? null : Math.max(0, stop - this.wallStartMs - this.pausedTotalMs),
      events: [...this.events],
      sessions: [...this.sessions.values()],
      samples: [...this.samples],
    }
  }

  private rememberSession(s: RecordingClockSession): void {
    const known = this.sessions.get(s.sessionId)
    const next: RecordingSessionInfo = {
      sessionId: s.sessionId,
      sessionType: s.sessionType,
      symbol: s.symbol,
      date: s.date,
      candleSeconds: s.candleSeconds ?? known?.candleSeconds,
      replaySpeed: s.replaySpeed ?? known?.replaySpeed,
      stepwise: s.stepwise ?? known?.stepwise,
    }
    this.sessions.set(s.sessionId, next)
  }
}

/** Drops every other sample (keeping the newest) when the cap is hit. */
function thin(samples: RecordingSample[]): RecordingSample[] {
  const kept = samples.filter((_, i) => i % 2 === 0)
  const last = samples[samples.length - 1]
  if (kept[kept.length - 1] !== last) kept.push(last)
  return kept
}
