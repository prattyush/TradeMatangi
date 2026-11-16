import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { computeView } from '../../../chart/chartModel'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { SPOT_THE_TRAP, SPOT_THE_TRAP_PARAMS } from '../../config/difficulty.market'
import { breakoutTruth, detectPattern, findBreakouts, PATTERN_KINDS } from '../../engine/patterns'
import { aggregate, barsFromWindow, type WindowData } from '../../engine/series'
import '../../../games'
import View, { breakoutChart, huntChart } from './View'
import { breakoutPlan, buildBreakoutRound, buildHuntRound, huntPlan, modeOf, scoreBreakout, scoreHunt, stretchVol, summariseSpot, type BreakoutRound, type HuntRound, type SpotResult } from './engine'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(join(here, '..', '..', 'engine', 'fixture.long.json'), 'utf8')) as Array<WindowData & { name: string }>

/** A random-walk window of one second bars (integer paise), long enough for 80 bars before a breakout and the minute after. */
function walkWindow(seed: number, seconds = 900): WindowData {
  const rng = createRng(seed); const t: number[] = [], c: number[] = []
  let price = 2_500_000; let drift = 0
  for (let i = 0; i < seconds; i++) { if (i % 90 === 0) drift = (rng.next() - 0.5) * 0.8; price += Math.round((drift + (rng.next() - 0.5) * 1.6) * 100); t.push(40_000 + i); c.push(price) }
  return { symbol: 'NIFTY', date: '2026-10-01', intervalSeconds: 1, startSec: 40_000, durationSec: seconds, t, o: c.map((v, i) => (i ? c[i - 1] : v)), h: c.map(v => v + 25), l: c.map(v => v - 25), c }
}
const windows = [...fixtures, ...Array.from({ length: 30 }, (_, i) => walkWindow(i + 1))]
const spec = (id: string, bars = 40) => ({ id, symbol: 'NIFTY', date: '2026-10-01', bars })

describe('breakout rounds', () => {
  it('stop at a bar that closes beyond the level at zero, with the thresholds from the volUnit of what is shown', () => {
    let built = 0
    for (const [k, w] of windows.entries()) {
      const r = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: true, ambiguous: false }); if (!r) continue
      built += 1
      expect(r.shown.t.length).toBe(40); expect(r.after.t.length).toBe(SPOT_THE_TRAP.horizonBars)
      expect(Math.sign(r.shown.c[39])).toBe(r.direction)
      // the level (zero) is the highest high (lowest low) of the 24 bars before the breakout bar
      const before = r.direction === 1 ? r.shown.h.slice(15, 39) : r.shown.l.slice(15, 39); expect(r.direction === 1 ? Math.max(...before) : Math.min(...before)).toBeCloseTo(0, 9)
      expect(r.vol).toBe(stretchVol({ ...r.shown })); expect(r.ext).toBeCloseTo(SPOT_THE_TRAP.extMult * r.vol, 9); expect(r.ret).toBeCloseTo(SPOT_THE_TRAP.retMult * r.vol, 9)
    }
    expect(built).toBeGreaterThan(25)
  })
  it('the truth is the detector\'s own verdict on the bars after the breakout', () => {
    for (const [k, w] of windows.entries()) {
      const r = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: false, ambiguous: false }); if (!r) continue
      const five = aggregate(barsFromWindow(w), 5)
      const b = findBreakouts(five, SPOT_THE_TRAP.lookback).find(x => five.t[x.index] === r.breakoutSec)!
      expect(breakoutTruth(five, b, r.ext, r.ret, SPOT_THE_TRAP.horizonBars)).toMatchObject({ real: r.real, extendedAt: r.extendedAt, returnedAt: r.returnedAt })
    }
  })
  it('picks a REAL or a FAKE breakout as wanted when the window has both, and a near-boundary one when ambiguity is wanted', () => {
    let real = 0, fake = 0, both = 0, ambiguous = 0, clear = 0
    for (const [k, w] of windows.entries()) {
      const a = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: true, ambiguous: false }), b = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: false, ambiguous: false })
      if (a?.real) real += 1; if (b && !b.real) fake += 1; if (a?.real && b && !b.real) both += 1
      const amb = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: true, ambiguous: true }); if (amb && amb.margin <= SPOT_THE_TRAP.boundaryMargin) ambiguous += 1
      const cl = buildBreakoutRound(w, spec(`NIFTY|d|${k}`), { real: true, ambiguous: false }); if (cl && cl.margin > SPOT_THE_TRAP.boundaryMargin) clear += 1
    }
    expect(real).toBeGreaterThan(20); expect(fake).toBeGreaterThan(20); expect(both).toBeGreaterThan(15); expect(ambiguous).toBeGreaterThan(5); expect(clear).toBeGreaterThan(5)
  })
  it('is the same for the same id and refuses a window too short for the bars on screen', () => {
    expect(buildBreakoutRound(windows[3], spec('x'), { real: true, ambiguous: false })).toEqual(buildBreakoutRound(windows[3], spec('x'), { real: true, ambiguous: false }))
    expect(buildBreakoutRound(walkWindow(5, 100), spec('y', 120), { real: true, ambiguous: false })).toBeNull(); expect(buildBreakoutRound({ t: [], o: [], h: [], l: [], c: [] }, spec('z'), { real: true, ambiguous: false })).toBeNull()
  })
  it('the real share of breakouts in real-like windows is neither tiny nor huge', () => {
    const rounds = windows.map((w, k) => buildBreakoutRound(w, spec(`NIFTY|d|${k}`, 60), { real: k % 2 === 0, ambiguous: false })).filter((r): r is BreakoutRound => r !== null)
    const share = rounds.filter(r => r.real).length / rounds.length; expect(share).toBeGreaterThan(0.3); expect(share).toBeLessThan(0.7)
  })
})

