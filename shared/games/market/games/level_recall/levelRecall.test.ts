import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { LEVEL_RECALL, LEVEL_RECALL_PARAMS } from '../../config/difficulty.market'
import { computeLevels, LEVEL_KINDS, type LevelKind } from '../../engine/levels'
import { barsFromWindow, type WindowData } from '../../engine/series'
import '../../../games'
import { Ladder } from './Ladder'
import View, { studyChart } from './View'
import { buildLevelRound, createLevelSource, isSequenceRound, scoreLevels, scoreSequence, sequenceTruth, summariseLevels, withPriorDays, type LevelRound, type RoundSpec } from './engine'

/** A full session of one minute bars, 09:15 to 15:29, as the server sends it (seconds of the day, integer paise). */
function dayWindow(seed: number, start: number, symbol = 'NIFTY', date = '2026-10-01'): WindowData {
  const rng = createRng(seed); const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = []
  let price = start * 100
  for (let i = 0; i < 375; i++) {
    const open = price
    price += Math.round(((Math.sin(i / 40 + seed) * 0.4 + (rng.next() - 0.5)) * 14) * 100)
    t.push(33_300 + i * 60); o.push(open); c.push(price); h.push(Math.max(open, price) + Math.round(rng.next() * 600)); l.push(Math.min(open, price) - Math.round(rng.next() * 600))
  }
  return { symbol, date, intervalSeconds: 60, startSec: 0, durationSec: 86_400, t, o, h, l, c }
}
const spec = (over: Partial<RoundSpec> = {}): RoundSpec => ({ id: 'NIFTY|2026-10-01|40500', symbol: 'NIFTY', date: '2026-10-01', priorDate: '2026-09-30', roundSec: 40_500, mode: 'levels', levelCount: 5, distractors: 2, ...over })
const prior = dayWindow(1, 24_800, 'NIFTY', '2026-09-30'), today = dayWindow(2, 24_850)
const build = (over: Partial<RoundSpec> = {}, seed = 3) => buildLevelRound(prior, today, spec(over), createRng(seed))!

describe('building a levels round', () => {
  it('uses only bars before the round time and takes the levels from them', () => {
    const round = build()
    expect(Math.max(...round.today.t)).toBeLessThan(40_500); expect(round.today.t[0]).toBe(33_300)
    const expected = computeLevels(barsFromWindow(prior), round.today, LEVEL_RECALL.openSec, 100)!
    for (const l of round.levels) expect(l.value).toBeCloseTo(expected.values[l.kind], 9)
    expect(round.price).toBe(expected.price)
  })
  it('asks the level count, shows the distractors that are not asked, and prompts the asked ones in an order of its own', () => {
    const round = build(); const asked = round.levels.filter(l => l.asked), shown = round.levels.filter(l => !l.asked)
    expect(asked.length).toBe(5); expect(shown.length).toBeLessThanOrEqual(2); expect([...round.prompts].sort()).toEqual(asked.map(l => l.kind).sort())
    expect(new Set(round.levels.map(l => l.kind)).size).toBe(round.levels.length)
    expect(new Set(Array.from({ length: 30 }, (_, i) => build({}, i).prompts.join())).size).toBeGreaterThan(5)
  })
  it('keeps shown levels apart so each has its own place on the ladder, and the ladder holds every level and the price', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const round = build({ levelCount: 8, distractors: 4 }, seed)
      const values = round.levels.map(l => l.value).sort((a, b) => a - b)
      const gap = Math.max(LEVEL_RECALL.minSeparation * round.volDay, LEVEL_RECALL.minAxisShare * (round.axis.hi - round.axis.lo))
      for (let i = 1; i < values.length; i++) expect(values[i] - values[i - 1]).toBeGreaterThanOrEqual(gap - 1e-9)
      for (const v of [...values, round.price]) { expect(v).toBeGreaterThanOrEqual(round.axis.lo); expect(v).toBeLessThanOrEqual(round.axis.hi) }
      expect(round.volDay).toBeGreaterThan(0)
    }
  })
  it('is the same for the same seed and differs for another', () => {
    expect(build({}, 5)).toEqual(build({}, 5)); expect(build({}, 5).prompts).not.toEqual(build({}, 6).prompts)
  })
  it('refuses a day without enough bars', () => {
    const short = { ...today, t: today.t.slice(0, 30), o: today.o.slice(0, 30), h: today.h.slice(0, 30), l: today.l.slice(0, 30), c: today.c.slice(0, 30) }
    expect(buildLevelRound(prior, short, spec(), createRng(1))).toBeNull(); expect(buildLevelRound({ ...prior, t: [], o: [], h: [], l: [], c: [] }, today, spec(), createRng(1))).toBeNull()
  })
})

