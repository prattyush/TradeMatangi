import type { DesktopPosition, DesktopStrategy, DesktopTradingSettings } from './contracts'

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
): string | null {
  if (strategy.strategy_type !== 'TargetProfit' || settings?.desktop_pnl_display_mode !== 'percent') return null
  if (!position || position.side === 'FLAT' || position.quantity <= 0 || sessionCapital <= 0) return null
  if (strategy.target_profit_is_pct && typeof strategy.target_profit_value === 'number') {
    return `TP +${strategy.target_profit_value.toFixed(1)}%`
  }
  if (typeof strategy.price !== 'number' || !Number.isFinite(strategy.price)) return null
  const direction = position.side === 'LONG' ? 1 : -1
  const pnl = direction * (strategy.price - position.avg_entry_price) * position.quantity
  return `TP ${pnl >= 0 ? '+' : ''}${((pnl / sessionCapital) * 100).toFixed(1)}%`
}
