/**
 * Strike Picker (spec 5.8): choose how far in or out of the money to buy, given the direction, the expected move, the time and an
 * explicit objective. Everything is modelled with Black-Scholes (`engine/optionPricing.ts`): no market data is read, only the lot size
 * and strike step from `/availability` (with defaults offline). Pure and seeded.
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { DTE_SETS, STRIKE_PICKER } from '../../config/difficulty.market'
import { blackScholes, type Right } from '../../engine/optionPricing'

export type IvRegime = 'low' | 'normal' | 'high'
export type ObjectiveKind = 'profit_per_lot' | 'return_pct' | 'capital_pnl' | 'costed_profit'
/** In the order they unlock: profit on a fixed capital first (deep in-the-money strikes do not fit it, so there is a real trade-off), then return, per-lot profit, and a costed one. */
export const OBJECTIVES: readonly ObjectiveKind[] = ['capital_pnl', 'return_pct', 'profit_per_lot', 'costed_profit']

export interface Scenario {
  symbol: string
  right: Right
  spot: number
  strikeStep: number
  lotSize: number
  /** Calendar days to expiry at the start (0 = expiry day). */
  dte: number
  ivRegime: IvRegime
  iv: number
  /** Relative change of the implied volatility during the scenario (0.1 = +10 %). */
  ivShift: number
  /** The move the card states, and the move that happens (equal unless the move "does not come"), signed in points. */
  expectedMove: number
  actualMove: number
  minutes: number
  objective: ObjectiveKind
  capital: number
  costPerLot: number
}

export interface ScenarioParams { dteSet: number; minutes: number; ivShiftShare: number; failShare: number; objectives: number }
export interface MarketSpec { symbol: string; lotSize: number; strikeStep: number }

/** Spot ranges of the two indices, so a premium and a strike look like the real ones. */
const SPOT_RANGE: Record<string, [number, number]> = { NIFTY: [22_000, 26_500], BSESEN: [74_000, 86_000] }
const FALLBACK: MarketSpec = { symbol: 'NIFTY', lotSize: 65, strikeStep: 50 }
const round5 = (value: number): number => Math.round(value / 5) * 5

export function makeScenario(rng: Rng, params: ScenarioParams, markets: MarketSpec[]): Scenario {
  const market = markets.length ? rng.pick(markets) : FALLBACK
  const [lo, hi] = SPOT_RANGE[market.symbol] ?? SPOT_RANGE.NIFTY
  const spot = Math.round((lo + rng.next() * (hi - lo)) / market.strikeStep) * market.strikeStep + rng.int(-9, 9) * (market.strikeStep / 10)
  const dtes = DTE_SETS[Math.max(0, Math.min(DTE_SETS.length - 1, Math.round(params.dteSet)))]
  const regime = rng.pick<IvRegime>(['low', 'normal', 'normal', 'high'])
  const iv = STRIKE_PICKER.iv[regime]
  const right: Right = rng.chance(0.5) ? 'CE' : 'PE'
  const minutes = Math.max(1, Math.round(params.minutes))
  // One standard deviation of the underlying over the scenario (trading minutes of a 252 day year), then 0.8 to 2 of them.
  const sigma = spot * iv * Math.sqrt(minutes / (STRIKE_PICKER.sessionMinutes * 252))
  const size = Math.max(market.strikeStep / 5, round5(sigma * (0.8 + rng.next() * 1.2)))
  const direction = right === 'CE' ? 1 : -1
  const fails = rng.chance(params.failShare)
  // "The move does not come": nothing happens, or it goes the other way by half.
  // A move that does come is rarely exactly the expected one: 0.4 to 1.4 times it (so buying far out of the money is a bet, not a sure thing).
  const actual = fails ? (rng.chance(0.5) ? 0 : -round5(size / 2)) : Math.max(5, round5(size * (0.4 + rng.next())))
  const shifts = [-0.2, -0.1, 0.1, 0.2]
  const ivShift = rng.chance(params.ivShiftShare) ? rng.pick(shifts) : 0
  const objective = OBJECTIVES[rng.int(0, Math.max(1, Math.min(OBJECTIVES.length, Math.round(params.objectives))) - 1)]
  return {
    symbol: market.symbol, right, spot, strikeStep: market.strikeStep, lotSize: market.lotSize, dte: rng.pick(dtes), ivRegime: regime, iv, ivShift,
    expectedMove: direction * size, actualMove: direction * actual, minutes, objective, capital: STRIKE_PICKER.capital, costPerLot: STRIKE_PICKER.costPerLotRs,
  }
}

