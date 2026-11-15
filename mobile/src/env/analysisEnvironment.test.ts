import { describe, expect, it } from 'vitest'
import { withMinuteGranularity } from './analysisEnvironment'

describe('withMinuteGranularity', () => {
  it('asks for minute candles on the three history routes, with or without a query', () => {
    expect(withMinuteGranularity('data/historical?symbol=NIFTY&trading_date=2026-11-10')).toBe('data/historical?symbol=NIFTY&trading_date=2026-11-10&granularity=minute')
    expect(withMinuteGranularity('data/pre-session?symbol=NIFTY')).toBe('data/pre-session?symbol=NIFTY&granularity=minute')
    expect(withMinuteGranularity('data/options-historical?symbol=NIFTY&strike=24500')).toBe('data/options-historical?symbol=NIFTY&strike=24500&granularity=minute')
    expect(withMinuteGranularity('data/historical')).toBe('data/historical?granularity=minute')
  })

  it('leaves every other route, and a request that already chose, alone', () => {
    expect(withMinuteGranularity('data/expiry?symbol=NIFTY&date=2026-11-10')).toBe('data/expiry?symbol=NIFTY&date=2026-11-10')
    expect(withMinuteGranularity('sessions?from=2026-11-01')).toBe('sessions?from=2026-11-01')
    expect(withMinuteGranularity('data/historical?symbol=NIFTY&granularity=minute')).toBe('data/historical?symbol=NIFTY&granularity=minute')
  })
})
