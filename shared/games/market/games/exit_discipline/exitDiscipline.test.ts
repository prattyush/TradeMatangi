import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyLevelRule, paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable, levelRulesFor } from '../../../core/registry'
import { EXIT_DISCIPLINE, EXIT_DISCIPLINE_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_COST } from '../../engine/costModel'
import type { Bars, WindowData } from '../../engine/series'
import { openTrade, simulateTrade, type TradeOutcome } from '../../engine/tradeSim'
import '../../../games'
import View, { exitChart, regretLines } from './View'
import { buildExitRound, buildExitRoundFor, classify, exitPlan, fullMfePts, scoreExit, suggestedPlan, summariseExit, validatePlan, wantedClass, type ExitContext, type ExitRound } from './engine'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixture.long.json'), 'utf8')) as Array<WindowData & { name: string; start_sec: number }>
const fixture = (name: string) => fixtures.find(f => f.name === name)!
const ctx: ExitContext = { lotSizeOf: symbol => (symbol === 'NIFTY' ? 65 : 20), cost: DEFAULT_COST, slipMult: 1 }
const L1 = paramsAt(EXIT_DISCIPLINE_PARAMS, 1), L10 = paramsAt(EXIT_DISCIPLINE_PARAMS, 10)

/** A hand-made round: a long trade entered at 0, suggested stop 2, one bar a second [high, low, close]. */
function handRound(rows: Array<[number, number, number]>, over: Partial<ExitRound> = {}): ExitRound {
  const startSec = 1000
  const path: Bars = { t: rows.map((_, i) => startSec + i), o: rows.map(r => r[2]), h: rows.map(r => r[0]), l: rows.map(r => r[1]), c: rows.map(r => r[2]) }
  return { id: 'hand', symbol: 'NIFTY', date: '2026-10-01', startSec, direction: 1, suggestedStop: 2, suggestedTarget: 4, horizonSec: rows.length, costPts: 0, base: 25_000, context: { t: [], o: [], h: [], l: [], c: [] }, path, volUnit: 1, cls: 'other', ...over }
}
const run = (round: ExitRound, plan: { stop: number; target: number }, act?: (trade: ReturnType<typeof openTrade>, k: number) => void): { out: TradeOutcome; overrides: number } => {
  const trade = openTrade({ direction: round.direction, entryPrice: 0, stop: plan.stop, target: plan.target })
  let out: TradeOutcome | null = null
  for (let k = 0; k < round.path.t.length && !out; k++) { out = trade.step({ t: round.path.t[k], h: round.path.h[k], l: round.path.l[k], c: round.path.c[k] }); if (!out) { act?.(trade, k); out = trade.closed } }
  return { out: out ?? trade.expire(round.startSec + round.horizonSec - 1)!, overrides: trade.overrides }
}

describe('classifying a plan outcome', () => {
  const o = (kind: TradeOutcome['kind'], r: number, mfeR: number): TradeOutcome => ({ kind, exitSec: 1, exitPrice: 0, r, mfeR, maeR: 0 })
  it('target, straight to stop, give-back, or other', () => {
    expect(classify(o('target', 2, 2))).toBe('target')
    expect(classify(o('stop', -1, 0.2))).toBe('stop')
    expect(classify(o('stop', -1, 1.4))).toBe('giveback')
    expect(classify(o('horizon', 0.2, 1.6))).toBe('giveback')
    expect(classify(o('horizon', 1.2, 1.6))).toBe('other')
    expect(classify(o('stop', -1, 0.7))).toBe('other')
    expect(classify(o('horizon', -0.3, 0.2))).toBe('other')
  })
})