export interface StrikeRow {
  /** -3 (ITM3) to +3 (OTM3). */
  offset: number
  strike: number
  premium: number
  premiumAfter: number
  delta: number
  gamma: number
  theta: number
  vega: number
  /** Round-trip spread in points. */
  spread: number
  /** Net result per unit (premium change less the spread), in points. */
  net: number
  lots: number
  /** Rupee result of one lot, and of the lots the capital buys (whole lots). */
  pnlPerLot: number
  pnlOnCapital: number
  returnPct: number
  /** What the objective measures for this strike (higher is better). */
  metric: number
  /** The parts of the result per unit: delta, gamma, theta, vega and spread, in points. */
  parts: { delta: number; gamma: number; theta: number; vega: number; spread: number }
}

export const offsetLabel = (offset: number): string => (offset === 0 ? 'ATM' : offset < 0 ? `ITM${-offset}` : `OTM${offset}`)

/** The time to expiry in years at the start of a scenario with `dte` calendar days to go. */
export const startYears = (dte: number): number => (dte + STRIKE_PICKER.dayLeft) / 365

export function priceChain(scenario: Scenario): StrikeRow[] {
  const atm = Math.round(scenario.spot / scenario.strikeStep) * scenario.strikeStep
  const t0 = startYears(scenario.dte)
  const elapsedDays = scenario.minutes / STRIKE_PICKER.sessionMinutes
  const t1 = Math.max(0, t0 - elapsedDays / 365)
  const spotAfter = scenario.spot + scenario.actualMove
  const ivAfter = scenario.iv * (1 + scenario.ivShift)
  const rows: StrikeRow[] = []
  for (let offset = -STRIKE_PICKER.strikesEachSide; offset <= STRIKE_PICKER.strikesEachSide; offset++) {
    const strike = scenario.right === 'CE' ? atm + offset * scenario.strikeStep : atm - offset * scenario.strikeStep
    const before = blackScholes(scenario.spot, strike, t0, scenario.iv, scenario.right)
    const after = blackScholes(spotAfter, strike, t1, ivAfter, scenario.right)
    const otmSteps = Math.max(0, offset)
    const spread = STRIKE_PICKER.spread.base + STRIKE_PICKER.spread.premiumShare * before.price + STRIKE_PICKER.spread.otmStep * otmSteps
    const net = after.price - before.price - spread
    const lotCost = before.price * scenario.lotSize
    const lots = lotCost > 0 ? Math.floor(scenario.capital / (lotCost + spread * scenario.lotSize)) : 0
    const pnlPerLot = net * scenario.lotSize
    const pnlOnCapital = lots * pnlPerLot
    const returnPct = before.price + spread > 0 ? (net / (before.price + spread / 2)) * 100 : 0
    const metric = scenario.objective === 'profit_per_lot' ? pnlPerLot
      : scenario.objective === 'return_pct' ? returnPct
      : scenario.objective === 'capital_pnl' ? pnlOnCapital
      : pnlPerLot - scenario.costPerLot
    const dSpot = spotAfter - scenario.spot
    rows.push({
      offset, strike, premium: before.price, premiumAfter: after.price, delta: before.delta, gamma: before.gamma, theta: before.theta, vega: before.vega,
      spread, net, lots, pnlPerLot, pnlOnCapital, returnPct, metric,
      parts: {
        delta: before.delta * dSpot, gamma: 0.5 * before.gamma * dSpot * dSpot, theta: before.theta * elapsedDays,
        vega: before.vega * (ivAfter - scenario.iv) * 100, spread: -spread,
      },
    })
  }
  return rows
}

export const OBJECTIVE_TEXT: Record<ObjectiveKind, (s: Scenario) => string> = {
  profit_per_lot: () => 'Maximise the rupee profit of one lot.',
  return_pct: () => 'Maximise the percentage return on the premium you pay.',
  capital_pnl: s => `Maximise the rupee profit on ₹${s.capital.toLocaleString('en-IN')} of capital (whole lots only).`,
  costed_profit: s => `Maximise the rupee profit of one lot after a flat cost of ₹${s.costPerLot} per lot.`,
}

