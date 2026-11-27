import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { NO_TRADE_DAY, NO_TRADE_DAY_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_COST } from '../../engine/costModel'
import type { Bars, WindowData } from '../../engine/series'
import '../../../games'
import View, { segmentChart } from './View'
import { buildSegment, clampRule, createSegmentSim, createSegmentSource, opportunity, RULE_KEYS, ruleCount, scoreSegment, segmentFetches, summariseNoTrade, type Rules, type Segment, type SegmentResult } from './engine'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixture.long.json'), 'utf8')) as Array<WindowData & { name: string; start_sec: number }>

/** A segment from a path of closes, one a second, in points from the start (R = 2 points, a trade costs 0.1 R). */
function seg(path: number[], over: Partial<Segment> = {}): Segment {
  const bars: Bars = { t: path.map((_, i) => 1000 + i), o: path.map((c, i) => (i ? path[i - 1] : 0)), h: path.map((c, i) => Math.max(c, i ? path[i - 1] : 0) + 0.05), l: path.map((c, i) => Math.min(c, i ? path[i - 1] : 0) - 0.05), c: path }
  return { id: 'seg', symbol: 'NIFTY', date: '2026-10-01', startSec: 1000, seconds: path.length, bars, base: 25_000, riskPts: 2, costR: 0.1, volUnit: 1, er: 0.2, ...over }
}
const ramp = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n)
const flat = (n: number, v = 0): number[] => Array.from({ length: n }, () => v)

describe('a trade in the simulation', () => {
  it('a long that is exited in profit makes its move in R less the cost, times the lots', () => {
    const s = seg([...flat(5), ...ramp(0, 4, 8), ...flat(10, 4)]); const sim = createSegmentSim(s, {}, { tilt: false })
    sim.advance(5); expect(sim.enter(1, 2, 5)).toMatchObject({ ok: true, violations: [], revenge: false })
    sim.advance(14); const out = sim.exit(14)!
    expect(out.how).toBe('exit'); expect(out.lots).toBe(2); expect(out.r).toBeCloseTo((4 / 2 - 0.1) * 2, 9); expect(sim.netR).toBeCloseTo(3.8, 9); expect(sim.position).toBeNull()
  })
  it('a short in profit is the mirror', () => {
    const s = seg([...flat(5), ...ramp(0, -4, 8), ...flat(10, -4)]); const sim = createSegmentSim(s, {}, { tilt: false })
    sim.advance(5); sim.enter(-1, 1, 5); sim.advance(14); expect(sim.exit(14)!.r).toBeCloseTo(2 - 0.1, 9)
  })
  it('the stop at 1 R is enforced by the game: the loss is 1 R plus the cost, per lot', () => {
    const s = seg([...flat(5), ...ramp(0, -6, 6), ...flat(10, -6)]); const sim = createSegmentSim(s, {}, { tilt: false })
    sim.advance(5); sim.enter(1, 3, 5); sim.advance(20)
    expect(sim.trades.length).toBe(1); expect(sim.trades[0]).toMatchObject({ how: 'stop', lots: 3 }); expect(sim.trades[0].r).toBeCloseTo((-1 - 0.1) * 3, 9); expect(sim.position).toBeNull()
  })
  it('cannot enter while in a position or after the segment has ended, and lots stay between 1 and 3', () => {
    const sim = createSegmentSim(seg(flat(30)), {}, { tilt: false }); sim.advance(3)
    expect(sim.enter(1, 9, 3).ok).toBe(true); expect(sim.position!.lots).toBe(3); expect(sim.enter(-1, 1, 4).ok).toBe(false); sim.exit(5)
    sim.advance(40); expect(sim.ended).toBe('time'); expect(sim.enter(1, 1, 31).ok).toBe(false)
    const two = createSegmentSim(seg(flat(30)), {}, { tilt: false }); two.advance(1); two.enter(1, 0, 1); expect(two.position!.lots).toBe(1)
  })
  it('an open trade is closed at the end of the segment', () => {
    const s = seg(flat(20)); const sim = createSegmentSim(s, {}, { tilt: false }); sim.advance(2); sim.enter(1, 1, 2); sim.advance(25)
    expect(sim.trades[0].how).toBe('end'); expect(sim.finish().tradeCount).toBe(1)
  })
})

