import { describe, expect, it } from 'vitest'
import type { RecordingMeta, RecordingSample } from '../../../shared/recordingMeta'
import { buildChapters, formatPnlPct, formatTimestamp } from './chapters'
import { buildCutPlan, mergeWindows, videoToOutputSec, type PlanTrade } from './cutPlan'
import { buildPlanTrades, contractLabel } from './tradeWindows'
import { buildMarketClock, isWallRecorded, pausedSpans, videoDurationSec, wallToVideoSec } from './videoTimeline'

const T0 = Date.UTC(2026, 10, 6, 3, 50, 0) // 09:20 IST, as a real wall time
const IST = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 6, h, m, s) / 1000 // trade-style market time

function meta(over: Partial<RecordingMeta> & { pauses?: Array<[number, number]>; seconds?: number }): RecordingMeta {
  const { pauses = [], seconds = 3000, ...rest } = over
  const events: RecordingMeta['events'] = [{ t: 'start', wallMs: T0 }]
  let pausedMs = 0
  for (const [a, b] of pauses) { events.push({ t: 'pause', wallMs: T0 + a * 1000 }, { t: 'resume', wallMs: T0 + b * 1000 }); pausedMs += (b - a) * 1000 }
  events.push({ t: 'stop', wallMs: T0 + seconds * 1000 })
  return {
    version: 1, source: 'website', videoFile: 'a.webm', wallStartMs: T0, wallStopMs: T0 + seconds * 1000,
    videoDurationMs: seconds * 1000 - pausedMs, events, sessions: [], samples: [], ...rest,
  }
}
/** A paper/real session: market time is the wall clock plus the IST offset. */
function liveSamples(seconds: number, sessionId = 's1'): RecordingSample[] {
  return Array.from({ length: seconds + 1 }, (_, t) => ({ wallMs: T0 + t * 1000, sessionId, marketTime: (T0 + t * 1000) / 1000 + 19_800 }))
}
const trade = (key: string, entry: number, exit: number | null, over: Partial<PlanTrade> = {}): PlanTrade => ({
  key, sessionId: 's1', number: Number(key.replace(/\D/g, '')) || 1, label: 'CE 24000', entryTime: entry, exitTime: exit, pnlPct: 1.5, ...over,
})

describe('videoTimeline', () => {
  it('collapses paused time out of the video clock', () => {
    const m = meta({ pauses: [[100, 160], [200, 230]] })
    expect(pausedSpans(m)).toEqual([{ startMs: T0 + 100_000, endMs: T0 + 160_000 }, { startMs: T0 + 200_000, endMs: T0 + 230_000 }])
    expect(wallToVideoSec(m, T0 + 50_000)).toBe(50)
    expect(wallToVideoSec(m, T0 + 130_000)).toBe(100) // inside a pause: held at the pause point
    expect(wallToVideoSec(m, T0 + 180_000)).toBe(120)
    expect(wallToVideoSec(m, T0 + 300_000)).toBe(210)
    expect(videoDurationSec(m)).toBe(3000 - 90)
  })
  it('treats a pause that never resumed as lasting to the stop', () => {
    const m = meta({ seconds: 100, events: [{ t: 'start', wallMs: T0 }, { t: 'pause', wallMs: T0 + 40_000 }, { t: 'stop', wallMs: T0 + 100_000 }] })
    expect(pausedSpans(m)).toEqual([{ startMs: T0 + 40_000, endMs: T0 + 100_000 }])
  })
  it('knows which wall times are in the recording', () => {
    const m = meta({ pauses: [[100, 160]], seconds: 400 })
    expect(isWallRecorded(m, T0 - 1)).toBe(false)
    expect(isWallRecorded(m, T0 + 50_000)).toBe(true)
    expect(isWallRecorded(m, T0 + 120_000)).toBe(false)
    expect(isWallRecorded(m, T0 + 401_000)).toBe(false)
  })
  it('falls back to stop - start - pauses when the duration is not stored', () => {
    expect(videoDurationSec(meta({ pauses: [[10, 20]], seconds: 100, videoDurationMs: null }))).toBe(90)
  })

  it('interpolates market time to wall time', () => {
    const clock = buildMarketClock([
      { wallMs: 0, sessionId: 'a', marketTime: 100 }, { wallMs: 10_000, sessionId: 'a', marketTime: 200 },
      { wallMs: 5_000, sessionId: 'b', marketTime: 999 },
    ], 'a')!
    expect(clock.wallAt(150)).toBe(5000)
    expect(clock.wallAt(100)).toBe(0)
    expect(clock.wallAt(200)).toBe(10_000)
    expect(clock.wallAt(99)).toBeNull()
    expect(clock.wallAt(201)).toBeNull()
    expect(buildMarketClock([], 'a')).toBeNull()
    expect(buildMarketClock([{ wallMs: 0, sessionId: 'b', marketTime: 1 }], 'a')).toBeNull()
  })
  it('finds when a stepwise clock jumped, and copes with a clock that goes backwards', () => {
    const clock = buildMarketClock([
      { wallMs: 0, sessionId: 'a', marketTime: 100 }, { wallMs: 1000, sessionId: 'a', marketTime: 100 }, { wallMs: 2000, sessionId: 'a', marketTime: 100 },
      { wallMs: 3000, sessionId: 'a', marketTime: 280 },
      { wallMs: 4000, sessionId: 'a', marketTime: 90 }, // glitch: held at 280
      { wallMs: 5000, sessionId: 'a', marketTime: 460 },
    ], 'a')!
    expect(clock.wallAt(100)).toBe(0)
    expect(clock.wallAt(280)).toBe(3000)
    expect(clock.wallAt(460)).toBe(5000)
    expect(clock.wallAt(370)).toBe(4500)
  })
})

