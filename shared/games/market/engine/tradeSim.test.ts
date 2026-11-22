import { describe, expect, it } from 'vitest'
import type { Bars } from './series'
import { costInR, netR, openTrade, simulateTrade, type TradeSpec } from './tradeSim'

/** Bars at seconds 1, 2, 3...: [high, low, close] each (the open is not used by the simulation). */
const bars = (rows: Array<[number, number, number]>): Bars => ({ t: rows.map((_, i) => i + 1), o: rows.map(r => r[2]), h: rows.map(r => r[0]), l: rows.map(r => r[1]), c: rows.map(r => r[2]) })
const long = (over: Partial<TradeSpec> = {}): TradeSpec => ({ direction: 1, entrySec: 0, entryPrice: 100, stop: 2, target: 4, endSec: 100, ...over })
const short = (over: Partial<TradeSpec> = {}): TradeSpec => long({ direction: -1, ...over })

describe('simulateTrade (long)', () => {
  it('exits at the target level and reports R as target over stop', () => {
    const out = simulateTrade(bars([[101, 99.5, 100.5], [104.6, 100.2, 104]]), long())
    expect(out).toMatchObject({ kind: 'target', exitSec: 2, exitPrice: 104, r: 2 })
    expect(out.mfeR).toBe(2) // the best price move is the target
    expect(out.maeR).toBeCloseTo(0.25, 9) // 0.5 against it on the first bar
  })

  it('exits at the stop level, always -1 R', () => {
    const out = simulateTrade(bars([[100.5, 99.9, 100.2], [100.4, 97.5, 98]]), long())
    expect(out).toMatchObject({ kind: 'stop', exitSec: 2, exitPrice: 98, r: -1 })
    expect(out.maeR).toBe(1)
  })

  it('counts the stop first when one bar reaches both', () => {
    expect(simulateTrade(bars([[105, 97, 101]]), long()).kind).toBe('stop')
  })

  it('marks to market at the last bar of the horizon, and stops looking at endSec', () => {
    const rows: Array<[number, number, number]> = [[100.8, 99.6, 100.5], [101.2, 100.1, 101], [110, 90, 100]]
    const out = simulateTrade(bars(rows), long({ endSec: 3 })) // the wild third bar is at endSec: not part of the trade
    expect(out).toMatchObject({ kind: 'horizon', exitSec: 2, exitPrice: 101 })
    expect(out.r).toBeCloseTo(0.5, 9)
    expect(out.mfeR).toBeCloseTo(0.6, 9)
  })

  it('ignores bars at or before the entry second and copes with no bars at all', () => {
    const b = bars([[90, 80, 85], [101, 99.5, 100.5]])
    expect(simulateTrade(b, long({ entrySec: 1 })).exitSec).toBe(2)
    expect(simulateTrade(bars([]), long())).toMatchObject({ kind: 'horizon', exitSec: 0, r: 0, exitPrice: 100 })
  })

  it('has no target when it is null: only the stop or the horizon ends it', () => {
    expect(simulateTrade(bars([[150, 100, 140]]), long({ target: null })).kind).toBe('horizon')
  })
})

describe('simulateTrade (short)', () => {
  it('mirrors the long: the stop is above and the target below', () => {
    expect(simulateTrade(bars([[100.4, 99.6, 100], [100.2, 95.5, 96]]), short())).toMatchObject({ kind: 'target', exitPrice: 96, r: 2 })
    expect(simulateTrade(bars([[102.5, 99.9, 102]]), short())).toMatchObject({ kind: 'stop', exitPrice: 102, r: -1 })
    expect(simulateTrade(bars([[100.5, 99, 99.2]]), short({ endSec: 5 }))).toMatchObject({ kind: 'horizon' })
    expect(simulateTrade(bars([[100.5, 99, 99]]), short({ endSec: 5 })).r).toBeCloseTo(0.5, 9)
  })
})