describe('rules and violations', () => {
  const losing = (n: number): number[] => { const p: number[] = []; let v = 0; for (let i = 0; i < n; i++) { p.push(...flat(3, v), ...ramp(v, v - 3, 3)); v -= 3 } return [...p, ...flat(30, v)] }
  const lose = (sim: ReturnType<typeof createSegmentSim>, at: number, lots = 1, direction: 1 | -1 = 1) => { sim.advance(at); const e = sim.enter(direction, lots, at); sim.advance(at + 4); return e }
  it('a trade over the limit is a violation, and each one after it too', () => {
    const sim = createSegmentSim(seg(flat(100)), { maxTrades: 2 }, { tilt: false })
    for (const at of [5, 20, 35]) { sim.advance(at); sim.enter(1, 1, at); sim.advance(at + 1); sim.exit(at + 1) }
    expect(sim.trades.map(t => t.violations)).toEqual([[], [], ['max_trades']]); expect(sim.violations).toBe(1)
  })
  it('more lots than the limit is a violation; a limit of 3 allows 3', () => {
    const a = createSegmentSim(seg(flat(30)), { maxLots: 1 }, { tilt: false }); a.advance(2); expect(a.enter(1, 2, 2).violations).toEqual(['max_lots'])
    const b = createSegmentSim(seg(flat(30)), { maxLots: 3 }, { tilt: false }); b.advance(2); expect(b.enter(1, 3, 2).violations).toEqual([])
  })
  it('after the allowed number of losses in a row, the next trade is a violation, and a win resets the streak', () => {
    const s = seg(losing(4)); const sim = createSegmentSim(s, { stopAfterLosses: 2 }, { tilt: false })
    expect(lose(sim, 0 + 1).violations).toEqual([]); expect(lose(sim, 10).violations).toEqual([])
    expect(sim.trades.map(t => t.how)).toEqual(['stop', 'stop']); sim.advance(18); expect(sim.preview(1, 18).violations).toContain('after_losses')
    const win = seg([...flat(3), ...ramp(0, -3, 3), ...flat(3, -3), ...ramp(-3, 3, 3), ...flat(20, 3)]); const w = createSegmentSim(win, { stopAfterLosses: 1 }, { tilt: false })
    w.advance(1); w.enter(1, 1, 1); w.advance(5); expect(w.trades[0].how).toBe('stop'); w.advance(8); expect(w.preview(1, 8).violations).toContain('after_losses')
  })
  it('an entry inside the cooldown after a loss is a violation, a later one is not', () => {
    const s = seg([...flat(3), ...ramp(0, -4, 3), ...flat(100, -4)]); const sim = createSegmentSim(s, { cooldownSec: 30 }, { tilt: false })
    sim.advance(1); sim.enter(1, 2, 1); sim.advance(8); expect(sim.trades.length).toBe(1); const lossAt = sim.trades[0].exitSec
    expect(sim.preview(1, lossAt + 10)).toEqual({ violations: ['cooldown'], revenge: false }) // fewer lots than the loss: not a revenge trade
    expect(sim.preview(1, lossAt + 31).violations).toEqual([])
  })
  it('a revenge trade is an entry soon after a loss with the same or more lots; with a cooldown rule it counts once, as a revenge trade', () => {
    const s = seg([...flat(3), ...ramp(0, -4, 3), ...flat(100, -4)])
    const plain = createSegmentSim(s, {}, { tilt: false }); plain.advance(1); plain.enter(1, 1, 1); plain.advance(8); const at = plain.trades[0].exitSec
    expect(plain.preview(1, at + 20)).toEqual({ violations: [], revenge: true }); expect(plain.preview(1, at + 70).revenge).toBe(false); expect(plain.preview(3, at + 20).revenge).toBe(true)
    const ruled = createSegmentSim(s, { cooldownSec: 120 }, { tilt: false }); ruled.advance(1); ruled.enter(1, 2, 1); ruled.advance(8)
    expect(ruled.preview(2, at + 50)).toEqual({ violations: [], revenge: true }); expect(ruled.preview(1, at + 50)).toEqual({ violations: ['cooldown'], revenge: false })
    ruled.advance(at + 50); ruled.enter(1, 2, at + 50); expect(ruled.revenge).toBe(1); expect(ruled.violations).toBe(0)
  })
  it('hitting the loss limit ends the segment at once and closes what is open', () => {
    const s = seg(losing(3)); const sim = createSegmentSim(s, { maxLossR: 2 }, { tilt: false })
    lose(sim, 1); lose(sim, 10); sim.advance(18)
    expect(sim.netR).toBeLessThanOrEqual(-2); expect(sim.ended).toBe('loss_limit'); expect(sim.enter(1, 1, 19).ok).toBe(false); expect(sim.finish().ended).toBe('loss_limit')
  })
  it('a rule not chosen is never broken', () => {
    const sim = createSegmentSim(seg(flat(200)), {}, { tilt: false })
    for (let i = 0; i < 8; i++) { const at = 3 + i * 20; sim.advance(at); sim.enter(1, 3, at); sim.advance(at + 1); sim.exit(at + 1) }
    expect(sim.violations).toBe(0)
  })
  it('rule limits are pulled into their range and counted', () => {
    expect(clampRule('maxTrades', 99)).toBe(10); expect(clampRule('maxTrades', 0)).toBe(1); expect(clampRule('cooldownSec', 5)).toBe(10); expect(clampRule('maxLots', 2.4)).toBe(2); expect(clampRule('maxLossR', Number.NaN)).toBe(NO_TRADE_DAY.limits.maxLossR.default)
    expect(ruleCount({})).toBe(0); expect(ruleCount({ maxTrades: 3, cooldownSec: 60 })).toBe(2); expect(RULE_KEYS.length).toBe(5)
  })
})

