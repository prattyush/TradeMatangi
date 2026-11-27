/**
 * Regime labels for the Regime Switch (spec 5.7): what kind of market a stretch of price was. Pure; computed on the stretch the player SEES
 * (never the hold), from 5 second bars and the round's volUnit:
 *
 *  - **spike**: some 5 second bar had a range of at least `SPIKE_MULT` volUnits (a news-like burst);
 *  - **trend up / down**: the net move is at least `TREND_NET` standard moves of the stretch (volUnit x sqrt(seconds / 5)) and the path is not
 *    pure whipsaw (efficiency ratio of the 5 second closes at least `TREND_ER`);
 *  - **range**: everything else.
 * The cut-offs were set on real NIFTY and Sensex stretches of 40, 90 and 120 seconds so that no label is vanishingly rare.
 */
import { aggregate, efficiencyRatio, type Bars } from './series'

export type Regime = 'trend_up' | 'trend_down' | 'range' | 'spike'
export const REGIMES: readonly Regime[] = ['trend_up', 'trend_down', 'range', 'spike']
export const REGIME_LABEL: Record<Regime, string> = { trend_up: 'Trend up', trend_down: 'Trend down', range: 'Range', spike: 'Spike' }

export const SPIKE_MULT = 3.5
export const TREND_NET = 0.75
export const TREND_ER = 0.15

export interface RegimeInfo { regime: Regime; er: number; netUnits: number; spikeUnits: number }

export function classifyRegime(bars: Bars, vol: number, seconds: number): RegimeInfo {
  const none: RegimeInfo = { regime: 'range', er: 0, netUnits: 0, spikeUnits: 0 }
  if (bars.t.length < 2 || !(vol > 0) || !(seconds > 0)) return none
  const five = aggregate(bars, 5)
  let widest = 0
  for (let i = 0; i < five.t.length; i++) widest = Math.max(widest, five.h[i] - five.l[i])
  const er = efficiencyRatio(five.c)
  const net = bars.c[bars.c.length - 1] - bars.c[0]
  const netUnits = net / (vol * Math.sqrt(seconds / 5))
  const spikeUnits = widest / vol
  if (spikeUnits >= SPIKE_MULT) return { regime: 'spike', er, netUnits, spikeUnits }
  if (Math.abs(netUnits) >= TREND_NET && er >= TREND_ER) return { regime: netUnits > 0 ? 'trend_up' : 'trend_down', er, netUnits, spikeUnits }
  return { regime: 'range', er, netUnits, spikeUnits }
}

/** The direction of the last `seconds` of a stretch: +1 up, -1 down, 0 when the first and last close are equal (or too little data). */
export function lastDirection(bars: Bars, seconds: number): 1 | -1 | 0 {
  const n = bars.t.length
  if (n < 2) return 0
  const cutoff = bars.t[n - 1] - seconds
  let first = 0
  while (first < n - 1 && bars.t[first] < cutoff) first += 1
  const move = bars.c[n - 1] - bars.c[first]
  return move > 0 ? 1 : move < 0 ? -1 : 0
}
