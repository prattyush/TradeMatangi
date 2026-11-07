import { describe, expect, it } from 'vitest'
import { positionPnlLevels, projectedPositionPnl } from './positionPnlLevels'
import { positionPnlLevels as websiteLevels, projectedTotalPnlPctAtTarget as websiteTotalAtTarget } from '../../frontend/src/indicators/positionPnlLevels'
import { projectedTotalPnlAtTarget, projectedTotalPnlPctAtTarget, pnlTargetLevels, parsePnlTargets } from './positionPnlLevels'
import { pnlTargetLevels as websiteTargetLevels, parsePnlTargets as websiteParse } from '../../frontend/src/indicators/positionPnlLevels'

describe('position P&L levels', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    it(`places ${side} targets at net session-capital percentages`, () => {
      const position = { side, quantity: 50, avg_entry_price: 200, entry_commission: 4 }
      const levels = positionPnlLevels(position, 100000, 2)
      expect(levels).toHaveLength(9)
      expect(levels[0].price).toBe(200)
      expect(levels[0].label).toBe('Avg entry')
      expect(levels.slice(1).map(level => level.label)).toEqual(['-4.5%', '-3%', '-2%', '-1%', '+1%', '+2%', '+3%', '+4.5%'])
      expect(projectedPositionPnl(position, 200, 2)).toBeLessThan(0)
      for (const level of levels.slice(1)) {
        const target = Number(level.key) / 100 * 100000
        expect(Math.abs(projectedPositionPnl(position, level.price, 2) - target)).toBeLessThanOrEqual(0.26)
        expect((level.price - 200) * (side === 'LONG' ? 1 : -1) * Math.sign(target)).toBeGreaterThan(0)
      }
      expect(websiteLevels(position, 100000, 2)).toEqual(levels)
    })
  }

  it('hides the indicator for flat positions and invalid capital', () => {
    expect(positionPnlLevels({ side: 'FLAT', quantity: 0, avg_entry_price: 0, entry_commission: 0 }, 100000, 1)).toEqual([])
    expect(positionPnlLevels({ side: 'LONG', quantity: 1, avg_entry_price: 100, entry_commission: 1 }, 0, 1)).toEqual([])
  })

  it('recomputes levels after average entry and quantity change', () => {
    const first = positionPnlLevels({ side: 'LONG', quantity: 20, avg_entry_price: 100, entry_commission: 2 }, 10000, 1)
    const scaled = positionPnlLevels({ side: 'LONG', quantity: 40, avg_entry_price: 110, entry_commission: 4 }, 10000, 1)
    expect(first.find(level => level.key === '1')?.price).not.toBe(scaled.find(level => level.key === '1')?.price)
  })

  it('includes entry charges, exit statutory charges, and brokerage', () => {
    const long = { side: 'LONG' as const, quantity: 50, avg_entry_price: 200, entry_commission: 4 }
    const short = { ...long, side: 'SHORT' as const }
    expect(projectedPositionPnl(long, 200, 2)).toBeCloseTo(-25.5643, 4)
    expect(projectedPositionPnl(short, 200, 2)).toBeCloseTo(-10.8643, 4)
  })

  it('projects total P&L at the target without double-counting the current position mark', () => {
    const position = { side: 'LONG' as const, quantity: 10, avg_entry_price: 100, entry_commission: 2 }
    const desktop = projectedTotalPnlPctAtTarget(position, 110, 120, 500, 10000, 1)
    const website = websiteTotalAtTarget(position, 110, 120, 500, 10000, 1)
    expect(desktop).toBeCloseTo(5.965, 2)
    expect(website).toBe(desktop)
    expect(projectedTotalPnlPctAtTarget(position, 110, 120, 500, 0, 1)).toBeNull()
  })
})


describe('target day P&L levels', () => {
  it('parses the comma-separated setting', () => {
    expect(parsePnlTargets('0,3, 6 ,,10,x,3')).toEqual([0, 3, 6, 10])
    expect(parsePnlTargets('')).toEqual([])
    expect(parsePnlTargets(undefined)).toEqual([])
    expect(websiteParse('0,3, 6 ,,10,x,3')).toEqual([0, 3, 6, 10])
  })

  for (const side of ['LONG', 'SHORT'] as const) {
    it(`${side}: each level makes the whole-day total hit the target, below/above entry follows the day P&L`, () => {
      const dir = side === 'LONG' ? 1 : -1
      const position = { side, quantity: 500, avg_entry_price: 200, entry_commission: 4 }
      const capital = 100000
      const current = 200 // freshly entered; the day's +6.9% is all booked P&L
      // Day is +6.9% of capital in total, including this open position's mark.
      const totalPnl = 6900
      const targets = [0, 3, 6, 10, 15, 18]
      const levels = pnlTargetLevels(position, current, totalPnl, capital, 2, targets, 'percent')
      expect(levels).toHaveLength(6)
      for (const [i, level] of levels.entries()) {
        const projected = projectedTotalPnlAtTarget(position, current, level.price, totalPnl, 2) as number
        expect(Math.abs(projected - targets[i] / 100 * capital)).toBeLessThanOrEqual(position.quantity * 0.005 + 0.01)
        // Targets under the current +6.9% sit on the losing side of the current price.
        const above = (level.price - current) * dir > 0
        expect(above).toBe(targets[i] > 6.9)
      }
      // 0, 3 and 6 are below (in P&L terms) the entry-based breakeven of the position alone.
      expect(levels.slice(0, 3).every(level => (level.price - 200) * dir < 0)).toBe(true)
      expect(levels.slice(3).every(level => (level.price - 200) * dir > 0)).toBe(true)
      expect(websiteTargetLevels(position, current, totalPnl, capital, 2, targets, 'percent')).toEqual(levels)
    })
  }

  it('treats the values as rupees in currency mode and ignores capital', () => {
    const position = { side: 'LONG' as const, quantity: 10, avg_entry_price: 100, entry_commission: 2 }
    const levels = pnlTargetLevels(position, 110, 500, 0, 1, [0, 1000], 'currency')
    expect(levels.map(level => level.label)).toEqual(['P&L 0', 'P&L +1000'])
    for (const level of levels) {
      const target = level.key === 'target:0' ? 0 : 1000
      expect(Math.abs((projectedTotalPnlAtTarget(position, 110, level.price, 500, 1) as number) - target)).toBeLessThanOrEqual(0.06)
    }
  })

  it('returns nothing without an active position or usable inputs', () => {
    const flat = { side: 'FLAT' as const, quantity: 0, avg_entry_price: 0, entry_commission: 0 }
    const long = { side: 'LONG' as const, quantity: 10, avg_entry_price: 100, entry_commission: 2 }
    expect(pnlTargetLevels(flat, 100, 0, 1000, 1, [1], 'percent')).toEqual([])
    expect(pnlTargetLevels(null, 100, 0, 1000, 1, [1], 'percent')).toEqual([])
    expect(pnlTargetLevels(long, 100, 0, 0, 1, [1], 'percent')).toEqual([])
    expect(pnlTargetLevels(long, 0, 0, 1000, 1, [1], 'percent')).toEqual([])
    expect(pnlTargetLevels(long, 100, 0, 1000, 1, [], 'percent')).toEqual([])
    // A short target that would need a non-positive price is dropped.
    const short = { side: 'SHORT' as const, quantity: 10, avg_entry_price: 100, entry_commission: 2 }
    expect(pnlTargetLevels(short, 100, 0, 1000, 1, [1e9], 'currency')).toEqual([])
  })
})
