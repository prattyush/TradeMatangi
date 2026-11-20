import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { ENTRY_SNIPER, ENTRY_SNIPER_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_COST } from '../../engine/costModel'
import type { WindowData } from '../../engine/series'
import { simulateTrade } from '../../engine/tradeSim'
import '../../../games'
import View, { sniperChart } from './View'
import { buildSniperRound, buildSniperRoundFor, directionOf, scoreSniper, sniperPlan, summariseSniper, type SniperContext, type SniperRound, type SniperSpec } from './engine'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixture.long.json'), 'utf8')) as Array<WindowData & { name: string; start_sec: number }>
const fixture = (name: string) => fixtures.find(f => f.name === name)!
const ctx: SniperContext = { lotSizeOf: symbol => (symbol === 'NIFTY' ? 65 : 20), cost: DEFAULT_COST, slipMult: 1 }
const L10 = paramsAt(ENTRY_SNIPER_PARAMS, 10)
const specFor = (f: { start_sec: number; symbol: string; date: string }, over: Partial<SniperSpec> = {}): SniperSpec => ({
  id: `${f.symbol}|${f.date}|${f.start_sec + 300}`, symbol: f.symbol, date: f.date, startSec: f.start_sec + 300, windowSec: L10.windowSec, horizonSec: L10.horizonSec, stopMult: L10.stopMult, rr: L10.rr, ...over,
})

describe('Entry Sniper rounds from real windows', () => {
  it('computes the result of entering at every second and the best of them from the same bars', () => {
    const f = fixture('trend'); const spec = specFor(f)
    const round = buildSniperRound(f, spec, ctx)!
    expect(round.netByOffset.length).toBe(spec.windowSec); expect(round.direction).toBe(directionOf(spec.id))
    expect(round.stop).toBeCloseTo(spec.stopMult * round.volUnit * Math.sqrt(spec.horizonSec / 5), 9); expect(round.target).toBeCloseTo(spec.rr * round.stop, 9)
    const nets = round.netByOffset.filter((v): v is number => v !== null)
    expect(round.bestR).toBeCloseTo(Math.max(...nets), 12); expect(round.netByOffset[round.bestOffset!]).toBe(round.bestR); expect(round.trap).toBe(round.bestR < ENTRY_SNIPER.trapBelowR)
    // Re-run one entry by hand: enter at the close of second 7 on the raw bars.
    const k = 7, at = spec.startSec + k
    const raw = { t: Array.from(f.t), o: Array.from(f.o, v => v / 100), h: Array.from(f.h, v => v / 100), l: Array.from(f.l, v => v / 100), c: Array.from(f.c, v => v / 100) }
    const i = raw.t.indexOf(at)
    const out = simulateTrade(raw, { direction: round.direction, entrySec: at, entryPrice: raw.c[i], stop: round.stop, target: round.target, endSec: Math.min(spec.startSec + spec.windowSec + spec.horizonSec, at + spec.horizonSec) })
    expect(round.netByOffset[k]).toBeCloseTo(out.r - round.costR, 9)
  })

  it('is rebased: the chart data starts near zero and nothing shows the real price', () => {
    const f = fixture('trend'); const round = buildSniperRound(f, specFor(f), ctx)!
    expect(round.context.c[round.context.c.length - 1]).toBeCloseTo(0, 1); expect(Math.max(...round.path.h.map(Math.abs))).toBeLessThan(round.base / 20)
    const data = sniperChart(round, 'result', 0, null, 0, true)
    for (const c of data.candles!) expect(Math.abs(c.h)).toBeLessThan(round.base / 20)
  })

  it('costs are in R of the stop and follow the lot size and slippage multiplier', () => {
    const f = fixture('trend')
    const cheap = buildSniperRound(f, specFor(f), { ...ctx, slipMult: 0 })!, dear = buildSniperRound(f, specFor(f), { ...ctx, slipMult: 1.5 })!
    expect(dear.costR).toBeGreaterThan(cheap.costR); expect(cheap.costR).toBeCloseTo(cheap.costPts / (ENTRY_SNIPER.deltaProxy * cheap.stop), 9)
  })

  it('refuses a window with gaps or no price before it', () => {
    const f = fixture('trend')
    const sparse = { t: f.t.filter((_, i) => i % 3 === 0), o: f.o.filter((_, i) => i % 3 === 0), h: f.h.filter((_, i) => i % 3 === 0), l: f.l.filter((_, i) => i % 3 === 0), c: f.c.filter((_, i) => i % 3 === 0) }
    expect(buildSniperRound(sparse, specFor(f), ctx)).toBeNull()
    expect(buildSniperRound({ t: [], o: [], h: [], l: [], c: [] }, specFor(f), ctx)).toBeNull()
    expect(buildSniperRound(f, specFor(f, { startSec: f.start_sec - 5000 }), ctx)).toBeNull()
  })

  it('states the direction that matches what the level wants: a trap never offers an entry, any other does', () => {
    let trapsFound = 0, entriesFound = 0
    for (const f of fixtures) {
      const trapRound = buildSniperRoundFor(f, specFor(f), ctx, true)!, entryRound = buildSniperRoundFor(f, specFor(f), ctx, false)!
      expect(trapRound.bestR).toBeLessThanOrEqual(entryRound.bestR)
      const up = buildSniperRound(f, { ...specFor(f), direction: 1 }, ctx)!, down = buildSniperRound(f, { ...specFor(f), direction: -1 }, ctx)!
      expect(trapRound.bestR).toBe(Math.min(up.bestR, down.bestR)); expect(entryRound.bestR).toBe(Math.max(up.bestR, down.bestR))
      if (trapRound.trap) trapsFound += 1; if (!entryRound.trap) entriesFound += 1
    }
    expect(trapsFound + entriesFound).toBeGreaterThan(0)
  })

  it('wants a trap at the level\'s trap share and an entry otherwise', () => {
    const f = fixture('chop'); const plan = sniperPlan({ ...L10, trapShare: 1 }, ctx)
    expect(plan.rules).toEqual({ preSec: 300, postSec: L10.windowSec + L10.horizonSec })
    expect(plan.wantNoEdge(createRng(1))).toBe(true); expect(sniperPlan({ ...L10, trapShare: 0 }, ctx).wantNoEdge(createRng(1))).toBe(false)
    const round = buildSniperRound(f, specFor(f), ctx)!
    expect(plan.misfit(round, true)).toBe(round.trap ? 0 : 1); expect(plan.misfit(round, false)).toBe(round.trap ? 1 : 0)
  })
})

