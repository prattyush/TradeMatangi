import type { RecordingMeta } from '../../../shared/recordingMeta'
import { buildMarketClock, isWallRecorded, videoDurationSec, wallToVideoSec } from './videoTimeline'

/** One round-trip trade to look for in the video. Times are market time (IST-as-UTC seconds). */
export interface PlanTrade {
  key: string
  sessionId: string
  /** 1-based number shown in the plan and the chapter list. */
  number: number
  /** Short contract text such as "CE 24000" or "EQ". */
  label: string
  entryTime: number
  /** Null while the trade is still open at the end of the data. */
  exitTime: number | null
  pnlPct: number | null
}

export interface CutWindow {
  startSec: number
  endSec: number
  tradeKeys: string[]
}

export type TradeStatus = 'in-video' | 'outside' | 'unmapped'

export interface PlannedTrade extends PlanTrade {
  status: TradeStatus
  /** Seconds into the original video where the entry happens (only when in the video). */
  entrySec: number | null
  exitSec: number | null
  /** Where the entry lands in the finished (cut) video. */
  outputEntrySec: number | null
}

export interface CutPlan {
  windows: CutWindow[]
  trades: PlannedTrade[]
  videoDurationSec: number
  keptDurationSec: number
}

export interface CutPlanOptions {
  meta: RecordingMeta
  trades: PlanTrade[]
  /** Candle interval in seconds; lead and lag are counted in these bars. */
  candleSeconds: number
  leadBars?: number
  lagBars?: number
  /** Shift applied to every mapped video time (corrects recorder start-up lag). */
  nudgeSec?: number
}

/**
 * Cut windows around trades.
 * A window starts `leadBars` before the bar that contains the entry and ends `lagBars` after the
 * bar that closes at or after the exit (an exit stamped exactly on a bar boundary belongs to the bar
 * that ends there). With 3-minute bars: entry 09:30 → starts 09:27; exit 09:45 → ends 09:48.
 * Overlapping or touching windows are merged. Open trades run to the end of the video.
 */
export function buildCutPlan(opts: CutPlanOptions): CutPlan {
  const { meta, candleSeconds } = opts
  const lead = opts.leadBars ?? 1
  const lag = opts.lagBars ?? 1
  const nudge = opts.nudgeSec ?? 0
  const duration = videoDurationSec(meta)
  const clamp = (sec: number) => Math.min(duration, Math.max(0, sec))
  const bar = candleSeconds > 0 ? candleSeconds : 180
  const clocks = new Map<string, ReturnType<typeof buildMarketClock>>()
  const clockOf = (sessionId: string) => {
    if (!clocks.has(sessionId)) clocks.set(sessionId, buildMarketClock(meta.samples, sessionId))
    return clocks.get(sessionId) ?? null
  }

  const planned: PlannedTrade[] = []
  const raw: Array<{ startSec: number; endSec: number; key: string }> = []

  for (const trade of opts.trades) {
    const clock = clockOf(trade.sessionId)
    const base: PlannedTrade = { ...trade, status: 'unmapped', entrySec: null, exitSec: null, outputEntrySec: null }
    if (!clock) { planned.push(base); continue }

    const startMarket = Math.floor(trade.entryTime / bar) * bar - lead * bar
    const endMarket = trade.exitTime === null ? Infinity : Math.ceil(trade.exitTime / bar) * bar + lag * bar

    // The whole window falls before the first sample or after the last one: not in this video.
    if (endMarket < clock.firstMarket || startMarket > clock.lastMarket) { planned.push({ ...base, status: 'outside' }); continue }

    // A window edge beyond the sampled range is held at the first / last sampled moment.
    const startWall = startMarket < clock.firstMarket ? clock.firstWallMs : clock.wallAt(startMarket)
    const endWall = endMarket > clock.lastMarket ? clock.lastWallMs : clock.wallAt(endMarket)
    if (startWall === null || endWall === null) { planned.push(base); continue }

    const startSec = clamp(wallToVideoSec(meta, startWall) + nudge)
    const endSec = trade.exitTime === null ? duration : clamp(wallToVideoSec(meta, endWall) + nudge)
    if (!(endSec > startSec)) { planned.push({ ...base, status: 'outside' }); continue }

    const entryWall = clock.wallAt(trade.entryTime)
    const exitWall = trade.exitTime === null ? null : clock.wallAt(trade.exitTime)
    raw.push({ startSec, endSec, key: trade.key })
    planned.push({
      ...base,
      status: 'in-video',
      // An entry made while the recording was paused is shown from the start of its window.
      entrySec: entryWall !== null && isWallRecorded(meta, entryWall) ? clamp(wallToVideoSec(meta, entryWall) + nudge) : startSec,
      exitSec: exitWall === null ? null : clamp(wallToVideoSec(meta, exitWall) + nudge),
    })
  }

  const windows = mergeWindows(raw)
  let kept = 0
  for (const w of windows) kept += w.endSec - w.startSec
  for (const t of planned) {
    if (t.status === 'in-video' && t.entrySec !== null) t.outputEntrySec = videoToOutputSec(t.entrySec, windows)
  }
  return { windows, trades: planned, videoDurationSec: duration, keptDurationSec: kept }
}

export function mergeWindows(items: Array<{ startSec: number; endSec: number; key: string }>): CutWindow[] {
  const sorted = [...items].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  const out: CutWindow[] = []
  for (const item of sorted) {
    const last = out[out.length - 1]
    if (last && item.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, item.endSec)
      last.tradeKeys.push(item.key)
    } else {
      out.push({ startSec: item.startSec, endSec: item.endSec, tradeKeys: [item.key] })
    }
  }
  return out
}

/** Position in the finished video for a time in the original (inside a window, else the next window start). */
export function videoToOutputSec(sec: number, windows: CutWindow[]): number {
  let before = 0
  for (const w of windows) {
    if (sec < w.startSec) return before
    if (sec <= w.endSec) return before + (sec - w.startSec)
    before += w.endSec - w.startSec
  }
  return before
}