describe('cut plan', () => {
  it('reproduces the spec example for a paper session (3-minute bars)', () => {
    const m = meta({ samples: liveSamples(3000), seconds: 3000 }) // recording 09:20 - 10:10
    const plan = buildCutPlan({
      meta: m, candleSeconds: 180,
      trades: [trade('t1', IST(9, 30), IST(9, 38)), trade('t2', IST(9, 39), IST(9, 45)), trade('t3', IST(9, 57), IST(10, 2))],
    })
    const at = (h: number, mi: number) => (h * 60 + mi - (9 * 60 + 20)) * 60
    expect(plan.windows).toEqual([
      { startSec: at(9, 27), endSec: at(9, 48), tradeKeys: ['t1', 't2'] },
      { startSec: at(9, 54), endSec: at(10, 6), tradeKeys: ['t3'] },
    ])
    expect(plan.keptDurationSec).toBe(21 * 60 + 12 * 60)
    expect(plan.videoDurationSec).toBe(3000)
    expect(plan.trades.map(t => t.status)).toEqual(['in-video', 'in-video', 'in-video'])
    expect(plan.trades[0].entrySec).toBe(at(9, 30))
    expect(plan.trades[0].outputEntrySec).toBe(3 * 60)
    expect(plan.trades[2].outputEntrySec).toBe(21 * 60 + 3 * 60)
  })

  it('keeps windows separate when there is a gap and merges ones that touch', () => {
    expect(mergeWindows([{ startSec: 0, endSec: 10, key: 'a' }, { startSec: 10, endSec: 20, key: 'b' }, { startSec: 30, endSec: 40, key: 'c' }]))
      .toEqual([{ startSec: 0, endSec: 20, tradeKeys: ['a', 'b'] }, { startSec: 30, endSec: 40, tradeKeys: ['c'] }])
  })

  it('maps a replay with a recording pause (10x speed) to the right video moments', () => {
    const base = IST(9, 15)
    const samples: RecordingSample[] = Array.from({ length: 301 }, (_, t) => ({ wallMs: T0 + t * 1000, sessionId: 's1', marketTime: base + 10 * t }))
    const m = meta({ samples, seconds: 300, pauses: [[100, 160]] })
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('t1', base + 2000, base + 2300)] })
    expect(plan.windows).toEqual([{ startSec: 120, endSec: 192, tradeKeys: ['t1'] }])
    expect(plan.trades[0].entrySec).toBe(140)
    expect(plan.trades[0].exitSec).toBe(170)
  })

  it('maps a stepwise session by when each bar appeared', () => {
    const base = IST(9, 15)
    const marketAt = (t: number) => base + Math.min(3, Math.floor(t / 60)) * 180
    const samples: RecordingSample[] = Array.from({ length: 201 }, (_, t) => ({ wallMs: T0 + t * 1000, sessionId: 's1', marketTime: marketAt(t) }))
    const plan = buildCutPlan({ meta: meta({ samples, seconds: 200 }), candleSeconds: 180, trades: [trade('t1', base + 180, base + 360)] })
    expect(plan.windows).toEqual([{ startSec: 0, endSec: 180, tradeKeys: ['t1'] }])
    expect(plan.trades[0].entrySec).toBe(60)
    expect(plan.trades[0].exitSec).toBe(120)
  })

  it('marks trades before the recording or after the session as outside the video', () => {
    const m = meta({ samples: liveSamples(600), seconds: 600 }) // 09:20 - 09:30
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('early', IST(9, 0), IST(9, 5)), trade('late', IST(11, 0), IST(11, 5)), trade('in', IST(9, 25), IST(9, 27))] })
    expect(plan.trades.map(t => t.status)).toEqual(['outside', 'outside', 'in-video'])
    expect(plan.windows).toHaveLength(1)
  })

  it('cuts a trade that straddles the end of the recording at the end', () => {
    const m = meta({ samples: liveSamples(600), seconds: 600 })
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('t1', IST(9, 27), IST(9, 40))] })
    expect(plan.windows).toEqual([{ startSec: 240, endSec: 600, tradeKeys: ['t1'] }])
  })

  it('lets an open trade run to the end of the video', () => {
    const m = meta({ samples: liveSamples(1200), seconds: 1200 })
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('t1', IST(9, 30), null)] })
    expect(plan.windows).toEqual([{ startSec: 420, endSec: 1200, tradeKeys: ['t1'] }])
  })

  it('applies the nudge and clamps to the video', () => {
    const m = meta({ samples: liveSamples(1200), seconds: 1200 })
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, nudgeSec: -5, trades: [trade('t1', IST(9, 22), IST(9, 24))] })
    expect(plan.windows[0].startSec).toBe(0)
    expect(plan.windows[0].endSec).toBe(7 * 60 - 5)
  })

  it('uses other lead and lag bar counts and a 5-minute interval', () => {
    const m = meta({ samples: liveSamples(3000), seconds: 3000 })
    const plan = buildCutPlan({ meta: m, candleSeconds: 300, leadBars: 2, lagBars: 0, trades: [trade('t1', IST(9, 40), IST(9, 50))] })
    expect(plan.windows).toEqual([{ startSec: 1200 - 600 + 0, endSec: 1800, tradeKeys: ['t1'] }])
  })

  it('reports trades of unsampled sessions as unmapped', () => {
    const m = meta({ samples: liveSamples(600, 'other'), seconds: 600 })
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('t1', IST(9, 25), IST(9, 27))] })
    expect(plan.trades[0].status).toBe('unmapped')
    expect(plan.windows).toEqual([])
  })

  it('shows an entry made during a recording pause from the window start', () => {
    const m = meta({ samples: liveSamples(1500), seconds: 1500, pauses: [[600, 900]] }) // pause 09:30 - 09:35
    const plan = buildCutPlan({ meta: m, candleSeconds: 180, trades: [trade('t1', IST(9, 32), IST(9, 44))] })
    expect(plan.trades[0].status).toBe('in-video')
    expect(plan.trades[0].entrySec).toBe(plan.windows[0].startSec)
  })

  it('maps original times to the finished video', () => {
    const w = [{ startSec: 100, endSec: 200, tradeKeys: [] }, { startSec: 400, endSec: 450, tradeKeys: [] }]
    expect(videoToOutputSec(150, w)).toBe(50)
    expect(videoToOutputSec(420, w)).toBe(120)
    expect(videoToOutputSec(50, w)).toBe(0)
    expect(videoToOutputSec(300, w)).toBe(100)
  })
})