describe('scoring a breakout call', () => {
  const round = buildBreakoutRound(windows[2], spec('s1'), { real: true, ambiguous: false })!
  it('1 for the right call, 0 for the wrong one or a late one', () => {
    expect(scoreBreakout(round, round.real ? 'real' : 'fake')).toMatchObject({ correct: true, roundScore: 1 }); expect(scoreBreakout(round, round.real ? 'fake' : 'real')).toMatchObject({ correct: false, roundScore: 0 }); expect(scoreBreakout(round, 'timeout')).toMatchObject({ correct: false, roundScore: 0 })
  })
})

describe('hunt rounds', () => {
  it('hold 1 to 6 true occurrences of the pattern in 60 bars, rebased to the first open, with the near misses it has', () => {
    let built = 0
    for (const [k, w] of windows.entries()) for (const pattern of PATTERN_KINDS) {
      const r = buildHuntRound(w, { id: `NIFTY|d|${k}`, symbol: 'NIFTY', date: 'd', pattern, distractors: 1 }); if (!r) continue
      built += 1
      expect(r.bars.t.length).toBe(SPOT_THE_TRAP.huntBars); expect(r.bars.o[0]).toBe(0); expect(r.truth.length).toBeGreaterThanOrEqual(1); expect(r.truth.length).toBeLessThanOrEqual(SPOT_THE_TRAP.maxOccurrences)
      expect(r.truth).toEqual(detectPattern(pattern, { ...r.bars, o: r.bars.o.map(v => v + 0) }, r.vol)); for (const i of [...r.truth, ...r.near]) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(60) }
      for (const i of r.near) for (const j of r.truth) expect(Math.abs(i - j)).toBeGreaterThan(1)
    }
    expect(built).toBeGreaterThan(80)
  })
  it('prefers a stretch with at least the wanted near misses, and falls back to the one with the most', () => {
    let more = 0, tested = 0
    for (const [k, w] of windows.entries()) {
      const none = buildHuntRound(w, { id: `NIFTY|d|${k}`, symbol: 'NIFTY', date: 'd', pattern: 'pin_bar', distractors: 0 }), many = buildHuntRound(w, { id: `NIFTY|d|${k}`, symbol: 'NIFTY', date: 'd', pattern: 'pin_bar', distractors: 3 })
      if (none && many) { tested += 1; if (many.near.length >= none.near.length) more += 1 }
    }
    expect(tested).toBeGreaterThan(15); expect(more).toBe(tested)
  })
  it('refuses a window with too few bars', () => { expect(buildHuntRound(walkWindow(2, 200), { id: 'a', symbol: 'NIFTY', date: 'd', pattern: 'engulfing', distractors: 0 })).toBeNull() })
  it('is scored by the F1 of the clicks', () => {
    const r = buildHuntRound(windows[5], { id: 'h', symbol: 'NIFTY', date: 'd', pattern: 'engulfing', distractors: 0 })!
    expect(scoreHunt(r, r.truth)).toMatchObject({ roundScore: 1, recall: 1, precision: 1 }); expect(scoreHunt(r, [])).toMatchObject({ roundScore: 0, recall: 0, clicks: 0 })
    const plusWrong = scoreHunt(r, [...r.truth, ...Array.from({ length: 60 }, (_, i) => i).filter(i => r.truth.every(t => Math.abs(t - i) > 1)).slice(0, r.truth.length)])
    expect(plusWrong.recall).toBe(1); expect(plusWrong.precision).toBe(0.5); expect(plusWrong.roundScore).toBeCloseTo(2 / 3, 9); expect(scoreHunt(r, [], true).timedOut).toBe(true)
  })
})

