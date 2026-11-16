import { describe, expect, it } from 'vitest'
import { computeLevels, dayVolUnit, LEVEL_KINDS, LEVEL_LABEL, OPENING_RANGE_SEC, swingPoints } from './levels'
import type { Bars } from './series'

const OPEN = 33_300
/** One minute bars from [open, high, low, close] rows starting at `start`. */
const minutes = (rows: Array<[number, number, number, number]>, start = OPEN): Bars => ({ t: rows.map((_, i) => start + i * 60), o: rows.map(r => r[0]), h: rows.map(r => r[1]), l: rows.map(r => r[2]), c: rows.map(r => r[3]) })
const flat = (n: number, price: number, start = OPEN): Bars => minutes(Array.from({ length: n }, () => [price, price + 1, price - 1, price] as [number, number, number, number]), start)

describe('computeLevels', () => {
  const prior = minutes([[100, 110, 95, 105], [105, 120, 100, 115], [115, 118, 90, 92]])
  const today = minutes(Array.from({ length: 40 }, (_, i) => [200 + i, 203 + i, 198 + i, 201 + i] as [number, number, number, number]))
  const levels = computeLevels(prior, today, OPEN, 50)!
  it('takes the prior day high, low and close', () => { expect(levels.values.prior_high).toBe(120); expect(levels.values.prior_low).toBe(90); expect(levels.values.prior_close).toBe(92) })
  it('takes today\'s open, high and low so far', () => { expect(levels.values.today_open).toBe(200); expect(levels.values.today_high).toBe(242); expect(levels.values.today_low).toBe(198) })
  it('the opening range is the first 15 minutes only', () => { expect(OPENING_RANGE_SEC).toBe(900); expect(levels.values.or_high).toBe(203 + 14); expect(levels.values.or_low).toBe(198) })
  it('the VWAP-like level is the mean typical price and the round number is the nearest multiple of the step', () => {
    const typical = today.t.map((_, i) => (today.h[i] + today.l[i] + today.c[i]) / 3); expect(levels.values.vwap).toBeCloseTo(typical.reduce((a, b) => a + b, 0) / 40, 9)
    expect(levels.price).toBe(240); expect(levels.values.round).toBe(250); expect(computeLevels(prior, today, OPEN, 100)!.values.round).toBe(200)
  })
  it('has a value and a label for every kind', () => { for (const k of LEVEL_KINDS) { expect(Number.isFinite(levels.values[k])).toBe(true); expect(LEVEL_LABEL[k].length).toBeGreaterThan(5) } })
  it('refuses missing data and a day with no opening range', () => {
    expect(computeLevels(minutes([]), today, OPEN, 50)).toBeNull(); expect(computeLevels(prior, minutes([]), OPEN, 50)).toBeNull()
    expect(computeLevels(prior, flat(10, 100, OPEN + 3600), OPEN, 50)).toBeNull()
  })
  it('does not look ahead: more bars after the round time are not part of the answer unless they are passed in', () => {
    const early = computeLevels(prior, minutes(Array.from({ length: 30 }, (_, i) => [200 + i, 203 + i, 198 + i, 201 + i] as [number, number, number, number])), OPEN, 50)!
    expect(early.values.today_high).toBe(232); expect(levels.values.today_high).toBe(242)
  })
})

describe('dayVolUnit', () => {
  it('is the median 5 minute range of both days, floored', () => {
    expect(dayVolUnit(flat(30, 100), flat(30, 200), 0)).toBeCloseTo(2 + 4 * 0, 9) // each bar spans 2, so a 5 minute bar spans 2
    expect(dayVolUnit(flat(30, 100), flat(30, 200), 7)).toBe(7); expect(dayVolUnit(minutes([]), minutes([]), 3)).toBe(3)
  })
  it('ignores a single wild bar (median)', () => {
    const rows = Array.from({ length: 60 }, () => [100, 101, 99, 100] as [number, number, number, number]); rows[22] = [100, 190, 99, 100]
    expect(dayVolUnit(minutes(rows), flat(30, 100), 0)).toBeLessThan(5)
  })
})

describe('swingPoints', () => {
  const zig = (closes: number[]): Bars => ({ t: closes.map((_, i) => OPEN + i * 60), o: closes, h: closes.map(c => c + 0.5), l: closes.map(c => c - 0.5), c: closes })
  it('finds alternating highs and lows once the price has moved the threshold', () => {
    const closes = [100, 104, 108, 112, 109, 105, 101, 98, 103, 109, 115, 111, 106, 100]
    const swings = swingPoints(zig(closes), 8)
    expect(swings.map(s => s.type)).toEqual(['low', 'high', 'low', 'high'])
    expect(swings[0].price).toBeCloseTo(99.5, 9); expect(swings[1].price).toBeCloseTo(112.5, 9); expect(swings[2].price).toBeCloseTo(97.5, 9); expect(swings[3].price).toBeCloseTo(115.5, 9)
    for (let i = 1; i < swings.length; i++) { expect(swings[i].type).not.toBe(swings[i - 1].type); expect(swings[i].t).toBeGreaterThan(swings[i - 1].t) }
  })
  it('does not call a move smaller than the threshold a swing, and a flat or short series has none', () => {
    expect(swingPoints(zig([100, 101, 100, 101, 100, 101, 100]), 8)).toEqual([]); expect(swingPoints(zig([100]), 5)).toEqual([]); expect(swingPoints(zig([100, 110]), 0)).toEqual([])
  })
  it('leaves out the last, unconfirmed extreme', () => {
    expect(swingPoints(zig([100, 106, 112, 118, 124]), 8).map(s => s.type)).toEqual(['low'])
  })
  it('works for a series that starts by falling', () => {
    const swings = swingPoints(zig([120, 114, 108, 102, 108, 114, 120]), 8)
    expect(swings.map(s => s.type)).toEqual(['high', 'low']); expect(swings[0].price).toBeCloseTo(120.5, 9)
  })
})
