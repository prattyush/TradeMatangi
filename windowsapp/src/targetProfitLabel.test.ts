import { describe, expect, it } from 'vitest'
import type { DesktopPosition, DesktopStrategy, DesktopTradingSettings } from './contracts'
import { targetProfitLabel } from './targetProfitLabel'

const settings = { desktop_pnl_display_mode: 'percent' } as DesktopTradingSettings
const strategy = { strategy_type: 'TargetProfit', price: 120 } as DesktopStrategy
const long = { side: 'LONG', quantity: 65, avg_entry_price: 100 } as DesktopPosition

describe('take profit line P&L', () => {
  it('projects the entire long position against session capital', () => {
    expect(targetProfitLabel(strategy, long, settings, 100_000)).toBe('TP +1.3%')
    expect(targetProfitLabel({ ...strategy, price: 80 }, long, settings, 100_000)).toBe('TP -1.3%')
  })

  it('appends projected total P&L including earlier realized results and exit charges', () => {
    expect(targetProfitLabel(strategy, long, settings, 100_000, 120, 100, 5_000, 1)).toBe('TP +1.3% / +6.3%')
    expect(targetProfitLabel({ ...strategy, price: 80 }, { ...long, side: 'SHORT' }, settings, 100_000, 80, 100, -5_000, 1)).toBe('TP +1.3% / -3.7%')
  })

  it('uses short position direction and changes with the position', () => {
    const short = { ...long, side: 'SHORT' as const, quantity: 100 }
    expect(targetProfitLabel({ ...strategy, price: 80 }, short, settings, 100_000)).toBe('TP +2.0%')
    expect(targetProfitLabel(strategy, short, settings, 100_000)).toBe('TP -2.0%')
  })

  it('omits projections without a matching position or on an underlying target', () => {
    expect(targetProfitLabel(strategy, null, settings, 100_000)).toBeNull()
    expect(targetProfitLabel(strategy, { ...long, side: 'FLAT' }, settings, 100_000)).toBeNull()
    expect(targetProfitLabel(strategy, long, { ...settings, desktop_pnl_display_mode: 'currency' }, 100_000)).toBeNull()
    expect(targetProfitLabel({ ...strategy, strategy_type: 'UnderlyingTargetProfit' }, long, settings, 100_000)).toBeNull()
  })
})