/** Random-walk windows (300 s of history, the window, the horizon) so the scoring can be checked over many rounds. */
function synthetic(seed: number, count: number, params = L10): SniperRound[] {
  const rng = createRng(seed); const out: SniperRound[] = []
  for (let n = 0; n < count; n++) {
    const length = 300 + params.windowSec + params.horizonSec + 10; const drift = (rng.next() - 0.5) * 0.4; let price = 2_500_000
    const t = Array.from({ length }, (_, i) => 40_000 + i), c: number[] = []
    for (let i = 0; i < length; i++) { price += Math.round((drift + (rng.next() - 0.5) * 1.6) * 100); c.push(price) }
    const w = { t, o: c.map((v, i) => (i ? c[i - 1] : v)), h: c.map(v => v + 20), l: c.map(v => v - 20), c }
    const r = buildSniperRoundFor(w, { id: `s${seed}-${n}`, symbol: 'NIFTY', date: '2026-10-01', startSec: 40_300, windowSec: params.windowSec, horizonSec: params.horizonSec, stopMult: params.stopMult, rr: params.rr }, ctx, rng.chance(params.trapShare))
    if (r) out.push(r)
  }
  return out
}

describe('scoring', () => {
  const rounds = synthetic(5, 400)
  it('entering scores R over the best entry (at least half an R), clamped; a pass scores only on a trap; a timeout is a pass', () => {
    const round = rounds.find(r => !r.trap && r.bestR > 0.6)!
    expect(scoreSniper(round, { kind: 'enter', offset: round.bestOffset! }).roundScore).toBe(1)
    const worst = round.netByOffset.reduce<number>((w, v, i) => (v !== null && v < (round.netByOffset[w] ?? Infinity) ? i : w), 0)
    expect(scoreSniper(round, { kind: 'enter', offset: worst }).roundScore).toBeCloseTo(Math.max(-1, round.netByOffset[worst]! / Math.max(round.bestR, 0.5)), 9)
    expect(scoreSniper(round, { kind: 'pass' }).roundScore).toBe(0); expect(scoreSniper(round, { kind: 'timeout' })).toMatchObject({ kind: 'timeout', roundScore: 0 })
    const trap = rounds.find(r => r.trap)!
    expect(scoreSniper(trap, { kind: 'pass' }).roundScore).toBe(ENTRY_SNIPER.passCredit); expect(scoreSniper(trap, { kind: 'timeout' }).roundScore).toBe(ENTRY_SNIPER.passCredit)
  })
  it('flags chasing (an entry in the first two seconds) and clamps an offset outside the window', () => {
    const round = rounds[0]
    expect(scoreSniper(round, { kind: 'enter', offset: 0 }).early).toBe(true); expect(scoreSniper(round, { kind: 'enter', offset: 1 }).early).toBe(true); expect(scoreSniper(round, { kind: 'enter', offset: 2 }).early).toBe(false)
    expect(scoreSniper(round, { kind: 'enter', offset: 999 }).offset).toBe(round.windowSec - 1)
  })
  it('the session score is 50 + 50 x the mean, in 0..100, with the stats the spec keeps', () => {
    const results = rounds.slice(0, 40).map((r, i) => scoreSniper(r, i % 4 === 0 ? { kind: 'pass' } : { kind: 'enter', offset: i % r.windowSec }))
    const summary = summariseSniper(results)
    expect(summary.score).toBe(Math.round(50 + 50 * results.reduce((s, r) => s + r.roundScore, 0) / results.length))
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20); expect(summariseSniper([]).score).toBe(50)
  })
})

