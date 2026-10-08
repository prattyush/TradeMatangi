import type { DesktopOrder, DesktopPosition, DesktopTradingSnapshot } from './contracts'

export const isStopOrder = (order: DesktopOrder) => order.is_stoploss || order.order_type === 'STOPLOSS'
export const orderBusy = (order: DesktopOrder) => ['prepared', 'modifying', 'submitting', 'unknown'].includes(order.split_operation?.state ?? '') || ['queued', 'modifying', 'cancelling', 'replacing', 'unknown'].includes(order.broker_conversion?.state ?? '')
export const orderContractKey = (order: Pick<DesktopOrder, 'symbol' | 'expiry' | 'strike' | 'right'>) => `${order.symbol}:${order.expiry ?? ''}:${order.strike ?? ''}:${order.right ?? ''}`

export function orderPosition(order: DesktopOrder, snapshot?: DesktopTradingSnapshot | null): DesktopPosition | null {
  if (!snapshot) return null
  return order.right ? snapshot.positions_by_contract[orderContractKey(order)] ?? null : snapshot.positions.equity
}

export function availableExitQuantity(order: DesktopOrder, position: DesktopPosition | null, orders: DesktopOrder[], excludeId?: string): number {
  if (!position || position.side === 'FLAT') return 0
  const side = position.side === 'LONG' ? 'SELL' : 'BUY'
  if (order.side !== side) return 0
  const covered = orders.filter(item => item.order_id !== excludeId && item.status === 'PENDING' && item.side === side && orderContractKey(item) === orderContractKey(order))
    .reduce((sum, item) => sum + Math.max(0, item.quantity - (item.broker_filled_quantity ?? 0)), 0)
  return Math.max(0, position.quantity - covered)
}

/** Change one increment, including off-grid drafts, without accumulating float error. */
export function incrementValue(raw: string, direction: number, step: number, min: number, max = Infinity): string {
  const current = Number(raw)
  const value = Number.isFinite(current) ? current : min
  const scaled = value / step
  const next = (direction > 0 ? Math.floor(scaled + 1e-8) + 1 : Math.ceil(scaled - 1e-8) - 1) * step
  return String(Math.round(Math.max(min, Math.min(max, next)) * 100000) / 100000)
}