describe('the swing sequence', () => {
  it('has six swings that alternate and five questions', () => {
    let found = 0
    for (let seed = 1; seed <= 12; seed++) {
      const round = buildLevelRound(dayWindow(seed, 24_800), dayWindow(seed + 50, 24_850), spec({ mode: 'sequence', roundSec: 50_000 }), createRng(seed)); if (!round) continue
      found += 1; expect(round.swings.length).toBe(6); expect(round.levels).toEqual([]); expect(round.prompts).toEqual([]); expect(sequenceTruth(round.swings).length).toBe(5)
      for (let i = 1; i < 6; i++) expect(round.swings[i].type).not.toBe(round.swings[i - 1].type)
    }
    expect(found).toBeGreaterThan(5)
  })
  it('scores accuracy corrected for chance: all right 1, half right 0, worse than chance 0, unanswered counts as wrong', () => {
    const swings = [100, 110, 105, 112, 104, 120].map((price, i) => ({ t: i * 600, price, type: (i % 2 ? 'high' : 'low') as 'high' | 'low' }))
    const truth = sequenceTruth(swings); expect(truth).toEqual([true, false, true, false, true])
    expect(scoreSequence(swings, truth)).toEqual({ correct: 5, total: 5, roundScore: 1 })
    const four = scoreSequence(swings, truth.map((v, i) => (i < 4 ? v : !v))); expect(four.correct).toBe(4); expect(four.roundScore).toBeCloseTo(0.6, 12)
    expect(scoreSequence(swings, [true, false, true, true, false]).roundScore).toBeCloseTo((3 / 5 - 0.5) / 0.5, 9)
    expect(scoreSequence(swings, truth.map(v => !v)).roundScore).toBe(0); expect(scoreSequence(swings, [null, null, null, null, null])).toMatchObject({ correct: 0, roundScore: 0 })
  })
  it('turns on from level 10 for every third round', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].filter(i => isSequenceRound(i, 1))).toEqual([2, 5, 8]); expect([0, 1, 2, 3, 4, 5].filter(i => isSequenceRound(i, 0))).toEqual([])
    expect(paramsAt(LEVEL_RECALL_PARAMS, 9).sequence).toBe(0); expect(paramsAt(LEVEL_RECALL_PARAMS, 10).sequence).toBe(1)
  })
})

describe('scoring levels', () => {
  const round = build(); const asked = round.levels.filter(l => l.asked)
  const exact = Object.fromEntries(asked.map(l => [l.kind, l.value])) as Partial<Record<LevelKind, number>>
  const tol = 0.6
  it('an exact placement scores 1, an error of the tolerance 0, and in between linearly', () => {
    expect(scoreLevels(round, exact, tol).roundScore).toBe(1)
    const off = (share: number) => Object.fromEntries(asked.map(l => [l.kind, l.value + share * tol * round.volDay]))
    expect(scoreLevels(round, off(1), tol).roundScore).toBeCloseTo(0, 9); expect(scoreLevels(round, off(0.5), tol).roundScore).toBeCloseTo(0.5, 9); expect(scoreLevels(round, off(2), tol).roundScore).toBe(0); expect(scoreLevels(round, off(-0.25), tol).roundScore).toBeCloseTo(0.75, 9)
  })
  it('reports the error in points and in day volUnits and scores a level that was not placed as 0', () => {
    const half = { ...exact }; delete half[asked[0].kind]; half[asked[1].kind] = asked[1].value + round.volDay * 0.3
    const scored = scoreLevels(round, half, tol)
    expect(scored.errors[0]).toMatchObject({ placed: null, errorPts: null, score: 0 }); expect(scored.errors[1].errorUnits).toBeCloseTo(0.3, 9); expect(scored.errors[1].errorPts).toBeCloseTo(round.volDay * 0.3, 9)
    expect(scored.roundScore).toBeCloseTo((asked.length - 2 + 0.5) / asked.length, 9)
    expect(scoreLevels(round, {}, tol).roundScore).toBe(0); expect(scoreLevels(round, { [asked[0].kind]: Number.NaN }, tol).errors[0].placed).toBeNull()
  })
  it('a tighter tolerance is harder for the same placement', () => {
    const near = Object.fromEntries(asked.map(l => [l.kind, l.value + 0.3 * round.volDay]))
    expect(scoreLevels(round, near, 1).roundScore).toBeGreaterThan(scoreLevels(round, near, 0.35).roundScore); expect(paramsAt(LEVEL_RECALL_PARAMS, 1).tolMult).toBe(1); expect(paramsAt(LEVEL_RECALL_PARAMS, 20).tolMult).toBeCloseTo(0.35, 9)
  })
})