describe('Exit Discipline rounds from real windows', () => {
  const spec = (f: { start_sec: number; symbol: string; date: string }, horizonSec = 180) => ({ id: `${f.symbol}|${f.date}|${f.start_sec + 300}`, symbol: f.symbol, date: f.date, startSec: f.start_sec + 300, horizonSec, stopMult: 1.5 })
  it('builds a rebased path from the entry price with a suggested plan scaled to the horizon', () => {
    const f = fixture('trend'); const round = buildExitRound(f, spec(f), ctx)!
    expect(round.path.t[0]).toBeGreaterThanOrEqual(round.startSec); expect(Math.max(...round.path.t)).toBeLessThan(round.startSec + 180)
    expect(round.context.c[round.context.c.length - 1]).toBeCloseTo(0, 1); expect(Math.max(...round.path.h.map(Math.abs))).toBeLessThan(round.base / 20)
    expect(round.suggestedTarget).toBeCloseTo(EXIT_DISCIPLINE.rr * round.suggestedStop, 9); expect(round.suggestedStop).toBeGreaterThan(round.volUnit)
    expect(['giveback', 'target', 'stop', 'other']).toContain(round.cls)
    expect(round.costPts).toBeCloseTo(40 / 65 + 1, 9)
  })
  it('a longer horizon gives a longer path and a wider suggested stop', () => {
    const f = fixture('trend'); const short = buildExitRound(f, spec(f, 120), ctx)!, long = buildExitRound(f, spec(f, 400), ctx)!
    expect(long.path.t.length).toBeGreaterThan(short.path.t.length); expect(long.suggestedStop).toBeGreaterThan(short.suggestedStop)
  })
  it('picks the direction that gives the wanted class when either can', () => {
    for (const f of fixtures) {
      const up = buildExitRound(f, { ...spec(f), direction: 1 }, ctx)!, down = buildExitRound(f, { ...spec(f), direction: -1 }, ctx)!
      for (const wanted of ['giveback', 'target', 'stop'] as const) {
        const chosen = buildExitRoundFor(f, spec(f), ctx, wanted)!
        if (up.cls === wanted || down.cls === wanted) expect(chosen.cls).toBe(wanted)
        expect([up.direction, down.direction]).toContain(chosen.direction)
      }
    }
  })
  it('refuses thin data', () => {
    const f = fixture('trend')
    const sparse = { t: f.t.filter((_, i) => i % 3 === 0), o: f.o.filter((_, i) => i % 3 === 0), h: f.h.filter((_, i) => i % 3 === 0), l: f.l.filter((_, i) => i % 3 === 0), c: f.c.filter((_, i) => i % 3 === 0) }
    expect(buildExitRound(sparse, spec(f), ctx)).toBeNull(); expect(buildExitRound({ t: [], o: [], h: [], l: [], c: [] }, spec(f), ctx)).toBeNull()
    expect(buildExitRound(f, { ...spec(f), horizonSec: 5000 }, ctx)).toBeNull()
  })
  it('the plan asks for the spec\'s 40 / 30 / 30 mix and prefers the wanted class', () => {
    const rng = createRng(4); const counts = { giveback: 0, target: 0, stop: 0, other: 0 }
    for (let i = 0; i < 3000; i++) counts[wantedClass(rng)] += 1
    expect(counts.giveback / 3000).toBeGreaterThan(0.36); expect(counts.giveback / 3000).toBeLessThan(0.44); expect(counts.target / 3000).toBeGreaterThan(0.26); expect(counts.stop / 3000).toBeGreaterThan(0.26); expect(counts.other).toBe(0)
    const plan = exitPlan(L1, ctx); expect(plan.rules).toEqual({ preSec: 300, postSec: 180 })
    plan.wantNoEdge(createRng(1))
    const round = buildExitRound(fixture('chop'), spec(fixture('chop')), ctx)!
    expect(plan.misfit(round, false)).toBeGreaterThanOrEqual(0)
  })
})

describe('the plan the player enters', () => {
  const round = handRound([[0.5, -0.5, 0]], { suggestedStop: 2, suggestedTarget: 4 })
  it('is suggested rounded to the tick, and checked against limits that keep a very wide stop from winning', () => {
    expect(suggestedPlan({ ...round, suggestedStop: 7.3123, suggestedTarget: 14.6246 })).toEqual({ stop: 7.3, target: 14.6 })
    expect(validatePlan(round, { stop: 2, target: 4 })).toBeNull(); expect(validatePlan(round, { stop: 1, target: 4 })).toBeNull(); expect(validatePlan(round, { stop: 3, target: 18 })).toBeNull()
    expect(validatePlan(round, { stop: 0.9, target: 4 })).toMatch(/stop must be between 1\.00 and 3\.00/)
    expect(validatePlan(round, { stop: 3.1, target: 4 })).toMatch(/stop must be between/)
    expect(validatePlan(round, { stop: 2, target: 0.9 })).toMatch(/target must be between 1\.00 and 12\.00/); expect(validatePlan(round, { stop: 2, target: 13 })).toMatch(/target/)
    for (const bad of [{ stop: 0, target: 4 }, { stop: -1, target: 4 }, { stop: Number.NaN, target: 4 }, { stop: 2, target: Number.POSITIVE_INFINITY }]) expect(validatePlan(round, bad)).toMatch(/Enter a stop/)
  })
  it('is prefilled only at levels 1 to 5', () => {
    expect([1, 5].map(l => paramsAt(EXIT_DISCIPLINE_PARAMS, l).prefilled)).toEqual([1, 1]); expect([6, 20].map(l => paramsAt(EXIT_DISCIPLINE_PARAMS, l).prefilled)).toEqual([0, 0])
  })
})

