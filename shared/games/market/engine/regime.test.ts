import { describe, expect, it } from 'vitest'
import { classifyRegime, lastDirection, REGIME_LABEL, REGIMES, SPIKE_MULT, TREND_ER, TREND_NET } from './regime'
import type { Bars } from './series'

/** One-second bars from a list of closes; high and low are one tick around the close, so ranges are small unless a test widens a bar. */
const bars = (closes: number[], widen: Record<number, number> = {}): Bars => ({
  t: closes.map((_, i) => i), o: closes.map((c, i) => (i ? closes[i - 1] : c)),
  h: closes.map((c, i) => c + 0.05 + (widen[i] ?? 0)), l: closes.map((c, i) => c - 0.05 - (widen[i] ?? 0)), c: closes,
})
const walk = (n: number, step: (i: number) => number, start = 100): number[] => { const out: number[] = []; let p = start; for (let i = 0; i < n; i++) { p += step(i); out.push(p) } return out }

describe('classifyRegime (vol unit 1, so 90 seconds is a standard move of about 4.2)', () => {
  it('a steady climb is a trend up and a steady fall a trend down', () => {
    expect(classifyRegime(bars(walk(90, () => 0.2)), 1, 90)).toMatchObject({ regime: 'trend_up' })
    expect(classifyRegime(bars(walk(90, () => -0.2)), 1, 90)).toMatchObject({ regime: 'trend_down' })
    expect(classifyRegime(bars(walk(90, () => 0.2)), 1, 90).netUnits).toBeGreaterThan(TREND_NET); expect(classifyRegime(bars(walk(90, () => 0.2)), 1, 90).er).toBeGreaterThan(TREND_ER)
  })
  it('going nowhere is a range, however much it moves in between', () => {
    expect(classifyRegime(bars(walk(90, i => (i % 2 ? 0.3 : -0.3))), 1, 90).regime).toBe('range')
    expect(classifyRegime(bars(Array.from({ length: 90 }, (_, i) => 100 + 2 * Math.sin(i / 6))), 1, 90).regime).toBe('range')
    expect(classifyRegime(bars(Array.from({ length: 90 }, () => 100)), 1, 90).regime).toBe('range')
  })
  it('a net move that is too small for the stretch is a range, not a trend', () => {
    expect(classifyRegime(bars(walk(90, () => 0.02)), 1, 90).regime).toBe('range') // 1.8 points: 0.4 of a standard move
  })
  it('a drift that is mostly whipsaw is not a trend even if the net move is big', () => {
    const noisy = walk(90, i => (i % 10 < 5 ? 1.6 : -1.45))
    const info = classifyRegime(bars(noisy), 1, 90)
    expect(info.er).toBeLessThan(TREND_ER); expect(info.regime).not.toBe('trend_up')
  })
  it('one very wide 5 second bar makes it a spike whatever else happened', () => {
    expect(classifyRegime(bars(walk(90, () => 0.2), { 40: 2.5 }), 1, 90)).toMatchObject({ regime: 'spike' })
    // a bar widened by w each side has a range of 2w + 0.1
    expect(classifyRegime(bars(walk(90, () => 0), { 10: SPIKE_MULT / 2 + 0.1 }), 1, 90).regime).toBe('spike')
    expect(classifyRegime(bars(walk(90, () => 0), { 10: SPIKE_MULT / 2 - 0.2 }), 1, 90).regime).toBe('range')
  })
  it('degenerate input is a range and never NaN', () => {
    for (const info of [classifyRegime(bars([]), 1, 90), classifyRegime(bars([100]), 1, 90), classifyRegime(bars(walk(30, () => 1)), 0, 30), classifyRegime(bars(walk(30, () => 1)), 1, 0)]) { expect(info.regime).toBe('range'); expect(Number.isFinite(info.er) && Number.isFinite(info.netUnits)).toBe(true) }
  })
  it('has four regimes with labels', () => { expect(REGIMES.length).toBe(4); for (const r of REGIMES) expect(REGIME_LABEL[r].length).toBeGreaterThan(3) })
})

describe('lastDirection', () => {
  it('looks at the last seconds only', () => {
    const closes = [...walk(60, () => 0.3), ...walk(30, () => -0.3, 118)]
    expect(lastDirection(bars(closes), 30)).toBe(-1); expect(lastDirection(bars(closes), 90)).toBe(1)
    expect(lastDirection(bars(walk(40, () => 0.1)), 30)).toBe(1)
  })
  it('is 0 when nothing moved or there is too little data', () => {
    expect(lastDirection(bars(Array.from({ length: 40 }, () => 100)), 30)).toBe(0); expect(lastDirection(bars([100]), 30)).toBe(0); expect(lastDirection(bars([]), 30)).toBe(0)
  })
})
