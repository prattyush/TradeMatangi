import type { DesktopPosition, DesktopTradingSnapshot } from './contracts'

export const isDesktopTradingSnapshot = (payload: unknown): payload is DesktopTradingSnapshot => {
  const value = payload as DesktopTradingSnapshot | null
  return Boolean(value?.session?.session_id && Array.isArray(value.open_orders) && value.pnl && value.settings)
}

export const acceptPaperSnapshot = (current: DesktopTradingSnapshot, incoming: DesktopTradingSnapshot): DesktopTradingSnapshot => {
  if (incoming.session.session_id !== current.session.session_id) return current
  return (incoming.event_cursor ?? 0) < (current.event_cursor ?? 0) ? current : incoming
}

const round = (value: number) => Math.round(value * 100) / 100
const mark = (position: DesktopPosition | undefined, price: number): number => {
  if (!position || position.side === 'FLAT' || price <= 0) return 0
  return position.quantity * price * (position.side === 'LONG' ? 1 : -1)
}

const recalcPaperPnl = (previous: DesktopTradingSnapshot, next: DesktopTradingSnapshot): DesktopTradingSnapshot => {
  const positionPnl = (position: DesktopPosition | undefined, price: number): number => {
    if (!position || position.side === 'FLAT' || position.quantity <= 0 || price <= 0) return 0
    const direction = position.side === 'LONG' ? 1 : -1
    // Match trading.compute_commission: closing a long sells, closing a short buys.
    const rate = direction === 1 ? (0.0625 + 1.18 * 0.06) / 100 : 0.006803 / 100
    const exitCommission = Math.round((price * position.quantity * rate + (next.session.brokerage_per_order ?? 1)) * 10000) / 10000
    return round((price - position.avg_entry_price) * position.quantity * direction - position.entry_commission - exitCommission)
  }
  const contracts: Record<string, number> = {}
  let change = mark(next.positions.equity, next.current_price) - mark(previous.positions.equity, previous.current_price)
  for (const [key, position] of Object.entries(next.positions_by_contract ?? {})) {
    const price = next.contract_quotes?.[key]?.price ?? 0
    contracts[key] = positionPnl(position, price)
    change += mark(position, price) - mark(position, previous.contract_quotes?.[key]?.price ?? 0)
  }
  if (!Object.keys(next.positions_by_contract ?? {}).length) {
    change += mark(next.positions.CE, next.current_price_ce) - mark(previous.positions.CE, previous.current_price_ce)
    change += mark(next.positions.PE, next.current_price_pe) - mark(previous.positions.PE, previous.current_price_pe)
  }
  // Authoritative day P&L includes closed trades and commissions; only marks change on ticks.
  const day = round(previous.pnl.day + change)
  const capital = next.session.session_capital || 0
  return { ...next, pnl: { ...next.pnl, equity: positionPnl(next.positions.equity, next.current_price), ce: positionPnl(next.positions.CE, next.current_price_ce), pe: positionPnl(next.positions.PE, next.current_price_pe), contracts, day, day_pct: capital > 0 ? round(day / capital * 100) : 0 } }
}

export const applyPaperStreamEvent = (snapshot: DesktopTradingSnapshot, event: Record<string, unknown>): DesktopTradingSnapshot => {
  if (isDesktopTradingSnapshot(event)) return acceptPaperSnapshot(snapshot, event)
  const eventId = Number(event.event_id)
  if (Number.isFinite(eventId) && eventId <= (snapshot.event_cursor ?? -1)) return snapshot
  if (event.type === 'bar_paused') {
    const barIndex = Number(event.bar_index)
    return Number.isFinite(barIndex) ? { ...snapshot, current_bar_index: barIndex, event_cursor: Number.isFinite(eventId) ? eventId : snapshot.event_cursor } : snapshot
  }
  if (event.type !== 'tick') return snapshot
  const price = Number(event.close)
  const time = Number(event.time)
  const right = typeof event.right === 'string' ? event.right.toUpperCase() : null
  const contractKey = typeof event.contract_key === 'string' ? event.contract_key : ''
  // Older servers may not supply event ids. Keep their ticks from rolling prices backward.
  const quoteTime = contractKey ? snapshot.contract_quotes?.[contractKey]?.timestamp : snapshot.current_time
  if (!Number.isFinite(eventId) && Number.isFinite(time) && time < (quoteTime ?? 0)) return snapshot
  let next: DesktopTradingSnapshot = {
    ...snapshot,
    event_cursor: Number.isFinite(eventId) ? eventId : snapshot.event_cursor,
    current_time: Number.isFinite(time) ? Math.max(time, snapshot.current_time) : snapshot.current_time,
  }
  if (Number.isFinite(price)) {
    if (right === 'CE') next = { ...next, current_price_ce: price }
    else if (right === 'PE') next = { ...next, current_price_pe: price }
    else next = { ...next, current_price: price }
  }
  if (contractKey && Number.isFinite(price)) {
    next = {
      ...next,
      contract_quotes: {
        ...next.contract_quotes,
        [contractKey]: {
          symbol: String(event.symbol ?? snapshot.session.symbol),
          expiry: String(event.expiry ?? ''),
          strike: Number(event.strike ?? 0),
          right: right === 'PE' ? 'PE' : 'CE',
          contract_key: contractKey,
          price,
          timestamp: Number.isFinite(time) ? time : snapshot.current_time,
          source: String(event.source ?? 'stream'),
        },
      },
    }
  }
  return recalcPaperPnl(snapshot, next)
}