describe('the session summary', () => {
  it('score is 100 x the mean round score with the error by level type and the sequence accuracy', () => {
    const round = build(); const asked = round.levels.filter(l => l.asked)
    const a = scoreLevels(round, Object.fromEntries(asked.map(l => [l.kind, l.value + 0.2 * round.volDay])), 1)
    const results = [{ mode: 'levels' as const, roundScore: a.roundScore, errors: a.errors }, { mode: 'sequence' as const, roundScore: 0.6, errors: [], sequence: { correct: 4, total: 5 } }, { mode: 'levels' as const, roundScore: 0, errors: scoreLevels(round, {}, 1).errors }]
    const summary = summariseLevels(results)
    expect(summary.score).toBe(Math.round((100 * (a.roundScore + 0.6 + 0)) / 3)); expect(summary.stats).toMatchObject({ rounds: 3, sequence_accuracy: 80, unplaced: asked.length })
    expect(summary.stats!.mean_error_units).toBeCloseTo(0.2, 2); for (const l of asked) expect(summary.stats![`err_${l.kind}`]).toBeCloseTo(0.2, 2)
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20); expect(summariseLevels([]).score).toBe(0)
  })
})

describe('days with a day before', () => {
  const availability = { symbols: { NIFTY: { lot_size: 65, dates: ['2026-10-05', '2026-10-01', '2026-10-02', '2026-09-20', '2026-10-30'] }, BSESEN: { dates: ['2026-10-02'] } } }
  it('keeps a date only when the previous listed date is at most four days earlier, and remembers which', () => {
    const { eligible, priorOf } = withPriorDays(availability)
    expect(eligible.symbols.NIFTY.dates).toEqual(['2026-10-02', '2026-10-05']); expect(priorOf.get('NIFTY|2026-10-05')).toBe('2026-10-02'); expect(priorOf.get('NIFTY|2026-10-02')).toBe('2026-10-01')
    expect(eligible.symbols.BSESEN.dates).toEqual([]); expect(priorOf.has('NIFTY|2026-10-30')).toBe(false); expect(eligible.symbols.NIFTY.lot_size).toBe(65)
  })
})

describe('the round source', () => {
  const dates = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).filter(d => ![6, 7].includes(Number(d.slice(8))))
  const availability = { symbols: { NIFTY: { lot_size: 65, dates } } }
  const fakeData = (calls: Array<Record<string, unknown>> = [], fail?: (q: { date: string }) => boolean) => ({
    async window(query: { symbol: string; date: string; startSec: number; durationSec: number; intervalSeconds?: number }) {
      calls.push(query); if (fail?.(query)) throw new Error('boom')
      return dayWindow(Number(query.date.slice(8)) + 7, 24_800 + Number(query.date.slice(8)) * 5, query.symbol, query.date)
    },
  })
  it('fetches yesterday and today as 60 second day windows and returns a round', async () => {
    const calls: Array<Record<string, any>> = []
    const source = createLevelSource({ rng: createRng(4), availability, data: fakeData(calls), seen: new Set() })
    const next = await source.next({ levelCount: 4, distractors: 1, mode: 'levels' })
    expect(next.ok).toBe(true); if (!next.ok) return
    expect(calls.length).toBe(2); for (const c of calls) expect(c).toMatchObject({ startSec: 0, durationSec: 86_400, intervalSeconds: 60, symbol: 'NIFTY' })
    expect(calls.map(c => c.date)).toEqual([next.round.priorDate, next.round.date]); expect(next.round.roundSec).toBeGreaterThanOrEqual(36_900); expect(next.round.roundSec).toBeLessThanOrEqual(51_900)
    expect(next.round.levels.filter(l => l.asked).length).toBe(4)
  })
  it('never repeats a round, honours the seen set, and says no_data when the data fails or nothing is eligible', async () => {
    const source = createLevelSource({ rng: createRng(8), availability, data: fakeData(), seen: new Set() })
    const ids = new Set<string>(); for (let i = 0; i < 15; i++) { const n = await source.next({ levelCount: 3, distractors: 0, mode: 'levels' }); if (n.ok) ids.add(n.round.id) }
    expect(ids.size).toBe(15)
    expect(await createLevelSource({ rng: createRng(1), availability, data: fakeData([], () => true), seen: new Set() }).next({ levelCount: 3, distractors: 0, mode: 'levels' })).toEqual({ ok: false, reason: 'no_data' })
    expect(await createLevelSource({ rng: createRng(1), availability: { symbols: { NIFTY: { dates: ['2026-10-01'] } } }, data: fakeData(), seen: new Set() }).next({ levelCount: 3, distractors: 0, mode: 'levels' })).toEqual({ ok: false, reason: 'no_data' })
    const controller = new AbortController(); controller.abort()
    expect(await createLevelSource({ rng: createRng(1), availability, data: fakeData(), seen: new Set() }).next({ levelCount: 3, distractors: 0, mode: 'levels' }, controller.signal)).toEqual({ ok: false, reason: 'cancelled' })
  })
  it('reports the window used so the no-repeat memory is updated', async () => {
    const used: string[] = []
    const next = await createLevelSource({ rng: createRng(4), availability, data: fakeData(), seen: new Set(), onUsed: id => used.push(id) }).next({ levelCount: 3, distractors: 0, mode: 'levels' })
    expect(next.ok && used[0]).toBe(next.ok ? next.round.id : '')
  })
})

