export interface RecoveryNotice {
  operationId: string
  state: 'pending' | 'restored' | 'needs_attention'
  message: string
}
export type RecoveryNotices = Record<string, RecoveryNotice>

export function recoveryContractKey(symbol: unknown, right: unknown, strike: unknown, expiry: unknown): string {
  return [symbol, right ?? 'EQ', strike ?? '', expiry ?? ''].join('|')
}

export function applyRecoveryEvent(previous: RecoveryNotices, event: Record<string, unknown>): RecoveryNotices {
  if (typeof event.symbol !== 'string' || typeof event.operation_id !== 'string') return previous
  const key = recoveryContractKey(event.symbol, event.right, event.strike, event.expiry)
  if (event.state === 'cleared') {
    if (!previous[key] || (event.operation_id && previous[key].operationId !== event.operation_id)) return previous
    const next = { ...previous }
    delete next[key]
    return next
  }
  if ((event.state !== 'pending' && event.state !== 'restored' && event.state !== 'needs_attention') || typeof event.message !== 'string') return previous
  return { ...previous, [key]: { operationId: event.operation_id, state: event.state, message: event.message } }
}

export function pruneRecoveryNotices(previous: RecoveryNotices, symbol: string, positions: { quantity: number; side: string; right: string | null; strike: number | null; expiry: string | null }[]): RecoveryNotices {
  const open = new Set(positions.filter(position => position.quantity > 0 && position.side !== 'FLAT')
    .map(position => recoveryContractKey(symbol, position.right, position.strike, position.expiry)))
  const entries = Object.entries(previous).filter(([key]) => open.has(key))
  return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries)
}
