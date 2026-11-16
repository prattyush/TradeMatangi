import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { REGIME_SWITCH, REGIME_SWITCH_PARAMS } from '../../config/difficulty.market'
import { DEFAULT_COST } from '../../engine/costModel'
import { REGIMES, type Regime } from '../../engine/regime'
import type { WindowData } from '../../engine/series'
import type { RoundContext } from '../tick_reader/engine'
import '../../../games'
import View from './View'
import { buildSegment, nextRegime, PLAYBOOKS, rankScores, regimePlan, runLength, scoreSegment, summariseRegime, type Playbook, type Segment, type SegmentResult } from './engine'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixture.long.json'), 'utf8')) as Array<WindowData & { name: string; start_sec: number }>
const ctx: RoundContext = { lotSizeOf: s => (s === 'NIFTY' ? 65 : 20), cost: DEFAULT_COST, slipMult: 1 }
const L10 = paramsAt(REGIME_SWITCH_PARAMS, 10)
const spec = (f: { start_sec: number; symbol: string; date: string }, extra = 0) => ({ id: `${f.symbol}|${f.date}|${f.start_sec + 300 + extra}`, symbol: f.symbol, date: f.date, decisionSec: f.start_sec + 300 + extra, segSec: 90, holdSec: 45 })

describe('ranking', () => {
  const v = (follow: number, fade: number, aside: number) => ({ follow, fade, aside })
  it('best 1, second 0.5, worst 0', () => {
    expect(rankScores(v(5, -3, 0))).toEqual({ follow: 1, aside: 0.5, fade: 0 }); expect(rankScores(v(-2, 4, 0))).toEqual({ fade: 1, aside: 0.5, follow: 0 }); expect(rankScores(v(-2, -4, 0))).toEqual({ aside: 1, follow: 0.5, fade: 0 })
  })
  it('equal results share the places they take, so the scores always add to 1.5', () => {
    expect(rankScores(v(-1, -1, 0))).toEqual({ aside: 1, follow: 0.25, fade: 0.25 }); expect(rankScores(v(2, 2, 0))).toEqual({ follow: 0.75, fade: 0.75, aside: 0 }); expect(rankScores(v(0, 0, 0))).toEqual({ follow: 0.5, fade: 0.5, aside: 0.5 })
    for (const [a, b, c] of [[1, 2, 3], [3, 3, 1], [-1, -1, -1], [0.5, -2, 0]]) { const r = rankScores(v(a, b, c)); expect(r.follow + r.fade + r.aside).toBeCloseTo(1.5, 12) }
  })
})

describe('segments from real windows', () => {
  it('rank follow, fade and stand aside on the hold with costs, direction from the last 30 seconds', () => {
    let built = 0
    for (const f of fixtures) for (const extra of [0, 60, 150]) {
      const seg = buildSegment(f, spec(f, extra), ctx); if (!seg) continue
      built += 1
      const gross = seg.round.move * REGIME_SWITCH.deltaProxy
      expect(seg.outcomes.follow).toBeCloseTo(seg.direction * gross - seg.round.costPts, 9); expect(seg.outcomes.fade).toBeCloseTo(-seg.direction * gross - seg.round.costPts, 9); expect(seg.outcomes.aside).toBe(0)
      expect(seg.ranks[seg.best]).toBeGreaterThanOrEqual(0.5); expect(Math.max(...PLAYBOOKS.map(p => seg.outcomes[p]))).toBe(seg.outcomes[seg.best])
      const lb = seg.round.lookback; const cut = lb.t[lb.t.length - 1] - 30; const first = lb.t.findIndex(t => t >= cut)
      expect(Math.sign(lb.c[lb.c.length - 1] - lb.c[first])).toBe(seg.direction); expect(REGIMES).toContain(seg.regime.regime)
    }
    expect(built).toBeGreaterThan(2)
  })
  it('follow and fade can never both beat standing aside (costs make one of them lose)', () => {
    for (const f of fixtures) for (const extra of [0, 30, 90, 120, 180]) { const seg = buildSegment(f, spec(f, extra), ctx); if (seg) expect(Math.min(seg.outcomes.follow, seg.outcomes.fade)).toBeLessThan(0) }
  })
  it('refuses thin data and a stretch with no direction in the last 30 seconds', () => {
    const f = fixtures[0]
    const sparse = { t: f.t.filter((_, i) => i % 3 === 0), o: f.o.filter((_, i) => i % 3 === 0), h: f.h.filter((_, i) => i % 3 === 0), l: f.l.filter((_, i) => i % 3 === 0), c: f.c.filter((_, i) => i % 3 === 0) }
    expect(buildSegment(sparse, spec(f), ctx)).toBeNull(); expect(buildSegment({ t: [], o: [], h: [], l: [], c: [] }, spec(f), ctx)).toBeNull()
  })
})

