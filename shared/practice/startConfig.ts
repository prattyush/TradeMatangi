import { STRIKE_INTERVALS } from '../deepdive/strikes'
import type { PracticePlan } from './types'

/** The market-data lookups a practice start may need (the hosts' own price and expiry calls). */
export interface StartLookups {
  getExpiry(symbol: string, date: string): Promise<{ expiry: string }>
  /** The underlying's price at `HH:MM` on the day, as a replay sees it. */
  getPriceAt(symbol: string, date: string, time: string): Promise<{ price: number }>
}

/** What the replay start and the trading screen's chart panes need for a practice day. */
export interface PracticeStartConfig {
  symbol: string
  date: string
  instrument_type: 'equity' | 'options'
  /** Options only. */
  strike?: number
  expiry?: string
  strike_ce?: number
  strike_pe?: number
  underlyingPrice: number
}

/**
 * The instrument settings of a practice replay. An index or stock with options trades the strikes the day was marked on (the
 * saved CE and PE strikes, so the recorded option chart is the one on screen); a strike that was never saved is the ATM
 * strike at the start time, as a normal replay would pick. The expiry is the server's, else looked up. Anything else is equity.
 */
export async function practiceStartConfig(plan: PracticePlan, lookups: StartLookups): Promise<PracticeStartConfig> {
  const base = { symbol: plan.symbol, date: plan.date }
  if (plan.instrument_type !== 'options') return { ...base, instrument_type: 'equity', underlyingPrice: 0 }
  const expiry = plan.expiry ?? (await lookups.getExpiry(plan.symbol, plan.date)).expiry
  let ce = plan.strike_ce, pe = plan.strike_pe, underlyingPrice = 0
  if (ce == null || pe == null) {
    const interval = STRIKE_INTERVALS[plan.symbol] ?? 50
    const { price } = await lookups.getPriceAt(plan.symbol, plan.date, plan.start_time.slice(0, 5))
    const atm = Math.round(price / interval) * interval
    underlyingPrice = price
    ce = ce ?? atm
    pe = pe ?? atm
  }
  return { ...base, instrument_type: 'options', strike: ce, expiry, strike_ce: ce, strike_pe: pe, underlyingPrice }
}