describe('the tilt event', () => {
  it('forces a loss a quarter of the way in: it counts in R, not as a trade, and starts the cooldown and the streak', () => {
    const s = seg(flat(200)); const sim = createSegmentSim(s, { cooldownSec: 60, stopAfterLosses: 1 }, { tilt: true })
    sim.advance(40); expect(sim.forcedLoss).toBe(0); sim.advance(60)
    expect(sim.forcedLoss).toBe(-1); expect(sim.netR).toBe(-1); expect(sim.tradeCount).toBe(0); expect(sim.sinceLoss(70)).toBe(20)
    expect(sim.preview(1, 70).violations).toContain('after_losses')
    const off = createSegmentSim(s, {}, { tilt: false }); off.advance(100); expect(off.forcedLoss).toBe(0)
  })
  it('can end the segment when it reaches the loss limit', () => {
    const sim = createSegmentSim(seg(flat(200)), { maxLossR: 1 }, { tilt: true }); sim.advance(100); expect(sim.ended).toBe('loss_limit')
  })
})

describe('opportunity', () => {
  const zig = (...legs: number[]): number[] => { const p: number[] = []; let v = 0; for (const leg of legs) { p.push(...ramp(v, v + leg, 12)); v += leg } return p }
  it('is the biggest legs of the segment in R less the cost, up to the trade limit, never below 0', () => {
    const s = seg(zig(10, -6, 14, -4))
    const all = opportunity(s, 10)
    expect(all.positiveLegs).toBeGreaterThanOrEqual(3)
    const one = opportunity(s, 1), two = opportunity(s, 2)
    expect(two.r).toBeGreaterThan(one.r); expect(all.r).toBeGreaterThanOrEqual(two.r)
    expect(one.r).toBeGreaterThan(5.5); expect(one.r).toBeLessThan(7) // the biggest leg is about 14 points = 7 R, less the cost and the swing detector's lag
    expect(opportunity(seg(flat(120)), 5)).toEqual({ r: 0, positiveLegs: 0 }); expect(opportunity(seg(zig(1, -1, 1)), 5).r).toBeLessThan(NO_TRADE_DAY.quietBelowR) // only the net move of the segment, worth 0.4 R
  })
  it('costs reduce it and a bigger R makes the same legs worth less', () => {
    const p = zig(10, -10, 10)
    expect(opportunity(seg(p, { costR: 0.5 }), 5).r).toBeLessThan(opportunity(seg(p, { costR: 0.1 }), 5).r); expect(opportunity(seg(p, { riskPts: 4 }), 5).r).toBeLessThan(opportunity(seg(p, { riskPts: 2 }), 5).r)
  })
})

