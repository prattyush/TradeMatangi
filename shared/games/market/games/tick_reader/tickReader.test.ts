import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { TICK_READER, TICK_READER_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_COST } from '../../engine/costModel'
import type { WindowData } from '../../engine/series'
import '../../../games'
import View, { chartFor } from './View'
import { buildRound, scoreRound, summariseTickReader, tickReaderPlan, type RoundContext, type TickAnswer, type TickRound } from './engine'
import { clock, describeResult } from './format'

const here = dirname(fileURLToPath(import.meta.url))
// Three real windows (NIFTY on a trending minute, NIFTY on a quiet one, the Sensex), 360 one-second rows each.
const fixtures = JSON.parse(readFileSync(join(here, 'fixture.windows.json'), 'utf8')) as Array<WindowData & { name: string; decision: number; start_sec: number }>
const fixture = (name: string) => fixtures.find(f => f.name === name)!
const ctx: RoundContext = { lotSizeOf: symbol => (symbol === 'NIFTY' ? 65 : 20), cost: DEFAULT_COST, slipMult: 1 }
const L10 = paramsAt(TICK_READER_PARAMS, 10)
const spec = (f: { name: string; decision: number; symbol: string; date: string }, p = L10) => ({ id: `${f.symbol}|${f.date}|${f.decision}`, symbol: f.symbol, date: f.date, decisionSec: f.decision, lookbackSec: p.lookbackSec, holdSec: p.holdSec })

describe('Tick Reader rounds from real windows', () => {
  it('builds a round whose zero is the last price shown and whose move is the exit minus the entry', () => {
    const f = fixture('trend')
    const round = buildRound(f, spec(f), ctx)!
    const at = (second: number) => f.c[f.t.findIndex((t, i) => t <= second && (i + 1 === f.t.length || f.t[i + 1] > second))] / 100
    expect(round.base).toBeCloseTo(at(f.decision - 1), 6)
    expect(round.move).toBeCloseTo(at(f.decision + L10.holdSec - 1) - at(f.decision - 1), 6)
    expect(round.lookback.c[round.lookback.c.length - 1]).toBeCloseTo(0, 9)
    expect(round.lookback.t[0]).toBeGreaterThanOrEqual(f.decision - L10.lookbackSec); expect(Math.max(...round.lookback.t)).toBeLessThan(f.decision)
    expect(Math.min(...round.future.t)).toBeGreaterThanOrEqual(f.decision); expect(Math.max(...round.future.t)).toBeLessThan(f.decision + L10.holdSec)
    expect(round.volUnit).toBeGreaterThan(0); expect(round.edge).toBe(true); expect(Math.abs(round.move)).toBeGreaterThan(20)
    expect(round.er).toBeGreaterThanOrEqual(0); expect(round.er).toBeLessThanOrEqual(1)
  })
  it('a quiet window has no tradable edge, so skipping scores and trading does not', () => {
    const f = fixture('quiet'); const round = buildRound(f, spec(f), ctx)!
    expect(round.edge).toBe(false)
    expect(scoreRound(round, 'skip', 500)).toMatchObject({ kind: 'correct_skip', roundScore: TICK_READER.skipCredit, net: 0 })
    expect(scoreRound(round, 'long', 500).roundScore).toBeLessThan(0); expect(scoreRound(round, 'short', 500).roundScore).toBeLessThan(0)
  })
  it('the lot size and the cost multiplier come from the context (Sensex lots differ)', () => {
    const f = fixture('sensex'); const cheap = buildRound(f, spec(f), { ...ctx, slipMult: 0 })!; const dear = buildRound(f, spec(f), { ...ctx, slipMult: 1.5 })!
    expect(cheap.costPts).toBeCloseTo(40 / 20, 9); expect(dear.costPts).toBeCloseTo(40 / 20 + 1.5, 9)
    expect(dear.edgeThreshold).toBeGreaterThanOrEqual(cheap.edgeThreshold)
  })
  it('the same seed gives the same plan decisions (determinism of the round source inputs)', () => {
    const plan = tickReaderPlan(L10, ctx)
    expect(plan.rules).toEqual({ preSec: 300, postSec: L10.holdSec }); expect(plan.fetchBefore).toBe(300); expect(plan.fetchAfter).toBe(L10.holdSec)
    const a = Array.from({ length: 20 }, () => 0).map((_, i) => plan.wantNoEdge(createRng(i))), b = Array.from({ length: 20 }, () => 0).map((_, i) => plan.wantNoEdge(createRng(i)))
    expect(a).toEqual(b)
    const f = fixture('trend'); const round = buildRound(f, spec(f), ctx)!
    expect(plan.misfit(round, false)).toBeCloseTo(Math.abs(round.er - L10.targetEr), 9); expect(plan.misfit(round, true)).toBeGreaterThan(1 - 1e-9)
  })
  it('refuses data that is too thin to play', () => {
    const f = fixture('trend')
    const sparse = { ...f, t: f.t.filter((_, i) => i % 3 === 0), o: f.o.filter((_, i) => i % 3 === 0), h: f.h.filter((_, i) => i % 3 === 0), l: f.l.filter((_, i) => i % 3 === 0), c: f.c.filter((_, i) => i % 3 === 0) }
    expect(buildRound(sparse, spec(f), ctx)).toBeNull() // a third of the seconds: below the 80 % coverage rule
    expect(buildRound({ t: [], o: [], h: [], l: [], c: [] }, spec(f), ctx)).toBeNull()
    const flat = { t: f.t, o: f.t.map(() => 2_500_000), h: f.t.map(() => 2_500_000), l: f.t.map(() => 2_500_000), c: f.t.map(() => 2_500_000) }
    expect(buildRound(flat, spec(f), ctx)).toBeNull() // nothing moved in the lookback
    const noFuture = { ...f, t: f.t.filter(t => t < f.decision), o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[] }
    f.t.forEach((t, i) => { if (t < f.decision) { noFuture.o.push(f.o[i]); noFuture.h.push(f.h[i]); noFuture.l.push(f.l[i]); noFuture.c.push(f.c[i]) } })
    expect(buildRound(noFuture, spec(f), ctx)).toBeNull()
    expect(buildRound(f, { ...spec(f), decisionSec: f.decision + 1000 }, ctx)).toBeNull() // asked for seconds the window does not hold
  })
})

