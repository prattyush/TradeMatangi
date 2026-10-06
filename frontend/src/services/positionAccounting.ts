import type { Position, Trade } from './api'

export type ContractPosition = Position & { right: string | null; strike: number | null; expiry: string | null }
export interface PositionSnapshot {
  session_id: string
  positions: ContractPosition[]
  state_version?: number
  state_generation?: string
  calculation_verified?: boolean
  trades?: Trade[]
  trade?: Trade | null
  application_orders?: import('./api').Order[]
}
export const positionKey = (right: string | null, strike: number | null, expiry: string | null) => JSON.stringify([right, strike, expiry])
export const flatPosition = (symbol: string): Position => ({ symbol, side: 'FLAT', quantity: 0, avg_entry_price: 0, entry_commission: 0 })

export function contractPosition(symbol: string, positions: ContractPosition[], right: string | null, strike: number | null, expiry: string | null): Position {
  const matches = positions.filter(p => p.right === right && (!right || (p.strike === strike && p.expiry === expiry)))
  const net = matches.reduce((sum, p) => sum + p.quantity * (p.side === 'LONG' ? 1 : p.side === 'SHORT' ? -1 : 0), 0)
  if (!net) return flatPosition(symbol)
  const side = net > 0 ? 'LONG' : 'SHORT'
  const same = matches.filter(p => p.side === side)
  const quantity = same.reduce((sum, p) => sum + p.quantity, 0)
  return { symbol, side, quantity: Math.abs(net), avg_entry_price: same.reduce((sum, p) => sum + p.quantity * p.avg_entry_price, 0) / quantity,
    entry_commission: same.reduce((sum, p) => sum + (p.entry_commission ?? 0), 0) }
}

export function unrealizedPnl(position: Position, price: number | null, brokerage: number): number | null {
  if (position.side === 'FLAT' || !position.quantity) return 0
  if (price === null || !Number.isFinite(price) || price <= 0) return null
  const value = price * position.quantity
  const exitFees = position.side === 'LONG'
    ? value * 0.0625 / 100 + 1.18 * (0.06 / 100) * value : value * 0.006803 / 100
  return (position.side === 'LONG' ? 1 : -1) * position.quantity * (price - position.avg_entry_price)
    - (position.entry_commission ?? 0) - exitFees - brokerage
}

export interface PositionClock { version: number; generation: string | null; retired: string[] }
export function advancePositionClock(clock: PositionClock, snapshot: PositionSnapshot): PositionClock | null {
  if (snapshot.calculation_verified === false) return null
  if (snapshot.state_version === undefined || !snapshot.state_generation) return clock
  const generation = snapshot.state_generation
  if (clock.retired.includes(generation)) return null
  if (clock.generation === generation && snapshot.state_version < clock.version) return null
  return { version: snapshot.state_version, generation,
    retired: clock.generation && clock.generation !== generation ? [...clock.retired.slice(-3), clock.generation] : clock.retired }
}

export function mergeConfirmedTrade(trades: Trade[], trade: Trade): Trade[] {
  const index = trades.findIndex(item => item.trade_id === trade.trade_id || (trade.kotak_order_id && item.kotak_order_id === trade.kotak_order_id))
  if (index < 0) return [...trades, trade]
  if (trades[index].quantity >= trade.quantity) return trades
  return trades.map((item, i) => i === index ? trade : item)
}
