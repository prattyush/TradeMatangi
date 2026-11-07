import { describe, expect, it } from 'vitest'
import type { RecordingMeta } from '../../../shared/recordingMeta'
import {
  IDLE_JOB, applyVideoEvent, buildJobRequest, cannotStartReason, computeVideoPlan, defaultCandleSeconds, descriptionPathFor, describeSession,
  formatDuration, marketClock, pairingWarning, parseRecordingMeta, startJob, suggestedOutputName,
} from './videoMakerModel'

const T0 = Date.UTC(2026, 10, 6, 3, 50, 0)
const IST = (h: number, m: number) => Date.UTC(2026, 10, 6, h, m, 0) / 1000
const meta = (over: Partial<RecordingMeta> = {}): RecordingMeta => ({
  version: 1, source: 'desktop', videoFile: 'a.webm', wallStartMs: T0, wallStopMs: T0 + 3_000_000, videoDurationMs: 3_000_000,
  events: [{ t: 'start', wallMs: T0 }, { t: 'stop', wallMs: T0 + 3_000_000 }],
  sessions: [{ sessionId: 's1', sessionType: 'paper', symbol: 'NIFTY', date: '2026-11-06', candleSeconds: 300 }],
  samples: Array.from({ length: 3001 }, (_, t) => ({ wallMs: T0 + t * 1000, sessionId: 's1', marketTime: (T0 + t * 1000) / 1000 + 19_800 })),
  ...over,
})
const trip = (index: number, entry: number, exit: number, pct = 1) => ({ index, right: 'CE', entry_trades: [{ timestamp: entry, right: 'CE', strike: 24000 }], exit_trades: [{ timestamp: exit }], pnl_pct: pct })

describe('parseRecordingMeta', () => {
  it('accepts a valid file', () => {
    const { meta: parsed, error } = parseRecordingMeta(JSON.stringify(meta()))
    expect(error).toBe('')
    expect(parsed?.sessions[0].sessionId).toBe('s1')
    expect(parsed?.source).toBe('desktop')
  })
  it('explains what is wrong', () => {
    expect(parseRecordingMeta('{nope').error).toMatch(/not valid JSON/)
    expect(parseRecordingMeta('5').error).toMatch(/not recording metadata/)
    expect(parseRecordingMeta(JSON.stringify({ version: 2 })).error).toMatch(/Unsupported/)
    expect(parseRecordingMeta(JSON.stringify({ version: 1, wallStartMs: 1 })).error).toMatch(/incomplete/)
    expect(parseRecordingMeta(JSON.stringify(meta({ sessions: [], samples: [] }))).error).toMatch(/No trading session/)
  })
  it('tolerates a recording that was never stopped cleanly', () => {
    const raw = { ...meta(), wallStopMs: null, videoDurationMs: null }
    const { meta: parsed } = parseRecordingMeta(JSON.stringify(raw))
    expect(parsed?.wallStopMs).toBeNull()
    expect(parsed?.videoDurationMs).toBeNull()
  })
})