describe('Tick Reader scoring', () => {
  const round = (over: Partial<TickRound> = {}): TickRound => ({
    id: 'r', symbol: 'NIFTY', date: '2026-10-01', decisionSec: 40_000, lookback: { t: [], o: [], h: [], l: [], c: [] }, future: { t: [], o: [], h: [], l: [], c: [] },
    base: 25_000, lookbackSec: 90, holdSec: 35, move: 10, volUnit: 2, costPts: 1, edgeThreshold: 3, edge: true, er: 0.3, ...over,
  })
  it('a trade scores its net option points over k times the hold-scaled volUnit, clamped to one', () => {
    const volH = 2 * Math.sqrt(35 / 5)
    const small = scoreRound(round({ move: 4 }), 'long', 1000) // 4 * 0.5 - 1 = 1
    expect(small.net).toBeCloseTo(1, 9); expect(small.roundScore).toBeCloseTo(1 / (TICK_READER.k * volH), 9); expect(small.kind).toBe('trade')
    expect(scoreRound(round({ move: 100 }), 'long', 1).roundScore).toBe(1); expect(scoreRound(round({ move: 100 }), 'short', 1).roundScore).toBe(-1)
    expect(scoreRound(round({ move: -4 }), 'short', 1).net).toBeCloseTo(1, 9)
  })
  it('skips: credit when there was nothing to trade, nothing (not a penalty) when a move was missed; a timeout is a flagged skip', () => {
    expect(scoreRound(round({ edge: false }), 'skip', 1)).toMatchObject({ kind: 'correct_skip', roundScore: 0.3 })
    expect(scoreRound(round({ edge: true }), 'skip', 1)).toMatchObject({ kind: 'missed_move', roundScore: 0 })
    expect(scoreRound(round({ edge: false }), 'timeout', 5000)).toMatchObject({ kind: 'timeout_skip', roundScore: 0.3, decisionMs: 5000 })
    expect(scoreRound(round({ edge: true }), 'timeout', 5000)).toMatchObject({ kind: 'timeout_missed', roundScore: 0 })
  })
  it('the session score is 50 + 50 x the mean, as an integer in 0..100, with the stats the spec keeps', () => {
    const results = [scoreRound(round({ move: 4 }), 'long', 1000), scoreRound(round({ edge: false }), 'skip', 800), scoreRound(round({ edge: true }), 'timeout', 3000), scoreRound(round({ move: -4 }), 'long', 600)]
    const summary = summariseTickReader(results, 5)
    const mean = results.reduce((a, r) => a + r.roundScore, 0) / 4
    expect(summary.score).toBe(Math.round(50 + 50 * mean)); expect(Number.isInteger(summary.score)).toBe(true)
    expect(summary.stats).toMatchObject({ rounds: 4, trades: 2, hit_rate: 50, timeouts: 1, edge_rounds: 3, skip_precision: 50, mean_decision_ms: 800 })
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value)).toBe(true) }
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(summariseTickReader([]).score).toBe(50); expect(summariseTickReader([scoreRound(round({ move: 100 }), 'short', 1)]).score).toBe(0)
  })
})

