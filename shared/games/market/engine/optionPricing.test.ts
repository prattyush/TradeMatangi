import { describe, expect, it } from 'vitest'
import { blackScholes, daysToYears, normCdf, normPdf, RISK_FREE } from './optionPricing'

describe('normal distribution', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 14)
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 12)
    expect(normCdf(-1.96)).toBeCloseTo(0.024997895148220435, 12)
    expect(normCdf(3)).toBeCloseTo(0.9986501019683699, 12)
    expect(normCdf(-8) / 6.22096057427178e-16).toBeCloseTo(1, 6)
    expect(normCdf(40)).toBe(1); expect(normCdf(-40)).toBe(0)
    expect(normPdf(0)).toBeCloseTo(0.3989422804014327, 14)
  })
  it('is symmetric and increasing', () => {
    for (const x of [0.1, 0.7, 1.3, 2.5, 5]) expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 14)
    let last = -1
    for (let x = -6; x <= 6; x += 0.25) { const v = normCdf(x); expect(v).toBeGreaterThan(last); last = v }
  })
})

describe('Black-Scholes reference values (S=100, K=100, T=1, r=5%, vol=20%)', () => {
  const call = blackScholes(100, 100, 1, 0.2, 'CE', 0.05), put = blackScholes(100, 100, 1, 0.2, 'PE', 0.05)
  it('prices', () => { expect(call.price).toBeCloseTo(10.450583572185565, 9); expect(put.price).toBeCloseTo(5.573526022256971, 9) })
  it('delta and gamma', () => {
    expect(call.delta).toBeCloseTo(0.6368306511756191, 9); expect(put.delta).toBeCloseTo(-0.3631693488243809, 9)
    expect(call.gamma).toBeCloseTo(0.018762017345846895, 9); expect(put.gamma).toBeCloseTo(call.gamma, 12)
  })
  it('vega per volatility point and theta per day', () => {
    expect(call.vega).toBeCloseTo(0.3752403469169379, 9); expect(put.vega).toBeCloseTo(call.vega, 12)
    expect(call.theta).toBeCloseTo(-6.414027546438197 / 365, 9); expect(put.theta).toBeCloseTo(-1.6578804 / 365, 6)
  })
})

describe('properties', () => {
  const cases: Array<[number, number, number, number]> = [[24800, 24800, 5 / 365, 0.14], [24800, 25000, 1 / 365, 0.2], [24800, 24500, 2 / 365, 0.11], [100, 120, 0.5, 0.35], [100, 80, 3, 0.1]]
  it('put-call parity: C - P = S - K e^(-rT)', () => {
    for (const [s, k, t, v] of cases) {
      const c = blackScholes(s, k, t, v, 'CE').price, p = blackScholes(s, k, t, v, 'PE').price
      expect(c - p).toBeCloseTo(s - k * Math.exp(-RISK_FREE * t), 7)
    }
  })
  it('delta signs and bounds, gamma and vega positive, theta negative for a long option', () => {
    for (const [s, k, t, v] of cases) {
      const c = blackScholes(s, k, t, v, 'CE'), p = blackScholes(s, k, t, v, 'PE')
      expect(c.delta).toBeGreaterThan(0); expect(c.delta).toBeLessThan(1); expect(p.delta).toBeLessThan(0); expect(p.delta).toBeGreaterThan(-1)
      expect(c.delta - p.delta).toBeCloseTo(1, 12); expect(c.gamma).toBeGreaterThan(0); expect(c.vega).toBeGreaterThan(0)
      expect(c.theta).toBeLessThan(0.0001); expect(c.price).toBeGreaterThanOrEqual(0)
    }
  })
  it('Greeks agree with finite differences of the price', () => {
    const s = 24800, k = 24900, t = 3 / 365, v = 0.15, h = 0.5
    for (const right of ['CE', 'PE'] as const) {
      const f = (spot: number, years = t, vol = v) => blackScholes(spot, k, years, vol, right).price
      expect(blackScholes(s, k, t, v, right).delta).toBeCloseTo((f(s + h) - f(s - h)) / (2 * h), 6)
      expect(blackScholes(s, k, t, v, right).gamma).toBeCloseTo((f(s + h) - 2 * f(s) + f(s - h)) / (h * h), 6)
      expect(blackScholes(s, k, t, v, right).vega).toBeCloseTo((f(s, t, v + 0.0005) - f(s, t, v - 0.0005)) / 0.1, 5)
      expect(blackScholes(s, k, t, v, right).theta).toBeCloseTo((f(s, t - 1 / 365 / 1000) - f(s, t + 1 / 365 / 1000)) / 2 * 1000, 4)
    }
  })
  it('a call is worth more with a lower strike and a put with a higher one; more time and volatility cost more', () => {
    expect(blackScholes(100, 95, 0.1, 0.2, 'CE').price).toBeGreaterThan(blackScholes(100, 105, 0.1, 0.2, 'CE').price)
    expect(blackScholes(100, 105, 0.1, 0.2, 'PE').price).toBeGreaterThan(blackScholes(100, 95, 0.1, 0.2, 'PE').price)
    expect(blackScholes(100, 100, 0.2, 0.2, 'CE').price).toBeGreaterThan(blackScholes(100, 100, 0.1, 0.2, 'CE').price)
    expect(blackScholes(100, 100, 0.1, 0.3, 'PE').price).toBeGreaterThan(blackScholes(100, 100, 0.1, 0.2, 'PE').price)
  })
})

describe('edges', () => {
  it('at expiry the premium is intrinsic with a clean delta and no NaN', () => {
    expect(blackScholes(105, 100, 0, 0.2, 'CE')).toEqual({ price: 5, delta: 1, gamma: 0, theta: 0, vega: 0 })
    expect(blackScholes(95, 100, 0, 0.2, 'CE')).toEqual({ price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 })
    expect(blackScholes(95, 100, -1, 0.2, 'PE')).toEqual({ price: 5, delta: -1, gamma: 0, theta: 0, vega: 0 })
    expect(blackScholes(100, 100, 0.1, 0, 'CE').price).toBe(0)
  })
  it('bad inputs give zeros, not NaN', () => {
    for (const bad of [[0, 100], [100, 0], [Number.NaN, 100]] as const) {
      const g = blackScholes(bad[0], bad[1], 0.1, 0.2, 'CE'); for (const v of Object.values(g)) expect(Number.isFinite(v)).toBe(true)
    }
  })
  it('a deep out-of-the-money option on the last day is nearly worthless, a deep in-the-money one is intrinsic plus a little', () => {
    expect(blackScholes(24800, 25500, 1 / 365, 0.14, 'CE').price).toBeLessThan(0.01)
    expect(blackScholes(24800, 24000, 1 / 365, 0.14, 'CE').price).toBeCloseTo(800 + 24000 * (1 - Math.exp(-RISK_FREE / 365)), 2)
    expect(daysToYears(365)).toBe(1)
  })
})
