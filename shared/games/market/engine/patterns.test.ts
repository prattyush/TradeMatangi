import { describe, expect, it } from 'vitest'
import { breakoutTruth, detectPattern, findBreakouts, huntF1, nearMisses, PATTERN_HELP, PATTERN_KINDS, PATTERN_LABEL, type Breakout } from './patterns'
import type { Bars } from './series'

/** Bars from [open, high, low, close] rows, 5 seconds apart. Volume unit 1 throughout, so a 1.0 range is one typical bar. */
const mk = (rows: Array<[number, number, number, number]>): Bars => ({ t: rows.map((_, i) => i * 5), o: rows.map(r => r[0]), h: rows.map(r => r[1]), l: rows.map(r => r[2]), c: rows.map(r => r[3]) })
const calm = (n: number, price = 100): Array<[number, number, number, number]> => Array.from({ length: n }, () => [price, price + 0.3, price - 0.3, price])

describe('inside-bar break', () => {
  it('finds the bar that closes beyond the mother bar after an inside bar', () => {
    const bars = mk([...calm(4), [100, 102, 99, 101], [100.8, 101.5, 99.6, 100.9], [101, 103, 100.5, 102.6], ...calm(2, 102)])
    expect(detectPattern('inside_break', bars, 1)).toEqual([6]) // bar 4 is the mother, 5 the inside bar, 6 closes above 102? close 102.6 > 102
  })
  it('also finds a break downwards', () => {
    expect(detectPattern('inside_break', mk([...calm(3), [100, 102, 99, 100.5], [100.4, 101.5, 99.5, 100], [100, 100.4, 97.5, 98], ...calm(2, 98)]), 1)).toEqual([5])
  })
  it('does not count a small mother bar, or an inside bar that is followed by a bar still inside', () => {
    expect(detectPattern('inside_break', mk([...calm(3), [100, 100.4, 99.8, 100.1], [100.1, 100.3, 99.9, 100], [100, 100.9, 99.9, 100.8]]), 1)).toEqual([])
    expect(detectPattern('inside_break', mk([...calm(3), [100, 102, 99, 101], [100.8, 101.5, 99.6, 100.9], [101, 101.8, 99.8, 101.2]]), 1)).toEqual([])
  })
  it('a mother bar of 0.7 is a near miss, not an occurrence', () => {
    const rows: Array<[number, number, number, number]> = [...calm(3), [100, 100.8, 100.1 - 0.0, 100.5], [100.4, 100.7, 100.2, 100.3], [100.3, 101.2, 100.3, 101.0], ...calm(2, 101)]
    rows[3] = [100, 100.8, 100.1, 100.5] // range 0.7
    const bars = mk(rows)
    expect(detectPattern('inside_break', bars, 1)).toEqual([]); expect(detectPattern('inside_break', bars, 1, true)).toEqual([5]); expect(nearMisses('inside_break', bars, 1)).toEqual([5])
  })
})

describe('engulfing', () => {
  it('finds a body that covers the previous body in the opposite colour', () => {
    expect(detectPattern('engulfing', mk([...calm(3), [100, 100.6, 99.9, 100.5], [100.7, 101.0, 99.2, 99.4], ...calm(2, 99.4)]), 1)).toEqual([4])
    expect(detectPattern('engulfing', mk([...calm(3), [100, 100.1, 99.4, 99.5], [99.3, 101.1, 99.2, 101], ...calm(2, 101)]), 1)).toEqual([4])
  })
  it('needs the opposite colour, a body big enough and a body that really covers the last one', () => {
    expect(detectPattern('engulfing', mk([...calm(3), [100, 100.6, 99.9, 100.5], [100.4, 101.4, 100.3, 101.3]]), 1)).toEqual([]) // same colour
    expect(detectPattern('engulfing', mk([...calm(3), [100, 100.6, 99.9, 100.5], [100.45, 100.5, 100.0, 100.05]]), 1)).toEqual([]) // body 0.4, too small
    expect(detectPattern('engulfing', mk([...calm(3), [100, 101.2, 99.9, 101], [100.9, 101.1, 99.9, 100.1]]), 1)).toEqual([]) // does not cover (opens inside)
  })
  it('a body of 0.45 is a near miss', () => {
    const bars = mk([...calm(3), [100, 100.6, 99.9, 100.5], [100.55, 100.6, 99.95, 100.0]])
    expect(detectPattern('engulfing', bars, 1)).toEqual([]); expect(nearMisses('engulfing', bars, 1)).toEqual([4])
  })
})

