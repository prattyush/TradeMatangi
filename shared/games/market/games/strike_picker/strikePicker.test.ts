import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import { getGame, isPlayable } from '../../../core/registry'
import { DTE_SETS, STRIKE_PICKER, STRIKE_PICKER_PARAMS } from '../../config/difficulty.market'
import { blackScholes } from '../../engine/optionPricing'
import '../../../games'
import View from './View'
import { explain, makeScenario, OBJECTIVES, OBJECTIVE_TEXT, offsetLabel, priceChain, scorePick, startYears, summarisePicks, type MarketSpec, type Scenario, type StrikeRow } from './engine'

const NIFTY: MarketSpec = { symbol: 'NIFTY', lotSize: 65, strikeStep: 50 }
const SENSEX: MarketSpec = { symbol: 'BSESEN', lotSize: 20, strikeStep: 100 }
const level = (n: number) => { const p = paramsAt(STRIKE_PICKER_PARAMS, n); return { dteSet: p.dteSet, minutes: p.minutes, ivShiftShare: p.ivShiftShare, failShare: p.failShare, objectives: p.objectives } }
const scenarios = (n: number, lv = 10, seed = 1) => { const rng = createRng(seed); return Array.from({ length: n }, () => makeScenario(rng, level(lv), [NIFTY, SENSEX])) }

describe('scenarios', () => {
  it('are deterministic for a seed and finite', () => {
    expect(scenarios(20, 10, 7)).toEqual(scenarios(20, 10, 7)); expect(scenarios(5, 10, 7)).not.toEqual(scenarios(5, 10, 8))
    for (const s of scenarios(200, 20, 3)) for (const v of [s.spot, s.iv, s.expectedMove, s.actualMove, s.strikeStep, s.lotSize]) expect(Number.isFinite(v)).toBe(true)
  })
  it('state a move in the direction of the option, within the level\'s days to expiry and objectives', () => {
    for (const lv of [1, 5, 10, 15, 20]) {
      const p = paramsAt(STRIKE_PICKER_PARAMS, lv)
      for (const s of scenarios(150, lv, lv)) {
        expect(Math.sign(s.expectedMove)).toBe(s.right === 'CE' ? 1 : -1); expect(DTE_SETS[p.dteSet]).toContain(s.dte)
        expect(OBJECTIVES.indexOf(s.objective)).toBeLessThan(p.objectives); expect(s.minutes).toBe(p.minutes)
        if (s.actualMove !== 0) expect(Math.sign(s.actualMove) === Math.sign(s.expectedMove) || p.failShare > 0).toBe(true)
        if (p.ivShiftShare === 0) expect(s.ivShift).toBe(0)
        expect(s.spot % (s.strikeStep / 10)).toBe(0)
      }
    }
  })
  it('the mix of days to expiry follows the spec\'s table and 0 DTE only at the top', () => {
    expect(DTE_SETS.map(set => [...set])).toEqual([[5, 2], [5, 2, 1], [2, 1, 0], [1, 0], [0]])
    expect(scenarios(200, 1).every(s => s.dte >= 2)).toBe(true); expect(scenarios(200, 20).every(s => s.dte === 0)).toBe(true)
    expect(scenarios(300, 10).some(s => s.dte === 0)).toBe(true)
  })
  it('both indices appear with their own lot size and strike step, and offline defaults work', () => {
    const list = scenarios(100, 10); expect(new Set(list.map(s => s.symbol))).toEqual(new Set(['NIFTY', 'BSESEN']))
    for (const s of list) expect(s.lotSize).toBe(s.symbol === 'NIFTY' ? 65 : 20)
    const offline = makeScenario(createRng(1), level(5), []); expect(offline).toMatchObject({ symbol: 'NIFTY', lotSize: 65, strikeStep: 50 })
  })
  it('failures ("the move does not come") appear only where the level asks, as nothing or a half-size reversal', () => {
    expect(scenarios(300, 1).every(s => s.actualMove !== 0 && Math.sign(s.actualMove) === Math.sign(s.expectedMove))).toBe(true)
    const hard = scenarios(600, 20); const failed = hard.filter(s => s.actualMove === 0 || Math.sign(s.actualMove) !== Math.sign(s.expectedMove))
    expect(failed.length / hard.length).toBeGreaterThan(0.15); expect(failed.length / hard.length).toBeLessThan(0.35)
  })
  it('implied volatility shifts happen only at levels that have them', () => {
    expect(scenarios(200, 1).every(s => s.ivShift === 0)).toBe(true); expect(scenarios(300, 15).filter(s => s.ivShift !== 0).length).toBeGreaterThan(80)
  })
})