describe('the session summary and modes', () => {
  it('alternates breakout and hunt from level 6 only', () => {
    expect([0, 1, 2, 3, 4].map(i => modeOf(i, 0))).toEqual(['breakout', 'breakout', 'breakout', 'breakout', 'breakout']); expect([0, 1, 2, 3, 4].map(i => modeOf(i, 1))).toEqual(['breakout', 'hunt', 'breakout', 'hunt', 'breakout'])
    expect(paramsAt(SPOT_THE_TRAP_PARAMS, 5).modeB).toBe(0); expect(paramsAt(SPOT_THE_TRAP_PARAMS, 6).modeB).toBe(1)
  })
  it('score is 100 x the mean; stats are fake-out accuracy, real hesitation and per-pattern recall and precision', () => {
    const res: SpotResult[] = [
      { kind: 'breakout', verdict: 'fake', real: false, correct: true, roundScore: 1 }, { kind: 'breakout', verdict: 'fake', real: true, correct: false, roundScore: 0 }, { kind: 'breakout', verdict: 'real', real: false, correct: false, roundScore: 0 }, { kind: 'breakout', verdict: 'timeout', real: true, correct: false, roundScore: 0 },
      { kind: 'hunt', pattern: 'engulfing', precision: 0.5, recall: 1, roundScore: 2 / 3, clicks: 4, truth: 2, timedOut: false }, { kind: 'hunt', pattern: 'engulfing', precision: 1, recall: 0.5, roundScore: 2 / 3, clicks: 1, truth: 2, timedOut: true },
    ]
    const summary = summariseSpot(res)
    expect(summary.score).toBe(Math.round((100 * (1 + 0 + 0 + 0 + 2 / 3 + 2 / 3)) / 6)); expect(summary.stats).toMatchObject({ rounds: 6, breakouts: 4, hunts: 2, fake_accuracy: 50, real_hesitation: 50, timeouts: 2, recall_engulfing: 75, precision_engulfing: 75 })
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20); expect(summariseSpot([]).score).toBe(0)
  })
})