describe('helpers', () => {
  it('describes sessions and picks the candle interval', () => {
    expect(describeSession(meta().sessions[0])).toBe('NIFTY · 2026-11-06 · Paper')
    expect(defaultCandleSeconds(meta(), ['s1'])).toBe(300)
    expect(defaultCandleSeconds(meta(), ['other'])).toBe(180)
  })
  it('warns when the video and metadata names differ', () => {
    expect(pairingWarning(meta(), 'C:\\Videos\\a.webm')).toBe('')
    expect(pairingWarning(meta(), '/home/me/b.webm')).toMatch(/saved for "a.webm"/)
    expect(pairingWarning(meta({ videoFile: '' }), 'b.webm')).toBe('')
  })
  it('formats names, times and durations', () => {
    expect(suggestedOutputName('C:\\v\\TradeMatangi_NIFTY.webm', 'cut')).toBe('TradeMatangi_NIFTY_trades.mp4')
    expect(suggestedOutputName('/v/x.webm', 'convert')).toBe('x.mp4')
    expect(descriptionPathFor('C:\\v\\x_trades.mp4')).toBe('C:\\v\\x_trades_description.txt')
    expect(marketClock(IST(9, 30))).toBe('09:30:00')
    expect(marketClock(null)).toBe('—')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})

describe('computeVideoPlan', () => {
  it('builds the plan and the chapter list from the selected sessions', () => {
    const out = computeVideoPlan({
      meta: meta(), selectedSessionIds: ['s1'], candleSeconds: 180, nudgeSec: 0,
      tripsBySession: { s1: [trip(0, IST(9, 30), IST(9, 38), 2.4), trip(1, IST(9, 39), IST(9, 45), -1), trip(2, IST(9, 57), IST(10, 2), 0.5)] },
    })
    expect(out.plan.windows.map(w => [w.startSec, w.endSec])).toEqual([[420, 1680], [2040, 2760]])
    expect(out.chapters.text.split('\n')[0]).toBe('0:00 Introduction')
    expect(out.chapters.chapters).toHaveLength(4)
  })
  it('ignores sessions that are not selected and handles a session without trades', () => {
    const out = computeVideoPlan({ meta: meta(), selectedSessionIds: [], candleSeconds: 180, nudgeSec: 0, tripsBySession: { s1: [trip(0, IST(9, 30), IST(9, 38))] } })
    expect(out.trades).toEqual([])
    expect(out.plan.windows).toEqual([])
    const none = computeVideoPlan({ meta: meta(), selectedSessionIds: ['s1'], candleSeconds: 180, nudgeSec: 0, tripsBySession: {} })
    expect(none.chapters.warnings.join(' ')).toMatch(/No trade falls inside/)
  })
})

describe('job request and start rules', () => {
  const plan = computeVideoPlan({ meta: meta(), selectedSessionIds: ['s1'], candleSeconds: 180, nudgeSec: 0, tripsBySession: { s1: [trip(0, IST(9, 30), IST(9, 38))] } }).plan
  it('sends windows only when cutting', () => {
    expect(buildJobRequest({ input: 'a.webm', output: 'b.mp4', mode: 'cut', plan, totalSec: 3000 }).windows).toEqual([{ startSec: 420, endSec: 840 + 0 }].map(() => ({ startSec: plan.windows[0].startSec, endSec: plan.windows[0].endSec })))
    expect(buildJobRequest({ input: 'a.webm', output: 'b.mp4', mode: 'convert', plan, totalSec: 3000 }).windows).toEqual([])
    expect(buildJobRequest({ input: 'a', output: 'b', mode: 'convert', plan: null, totalSec: 1 })).toMatchObject({ crf: 23, preferHardware: true, totalSec: 1 })
  })
  it('explains why Make video is unavailable', () => {
    const base = { ffmpegAvailable: true as boolean | null, hasMeta: true, mode: 'cut' as const, plan, output: 'b.mp4', running: false }
    expect(cannotStartReason(base)).toBe('')
    expect(cannotStartReason({ ...base, running: true })).toMatch(/being made/)
    expect(cannotStartReason({ ...base, ffmpegAvailable: false })).toMatch(/ffmpeg/)
    expect(cannotStartReason({ ...base, output: '' })).toMatch(/where to save/)
    expect(cannotStartReason({ ...base, hasMeta: false })).toMatch(/\.rec\.json/)
    expect(cannotStartReason({ ...base, plan: { ...plan, windows: [] } })).toMatch(/nothing to cut/)
    expect(cannotStartReason({ ...base, mode: 'convert', hasMeta: false, plan: null })).toBe('')
  })
})

describe('job events', () => {
  const ev = (over: Partial<Parameters<typeof applyVideoEvent>[1]>) => ({ jobId: 'j1', status: 'progress' as const, percent: 10, message: 'Cutting', ...over })
  it('tracks progress, never going backwards, and finishes', () => {
    let ui = startJob('j1')
    ui = applyVideoEvent(ui, ev({ percent: 40 }))
    ui = applyVideoEvent(ui, ev({ percent: 30 }))
    expect(ui).toMatchObject({ state: 'running', percent: 40 })
    ui = applyVideoEvent(ui, ev({ status: 'done', percent: 100, message: 'Finished', output: 'b.mp4', encoder: 'x264 (CPU)', keptSec: 12 }))
    expect(ui).toMatchObject({ state: 'done', percent: 100, output: 'b.mp4', keptSec: 12 })
    expect(applyVideoEvent(ui, ev({ percent: 50 }))).toBe(ui)
  })
  it('ignores events of another job and reports errors and cancels', () => {
    const ui = startJob('j1')
    expect(applyVideoEvent(ui, ev({ jobId: 'other' }))).toBe(ui)
    expect(applyVideoEvent(ui, ev({ status: 'error', message: 'disk full' }))).toMatchObject({ state: 'error', message: 'disk full' })
    expect(applyVideoEvent(ui, ev({ status: 'cancelled' }))).toMatchObject({ state: 'cancelled' })
  })
  it('accepts the first event of a job whose id was not known yet', () => {
    expect(applyVideoEvent(IDLE_JOB, ev({}))).toMatchObject({ state: 'running', jobId: 'j1' })
  })
})