describe('the priced chain', () => {
  const s: Scenario = { symbol: 'NIFTY', right: 'CE', spot: 24_812, strikeStep: 50, lotSize: 65, dte: 2, ivRegime: 'normal', iv: 0.14, ivShift: 0.1, expectedMove: 80, actualMove: 80, minutes: 30, objective: 'profit_per_lot', capital: 10_000, costPerLot: 60 }
  const rows = priceChain(s)
  it('has seven strikes from ITM3 to OTM3 around the ATM, calls and puts on the right sides', () => {
    expect(rows.map(r => r.offset)).toEqual([-3, -2, -1, 0, 1, 2, 3]); expect(rows[3].strike).toBe(24_800)
    expect(rows.map(r => r.strike)).toEqual([24_650, 24_700, 24_750, 24_800, 24_850, 24_900, 24_950])
    const put = priceChain({ ...s, right: 'PE', expectedMove: -80, actualMove: -80 }); expect(put.map(r => r.strike)).toEqual([24_950, 24_900, 24_850, 24_800, 24_750, 24_700, 24_650])
    expect(rows.map(r => offsetLabel(r.offset))).toEqual(['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3'])
  })
  it('premiums fall away from the money, deltas fall with them, and gamma peaks near the money', () => {
    for (let i = 1; i < rows.length; i++) { expect(rows[i].premium).toBeLessThan(rows[i - 1].premium); expect(rows[i].delta).toBeLessThan(rows[i - 1].delta) }
    expect(rows[3].gamma).toBeGreaterThan(rows[0].gamma); expect(rows[3].gamma).toBeGreaterThan(rows[6].gamma)
  })
  it('the premiums are Black-Scholes before and after the move, time and volatility change', () => {
    const t0 = startYears(2), t1 = t0 - (30 / STRIKE_PICKER.sessionMinutes) / 365
    const row = rows[4]
    expect(row.premium).toBeCloseTo(blackScholes(24_812, 24_850, t0, 0.14, 'CE').price, 9)
    expect(row.premiumAfter).toBeCloseTo(blackScholes(24_892, 24_850, t1, 0.14 * 1.1, 'CE').price, 9)
  })
  it('the result per strike is the premium change less the spread, in rupees per lot', () => {
    for (const row of rows) {
      expect(row.net).toBeCloseTo(row.premiumAfter - row.premium - row.spread, 9); expect(row.pnlPerLot).toBeCloseTo(row.net * 65, 9)
      expect(row.spread).toBeCloseTo(0.3 + 0.012 * row.premium + 0.5 * Math.max(0, row.offset), 9)
    }
    expect(rows[6].spread).toBeGreaterThan(rows[3].spread - 0.012 * rows[3].premium) // the far strike pays more spread for its tiny premium
  })
  it('the parts add up to the result (delta, gamma, theta, vega and spread, to second order)', () => {
    for (const row of rows) {
      const sum = Object.values(row.parts).reduce((a, b) => a + b, 0)
      expect(Math.abs(sum - row.net)).toBeLessThan(Math.max(1.5, Math.abs(row.net) * 0.25))
    }
  })
  it('the capital objective buys whole lots only: a strike that costs more than the capital buys none', () => {
    const rich = priceChain({ ...s, objective: 'capital_pnl', dte: 5 })
    for (const row of rich) { expect(Number.isInteger(row.lots)).toBe(true); expect(row.pnlOnCapital).toBeCloseTo(row.lots * row.pnlPerLot, 9); expect(row.metric).toBe(row.pnlOnCapital); expect(row.lots * (row.premium * 65)).toBeLessThanOrEqual(10_000) }
    expect(rich[0].lots).toBe(0); expect(rich[0].pnlOnCapital).toBe(0); expect(rich[6].lots).toBeGreaterThanOrEqual(1)
  })
  it('every objective measures its own thing', () => {
    expect(priceChain({ ...s, objective: 'profit_per_lot' })[3].metric).toBeCloseTo(rows[3].pnlPerLot, 9)
    expect(priceChain({ ...s, objective: 'return_pct' })[3].metric).toBeCloseTo(rows[3].returnPct, 9)
    expect(priceChain({ ...s, objective: 'costed_profit' })[3].metric).toBeCloseTo(rows[3].pnlPerLot - 60, 9)
    for (const kind of OBJECTIVES) expect(OBJECTIVE_TEXT[kind]({ ...s, objective: kind })).toMatch(/Maximise/)
  })
  it('a move that does not come leaves only decay and the spread, so every long option loses', () => {
    for (const row of priceChain({ ...s, actualMove: 0, ivShift: 0 })) expect(row.net).toBeLessThan(0)
  })
  it('no NaN anywhere, on the last day too', () => {
    for (const sc of scenarios(300, 20, 9)) for (const row of priceChain(sc)) for (const v of [row.premium, row.premiumAfter, row.delta, row.gamma, row.theta, row.net, row.metric, row.returnPct]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('scoring', () => {
  const rows = (metrics: number[]): StrikeRow[] => metrics.map((metric, i) => ({ offset: i - 3, strike: 24_800 + i * 50, premium: 1, premiumAfter: 1, delta: 0.5, gamma: 0, theta: 0, vega: 0, spread: 0, net: metric, lots: 1, pnlPerLot: metric, pnlOnCapital: metric, returnPct: metric, metric, parts: { delta: metric, gamma: 0, theta: 0, vega: 0, spread: 0 } }))
  it('is the way from the worst strike to the best, 0 to 1', () => {
    const chain = rows([-50, -20, 0, 100, 40, 10, -80])
    expect(scorePick(chain, -3).roundScore).toBeCloseTo(30 / 180, 12); expect(scorePick(chain, 0).roundScore).toBe(1); expect(scorePick(chain, 0)).toMatchObject({ best: 100, worst: -80 }); expect(scorePick(chain, 3).roundScore).toBe(0)
  })
  it('is 1 when every strike is the same, and a late or missing pick is 0 and flagged', () => {
    expect(scorePick(rows([5, 5, 5, 5, 5, 5, 5]), -2).roundScore).toBe(1)
    expect(scorePick(rows([1, 2, 3, 4, 5, 6, 7]), null)).toMatchObject({ roundScore: 0, timedOut: true, offset: null })
    expect(scorePick(rows([1, 2, 3, 4, 5, 6, 7]), 9).timedOut).toBe(true)
  })
  it('explains the best strike, the pick\'s driver and a missed move or a volatility change', () => {
    const sc: Scenario = { symbol: 'NIFTY', right: 'CE', spot: 24_800, strikeStep: 50, lotSize: 65, dte: 0, ivRegime: 'low', iv: 0.11, ivShift: -0.2, expectedMove: 60, actualMove: 0, minutes: 10, objective: 'profit_per_lot', capital: 10_000, costPerLot: 60 }
    const chain = priceChain(sc); const result = scorePick(chain, 2)
    const text = explain(sc, chain, result).join(' ')
    expect(text).toMatch(/best strike for this objective was/); expect(text).toMatch(/did not come/); expect(text).toMatch(/volatility fell 20%/); expect(text).not.toMatch(/NaN|undefined/)
    expect(explain({ ...sc, actualMove: 60, ivShift: 0 }, priceChain({ ...sc, actualMove: 60, ivShift: 0 }), scorePick(priceChain({ ...sc, actualMove: 60, ivShift: 0 }), 3)).length).toBeGreaterThan(0)
  })
  it('flags a pick that lost mostly to decay', () => {
    const sc: Scenario = { symbol: 'NIFTY', right: 'CE', spot: 24_800, strikeStep: 50, lotSize: 65, dte: 0, ivRegime: 'normal', iv: 0.14, ivShift: 0, expectedMove: 60, actualMove: 0, minutes: 30, objective: 'profit_per_lot', capital: 10_000, costPerLot: 60 }
    const chain = priceChain(sc)
    const blind = chain.map(r => scorePick(chain, r.offset)).filter(r => r.thetaLoss)
    expect(blind.length).toBeGreaterThan(0)
  })
  it('the session score is 100 x the mean with the pick distribution in the stats', () => {
    const results = scenarios(40, 10, 4).map((sc, i) => scorePick(priceChain(sc), i % 5 === 0 ? null : (i % 7) - 3))
    const summary = summarisePicks(results)
    expect(summary.score).toBe(Math.round(100 * results.reduce((a, r) => a + r.roundScore, 0) / results.length))
    for (const [key, value] of Object.entries(summary.stats!)) { expect(key).toMatch(/^[a-z0-9_]+$/); expect(Number.isFinite(value), key).toBe(true) }
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20); expect(summary.stats!.timeouts).toBe(results.filter(r => r.timedOut).length)
    const picks = Object.entries(summary.stats!).filter(([k]) => k.startsWith('pick_')).reduce((a, [, v]) => a + v, 0); expect(picks).toBe(results.filter(r => r.offset !== null).length)
    expect(summarisePicks([]).score).toBe(0)
  })
})

describe('simulated players', () => {
  const chains = (lv: number) => scenarios(400, lv, 11).map(priceChain)
  const score = (lv: number, pick: (rows: StrikeRow[]) => number | null) => summarisePicks(chains(lv).map(rows => scorePick(rows, pick(rows)))).score
  it('the best strike scores 100, a timeout 0, and a random guesser sits near the middle', () => {
    const rng = createRng(5)
    for (const lv of [1, 10, 20]) {
      expect(score(lv, rows => rows.reduce((a, b) => (b.metric > a.metric ? b : a)).offset)).toBe(100); expect(score(lv, () => null)).toBe(0)
      const random = score(lv, () => rng.int(-3, 3)); expect(random).toBeGreaterThan(40); expect(random).toBeLessThan(70)
    }
  })
  it('no single strike is the best choice at every level (the answer depends on the scenario)', () => {
    for (const lv of [10, 15, 20]) {
      const best = new Set(chains(lv).map(rows => rows.reduce((a, b) => (b.metric > a.metric ? b : a)).offset)); expect(best.size).toBeGreaterThanOrEqual(4)
    }
    expect(score(20, () => 3)).toBeLessThan(45); expect(score(20, () => 0)).toBeGreaterThan(50)
  })
})

describe('registration and first paint', () => {
  it('is a playable market game in Reasoning with a parameter at every level', () => {
    expect(isPlayable('strike_picker')).toBe(true)
    const game = getGame('strike_picker')!
    expect(game.kind).toBe('market'); expect(game.category).toBe('reasoning'); expect(game.instructions.length).toBeLessThanOrEqual(6)
    for (let lv = 1; lv <= 20; lv++) { const p = paramsAt(game.paramTable, lv); for (const [key, value] of Object.entries(p)) expect(Number.isFinite(value), `L${lv} ${key}`).toBe(true); if (game.kind === 'market') expect(game.roundsPerSession(lv)).toBe(p.scenarios) }
    expect(paramsAt(game.paramTable, 1)).toMatchObject({ dteSet: 0, objectives: 1 }); expect(paramsAt(game.paramTable, 20)).toMatchObject({ dteSet: 4, objectives: 4, minutes: 5 })
  })
  it('first paint is a short wait before the first scenario', () => {
    const html = renderToStaticMarkup(createElement(View, { level: 1, mode: 'practice', params: paramsAt(STRIKE_PICKER_PARAMS, 1), rng: createRng(1), seed: 1, suspended: false, onFinish: () => undefined, onAbort: () => undefined }))
    expect(html).toContain('Getting ready')
  })
})
