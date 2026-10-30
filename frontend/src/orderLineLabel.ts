import { projectedTotalPnlAtTarget, type LevelPosition } from './indicators/positionPnlLevels.ts'

function formatProjected(pnl: number, pnlPctMode?: boolean, sessionCapital?: number): string {
  if (pnlPctMode && sessionCapital && sessionCapital > 0) {
    const pct = (pnl / sessionCapital) * 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  }
  return `${pnl >= 0 ? '+' : ''}${Math.round(pnl)}`
}

/** `SL <this order> | <whole position> | <session>` for an exit order line at `price`. */
export function exitOrderLineLabel(
  typeLabel: string,
  price: number,
  orderQuantity: number,
  position: LevelPosition,
  pnlPctMode?: boolean,
  sessionCapital?: number,
  aggregatePnl?: number,
  currentPrice?: number,
  brokeragePerOrder = 0,
): string {
  const dir = position.side === 'LONG' ? 1 : -1
  const gross = (qty: number) => dir * (price - position.avg_entry_price) * qty
  const parts = [
    formatProjected(gross(Math.min(orderQuantity, position.quantity)), pnlPctMode, sessionCapital),
    formatProjected(gross(position.quantity), pnlPctMode, sessionCapital),
  ]
  const sessionPnl = aggregatePnl !== undefined && currentPrice !== undefined
    ? projectedTotalPnlAtTarget(position, currentPrice, price, aggregatePnl, brokeragePerOrder)
    : null
  if (sessionPnl !== null) parts.push(formatProjected(sessionPnl, pnlPctMode, sessionCapital))
  return `${typeLabel} ${parts.join(' | ')}`
}
