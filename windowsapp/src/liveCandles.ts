import type { Candle } from './contracts'

export const RECENT_LIVE_TICK_SECONDS = 15 * 60

export const appendLiveTick = (ticks: Candle[], tick: Candle): Candle[] => {
  const byTimestamp = new Map(ticks.map(item => [item.timestamp, item]))
  byTimestamp.set(tick.timestamp, tick)
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

/** Merge local seconds with an authoritative refresh payload.
 *
 * Local ticks whose timestamp is not in the payload remain intact, while the
 * backend replaces the same timestamp.  This is deliberately independent of
 * candle interval: SQLite and memory hold only raw one-second OHLC.
 */
export const reconcileLiveTicks = (localTicks: Candle[], backendTicks: Candle[]): Candle[] => {
  const byTimestamp = new Map(localTicks.map(item => [item.timestamp, item]))
  backendTicks.forEach(tick => byTimestamp.set(tick.timestamp, tick))
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

export const aggregateLiveCandles = (history: Candle[], ticks: Candle[], intervalMinutes: number): Candle[] => {
  const intervalSeconds = intervalMinutes * 60
  const byTimestamp = new Map(history.map(candle => [candle.timestamp, candle]))
  for (const tick of ticks) {
    const timestamp = Math.floor(tick.timestamp / intervalSeconds) * intervalSeconds
    const current = byTimestamp.get(timestamp)
    byTimestamp.set(timestamp, current
      ? { timestamp, open: current.open, high: Math.max(current.high, tick.high), low: Math.min(current.low, tick.low), close: tick.close }
      : { timestamp, open: tick.open, high: tick.high, low: tick.low, close: tick.close })
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

export const recentLiveTicks = (ticks: Candle[], now: number, seconds = RECENT_LIVE_TICK_SECONDS): Candle[] =>
  ticks.filter(tick => tick.timestamp >= now - seconds)

export const mergeHistoryWithLiveTicks = (history: Candle[], ticks: Candle[], intervalMinutes: number): Candle[] =>
  aggregateLiveCandles(history, ticks, intervalMinutes)