describe('chapters', () => {
  const planFor = (trades: PlanTrade[], seconds = 3000) =>
    buildCutPlan({ meta: meta({ samples: liveSamples(seconds), seconds }), candleSeconds: 180, trades })

  it('formats timestamps', () => {
    expect(formatTimestamp(0, false)).toBe('0:00')
    expect(formatTimestamp(135, false)).toBe('2:15')
    expect(formatTimestamp(3725, true)).toBe('1:02:05')
    expect(formatTimestamp(3725, false)).toBe('62:05')
    expect(formatPnlPct(2.456)).toBe('+2.46%')
    expect(formatPnlPct(-1.1)).toBe('-1.10%')
    expect(formatPnlPct(0)).toBe('0.00%')
    expect(formatPnlPct(null)).toBe('P&L n/a')
  })

  it('lists the intro and one chapter per trade in the finished video', () => {
    const list = buildChapters(planFor([
      trade('t1', IST(9, 30), IST(9, 38), { number: 1, pnlPct: 2.4 }),
      trade('t2', IST(9, 39), IST(9, 45), { number: 2, label: 'PE 24000', pnlPct: -1.2 }),
      trade('t3', IST(9, 57), IST(10, 2), { number: 3, pnlPct: 0.8 }),
    ]))
    expect(list.text.split('\n')).toEqual([
      '0:00 Introduction',
      '2:50 Trade 1 · CE 24000 · +2.40%',
      '11:50 Trade 2 · PE 24000 · -1.20%',
      '23:50 Trade 3 · CE 24000 · +0.80%',
    ])
    expect(list.warnings).toEqual([])
  })

  it('warns when there are too few or too close chapters, and for videos with no trade', () => {
    expect(buildChapters(planFor([trade('t1', IST(9, 30), IST(9, 38))])).warnings.join(' ')).toMatch(/at least 3/)
    expect(buildChapters(planFor([trade('t1', IST(11, 30), IST(11, 38))])).warnings.join(' ')).toMatch(/No trade falls inside/)
    const close = buildChapters(planFor([trade('t1', IST(9, 30), IST(9, 31)), trade('t2', IST(9, 30), IST(9, 31), { number: 2 })]))
    expect(close.warnings.join(' ')).toMatch(/under 10s apart/)
  })

  it('marks open trades and uses hours format for long videos', () => {
    const list = buildChapters(planFor([trade('t1', IST(9, 30), null)], 3000))
    expect(list.text).toContain('(open)')
    const long = buildChapters(planFor([trade('t1', IST(9, 30), null)], 4200))
    expect(long.text.split('\n')[0]).toBe('0:00:00 Introduction')
  })
})