describe('scoring a segment', () => {
  const s = seg([...flat(3), ...ramp(0, 12, 12), ...flat(30, 12), ...ramp(12, 0, 12), ...flat(30, 0)])
  const sim = (rules: Rules, plays: Array<[number, number, 1 | -1, number]>): SegmentResult => {
    const g = createSegmentSim(s, rules, { tilt: false })
    for (const [at, lots, direction, exitAt] of plays) { g.advance(at); g.enter(direction, lots, at); g.advance(exitAt); g.exit(exitAt) }
    g.advance(s.seconds)
    return scoreSegment(s, rules, g.finish())
  }
  it('half performance (against what was available) and half discipline', () => {
    const best = sim({}, [[3, 1, 1, 15]]); const opp = opportunity(s, 5).r
    expect(best.opportunity).toBeCloseTo(opp, 9); expect(best.perf).toBeCloseTo(Math.min(1, best.netR / Math.max(opp, 0.5)), 9); expect(best.discipline).toBe(1)
    expect(best.roundScore).toBeCloseTo(0.5 * ((best.perf + 1) / 2) + 0.5, 9)
  })
  it('breaking rules and revenge trading cost 0.25 each off the discipline, which cannot go below 0', () => {
    const one = sim({ maxTrades: 1 }, [[3, 1, 1, 6], [8, 1, 1, 12]]); expect(one.violations).toBe(1); expect(one.discipline).toBeCloseTo(0.75, 9)
    const many = sim({ maxTrades: 1, maxLots: 1 }, [[3, 3, 1, 6], [8, 3, 1, 10], [12, 3, 1, 14], [16, 3, 1, 18], [20, 3, 1, 22]]); expect(many.discipline).toBe(0)
  })
  it('a quiet segment with at most one trade gets the stand-aside credit; two trades do not', () => {
    const quiet = seg(flat(120)); const run = (n: number) => { const g = createSegmentSim(quiet, {}, { tilt: false }); for (let i = 0; i < n; i++) { g.advance(3 + i * 20); g.enter(1, 1, 3 + i * 20); g.advance(4 + i * 20); g.exit(4 + i * 20) } g.advance(120); return scoreSegment(quiet, {}, g.finish()) }
    expect(run(0)).toMatchObject({ quiet: true, standAside: true, perf: 0.6 }); expect(run(1).standAside).toBe(true); expect(run(1).perf).toBeGreaterThanOrEqual(0.6); expect(run(2).standAside).toBe(false); expect(run(2).perf).toBeLessThan(0.6)
  })
  it('the round score is 0 to 1 whatever happens', () => {
    const rng = createRng(3)
    for (let n = 0; n < 100; n++) {
      const g = createSegmentSim(s, { maxTrades: rng.int(1, 4), cooldownSec: rng.int(10, 120) }, { tilt: rng.chance(0.5) })
      for (let t = 0; t < s.seconds; t += 3) { g.advance(t); if (rng.chance(0.3)) g.enter(rng.chance(0.5) ? 1 : -1, rng.int(1, 3), t); else if (rng.chance(0.3)) g.exit(t) }
      g.advance(s.seconds); const r = scoreSegment(s, {}, g.finish())
      expect(r.roundScore).toBeGreaterThanOrEqual(0); expect(r.roundScore).toBeLessThanOrEqual(1); expect(Number.isFinite(r.netR)).toBe(true)
    }
  })
})