describe('simulated players', () => {
  const rounds: LevelRound[] = Array.from({ length: 80 }, (_, i) => buildLevelRound(dayWindow(i + 1, 24_800), dayWindow(i + 200, 24_850), spec({ roundSec: 38_000 + (i % 10) * 1_500, levelCount: 6, distractors: 3 }), createRng(i))).filter((r): r is LevelRound => r !== null)
  const play = (place: (r: LevelRound, kind: LevelKind, truth: number, rng: ReturnType<typeof createRng>) => number | undefined, tol = 0.6) => {
    const rng = createRng(5); const results = rounds.map(r => { const placed: Partial<Record<LevelKind, number>> = {}; for (const l of r.levels.filter(x => x.asked)) { const v = place(r, l.kind, l.value, rng); if (v !== undefined) placed[l.kind] = v } const s = scoreLevels(r, placed, tol); return { mode: 'levels' as const, roundScore: s.roundScore, errors: s.errors } }); return summariseLevels(results).score
  }
  it('a player who remembers exactly scores 100, a slightly blurry one well, a random click or always the current price poorly, none 0', () => {
    expect(rounds.length).toBeGreaterThan(60)
    expect(play((r, k, t) => t)).toBe(100)
    const blurry = play((r, k, t, rng) => t + (rng.next() - 0.5) * 0.4 * r.volDay); expect(blurry).toBeGreaterThan(65); expect(blurry).toBeLessThan(100)
    const random = play((r, k, t, rng) => r.axis.lo + rng.next() * (r.axis.hi - r.axis.lo)); expect(random).toBeLessThan(15)
    expect(play(r => r.price)).toBeLessThan(40); expect(play(() => undefined)).toBe(0)
  })
  it('a tighter tolerance lowers the score of the same blurry player (the difficulty lever works)', () => {
    const blurry = (tol: number) => play((r, k, t, rng) => t + (rng.next() - 0.5) * 0.6 * r.volDay, tol)
    expect(blurry(1)).toBeGreaterThan(blurry(0.35) + 15)
  })
})

describe('what is drawn', () => {
  it('the study chart has the days\' candles, a line for each shown level (asked yellow, others grey) and swing markers in sequence mode', () => {
    const round = build({ distractors: 2 }); const data = studyChart(round)
    expect(data.candles!.length).toBeGreaterThan(70); expect(data.levels!.length).toBe(round.levels.length); expect(data.levels!.filter(l => l.colour === '#F0E442').length).toBe(5)
    expect(data.candles![0].t).toBeLessThan(0); expect(data.candles![data.candles!.length - 1].t).toBeLessThanOrEqual((round.roundSec - 33_300) / 60)
    const seq = buildLevelRound(dayWindow(3, 24_800), dayWindow(53, 24_850), spec({ mode: 'sequence', roundSec: 50_000 }), createRng(3))
    if (seq) { const d = studyChart(seq); expect(d.markers!.map(m => m.label)).toEqual(['1', '2', '3', '4', '5', '6']); expect(d.levels).toBeUndefined() }
  })
  it('the ladder renders a labelled blank scale with the lines it is given', () => {
    const html = renderToStaticMarkup(createElement(Ladder, { lo: 24_000, hi: 25_000, label: 'Blank price ladder', lines: [{ label: 'now 24500', value: 24_500, tone: 'now' }, { label: 'Prior-day high', value: 24_800, tone: 'placed' }] }))
    expect(html).toContain('aria-label="Blank price ladder"'); expect(html).toContain('now 24500'); expect(html).toContain('Prior-day high'); expect(html).toContain('is-placed'); expect(html).toContain('games-ladder-tick')
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Memory with a parameter at every level', () => {
    expect(isPlayable('level_recall')).toBe(true)
    const game = getGame('level_recall')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('memory'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let lv = 1; lv <= 20; lv++) { const p = paramsAt(game.paramTable, lv); for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${lv} ${key}`).toBe(true); if (game.kind === 'market') expect(game.roundsPerSession(lv)).toBe(p.rounds); expect(p.levelCount).toBeLessThanOrEqual(LEVEL_KINDS.length) }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ levelCount: 3, studySec: 20, distractors: 0, sequence: 0 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ levelCount: 8, studySec: 5, distractors: 4, sequence: 1 })
  })
  it('first paint is loading', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(LEVEL_RECALL_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Loading market data')
  })
})