/** Random-walk windows: 300 s of history then the hold, decision at second 300. Enough to check the scoring's shape without market data. */
function synthetic(seed: number, count: number): TickRound[] {
  const rng = createRng(seed); const out: TickRound[] = []
  for (let n = 0; n < count; n++) {
    const length = 300 + 35; const drift = (rng.next() - 0.5) * 0.12; let price = 2_500_000
    const t = Array.from({ length }, (_, i) => 40_000 + i), c: number[] = []
    for (let i = 0; i < length; i++) { price += Math.round((drift + (rng.next() - 0.5) * 0.9) * 400); c.push(price) }
    const w = { t, o: c.map((v, i) => (i ? c[i - 1] : v)), h: c.map(v => v + 20), l: c.map(v => v - 20), c }
    const r = buildRound(w, { id: `s${seed}-${n}`, symbol: 'NIFTY', date: '2026-10-01', decisionSec: 40_300, lookbackSec: 90, holdSec: 35 }, ctx)
    if (r) out.push(r)
  }
  return out
}

describe('simulated players', () => {
  const rounds = synthetic(11, 600)
  const play = (choose: (r: TickRound) => TickAnswer) => summariseTickReader(rounds.map(r => scoreRound(r, choose(r), 1000))).score
  const rng = createRng(77)
  it('a player who knows the future scores high; a coin flip stays under 50; always skipping cannot pass the skip ceiling', () => {
    const perfect = play(r => (r.edge ? (r.move > 0 ? 'long' : 'short') : 'skip'))
    const perfectAlways = play(r => (r.move > 0 ? 'long' : 'short'))
    const coin = play(() => (rng.chance(0.5) ? 'long' : 'short'))
    const skip = play(() => 'skip')
    const never = play(() => 'timeout')
    expect(rounds.length).toBeGreaterThan(500)
    expect(perfect).toBeGreaterThanOrEqual(75); expect(perfect).toBeGreaterThan(perfectAlways - 1)
    expect(coin).toBeLessThan(50); expect(coin).toBeLessThan(perfect - 25)
    expect(skip).toBeLessThanOrEqual(50 + 50 * TICK_READER.skipCredit); expect(never).toBe(skip)
  })
  it('no score is ever NaN or outside 0..100, whatever is answered', () => {
    for (const choose of [(): TickAnswer => 'long', (): TickAnswer => 'short', (): TickAnswer => 'skip', (): TickAnswer => 'timeout', (): TickAnswer => (rng.chance(0.5) ? 'long' : 'skip')]) {
      const score = play(choose); expect(Number.isFinite(score)).toBe(true); expect(score).toBeGreaterThanOrEqual(0); expect(score).toBeLessThanOrEqual(100)
    }
  })
})

