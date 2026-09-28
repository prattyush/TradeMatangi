import type { DesktopPosition, DesktopStrategy, DesktopTradingSettings } from './contracts'

/** The same gross, session-capital percentage used by chart stop-loss lines. */
export function targetProfitLabel(
  strategy: DesktopStrategy,
  position: DesktopPosition | null,
  settings: DesktopTradingSettings | null,
  sessionCapital: number,
): string | null {
  if (strategy.strategy_type !== 'TargetProfit' || settings?.desktop_pnl_display_mode !== 'percent') return null
  if (!position || position.side === 'FLAT' || position.quantity <= 0 || sessionCapital <= 0) return null
  if (typeof strategy.price !== 'number' || !Number.isFinite(strategy.price)) return null
  const direction = position.side === 'LONG' ? 1 : -1
  const pnl = direction * (strategy.price - position.avg_entry_price) * position.quantity
  return `TP ${pnl >= 0 ? '+' : ''}${((pnl / sessionCapital) * 100).toFixed(1)}%`
}