const fake = (regime: Regime, best: Playbook, outcomes?: Record<Playbook, number>): Segment => {
  const o = outcomes ?? { follow: best === 'follow' ? 3 : -1, fade: best === 'fade' ? 3 : -2, aside: best === 'aside' ? 0 : -0 }
  return { round: {} as Segment['round'], regime: { regime, er: 0, netUnits: 0, spikeUnits: 0 }, direction: 1, outcomes: o, ranks: rankScores(o), best }
}

describe('scoring a segment', () => {
  it('is the rank score of the chosen playbook', () => {
    const seg = fake('range', 'fade', { follow: -3, fade: 2, aside: 0 })
    expect(scoreSegment(seg, 'fade', null)).toMatchObject({ roundScore: 1, correct: true, changed: false, perseveration: false }); expect(scoreSegment(seg, 'aside', null).roundScore).toBe(0.5); expect(scoreSegment(seg, 'follow', null)).toMatchObject({ roundScore: 0, correct: false })
  })
  it('a regime change makes repeating the old playbook, when it is no longer the best, cost 0.25', () => {
    const seg = fake('range', 'fade', { follow: -1, fade: 2, aside: 0 })
    const repeated = scoreSegment(seg, 'follow', { regime: 'trend_up', playbook: 'follow' })
    expect(repeated).toMatchObject({ changed: true, chance: true, perseveration: true, roundScore: 0 })
    const second = fake('range', 'aside', { follow: -0.5, fade: -2, aside: 0 }) // follow is second best here: 0.5
    expect(scoreSegment(second, 'follow', { regime: 'trend_up', playbook: 'follow' })).toMatchObject({ perseveration: true, roundScore: 0.25 })
    expect(scoreSegment(seg, 'aside', { regime: 'trend_up', playbook: 'follow' })).toMatchObject({ perseveration: false, roundScore: 0.5 })
  })
  it('no penalty without a change, or when the old playbook is still the best, and the score never goes below 0', () => {
    const seg = fake('trend_up', 'follow', { follow: 3, fade: -3, aside: 0 })
    expect(scoreSegment(seg, 'follow', { regime: 'trend_up', playbook: 'follow' })).toMatchObject({ changed: false, perseveration: false, roundScore: 1 })
    expect(scoreSegment(seg, 'follow', { regime: 'range', playbook: 'follow' })).toMatchObject({ changed: true, chance: false, perseveration: false, roundScore: 1 })
    const worst = fake('spike', 'fade', { follow: -3, fade: 2, aside: 0 })
    expect(scoreSegment(worst, 'follow', { regime: 'range', playbook: 'follow' }).roundScore).toBe(0)
  })
  it('a late choice scores 0 and is never perseveration', () => {
    expect(scoreSegment(fake('range', 'fade'), 'timeout', { regime: 'trend_up', playbook: 'follow' })).toMatchObject({ playbook: 'timeout', roundScore: 0, perseveration: false })
  })
})

describe('the session summary', () => {
  const results = (rows: Array<[Playbook | 'timeout', Regime, Regime | null, Playbook, boolean, number]>): SegmentResult[] => rows.map(([playbook, regime, previous, best, perseveration, roundScore]) => ({ playbook, regime, previous, changed: previous !== null && previous !== regime, best, correct: playbook === best, roundScore, perseveration, chance: perseveration || (previous !== null && previous !== regime && playbook !== best) }))
  it('score is 100 x the mean; stats are perseveration rate, switch accuracy and bias', () => {
    const rs = results([['follow', 'trend_up', null, 'follow', false, 1], ['follow', 'range', 'trend_up', 'fade', true, 0], ['fade', 'trend_down', 'range', 'fade', false, 1], ['aside', 'range', 'trend_down', 'aside', false, 1], ['timeout', 'spike', 'range', 'fade', false, 0]])
    const summary = summariseRegime(rs)
    expect(summary.score).toBe(60); expect(summary.stats).toMatchObject({ segments: 5, regime_changes: 4, timeouts: 1, follow_share: 50, fade_share: 25, aside_share: 25 })
    expect(summary.stats!.switch_accuracy).toBe(50); expect(summary.stats!.persev_rate).toBe(50)
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(summariseRegime([]).score).toBe(0)
  })
})

