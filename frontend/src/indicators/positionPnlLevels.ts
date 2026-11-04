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
  const exitRate = direction === 1 ? (0.15 + 1.18 * 0.03563) / 100 : (0.003 + 1.18 * 0.03563) / 100
  const exitCommission = Math.round((price * position.quantity * exitRate + 1.18 * brokeragePerOrder) * 10000) / 10000
  return direction * position.quantity * (price - position.avg_entry_price) - position.entry_commission - exitCommission
}

export function projectedTotalPnlAtTarget(position: LevelPosition, currentPrice: number, targetPrice: number, totalPnl: number, brokeragePerOrder: number): number | null {
  const direction = position.side === 'LONG' ? 1 : position.side === 'SHORT' ? -1 : 0
  if (!direction || position.quantity <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(totalPnl) || !Number.isFinite(brokeragePerOrder) || brokeragePerOrder < 0) return null
  const exitRate = direction === 1 ? (0.15 + 1.18 * 0.03563) / 100 : (0.003 + 1.18 * 0.03563) / 100
  const exitCommission = Math.round((targetPrice * position.quantity * exitRate + 1.18 * brokeragePerOrder) * 10000) / 10000
  return totalPnl + direction * position.quantity * (targetPrice - currentPrice) - exitCommission
}

export function projectedTotalPnlPctAtTarget(position: LevelPosition, currentPrice: number, targetPrice: number, totalPnl: number, sessionCapital: number, brokeragePerOrder: number): number | null {
  if (!Number.isFinite(sessionCapital) || sessionCapital <= 0) return null
  const value = projectedTotalPnlAtTarget(position, currentPrice, targetPrice, totalPnl, brokeragePerOrder)
  return value === null ? null : value / sessionCapital * 100
}

export function positionPnlLevels(position: LevelPosition | null | undefined, sessionCapital: number, brokeragePerOrder: number): PositionPnlLevel[] {
  if (!position || position.side === 'FLAT' || !Number.isFinite(position.quantity) || position.quantity <= 0 || !Number.isFinite(position.avg_entry_price) || position.avg_entry_price <= 0 || !Number.isFinite(position.entry_commission) || !Number.isFinite(sessionCapital) || sessionCapital <= 0 || !Number.isFinite(brokeragePerOrder) || brokeragePerOrder < 0) return []
  const direction = position.side === 'LONG' ? 1 : -1
  const exitRate = direction === 1 ? (0.15 + 1.18 * 0.03563) / 100 : (0.003 + 1.18 * 0.03563) / 100
  const levels: PositionPnlLevel[] = [{ key: 'entry', label: 'Avg entry', price: position.avg_entry_price, color: '#e6edf3' }]
  for (const target of POSITION_PNL_TARGETS) {
    const targetPnl = target / 100 * sessionCapital
    // Solve the linear fee model, then search adjacent paise to account for backend fee rounding.
    const denominator = position.quantity * (direction - exitRate)
    if (Math.abs(denominator) < 1e-12) continue
    const estimate = (targetPnl + direction * position.quantity * position.avg_entry_price + position.entry_commission + 1.18 * brokeragePerOrder) / denominator
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


export type PnlTargetMode = 'percent' | 'currency'

/** Parse the comma-separated Display setting; ignores blanks and non-numbers. */
export function parsePnlTargets(raw: string | null | undefined): number[] {
  if (!raw) return []
  const values: number[] = []
  for (const part of raw.split(',')) {
    const text = part.trim()
    if (!text) continue
    const value = Number(text)
    if (Number.isFinite(value) && !values.includes(value)) values.push(value)
  }
  return values
}

/**
 * Prices at which exiting the whole position makes the day's total P&L equal
 * each target (percent of session capital, or rupees). `totalPnl` is the day
 * total marked at `currentPrice`, net of booked commissions; the exit charge
 * is the same fee model as projectedTotalPnlAtTarget.
 */
export function pnlTargetLevels(
  position: LevelPosition | null | undefined,
  currentPrice: number,
  totalPnl: number,
  sessionCapital: number,
  brokeragePerOrder: number,
  targets: readonly number[],
  mode: PnlTargetMode,
): PositionPnlLevel[] {
  if (
    !position ||
    position.side === 'FLAT' ||
    !Number.isFinite(position.quantity) ||
    position.quantity <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isFinite(totalPnl) ||
    !Number.isFinite(brokeragePerOrder) ||
    brokeragePerOrder < 0 ||
    (mode === 'percent' && (!Number.isFinite(sessionCapital) || sessionCapital <= 0))
  )
    return []
  const direction = position.side === 'LONG' ? 1 : -1
  const exitRate =
    direction === 1
      ? (0.15 + 1.18 * 0.03563) / 100
      : (0.003 + 1.18 * 0.03563) / 100
  const denominator = position.quantity * (direction - exitRate)
  if (Math.abs(denominator) < 1e-12) return []
  const levels: PositionPnlLevel[] = []
  for (const target of targets) {
    const targetPnl = mode === 'percent' ? (target / 100) * sessionCapital : target
    const estimate =
      (targetPnl -
        totalPnl +
        direction * position.quantity * currentPrice +
        1.18 * brokeragePerOrder) /
      denominator
    if (!Number.isFinite(estimate) || estimate <= 0) continue
    const candidates = [Math.floor(estimate * 100), Math.ceil(estimate * 100)]
      .flatMap((paise) => [paise - 1, paise, paise + 1])
      .filter((paise) => paise > 0)
    const errorAt = (paise: number) =>
      Math.abs(
        (projectedTotalPnlAtTarget(position, currentPrice, paise / 100, totalPnl, brokeragePerOrder) ?? Infinity) -
          targetPnl,
      )
    const bestPaise = candidates.reduce(
      (best, paise) => (errorAt(paise) < errorAt(best) ? paise : best),
      candidates[0],
    )
    const sign = target > 0 ? '+' : ''
    levels.push({
      key: `target:${target}`,
      label: mode === 'percent' ? `P&L ${sign}${target}%` : `P&L ${sign}${target}`,
      price: bestPaise / 100,
      color: target >= 0 ? '#38bdf8' : '#f472b6',
    })
  }
  return levels
}