describe('the round source plans', () => {
  it('breakouts ask for a window with room for the bars on screen and the minute after, hunts for 60 bars', () => {
    expect(breakoutPlan({ ...paramsAt(SPOT_THE_TRAP_PARAMS, 20) }).fetchBefore).toBe(600); expect(breakoutPlan({ ...paramsAt(SPOT_THE_TRAP_PARAMS, 1) }).fetchBefore).toBe(300)
    expect(huntPlan(paramsAt(SPOT_THE_TRAP_PARAMS, 10)).fetchAfter).toBe(360)
  })
  it('the breakout plan asks for REAL about half the time and prefers a matching candidate', () => {
    const plan = breakoutPlan(paramsAt(SPOT_THE_TRAP_PARAMS, 10)); const rng = createRng(4); let real = 0
    for (let i = 0; i < 400; i++) if (plan.wantNoEdge(rng)) real += 1
    expect(real / 400).toBeGreaterThan(0.4); expect(real / 400).toBeLessThan(0.6)
    plan.wantNoEdge(createRng(1)); const r = buildBreakoutRound(windows[2], spec('p'), { real: true, ambiguous: false })!
    expect(plan.misfit(r, true)).toBeGreaterThanOrEqual(0)
  })
  it('the hunt pool grows with the level', () => {
    const seen = (level: number) => { const plan = huntPlan(paramsAt(SPOT_THE_TRAP_PARAMS, level)); const rng = createRng(2); const patterns = new Set<string>(); for (let i = 0; i < 200; i++) { plan.wantNoEdge(rng); const r = plan.build(windows[(i % 10) + 1], { id: `a${i}`, symbol: 'NIFTY', date: 'd', decisionSec: 0 } as never); if (r) patterns.add(r.pattern) } return patterns.size }
    expect(seen(6)).toBeLessThanOrEqual(2); expect(seen(11)).toBeLessThanOrEqual(3); expect(seen(20)).toBeGreaterThanOrEqual(3)
  })
})

describe('what is drawn', () => {
  const round = buildBreakoutRound(windows[2], spec('d1'), { real: true, ambiguous: false })!
  it('the breakout chart shows the bars up to the breakout and the level; after the call the minute that followed and the two thresholds', () => {
    const before = breakoutChart(round, false)
    expect(before.candles!.length).toBe(40); expect(before.levels).toEqual([{ y: 0, label: 'level', colour: '#F0E442' }]); expect(before.markers![0].t).toBe(39)
    const after = breakoutChart(round, true); expect(after.candles!.length).toBe(40 + SPOT_THE_TRAP.horizonBars); expect(after.levels!.length).toBe(3)
  })
  it('the hunt chart marks the clicks and, afterwards, the true occurrences and near misses; a click maps back to the bar under it', () => {
    const hunt = buildHuntRound(windows[5], { id: 'h', symbol: 'NIFTY', date: 'd', pattern: 'engulfing', distractors: 1 })!
    const live = huntChart(hunt, [3, 9], false); expect(live.markers!.map(m => m.label)).toEqual(['you', 'you']); expect(live.candles!.length).toBe(60)
    const done = huntChart(hunt, [3], true); expect(done.markers!.filter(m => m.label === 'yes').length).toBe(hunt.truth.length); expect(done.markers!.filter(m => m.label === 'near').length).toBe(hunt.near.length)
    const view = computeView(live, { width: 720, height: 320 })
    for (const i of [0, 7, 30, 59]) expect(Math.floor(view.timeAt(view.x(i + 0.5)))).toBe(i)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Attention with a parameter at every level', () => {
    expect(isPlayable('spot_the_trap')).toBe(true)
    const game = getGame('spot_the_trap')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('attention'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let lv = 1; lv <= 20; lv++) { const p = paramsAt(game.paramTable, lv); for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${lv} ${key}`).toBe(true); if (game.kind === 'market') expect(game.roundsPerSession(lv)).toBe(p.rounds) }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ decisionSec: 12, bars: 40, huntSec: 30, modeB: 0 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ decisionSec: 3, bars: 120, huntSec: 12, modeB: 1, patternPool: 4 })
  })
  it('first paint is loading with the REAL and FAKE buttons off', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(SPOT_THE_TRAP_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data'); expect((html.match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
