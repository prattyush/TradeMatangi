export interface LevelPosition {
  side: 'LONG' | 'SHORT' | 'FLAT'
  quantity: number
  avg_entry_price: number
  entry_commission: number
}

export interface PositionPnlLevel {
  key: string
  label: string
  price: number
  color: string
}

export const POSITION_PNL_TARGETS = [-4.5, -3, -2, -1, 1, 2, 3, 4.5] as const

// Keep the fee rates aligned with backend/app/services/trading.py:compute_commission.
export function projectedPositionPnl(position: LevelPosition, price: number, brokeragePerOrder: number): number {
  const direction = position.side === 'LONG' ? 1 : position.side === 'SHORT' ? -1 : 0
  if (!direction || price <= 0 || position.quantity <= 0) return 0
  const exitRate = direction === 1 ? (0.0625 + 1.18 * 0.06) / 100 : 0.006803 / 100
  const exitCommission = Math.round((price * position.quantity * exitRate + brokeragePerOrder) * 10000) / 10000
  return direction * position.quantity * (price - position.avg_entry_price) - position.entry_commission - exitCommission
}

export function projectedTotalPnlPctAtTarget(position: LevelPosition, currentPrice: number, targetPrice: number, totalPnl: number, sessionCapital: number, brokeragePerOrder: number): number | null {
  const direction = position.side === 'LONG' ? 1 : position.side === 'SHORT' ? -1 : 0
  if (!direction || position.quantity <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(totalPnl) || !Number.isFinite(sessionCapital) || sessionCapital <= 0 || !Number.isFinite(brokeragePerOrder) || brokeragePerOrder < 0) return null
  const exitRate = direction === 1 ? (0.0625 + 1.18 * 0.06) / 100 : 0.006803 / 100
  const exitCommission = Math.round((targetPrice * position.quantity * exitRate + brokeragePerOrder) * 10000) / 10000
  return (totalPnl + direction * position.quantity * (targetPrice - currentPrice) - exitCommission) / sessionCapital * 100
}

export function positionPnlLevels(position: LevelPosition | null | undefined, sessionCapital: number, brokeragePerOrder: number): PositionPnlLevel[] {
  if (!position || position.side === 'FLAT' || !Number.isFinite(position.quantity) || position.quantity <= 0 || !Number.isFinite(position.avg_entry_price) || position.avg_entry_price <= 0 || !Number.isFinite(position.entry_commission) || !Number.isFinite(sessionCapital) || sessionCapital <= 0 || !Number.isFinite(brokeragePerOrder) || brokeragePerOrder < 0) return []
  const direction = position.side === 'LONG' ? 1 : -1
  const exitRate = direction === 1 ? (0.0625 + 1.18 * 0.06) / 100 : 0.006803 / 100
  const levels: PositionPnlLevel[] = [{ key: 'entry', label: 'Avg entry', price: position.avg_entry_price, color: '#e6edf3' }]
  for (const target of POSITION_PNL_TARGETS) {
    const targetPnl = target / 100 * sessionCapital
    // Solve the linear fee model, then search adjacent paise to account for backend fee rounding.
    const denominator = position.quantity * (direction - exitRate)
    if (Math.abs(denominator) < 1e-12) continue
    const estimate = (targetPnl + direction * position.quantity * position.avg_entry_price + position.entry_commission + brokeragePerOrder) / denominator
    if (!Number.isFinite(estimate) || estimate <= 0) continue
    const candidates = [Math.floor(estimate * 100), Math.ceil(estimate * 100)]
      .flatMap(paise => [paise - 1, paise, paise + 1])
      .filter(paise => paise > 0)
    const bestPaise = candidates.reduce((best, paise) => {
      const error = Math.abs(projectedPositionPnl(position, paise / 100, brokeragePerOrder) - targetPnl)
      const bestError = Math.abs(projectedPositionPnl(position, best / 100, brokeragePerOrder) - targetPnl)
      return error < bestError ? paise : best
    }, candidates[0])
    const price = bestPaise / 100
    levels.push({ key: String(target), label: `${target > 0 ? '+' : ''}${target}%`, price, color: target > 0 ? '#22c55e' : '#ef4444' })
  }
  return levels
}