describe('pin bar', () => {
  it('finds a long upper wick at a new high, closing near the low (a rejection)', () => {
    const rows: Array<[number, number, number, number]> = [...Array.from({ length: 8 }, (_, i) => [100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.2 + i * 0.1] as [number, number, number, number]), [100.8, 102.2, 100.7, 100.9], ...calm(2, 100.9)]
    expect(detectPattern('pin_bar', mk(rows), 1)).toEqual([8])
  })
  it('and a long lower wick at a new low closing near the high', () => {
    const rows: Array<[number, number, number, number]> = [...Array.from({ length: 8 }, (_, i) => [100 - i * 0.1, 100.2 - i * 0.1, 99.6 - i * 0.1, 99.9 - i * 0.1] as [number, number, number, number]), [99.2, 99.3, 97.8, 99.1], ...calm(2, 99.1)]
    expect(detectPattern('pin_bar', mk(rows), 1)).toEqual([8])
  })
  it('a wick that is not at an extreme, or too short, or with a big body, is not one', () => {
    const base: Array<[number, number, number, number]> = Array.from({ length: 8 }, () => [100, 103, 99.8, 100.2])
    expect(detectPattern('pin_bar', mk([...base, [100.8, 102.2, 100.7, 100.9]]), 1)).not.toContain(8) // earlier bars went higher: no new high
    const rising: Array<[number, number, number, number]> = Array.from({ length: 8 }, (_, i) => [100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.2 + i * 0.1])
    expect(detectPattern('pin_bar', mk([...rising, [100.8, 101.4, 100.7, 100.9]]), 1)).toEqual([]) // wick 0.5: short
    expect(detectPattern('pin_bar', mk([...rising, [100.8, 102.2, 100.7, 102.0]]), 1)).toEqual([]) // closes at the high
  })
})

describe('higher-low sequence', () => {
  /** Bars whose lows follow the path (each bar a point above its low), so the pivots are exactly where the path turns. */
  const path = (lows: number[]): Bars => mk(lows.map(v => [v + 0.5, v + 1, v, v + 0.7] as [number, number, number, number]))
  const V = [105, 104, 103, 102, 103, 104, 105, 104, 103, 102.5, 103.5, 104.5, 105.5, 104.5, 103.5, 103, 104, 105]
  it('finds the third of three pivot lows that each rise', () => {
    expect(detectPattern('higher_low', path(V), 1)).toEqual([15])
  })
  it('needs each low to rise by enough: a rise of 0.1 is only a near miss', () => {
    const flat = [105, 104, 103, 102, 103, 104, 105, 104, 103, 102.1, 103.1, 104.1, 105.1, 104.1, 103.1, 102.2, 103.2, 104.2]
    expect(detectPattern('higher_low', path(flat), 1)).toEqual([]); expect(nearMisses('higher_low', path(flat), 1)).toEqual([15])
  })
  it('finds none in a falling or flat series, or where the lows fall', () => {
    expect(detectPattern('higher_low', path([103, 102, 101, 100, 99]), 1)).toEqual([]); expect(detectPattern('higher_low', mk(calm(20)), 1)).toEqual([])
    expect(detectPattern('higher_low', path([105, 104, 103, 102, 103, 104, 105, 104, 103, 101.5, 102.5, 103.5, 104.5, 103.5, 102.5, 101, 102, 103]), 1)).toEqual([])
  })
})

describe('general', () => {
  it('every pattern has a label and help text, and no detector fails on tiny or flat input', () => {
    for (const k of PATTERN_KINDS) { expect(PATTERN_LABEL[k].length).toBeGreaterThan(5); expect(PATTERN_HELP[k].length).toBeGreaterThan(30); expect(detectPattern(k, mk([]), 1)).toEqual([]); expect(detectPattern(k, mk(calm(2)), 1)).toEqual([]); expect(detectPattern(k, mk(calm(30)), 0)).toEqual([]); expect(Array.isArray(nearMisses(k, mk(calm(30)), 1))).toBe(true) }
  })
  it('loose finds everything strict finds', () => {
    const rows: Array<[number, number, number, number]> = []
    let p = 100; let s = 1
    for (let i = 0; i < 120; i++) { s = (s * 16807) % 2147483647; const move = ((s % 1000) / 1000 - 0.5) * 2; const o = p; p += move; rows.push([o, Math.max(o, p) + (s % 7) / 10, Math.min(o, p) - (s % 5) / 10, p]) }
    const bars = mk(rows)
    for (const k of PATTERN_KINDS) { const strict = detectPattern(k, bars, 1), loose = detectPattern(k, bars, 1, true); for (const i of strict) expect(loose).toContain(i) }
  })
})

