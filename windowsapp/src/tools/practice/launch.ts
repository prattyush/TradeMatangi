import type { PracticePlan } from '../../../../shared/practice/types'
import type { PracticeStartConfig } from '../../../../shared/practice/startConfig'

/** What the Tools view hands to the workspace to start a practice replay: the day, the start, the contracts and the marker. */
export interface PracticeLaunch {
  /** Makes each request distinct, so a second Start on the same day is not taken for the first. */
  id: number
  symbol: string
  date: string
  /** `HH:MM:SS`; whole minutes. */
  start_time: string
  interval_minutes: number
  instrument_type: 'equity' | 'options'
  strike_ce?: number
  strike_pe?: number
  expiry?: string
  /** The desktop's own multiplier (2 = twice as fast). */
  speed: number
  practice: PracticePlan['practice']
}

/** The shape of a workspace tile (the desktop keeps its own `TileConfig`; this one is structurally the same). */
export interface LaunchTile {
  id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string
  expiry: string; strike: string; right: string; selection_mode?: 'manual' | 'max_price'
}

export const launchFrom = (id: number, plan: PracticePlan, config: PracticeStartConfig, speed: number): PracticeLaunch => ({
  id, symbol: plan.symbol, date: plan.date, start_time: plan.start_time, interval_minutes: plan.interval_minutes,
  instrument_type: config.instrument_type, strike_ce: config.strike_ce, strike_pe: config.strike_pe, expiry: config.expiry,
  speed, practice: plan.practice,
})

/**
 * The charts of a practice screen: the underlying and, for a symbol with options, the CE and PE the day was marked on, so the
 * recorded option chart is on screen. Fresh ids each time (a screen is replaced, not edited).
 */
export function practiceTiles(launch: PracticeLaunch, newId: () => string = () => crypto.randomUUID()): LaunchTile[] {
  const base = { symbol: launch.symbol, interval: String(launch.interval_minutes), tradingDate: launch.date }
  const spot: LaunchTile = { id: newId(), kind: 'spot', ...base, expiry: '', strike: '', right: 'CE' }
  if (launch.instrument_type !== 'options' || launch.strike_ce == null || launch.strike_pe == null || !launch.expiry) return [spot]
  const option = (right: 'CE' | 'PE', strike: number): LaunchTile => ({ id: newId(), kind: 'option', ...base, expiry: launch.expiry!, strike: String(strike), right, selection_mode: 'manual' })
  return [spot, option('CE', launch.strike_ce), option('PE', launch.strike_pe)]
}

/** The replay speeds the desktop's Speed list offers. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 1.1, 1.25, 1.5, 2, 5, 10] as const