describe('the chain of regimes', () => {
  it('runs about changeEvery segments and the next regime is always a different one', () => {
    const rng = createRng(3)
    for (const every of [2, 3, 4]) for (let i = 0; i < 200; i++) { const n = runLength(rng, every); expect(n).toBeGreaterThanOrEqual(Math.max(1, every - 1)); expect(n).toBeLessThanOrEqual(every + 1) }
    let current: Regime | null = null; const counts: Record<string, number> = {}
    for (let i = 0; i < 2000; i++) { const next = nextRegime(rng, current); expect(next).not.toBe(current); counts[next] = (counts[next] ?? 0) + 1; current = next }
    expect(counts.spike).toBeLessThan(counts.range); expect(Object.keys(counts).length).toBe(4)
  })
  it('the plan asks for the same regime inside a run and changes after it', () => {
    const plan = regimePlan({ ...L10, changeEvery: 3 }, ctx); const rng = createRng(5)
    const asked: Regime[] = []
    const probe = (regime: Regime): Segment => fake(regime, 'follow')
    for (let i = 0; i < 40; i++) { plan.wantNoEdge(rng); asked.push(REGIMES.find(r => plan.misfit(probe(r), true) === 0)!) }
    let changes = 0; for (let i = 1; i < asked.length; i++) if (asked[i] !== asked[i - 1]) changes += 1
    expect(changes).toBeGreaterThan(7); expect(changes).toBeLessThan(25)
    const hard = regimePlan({ ...L10, changeEvery: 1 }, ctx); const quiet = regimePlan({ ...L10, changeEvery: 6 }, ctx)
    const count = (p: typeof plan) => { let c = 0, last: Regime | null = null; const r = createRng(9); for (let i = 0; i < 200; i++) { p.wantNoEdge(r); const w = REGIMES.find(x => p.misfit(probe(x), true) === 0)!; if (last && w !== last) c += 1; last = w } return c }
    expect(count(hard)).toBeGreaterThan(count(quiet) * 2)
    expect(plan.rules).toEqual({ preSec: 300, postSec: L10.holdSec })
  })
})

describe('simulated players', () => {
  /** Synthetic segments with a spread of drifts and hold outcomes. */
  function synthetic(count: number, seed: number): Segment[] {
    const rng = createRng(seed); const out: Segment[] = []
    for (let n = 0; n < count; n++) {
      const seg = 90, hold = 45; const length = 300 + seg + hold + 5; const driftA = (rng.next() - 0.5) * 0.9; const driftB = (rng.next() - 0.5) * 0.9
      let p = 2_500_000; const c: number[] = []
      for (let i = 0; i < length; i++) { p += Math.round(((i < 300 + seg ? driftA : driftB) + (rng.next() - 0.5) * 1.4) * 100); c.push(p) }
      const t = Array.from({ length }, (_, i) => 40_000 + i)
      const s = buildSegment({ t, o: c.map((v, i) => (i ? c[i - 1] : v)), h: c.map(v => v + 20), l: c.map(v => v - 20), c }, { id: `s${seed}-${n}`, symbol: 'NIFTY', date: '2026-10-01', decisionSec: 40_000 + 300 + seg, segSec: seg, holdSec: hold }, ctx)
      if (s) out.push(s)
    }
    return out
  }
  const segs = synthetic(500, 21)
  const play = (choose: (s: Segment, i: number) => Playbook) => { let prev: { regime: Regime; playbook: Playbook } | null = null; const res = segs.map((s, i) => { const p = choose(s, i); const r = scoreSegment(s, p, prev); prev = { regime: s.regime.regime, playbook: p }; return r }); return summariseRegime(res).score }
  it('the best playbook every time scores 100; fixed playbooks and guessing score about the same, far below', () => {
    expect(segs.length).toBeGreaterThan(400)
    const perfect = play(s => s.best), follow = play(() => 'follow'), fade = play(() => 'fade'), aside = play(() => 'aside'); const rng = createRng(2); const random = play(() => rng.pick(PLAYBOOKS))
    expect(perfect).toBe(100); for (const v of [follow, fade, aside, random]) { expect(v).toBeGreaterThan(30); expect(v).toBeLessThan(70) }
  })
  it('sticking to one playbook through regime changes is punished compared with the same choices without the penalty', () => {
    const noPenalty = segs.map(s => s.ranks.follow).reduce((a, b) => a + b, 0) / segs.length * 100
    expect(play(() => 'follow')).toBeLessThanOrEqual(Math.round(noPenalty))
  })
  it('no score is NaN and every round score is in 0..1', () => {
    for (const s of segs) for (const p of PLAYBOOKS) { const r = scoreSegment(s, p, { regime: 'spike', playbook: 'follow' }); expect(r.roundScore).toBeGreaterThanOrEqual(0); expect(r.roundScore).toBeLessThanOrEqual(1) }
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Flexibility with a parameter at every level', () => {
    expect(isPlayable('regime_switch')).toBe(true)
    const game = getGame('regime_switch')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('flexibility'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let lv = 1; lv <= 20; lv++) { const p = paramsAt(game.paramTable, lv); for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${lv} ${key}`).toBe(true); if (game.kind === 'market') expect(game.roundsPerSession(lv)).toBe(p.segments) }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ segSec: 120, holdSec: 60, segments: 8, changeEvery: 4, hint: 1 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ segSec: 40, holdSec: 20, segments: 16, changeEvery: 2, hint: 0 })
  })
  it('first paint is loading with the three buttons off', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(REGIME_SWITCH_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data'); expect((html.match(/disabled=""/g) ?? []).length).toBe(3)
  })
})