describe('huntF1', () => {
  it('perfect, partial, wrong, and empty cases', () => {
    expect(huntF1([5, 20], [5, 20])).toMatchObject({ f1: 1, matched: 2 })
    const half = huntF1([5, 40], [5, 20]); expect(half.precision).toBe(0.5); expect(half.recall).toBe(0.5); expect(half.f1).toBe(0.5)
    expect(huntF1([1, 2, 3], [20]).f1).toBe(0); expect(huntF1([], [20]).f1).toBe(0); expect(huntF1([4], []).f1).toBe(0); expect(huntF1([], [])).toMatchObject({ f1: 1, matched: 0 })
  })
  it('a click within one bar counts, two bars away does not, and one occurrence is matched once', () => {
    expect(huntF1([6], [5]).f1).toBe(1); expect(huntF1([7], [5]).f1).toBe(0); expect(huntF1([4, 6], [5])).toMatchObject({ matched: 1, precision: 0.5, recall: 1 })
    expect(huntF1([5, 6, 7], [5, 7]).matched).toBe(2)
  })
  it('F1 is always 0..1 whatever is clicked', () => {
    for (let n = 0; n < 200; n++) { const clicks = Array.from({ length: n % 9 }, (_, i) => (i * 7 + n) % 60), truth = Array.from({ length: n % 5 }, (_, i) => (i * 11 + n * 3) % 60); const f = huntF1(clicks, truth); expect(f.f1).toBeGreaterThanOrEqual(0); expect(f.f1).toBeLessThanOrEqual(1) }
  })
})

describe('breakouts', () => {
  it('finds the first close beyond the highest high or lowest low of the last bars', () => {
    const rows = [...calm(10), [100, 101.4, 100, 101.3], [101.3, 102, 101.2, 101.9], ...calm(4, 101.9)]
    const found = findBreakouts(mk(rows as Array<[number, number, number, number]>), 8)
    expect(found[0]).toEqual({ index: 10, direction: 1, level: 100.3 }) // bar 11 closes beyond the new high of bar 10, which is a further break of its own
    const down = findBreakouts(mk([...calm(10), [100, 100.1, 98.5, 98.7]]), 8); expect(down).toEqual([{ index: 10, direction: -1, level: 99.7 }])
    expect(findBreakouts(mk(calm(20)), 8)).toEqual([]); expect(findBreakouts(mk(calm(5)), 8)).toEqual([])
  })
  const b: Breakout = { index: 0, direction: 1, level: 100 }
  const after = (rows: Array<[number, number, number, number]>): Bars => mk([[100, 100.5, 99.9, 100.2], ...rows])
  it('REAL when it extends before it comes back', () => {
    expect(breakoutTruth(after([[100.2, 101.2, 100.1, 101], [101, 102.2, 100.9, 102]]), b, 2, 0.5, 5)).toMatchObject({ real: true, extendedAt: 2, returnedAt: -1 })
    expect(breakoutTruth(after([[100.2, 101, 100.1, 100.9], [100.9, 102.5, 99.4, 99.5]]), b, 2, 0.5, 5)).toMatchObject({ real: true, extendedAt: 2, returnedAt: 2 }) // extended and returned in the same bar: extension first
  })
  it('FAKE when it falls back first, or never extends', () => {
    expect(breakoutTruth(after([[100.2, 100.6, 99.2, 99.4], [99.4, 103, 99.3, 102.5]]), b, 2, 0.5, 5)).toMatchObject({ real: false, returnedAt: 1, extendedAt: 2 })
    expect(breakoutTruth(after([[100.2, 101, 100.1, 100.8], [100.8, 101.4, 100.4, 101]]), b, 2, 0.5, 5)).toMatchObject({ real: false, extendedAt: -1, returnedAt: -1 })
    expect(breakoutTruth(after([[100.2, 101, 100.1, 100.8], [100.8, 101.4, 100.4, 101]]), b, 2, 0.5, 5).maxExtension).toBeCloseTo(1.4, 9)
  })
  it('works downwards and only looks at the horizon', () => {
    const d: Breakout = { index: 0, direction: -1, level: 100 }
    expect(breakoutTruth(mk([[100, 100.1, 99.5, 99.7], [99.7, 99.8, 97.8, 98]]), d, 2, 0.5, 5)).toMatchObject({ real: true, extendedAt: 1 })
    expect(breakoutTruth(after([[100.2, 100.5, 100, 100.3], [100.3, 104, 100.2, 103.9]]), b, 2, 0.5, 1)).toMatchObject({ real: false, extendedAt: -1 }) // the move comes after the horizon
  })
})