describe('the session summary', () => {
  const res = (over: Partial<SegmentResult> = {}): SegmentResult => ({ netR: 1, tradeCount: 3, violations: 0, revenge: 0, opportunity: 4, positiveLegs: 3, perf: 0.5, discipline: 1, roundScore: 0.875, standAside: false, quiet: false, entries: 3, cleanEntries: 3, ended: 'time', rules: 1, ...over })
  it('score is 100 x the mean; stats are adherence, revenge, overtrading, net R and stand-aside accuracy', () => {
    const summary = summariseNoTrade([res(), res({ roundScore: 0.5, violations: 2, revenge: 1, cleanEntries: 1, netR: -2, tradeCount: 6, quiet: true, standAside: false, ended: 'loss_limit' }), res({ quiet: true, standAside: true, tradeCount: 0, entries: 0, cleanEntries: 0, positiveLegs: 0, roundScore: 0.8 })])
    expect(Math.abs(summary.score - (100 * (0.875 + 0.5 + 0.8)) / 3)).toBeLessThanOrEqual(0.5 + 1e-9); expect(summary.stats).toMatchObject({ segments: 3, revenge_trades: 1, violations: 2, stand_aside_accuracy: 50, loss_limit_hits: 1, mean_net_r: 0 })
    expect(summary.stats!.rule_adherence).toBeCloseTo((4 / 6) * 100, 1); expect(summary.stats!.overtrade_ratio).toBeCloseTo(9 / 7, 2)
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(summariseNoTrade([]).score).toBe(0)
  })
})

describe('building a segment', () => {
  const ctx = { lotSizeOf: () => 65, cost: DEFAULT_COST, slipMult: 1 }
  const f = fixtures[0]
  const spec = (over = {}) => ({ id: 'a', symbol: 'NIFTY', date: 'd', startSec: f.start_sec + 300, segMin: 6, stopMult: 1, ...over })
  it('is one second bars from the start price, with 1 R scaled to the minute and the cost in R', () => {
    const s = buildSegment(f, spec(), ctx)!
    expect(s.seconds).toBe(360); expect(s.bars.t.length).toBeGreaterThan(300); expect(Math.abs(s.bars.c[0])).toBeLessThan(s.volUnit * 5); expect(s.riskPts).toBeCloseTo(s.volUnit * Math.sqrt(12), 9)
    expect(s.costR).toBeGreaterThan(0); expect(s.er).toBeGreaterThanOrEqual(0); expect(s.er).toBeLessThanOrEqual(1)
    expect(buildSegment(f, spec({ stopMult: 2 }), ctx)!.riskPts).toBeCloseTo(s.riskPts * 2, 9)
  })
  it('refuses thin data and a segment that runs past the window', () => {
    expect(buildSegment({ t: [], o: [], h: [], l: [], c: [] }, spec(), ctx)).toBeNull(); expect(buildSegment(f, spec({ segMin: 25 }), ctx)).toBeNull()
  })
})