describe('costs', () => {
  it('turns option points into R of the underlying stop', () => {
    expect(costInR(1, 0.5, 4)).toBeCloseTo(0.5, 9)
    expect(costInR(2.12, 0.5, 2)).toBeCloseTo(2.12, 9)
    expect(costInR(1, 0.5, 0)).toBe(0); expect(costInR(1, 0, 4)).toBe(0)
    expect(netR(simulateTrade(bars([[104.5, 100, 104]]), long()), 0.25)).toBeCloseTo(1.75, 9)
  })
})

describe('openTrade (the stepped trade of Exit Discipline)', () => {
  const bar = (t: number, h: number, l: number, c: number) => ({ t, h, l, c })

  it('enforces the stop and the target on every bar', () => {
    const a = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 4 })
    expect(a.step(bar(1, 1, -1, 0.5))).toBeNull()
    expect(a.step(bar(2, 4.2, 1, 4))).toMatchObject({ kind: 'target', r: 2, exitPrice: 4 })
    expect(a.step(bar(3, 9, 9, 9))).toBeNull() // closed: nothing more happens
    const b = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 4 })
    expect(b.step(bar(1, 0.5, -2.5, -2))).toMatchObject({ kind: 'stop', r: -1, exitPrice: -2 })
    expect(openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 4 }).step(bar(1, 5, -3, 0))).toMatchObject({ kind: 'stop' })
  })

  it('tracks the open profit in R', () => {
    const t = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 6 })
    t.step(bar(1, 1.2, -0.2, 1)); expect(t.openR).toBeCloseTo(0.5, 9)
    const s = openTrade({ direction: -1, entryPrice: 0, stop: 2, target: 6 })
    s.step(bar(1, 0.2, -1.2, -1)); expect(s.openR).toBeCloseTo(0.5, 9)
  })

  it('trails to cost only while in profit and behind the entry, and it counts as an override', () => {
    const t = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 6 })
    expect(t.trailToCost()).toBe(false) // nothing has traded yet
    t.step(bar(1, 0.4, -0.5, -0.3)); expect(t.trailToCost()).toBe(false) // in loss
    t.step(bar(2, 1.5, 0, 1)); expect(t.trailToCost()).toBe(true)
    expect(t.stopPrice).toBe(0); expect(t.overrides).toBe(1)
    expect(t.trailToCost()).toBe(false) // already there
    expect(t.step(bar(3, 0.5, -0.1, 0))).toMatchObject({ kind: 'stop', exitPrice: 0, r: 0 })
  })

  it('locks a share of the open profit and the stop only ever improves', () => {
    const t = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 9 })
    t.step(bar(1, 4.1, 0, 4)); expect(t.lock(0.5)).toBe(true); expect(t.stopPrice).toBe(2)
    t.step(bar(2, 4, 2.5, 3)); expect(t.lock(0.5)).toBe(false) // 3 x 0.5 = 1.5 would move the stop back
    expect(t.stopPrice).toBe(2)
    expect(t.lock(0)).toBe(false); expect(t.lock(1)).toBe(false)
    expect(t.step(bar(3, 3, 1.9, 2))).toMatchObject({ kind: 'stop', exitPrice: 2 })
  })

  it('works for a short trade', () => {
    const t = openTrade({ direction: -1, entryPrice: 0, stop: 2, target: 9 })
    t.step(bar(1, 0.1, -3.9, -4)); expect(t.openR).toBeCloseTo(2, 9)
    expect(t.lock(0.5)).toBe(true); expect(t.stopPrice).toBe(-2)
    expect(t.step(bar(2, -1.5, -4, -3))).toMatchObject({ kind: 'stop', exitPrice: -2 })
  })

  it('exit leaves at the last price as an override; expire closes at the horizon without one', () => {
    const a = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 6 })
    a.step(bar(1, 1.5, 0, 1.2))
    expect(a.exit(7)).toMatchObject({ kind: 'manual', exitSec: 7, exitPrice: 1.2 }); expect(a.overrides).toBe(1); expect(a.closed).not.toBeNull(); expect(a.exit(8)).toBeNull()
    const b = openTrade({ direction: 1, entryPrice: 0, stop: 2, target: 6 })
    b.step(bar(1, 1.5, 0, 1.2))
    expect(b.expire(9)).toMatchObject({ kind: 'horizon', exitPrice: 1.2 }); expect(b.overrides).toBe(0)
  })
})