export interface PickResult {
  offset: number | null
  /** 0 to 1 against the best and worst strike on the objective. */
  roundScore: number
  best: number
  worst: number
  /** The pick's metric, and the largest regret in the objective's own unit. */
  metric: number
  timedOut: boolean
  /** The part of the result that moved the pick the most (by absolute size). */
  driver: keyof StrikeRow['parts']
  /** A pick that lost money mostly to decay. */
  thetaLoss: boolean
}

const DRIVER_TEXT: Record<keyof StrikeRow['parts'], string> = {
  delta: 'the underlying move (delta)', gamma: 'the speed-up of the move (gamma)', theta: 'time decay (theta)', vega: 'the change in volatility (vega)', spread: 'the spread you pay to trade',
}
export const driverOf = (row: StrikeRow): keyof StrikeRow['parts'] =>
  (Object.entries(row.parts) as Array<[keyof StrikeRow['parts'], number]>).reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))[0]

/** `roundScore = (pnl(pick) - pnl(worst)) / (pnl(best) - pnl(worst))` on the objective, 1 when best and worst are equal; a late pick scores 0. */
export function scorePick(rows: StrikeRow[], offset: number | null): PickResult {
  const metrics = rows.map(r => r.metric)
  const best = Math.max(...metrics), worst = Math.min(...metrics)
  const row = rows.find(r => r.offset === offset)
  if (!row) return { offset: null, roundScore: 0, best, worst, metric: 0, timedOut: true, driver: 'delta', thetaLoss: false }
  const roundScore = best === worst ? 1 : clamp((row.metric - worst) / (best - worst), 0, 1)
  const driver = driverOf(row)
  return { offset: row.offset, roundScore, best, worst, metric: row.metric, timedOut: false, driver, thetaLoss: row.net < 0 && driver === 'theta' }
}

/** A sentence about why the best strike won and what drove the player's result. */
export function explain(scenario: Scenario, rows: StrikeRow[], result: PickResult): string[] {
  const best = rows.reduce((a, b) => (b.metric > a.metric ? b : a))
  const pick = rows.find(r => r.offset === result.offset)
  const out = [`The best strike for this objective was ${offsetLabel(best.offset)} (${best.strike}): its result was driven mostly by ${DRIVER_TEXT[driverOf(best)]}.`]
  if (pick && pick.offset !== best.offset) out.push(`Your ${offsetLabel(pick.offset)} (${pick.strike}) was driven mostly by ${DRIVER_TEXT[result.driver]}${result.thetaLoss ? ': you lost to decay while waiting for the move' : ''}.`)
  else if (pick) out.push('That is the strike you picked.')
  const ratio = scenario.expectedMove !== 0 ? scenario.actualMove / scenario.expectedMove : 1
  if (ratio <= 0) out.push(scenario.actualMove === 0 ? 'The expected move did not come: only time decay and the spread acted.' : 'The market went the other way from what the card expected.')
  else if (Math.abs(ratio - 1) > 0.15) out.push(`The move was ${ratio < 1 ? 'smaller' : 'bigger'} than expected: ${Math.abs(scenario.actualMove)} points instead of ${Math.abs(scenario.expectedMove)}.`)
  if (scenario.ivShift !== 0) out.push(`Implied volatility ${scenario.ivShift > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(scenario.ivShift * 100))}% during the move.`)
  return out
}

const round2 = (value: number): number => Math.round(value * 100) / 100

export function summarisePicks(results: PickResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.roundScore, 0) / n : 0
  const picked = results.filter(r => r.offset !== null)
  const stats: Record<string, number> = {
    scenarios: n,
    optimal_rate: n ? round2((results.filter(r => !r.timedOut && Math.abs(r.metric - r.best) < 1e-9).length / n) * 100) : 0,
    mean_offset: picked.length ? round2(picked.reduce((s, r) => s + (r.offset ?? 0), 0) / picked.length) : 0,
    theta_blind_rate: picked.length ? round2((results.filter(r => r.thetaLoss).length / picked.length) * 100) : 0,
    timeouts: results.filter(r => r.timedOut).length,
  }
  for (let k = -STRIKE_PICKER.strikesEachSide; k <= STRIKE_PICKER.strikesEachSide; k++) stats[`pick_${k < 0 ? 'm' : k > 0 ? 'p' : 'z'}${Math.abs(k)}`] = results.filter(r => r.offset === k).length
  return { score: toSessionScore(100 * mean), stats }
}