describe('simulated players', () => {
  const rounds = synthetic(9, 500)
  const play = (choose: (r: SniperRound) => Parameters<typeof scoreSniper>[1]) => summariseSniper(rounds.map(r => scoreSniper(r, choose(r)))).score
  const rng = createRng(31)
  it('a player who knows the best entry and the traps scores high; one who always chases or guesses does not', () => {
    const perfect = play(r => (r.trap ? { kind: 'pass' } : { kind: 'enter', offset: r.bestOffset! }))
    const chase = play(() => ({ kind: 'enter', offset: 0 }))
    const random = play(r => ({ kind: 'enter', offset: rng.int(0, r.windowSec - 1) }))
    const pass = play(() => ({ kind: 'pass' }))
    expect(perfect).toBeGreaterThanOrEqual(80); expect(chase).toBeLessThan(perfect - 25); expect(random).toBeLessThan(perfect - 25)
    expect(pass).toBeLessThanOrEqual(50 + 50 * ENTRY_SNIPER.passCredit * 1); expect(pass).toBeLessThan(perfect)
  })
  it('no player can beat the optimal one on any round, and no score is NaN', () => {
    for (const r of rounds) {
      const best = r.trap ? ENTRY_SNIPER.passCredit : 1
      for (let k = 0; k < r.windowSec; k += 3) expect(scoreSniper(r, { kind: 'enter', offset: k }).roundScore).toBeLessThanOrEqual(1 + 1e-9)
      expect(scoreSniper(r, r.trap ? { kind: 'pass' } : { kind: 'enter', offset: r.bestOffset! }).roundScore).toBeLessThanOrEqual(best + 1e-9)
      expect(Number.isFinite(scoreSniper(r, { kind: 'pass' }).roundScore)).toBe(true)
    }
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Attention with a parameter at every level', () => {
    expect(isPlayable('entry_sniper')).toBe(true)
    const game = getGame('entry_sniper')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('attention'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let level = 1; level <= 20; level++) {
      const p = paramsAt(game.paramTable, level)
      for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${level} ${key}`).toBe(true)
      if (game.kind === 'market') expect(game.roundsPerSession(level)).toBe(p.rounds)
    }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ windowSec: 45, stopMult: 1.5, rr: 1, trapShare: 0 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ windowSec: 10, stopMult: 0.8, rr: 2, trapShare: 0.3 })
    expect(game.reducedMotionParams!({ windowSpeed: 3, replaySpeed: 8 }).windowSpeed).toBeCloseTo(2.1, 9)
  })
  it('first paint is loading with the answer buttons off', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(ENTRY_SNIPER_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data'); expect((html.match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