describe('chart content and text', () => {
  const f = fixture('trend'); const round = buildRound(f, spec(f), ctx)!
  it('shows only the past while deciding, then reveals the hold as the replay clock runs', () => {
    const deciding = chartFor(round, 'decide', 0, null)
    expect(Math.max(...deciding.line!.map(p => p.t))).toBeLessThan(0); expect(deciding.levels).toBeUndefined(); expect(deciding.markers).toBeUndefined()
    expect(deciding.xRange).toEqual([-L10.lookbackSec, L10.holdSec + 5])
    const mid = chartFor(round, 'hold', 10, 'long')
    expect(Math.max(...mid.line!.map(p => p.t))).toBeLessThan(10); expect(Math.max(...mid.line!.map(p => p.t))).toBeGreaterThanOrEqual(0)
    expect(mid.clock).toBe(10); expect(mid.levels).toEqual([{ y: 0, label: 'entry' }]); expect(mid.markers).toEqual([{ t: 0, y: 0, kind: 'long', label: 'CE' }])
    const done = chartFor(round, 'flash', 99, 'short')
    expect(Math.max(...done.line!.map(p => p.t))).toBeGreaterThan(L10.holdSec - 6); expect(done.markers!.map(m => m.kind)).toEqual(['short', 'exit'])
    expect(chartFor(round, 'hold', 5, 'skip').markers).toBeUndefined()
  })
  it('the chart is rebased: no absolute price appears in what the player sees', () => {
    const data = chartFor(round, 'flash', 99, 'long')
    for (const candle of data.candles!) for (const v of [candle.o, candle.h, candle.l, candle.c]) expect(Math.abs(v)).toBeLessThan(round.base / 10)
    for (const p of data.line!) expect(Math.abs(p.v)).toBeLessThan(round.base / 10)
  })
  it('formats the clock and describes every result kind', () => {
    expect(clock(34_200)).toBe('09:30:00'); expect(clock(55_799)).toBe('15:29:59')
    const kinds: Array<[TickAnswer, TickRound]> = [['long', round], ['skip', { ...round, edge: false }], ['skip', round], ['timeout', { ...round, edge: false }], ['timeout', round]]
    for (const [answer, r] of kinds) { const text = describeResult(r, scoreRound(r, answer, 100)); expect(text.length).toBeGreaterThan(20); expect(text).not.toMatch(/NaN|undefined/) }
    expect(describeResult(round, scoreRound(round, 'long', 1))).toMatch(/Long \(CE\)/)
  })
})

describe('registration and the first paint', () => {
  it('is playable as a market game with six instruction lines at most and a parameter at every level', () => {
    expect(isPlayable('tick_reader')).toBe(true)
    const game = getGame('tick_reader')!
    expect(game.kind).toBe('market'); expect(game.instructions.length).toBeLessThanOrEqual(6); expect(typeof game.View).toBe('function')
    for (let level = 1; level <= 20; level++) {
      const p = paramsAt(game.paramTable, level)
      for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${level} ${key}`).toBe(true)
      if (game.kind === 'market') expect(game.roundsPerSession(level)).toBe(p.rounds)
      expect(p.decisionSec).toBeGreaterThanOrEqual(2); expect(p.holdSec).toBeGreaterThanOrEqual(15); expect(p.lookbackSec).toBeGreaterThanOrEqual(45)
    }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ lookbackSec: 180, decisionSec: 10, holdSec: 60, rounds: 15 })
    expect(paramsAt(game.paramTable, 20)).toMatchObject({ lookbackSec: 45, decisionSec: 2, holdSec: 15, rounds: 25 })
    expect(game.reducedMotionParams!({ replaySpeed: 6 }).replaySpeed).toBeCloseTo(4.2, 9)
  })
  it('starts on a loading state with the answer buttons off until a round is ready', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(TICK_READER_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data'); expect(html).toContain('games-chart-placeholder')
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3)
  })
})
