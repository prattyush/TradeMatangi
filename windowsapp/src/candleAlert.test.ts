import { describe, expect, it } from 'vitest'
import { createCandleAlertTracker, candleEnd, candleAlertConfigValid } from '../../shared/candleAlert'
import { headerAlertColor, maxSizeAlertActive, maxSizeCapitalInUse, type MaxSizeSettings, type SizedPosition } from '../../shared/maxSizeAlert'

// IST-as-UTC seconds for 2026-11-04 at the given wall-clock time.
const at = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 4, h, m, s) / 1000
const config = { enabled: true, intervalMin: 3, secondsBefore: 15 }

function run(times: number[], cfg = config) {
  const tracker = createCandleAlertTracker()
  return times.filter(time => tracker.observe(time, cfg))
}

describe('candle alert timing', () => {
  it('3 min / 15 s fires at 09:26:45 (one second before 09:27:00 boundary minus 15)', () => {
    expect(candleEnd(at(9, 26, 10), 3)).toBe(at(9, 27))
    const ticks = Array.from({ length: 60 }, (_, i) => at(9, 26, i))
    expect(run(ticks)).toEqual([at(9, 26, 45)])
  })

  it('fires once per candle across many candles, never twice in the window', () => {
    const ticks = Array.from({ length: 12 * 60 }, (_, i) => at(9, 15, 0) + i)
    expect(run(ticks)).toEqual([at(9, 17, 45), at(9, 20, 45), at(9, 23, 45), at(9, 26, 45)])
  })

  it('does not fire when the first sample is already inside the window (start/resume)', () => {
    expect(run([at(9, 26, 50), at(9, 26, 51), at(9, 26, 52)])).toEqual([])
  })

  it('fires with batched or gapped ticks that jump over the threshold', () => {
    expect(run([at(9, 26, 40), at(9, 26, 58)])).toEqual([at(9, 26, 58)])
  })

  it('stays silent while the clock is paused and resumes without a double fire', () => {
    expect(run([at(9, 26, 44), at(9, 26, 44), at(9, 26, 44), at(9, 26, 45), at(9, 26, 45), at(9, 26, 46)])).toEqual([at(9, 26, 45)])
  })

  it('reset forgets history so a new session does not fire from a stale sample', () => {
    const tracker = createCandleAlertTracker()
    tracker.observe(at(9, 26, 44), config)
    tracker.reset()
    expect(tracker.observe(at(9, 26, 45), config)).toBe(false)
    expect(tracker.observe(at(9, 26, 46), config)).toBe(false)
  })

  it('honours other intervals and ignores invalid configs', () => {
    expect(run(Array.from({ length: 300 }, (_, i) => at(9, 15, 0) + i), { enabled: true, intervalMin: 5, secondsBefore: 30 })).toEqual([at(9, 19, 30)])
    expect(candleAlertConfigValid({ enabled: true, intervalMin: 1, secondsBefore: 60 })).toBe(false)
    expect(candleAlertConfigValid({ enabled: false, intervalMin: 3, secondsBefore: 15 })).toBe(false)
    expect(run([at(9, 26, 44), at(9, 26, 45)], { ...config, enabled: false })).toEqual([])
  })

  it('ignores missing clocks', () => {
    const tracker = createCandleAlertTracker()
    expect(tracker.observe(null, config)).toBe(false)
    expect(tracker.observe(undefined, config)).toBe(false)
  })
})

describe('MAX SIZE 50% alert', () => {
  const settings: MaxSizeSettings = { enabled: true, alertEnabled: true, mode: 'percentage', pct: 20, value: 0 }
  const equity = (quantity: number, price: number): SizedPosition => ({ side: 'LONG', quantity, avg_entry_price: price, isOption: false })
  const option = (quantity: number, price: number): SizedPosition => ({ side: 'LONG', quantity, avg_entry_price: price, isOption: true })

  it('applies the 20% equity margin and full option premium, like the backend', () => {
    expect(maxSizeCapitalInUse([equity(100, 500)], 'equity')).toBe(10000)
    expect(maxSizeCapitalInUse([option(100, 50), option(50, 40)], 'options')).toBe(7000)
    expect(maxSizeCapitalInUse([{ side: 'FLAT', quantity: 0, avg_entry_price: 0, isOption: false }], 'equity')).toBe(0)
  })

  it('alerts from 50% of the percentage-mode limit and sums all contracts', () => {
    // limit = 20% of 100000 = 20000; half = 10000
    expect(maxSizeAlertActive(settings, [option(100, 99)], 100000, 'options')).toBe(false)
    expect(maxSizeAlertActive(settings, [option(100, 100)], 100000, 'options')).toBe(true)
    expect(maxSizeAlertActive(settings, [option(100, 60), option(100, 40)], 100000, 'options')).toBe(true)
  })

  it('supports value mode and requires both switches', () => {
    const value = { ...settings, mode: 'value', value: 4000 }
    expect(maxSizeAlertActive(value, [option(10, 199)], 100000, 'options')).toBe(false)
    expect(maxSizeAlertActive(value, [option(10, 200)], 100000, 'options')).toBe(true)
    expect(maxSizeAlertActive({ ...value, alertEnabled: false }, [option(10, 500)], 100000, 'options')).toBe(false)
    expect(maxSizeAlertActive({ ...value, enabled: false }, [option(10, 500)], 100000, 'options')).toBe(false)
    expect(maxSizeAlertActive({ ...value, value: 0 }, [option(10, 500)], 100000, 'options')).toBe(false)
    expect(maxSizeAlertActive(null, [option(10, 500)], 100000, 'options')).toBe(false)
  })

  it('red states outrank orange', () => {
    expect(headerAlertColor({ redAlert: false, banActive: false, maxSizeAlert: true })).toBe('orange')
    expect(headerAlertColor({ redAlert: true, banActive: false, maxSizeAlert: true })).toBe('red')
    expect(headerAlertColor({ redAlert: false, banActive: true, maxSizeAlert: true })).toBeNull()
    expect(headerAlertColor({ redAlert: false, banActive: false, maxSizeAlert: false })).toBeNull()
  })
})
