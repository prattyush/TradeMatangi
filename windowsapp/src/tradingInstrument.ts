import type { DesktopTradingSnapshot } from './contracts'

export function equityEntryEnabled(kind: string, symbol: string, snapshot?: DesktopTradingSnapshot | null): boolean {
  return Boolean(snapshot && snapshot.session.state !== 'ended' && symbol === snapshot.session.symbol &&
    (kind === 'option' || snapshot.session.instrument_type === 'equity'))
}

export function instrumentLotSize(kind: string, snapshot?: DesktopTradingSnapshot | null): number {
  return kind === 'option' ? snapshot?.option_lot_size ?? snapshot?.session.lot_size ?? 1 : 1
}

export function entryQuantity(kind: string, value: string, snapshot: DesktopTradingSnapshot): number {
  const units = Number(value)
  if (!Number.isInteger(units) || units < 1) throw new Error('Quantity must be a positive whole number')
  return units * instrumentLotSize(kind, snapshot)
}

export function validateEntryStop(side: 'BUY' | 'SELL', entry: number, stop: number): void {
  if (!(entry > 0 && stop > 0) || (side === 'BUY' ? stop >= entry : stop <= entry)) {
    throw new Error(side === 'BUY' ? 'Long stop-loss must be below entry' : 'Short stop-loss must be above entry')
  }
}
