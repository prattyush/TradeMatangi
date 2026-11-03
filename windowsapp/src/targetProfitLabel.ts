import type { DesktopPosition, DesktopStrategy, DesktopTradingSettings } from './contracts'
import { projectedTotalPnlPctAtTarget } from './positionPnlLevels'

/** Resolve a percentage target to the equivalent NSE tick-aligned chart price. */
export function targetProfitLinePrice(
  strategy: DesktopStrategy,
  position: DesktopPosition | null,
  sessionCapital: number,
): number | null {
  if (strategy.strategy_type !== 'TargetProfit') return null
  if (!strategy.target_profit_is_pct) {
    return typeof strategy.price === 'number' && Number.isFinite(strategy.price) ? strategy.price : null
  }
  const percentage = strategy.target_profit_value
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage <= 0) return null
  if (!position || position.side === 'FLAT' || position.quantity <= 0 || sessionCapital <= 0) return null
  const direction = position.side === 'LONG' ? 1 : -1
  const rawPrice = position.avg_entry_price + direction * (percentage / 100 * sessionCapital) / position.quantity
  return Number((Math.ceil(Math.round(rawPrice / 0.05 * 1e10) / 1e10) * 0.05).toFixed(2))
}

/** The same gross, session-capital percentage used by chart stop-loss lines. */
export function targetProfitLabel(
  strategy: DesktopStrategy,
  position: DesktopPosition | null,
  settings: DesktopTradingSettings | null,
  sessionCapital: number,
  targetPrice: number | null = typeof strategy.price === 'number' ? strategy.price : null,
  currentPrice?: number,
  totalPnl?: number,
  brokeragePerOrder = 1,
): string | null {
  if (strategy.strategy_type !== 'TargetProfit' || settings?.desktop_pnl_display_mode !== 'percent') return null
  if (!position || position.side === 'FLAT' || position.quantity <= 0 || sessionCapital <= 0) return null
  if (strategy.target_profit_is_pct && typeof strategy.target_profit_value === 'number') {
    const totalPct = targetPrice !== null && currentPrice !== undefined && totalPnl !== undefined
      ? projectedTotalPnlPctAtTarget(position, currentPrice, targetPrice, totalPnl, sessionCapital, brokeragePerOrder)
      : null
    return `TP${strategy.target_profit_size ? ` ${strategy.target_profit_size === 'half' ? 'Half' : 'Full'}` : ''} +${strategy.target_profit_value.toFixed(1)}%${totalPct === null ? '' : ` / ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`}`
  }
  if (targetPrice === null || !Number.isFinite(targetPrice)) return null
  const direction = position.side === 'LONG' ? 1 : -1
  const pnl = direction * (targetPrice - position.avg_entry_price) * position.quantity
  const positionPct = `${pnl >= 0 ? '+' : ''}${((pnl / sessionCapital) * 100).toFixed(1)}%`
  const totalPct = currentPrice !== undefined && totalPnl !== undefined
    ? projectedTotalPnlPctAtTarget(position, currentPrice, targetPrice, totalPnl, sessionCapital, brokeragePerOrder)
    : null
  return `TP${strategy.target_profit_size ? ` ${strategy.target_profit_size === 'half' ? 'Half' : 'Full'}` : ''} ${positionPct}${totalPct === null ? '' : ` / ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`}`
}