describe('fetching 15 to 25 minutes in requests of at most 900 seconds', () => {
  it('splits the history and the segment into contiguous chunks', () => {
    for (const minutes of [15, 18, 20, 22, 25]) {
      const chunks = segmentFetches(minutes); expect(chunks[0].offset).toBe(0)
      for (const c of chunks) expect(c.seconds).toBeLessThanOrEqual(900)
      chunks.forEach((c, i) => { if (i) expect(c.offset).toBe(chunks[i - 1].offset + chunks[i - 1].seconds) })
      expect(chunks.reduce((s, c) => s + c.seconds, 0)).toBe(300 + minutes * 60)
    }
    expect(segmentFetches(15).length).toBe(2); expect(segmentFetches(5).length).toBe(1)
  })
  const availability = { symbols: { NIFTY: { lot_size: 65, dates: ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'] } } }
  const data = (calls: Array<{ startSec: number; durationSec: number }> = []) => ({
    async window(q: { symbol: string; date: string; startSec: number; durationSec: number }) {
      calls.push(q); const n = q.durationSec; const t = Array.from({ length: n }, (_, i) => q.startSec + i); const c = t.map((_, i) => 2_500_000 + Math.round(Math.sin((q.startSec + i) / 50) * 4000 + i * 3))
      return { symbol: q.symbol, date: q.date, intervalSeconds: 1, startSec: q.startSec, durationSec: n, t, o: c, h: c.map(v => v + 30), l: c.map(v => v - 30), c } as WindowData
    },
  })
  it('requests the chunks in order, merges them, and returns a segment', async () => {
    const calls: Array<{ startSec: number; durationSec: number }> = []
    const next = await createSegmentSource({ rng: createRng(4), availability, data: data(calls), seen: new Set(), ctx: { lotSizeOf: () => 65, cost: DEFAULT_COST, slipMult: 1 } }).next({ segMin: 15, stopMult: 1, targetEr: 0.2, slipMult: 1 })
    expect(next.ok).toBe(true); if (!next.ok) return
    expect(calls.slice(0, 2).map(c => c.durationSec)).toEqual([900, 300]); expect(calls[1].startSec).toBe(calls[0].startSec + 900)
    expect(next.segment.seconds).toBe(900); expect(next.segment.bars.t.length).toBeGreaterThan(800)
  })
  it('keeps the candidate whose choppiness is closest to the wanted one, and says no_data when nothing works or it is cancelled', async () => {
    const used: string[] = []
    const next = await createSegmentSource({ rng: createRng(7), availability, data: data(), seen: new Set(), ctx: { lotSizeOf: () => 65, cost: DEFAULT_COST, slipMult: 1 }, onUsed: id => used.push(id) }).next({ segMin: 15, stopMult: 1, targetEr: 0.01, slipMult: 1 })
    expect(next.ok && used.length).toBe(1)
    const failing = { async window(): Promise<WindowData> { throw new Error('boom') } }
    expect(await createSegmentSource({ rng: createRng(1), availability, data: failing, seen: new Set(), ctx: { lotSizeOf: () => 65, cost: DEFAULT_COST, slipMult: 1 } }).next({ segMin: 15, stopMult: 1, targetEr: 0.2, slipMult: 1 })).toEqual({ ok: false, reason: 'no_data' })
    const c = new AbortController(); c.abort()
    expect(await createSegmentSource({ rng: createRng(1), availability, data: data(), seen: new Set(), ctx: { lotSizeOf: () => 65, cost: DEFAULT_COST, slipMult: 1 } }).next({ segMin: 15, stopMult: 1, targetEr: 0.2, slipMult: 1 }, c.signal)).toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('what is drawn', () => {
  it('shows only the seconds played, the open stop and the trades so far', () => {
    const s = seg([...flat(5), ...ramp(0, 4, 8), ...flat(30, 4)]); const sim = createSegmentSim(s, {}, { tilt: false })
    sim.advance(5); sim.enter(1, 2, 5); sim.advance(20)
    const open = segmentChart(s, sim, 20); expect(Math.max(...open.candles!.map(c => c.t))).toBeLessThan(20); expect(open.levels).toEqual([{ y: expect.any(Number), label: 'stop (1 R)', colour: '#D55E00' }]); expect(open.markers!.length).toBe(1)
    sim.exit(20); const done = segmentChart(s, sim, 40); expect(done.markers!.map(m => m.kind)).toEqual(['long', 'exit']); expect(done.levels).toBeUndefined(); expect(done.xRange).toEqual([0, s.seconds])
    expect(segmentChart(s, null, 0).candles!.length).toBeLessThanOrEqual(1)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Discipline with a parameter at every level and three segments', () => {
    expect(isPlayable('no_trade_day')).toBe(true)
    const game = getGame('no_trade_day')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('discipline'); expect(game.instructions.length).toBeLessThanOrEqual(6); if (game.kind === 'market') expect(game.roundsPerSession(1)).toBe(3)
    for (let lv = 1; lv <= 20; lv++) { const p = paramsAt(game.paramTable, lv); for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${lv} ${key}`).toBe(true); expect(p.segMin / p.playMin).toBeGreaterThan(2); expect(p.segMin / p.playMin).toBeLessThan(10) }
    expect([1, 5, 10, 15, 20].map(l => paramsAt(NO_TRADE_DAY_PARAMS, l).minRules)).toEqual([0, 1, 2, 3, 3]); expect(paramsAt(NO_TRADE_DAY_PARAMS, 10).tilt).toBe(1); expect(paramsAt(NO_TRADE_DAY_PARAMS, 9).tilt).toBe(0); expect(paramsAt(NO_TRADE_DAY_PARAMS, 11).warnings).toBe(0)
    expect(paramsAt(NO_TRADE_DAY_PARAMS, 1)).toMatchObject({ segMin: 15 }); expect(paramsAt(NO_TRADE_DAY_PARAMS, 20)).toMatchObject({ segMin: 25 })
  })
  it('first paint is loading', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(NO_TRADE_DAY_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data')
  })
})
