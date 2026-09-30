import { describe, expect, it } from 'vitest'
import { positionPnlLevels, projectedPositionPnl } from './positionPnlLevels'
import { positionPnlLevels as websiteLevels, projectedTotalPnlPctAtTarget as websiteTotalAtTarget } from '../../frontend/src/indicators/positionPnlLevels'
import { projectedTotalPnlPctAtTarget } from './positionPnlLevels'

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

  it('includes entry charges, exit STT and exchange charges, and brokerage', () => {
    const long = { side: 'LONG' as const, quantity: 50, avg_entry_price: 200, entry_commission: 4 }
    const short = { ...long, side: 'SHORT' as const }
    expect(projectedPositionPnl(long, 200, 2)).toBeCloseTo(-19.33, 4)
    expect(projectedPositionPnl(short, 200, 2)).toBeCloseTo(-6.6803, 4)
  })

  it('projects total P&L at the target without double-counting the current position mark', () => {
    const position = { side: 'LONG' as const, quantity: 10, avg_entry_price: 100, entry_commission: 2 }
    const desktop = projectedTotalPnlPctAtTarget(position, 110, 120, 500, 10000, 1)
    const website = websiteTotalAtTarget(position, 110, 120, 500, 10000, 1)
    expect(desktop).toBeCloseTo(5.974, 2)
    expect(website).toBe(desktop)
    expect(projectedTotalPnlPctAtTarget(position, 110, 120, 500, 0, 1)).toBeNull()
  })
})