describe('trade windows', () => {
  const rt = (index: number, entry: number, exit: number | null, over: Record<string, unknown> = {}) => ({
    index, right: 'CE', entry_trades: [{ timestamp: entry, right: 'CE', strike: 24000 }], exit_trades: exit === null ? [] : [{ timestamp: exit }], pnl_pct: 1, ...over,
  })
  it('numbers a single session by round-trip index + 1', () => {
    const trades = buildPlanTrades([{ sessionId: 's1', roundTrips: [rt(0, 100, 200), rt(2, 300, 400)] }])
    expect(trades.map(t => [t.key, t.number, t.label, t.entryTime, t.exitTime])).toEqual([['s1#0', 1, 'CE 24000', 100, 200], ['s1#2', 3, 'CE 24000', 300, 400]])
  })
  it('numbers several sessions in entry-time order', () => {
    const trades = buildPlanTrades([
      { sessionId: 'a', roundTrips: [rt(0, 500, 600), rt(1, 900, 950)] },
      { sessionId: 'b', roundTrips: [rt(0, 100, 200)] },
    ])
    expect(trades.map(t => [t.sessionId, t.number])).toEqual([['b', 1], ['a', 2], ['a', 3]])
  })
  it('treats trips with no exit, or marked open, as open, and uses first entry and last exit', () => {
    const trades = buildPlanTrades([{ sessionId: 's', roundTrips: [
      rt(0, 100, null),
      rt(1, 200, 300, { state: 'open' }),
      { index: 2, right: 'PE', entry_trades: [{ timestamp: 700 }, { timestamp: 650, strike: 24100 }], exit_trades: [{ timestamp: 800 }, { timestamp: 900 }], pnl_pct: null },
      { index: 3, right: null, entry_trades: [], exit_trades: [] },
    ] }])
    expect(trades.map(t => t.exitTime)).toEqual([null, null, 900])
    expect(trades[2]).toMatchObject({ entryTime: 650, pnlPct: null })
  })
  it('labels equities and contracts', () => {
    expect(contractLabel({ index: 0, right: null, entry_trades: [{ timestamp: 1 }], exit_trades: [] })).toBe('EQ')
    expect(contractLabel({ index: 0, right: 'pe', entry_trades: [{ timestamp: 1, strike: 24100 }], exit_trades: [] })).toBe('PE 24100')
    expect(contractLabel({ index: 0, right: 'CE', entry_trades: [], exit_trades: [] })).toBe('CE')
  })
})