describe('scoring', () => {
  // Price runs to +5 (2.5 R of a 2 point stop) and then falls to -3.
  const peak = handRound([[1, 0, 1], [3, 1, 3], [5.2, 3, 5], [4, 2, 3], [2, -3.2, -3]])
  const plan = { stop: 2, target: 4 }

  it('holding the plan: the target is hit, capture is how much of the best the plan took', () => {
    const { out, overrides } = run(peak, plan)
    const result = scoreExit(peak, plan, out, overrides)
    expect(out.kind).toBe('target'); expect(result.userR).toBeCloseTo(2, 9); expect(result.planR).toBeCloseTo(2, 9); expect(result.mfeR).toBeCloseTo(2.6, 9)
    expect(result.capture).toBeCloseTo((2 + 1) / (2.6 + 1), 9); expect(result.overrode).toBe(false); expect(result.worse).toBe(false); expect(result.roundScore).toBeCloseTo(result.capture, 9)
  })
  it('overriding and ending worse than the plan costs 0.2; ending better has no bonus', () => {
    const early = run(peak, plan, (t, k) => { if (k === 0) t.exit(0) }) // leave at +1: 0.5 R against a plan that made 2 R
    const worse = scoreExit(peak, plan, early.out, early.overrides)
    expect(worse.userR).toBeCloseTo(0.5, 9); expect(worse.overrode && worse.worse).toBe(true)
    expect(worse.roundScore).toBeCloseTo(Math.max(0, (0.5 + 1) / (2.6 + 1) - 0.2), 9)
    const crash = handRound([[0.5, -0.5, 0], [0.9, 0.2, 0.5], [0.5, -3, -2.5]])
    const fine = run(crash, plan, (t, k) => { if (k === 1) t.exit(1) }) // leaves at +0.5 and the plan would have been stopped at -1
    const better = scoreExit(crash, plan, fine.out, fine.overrides)
    expect(better.better).toBe(true); expect(better.worse).toBe(false); expect(better.roundScore).toBeCloseTo(better.capture, 9)
  })
  it('a trade that never goes into profit scores 1 unless the player did worse than the stop', () => {
    const down = handRound([[-0.2, -1, -0.8], [-1, -2.6, -2.5]])
    const stopped = run(down, plan); expect(stopped.out.kind).toBe('stop')
    expect(scoreExit(down, plan, stopped.out, 0)).toMatchObject({ capture: 1, roundScore: 1 })
    const worseThanStop: TradeOutcome = { kind: 'manual', exitSec: 1001, exitPrice: -3, r: -1.5, mfeR: 0, maeR: 1.5 }
    expect(scoreExit(down, plan, worseThanStop, 1).capture).toBe(0)
  })
  it('costs come off the player\'s R and the plan\'s R alike, in R of the stop', () => {
    const { out } = run(peak, plan); const cheap = scoreExit(peak, plan, out, 0), dear = scoreExit({ ...peak, costPts: 2 }, plan, out, 0)
    expect(cheap.userR - dear.userR).toBeCloseTo(2 / (EXIT_DISCIPLINE.deltaProxy * 2), 9); expect(cheap.planR - dear.planR).toBeCloseTo(2 / (EXIT_DISCIPLINE.deltaProxy * 2), 9)
  })
  it('the best the horizon offered is measured over the whole path, in the trade direction', () => {
    expect(fullMfePts(peak)).toBeCloseTo(5.2, 9)
    expect(fullMfePts(handRound([[0.5, -4, -3], [0.2, -6, -5]], { direction: -1 }))).toBeCloseTo(6, 9)
    expect(simulateTrade(peak.path, { direction: 1, entrySec: 999, entryPrice: 0, stop: 2, target: 4, endSec: 1100 }).kind).toBe('target')
  })
  it('a round score is always in 0..1 and capture too, whatever the player does', () => {
    const rng = createRng(8)
    for (let n = 0; n < 200; n++) {
      const rows: Array<[number, number, number]> = []; let p = 0
      for (let i = 0; i < 40; i++) { p += (rng.next() - 0.5) * 2; rows.push([p + rng.next(), p - rng.next(), p]) }
      const round = handRound(rows, { direction: rng.chance(0.5) ? 1 : -1, costPts: rng.next() * 3 })
      const stop = 1 + rng.next() * 2
      const { out, overrides } = run(round, { stop, target: stop * (0.5 + rng.next() * 5) }, (t, k) => { if (rng.chance(0.05)) { const a = rng.int(0, 2); if (a === 0) t.exit(k); else if (a === 1) t.trailToCost(); else t.lock(0.5) } })
      const r = scoreExit(round, { stop, target: stop * 2 }, out, overrides)
      expect(r.roundScore).toBeGreaterThanOrEqual(0); expect(r.roundScore).toBeLessThanOrEqual(1); expect(r.capture).toBeGreaterThanOrEqual(0); expect(r.capture).toBeLessThanOrEqual(1)
      for (const v of [r.userR, r.planR, r.mfeR]) expect(Number.isFinite(v)).toBe(true)
    }
  })
  it('summarises into 0..100 with the stats the spec keeps', () => {
    const a = run(peak, plan); const b = run(peak, plan, (t, k) => { if (k === 0) t.exit(0) })
    const summary = summariseExit([scoreExit(peak, plan, a.out, a.overrides), scoreExit(peak, plan, b.out, b.overrides)])
    const [x, y] = [scoreExit(peak, plan, a.out, a.overrides), scoreExit(peak, plan, b.out, b.overrides)]
    expect(summary.score).toBe(Math.round(100 * (x.roundScore + y.roundScore) / 2))
    expect(summary.stats).toMatchObject({ rounds: 2, override_rate: 50, override_regret_rate: 100 })
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(summariseExit([]).score).toBe(0)
  })
})

