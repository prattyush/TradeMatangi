import type { DesktopOrder, DesktopPosition, DesktopTradingSettings } from './contracts'
import { projectedTotalPnlAtTarget } from './positionPnlLevels'

export const orderPrice = (order: DesktopOrder) => order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price
export const compactQty = (value: number) => value >= 100000 ? `${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L` : value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K` : String(value)

/**
 * Exit orders read `SL <qty> <this order> | <whole position> | <session>` (P&L at the line price);
 * pass no currentPrice/totalPnl (e.g. the selected-order popup) to keep it to the order's own figure.
 */
export const orderLineLabel = (order: DesktopOrder, position?: DesktopPosition | null, settings?: DesktopTradingSettings | null, sessionCapital = 0, currentPrice?: number, totalPnl?: number, brokeragePerOrder = 1, compact = false) => {
  const qty = compactQty(order.quantity)
  const isSl = order.order_type === 'STOPLOSS' || order.is_stoploss
  if (position && position.side !== 'FLAT' && ((position.side === 'LONG' && order.side === 'SELL') || (position.side === 'SHORT' && order.side === 'BUY'))) {
    const dir = position.side === 'LONG' ? 1 : -1
    const price = orderPrice(order)
    const percent = settings?.desktop_pnl_display_mode === 'percent'
    const base = Math.max(1, sessionCapital)
    const fmt = (pnl: number) => percent ? `${pnl >= 0 ? '+' : ''}${((pnl / base) * 100).toFixed(1)}%` : `${pnl >= 0 ? '+' : ''}${Math.round(pnl)}`
    const parts = [fmt(dir * (price - position.avg_entry_price) * Math.min(order.quantity, position.quantity))]
    if (!compact) {
      parts.push(fmt(dir * (price - position.avg_entry_price) * position.quantity))
      const session = currentPrice !== undefined && totalPnl !== undefined ? projectedTotalPnlAtTarget(position, currentPrice, price, totalPnl, brokeragePerOrder) : null
      if (session !== null) parts.push(fmt(session))
    }
    return `${isSl ? 'SL' : order.order_type === 'LIMIT' ? 'L' : 'T'}${isSl ? ` ${qty}` : ''} ${parts.join(' | ')}`
  }
  return `${order.side === 'BUY' ? 'B' : 'S'}${order.order_type === 'LIMIT' ? 'L' : order.order_type === 'STOPLOSS' ? 'SL' : 'T'} ${qty}`
}