describe('what the player sees', () => {
  const round = handRound([[1, 0, 1], [3, 1, 3], [5.2, 3, 5]])
  it('the chart shows only what has happened, the live stop and target, and the exit', () => {
    const before = exitChart(round, 'plan', { shown: 0, stopPrice: null, targetPrice: null, outcome: null, startedAt: null })
    expect(before.line!.length).toBe(0); expect(before.levels).toEqual([{ y: 0, label: 'entry', colour: '#8b949e' }])
    const mid = exitChart(round, 'run', { shown: 2, stopPrice: -2, targetPrice: 4, outcome: null, startedAt: 0 })
    expect(Math.max(...mid.line!.map(p => p.t))).toBe(1); expect(mid.levels!.map(l => l.label)).toEqual(['entry', 'stop', 'target'])
    const done = exitChart(round, 'result', { shown: 3, stopPrice: 0, targetPrice: 4, outcome: { kind: 'manual', exitSec: 1002, exitPrice: 5, r: 2, mfeR: 2, maeR: 0 }, startedAt: 0 })
    expect(done.markers!.map(m => m.kind)).toEqual(['long', 'exit']); expect(done.xRange).toEqual([-60, 3])
  })
  it('the regret panel says what you did, what the plan would have done and what was there', () => {
    const { out, overrides } = run(handRound([[1, 0, 1], [3, 1, 3], [5.2, 3, 5], [4, 2, 3], [2, -3.2, -3]]), { stop: 2, target: 4 }, (t, k) => { if (k === 0) t.exit(0) })
    const lines = regretLines(scoreExit(handRound([[1, 0, 1], [3, 1, 3], [5.2, 3, 5], [4, 2, 3], [2, -3.2, -3]]), { stop: 2, target: 4 }, out, overrides))
    expect(lines[0]).toMatch(/exited by you.*Holding the plan untouched would have been \+2\.00 R.*best the window offered was \+2\.60 R/)
    expect(lines.join(' ')).toMatch(/ended worse than leaving it alone/); expect(lines.join(' ')).not.toMatch(/NaN|undefined/)
  })
})

describe('levelling', () => {
  it('this game levels at 50 and 20 because 70 is out of reach for a capture ratio; the others keep 70 and 40', () => {
    expect(levelRulesFor('exit_discipline')).toEqual({ upThreshold: 50, downThreshold: 20 }); expect(levelRulesFor('entry_sniper')).toEqual({ upThreshold: 70, downThreshold: 40 })
    let state = { level: 1, consecutiveHigh: 0, consecutiveLow: 0 }
    state = applyLevelRule(state, 55, levelRulesFor('exit_discipline')); state = applyLevelRule(state, 52, levelRulesFor('exit_discipline'))
    expect(state.level).toBe(2)
    expect(applyLevelRule({ level: 1, consecutiveHigh: 0, consecutiveLow: 0 }, 55, levelRulesFor('entry_sniper')).consecutiveHigh).toBe(0)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Reasoning with a parameter at every level', () => {
    expect(isPlayable('exit_discipline')).toBe(true)
    const game = getGame('exit_discipline')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('reasoning'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let level = 1; level <= 20; level++) {
      const p = paramsAt(game.paramTable, level)
      for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${level} ${key}`).toBe(true)
      if (game.kind === 'market') expect(game.roundsPerSession(level)).toBe(p.rounds)
    }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ horizonSec: 180, speed: 3, stopMult: 1.5, prefilled: 1 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ horizonSec: 600, speed: 12, stopMult: 0.8, prefilled: 0 })
    expect(L10.horizonSec).toBe(300)
  })
  it('first paint is the loading state', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: L1, rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data'); expect(html).toContain('games-chart-placeholder')
  })
})
