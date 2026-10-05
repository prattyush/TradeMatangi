import type { DesktopOrder, DesktopPosition, DesktopTrade, DesktopTradingSnapshot } from './contracts'

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
  if (!position || position.side === 'FLAT') return 0
  // An unquoted open contract is valued at entry, matching the backend day P&L.
  const markPrice = price > 0 ? price : position.avg_entry_price
  return position.quantity * markPrice * (position.side === 'LONG' ? 1 : -1)
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
  const cursor = Number.isFinite(eventId) ? eventId : snapshot.event_cursor
  if (typeof event.wallet_balance === 'number' && Number.isFinite(event.wallet_balance)) {
    snapshot = { ...snapshot, wallet_balance: event.wallet_balance }
  }
  const orderId = typeof event.order_id === 'string' ? event.order_id : ''
  if ((event.type === 'order_placed' || event.type === 'order_updated') && orderId && event.status === 'PENDING') {
    if (event.type === 'order_updated' && snapshot.open_orders.some(order => order.order_id === orderId)) {
      return { ...snapshot, event_cursor: cursor, open_orders: snapshot.open_orders.map(order => order.order_id === orderId ? { ...order, ...event } as DesktopOrder : order) }
    }
    if (snapshot.open_orders.some(order => order.order_id === orderId) || snapshot.trades.some(trade => trade.trade_id === orderId)) return { ...snapshot, event_cursor: cursor }
    return { ...snapshot, event_cursor: cursor, open_orders: [...snapshot.open_orders, event as unknown as DesktopOrder] }
  }
  if (event.type === 'order_cancelled' && orderId) {
    return { ...snapshot, event_cursor: cursor, open_orders: snapshot.open_orders.filter(order => order.order_id !== orderId) }
  }
  if (event.type === 'order_converted' && orderId) {
    return { ...snapshot, event_cursor: cursor, open_orders: snapshot.open_orders.map(order => order.order_id === orderId ? {
      ...order,
      order_type: String(event.new_order_type ?? order.order_type) as DesktopOrder['order_type'],
      trigger_price: Number(event.trigger_price ?? order.trigger_price),
      limit_price: Number(event.limit_price ?? order.limit_price),
      is_stoploss: Boolean(event.is_stoploss ?? order.is_stoploss),
    } : order) }
  }
  if (event.type === 'strategy_completed' && typeof event.strategy_id === 'string') {
    return { ...snapshot, event_cursor: cursor, strategies: snapshot.strategies.filter(item => item.strategy_id !== event.strategy_id) }
  }
  if (event.type === 'order_filled' && orderId && event.trade && event.position && event.pnl) {
    const trade = event.trade as DesktopTrade
    const position = event.position as DesktopPosition
    const right = event.right === 'CE' || event.right === 'PE' ? event.right : null
    const contractKey = typeof event.contract_key === 'string' ? event.contract_key : ''
    const primaryContract = !right || (Number(event.strike) === (right === 'CE' ? snapshot.session.strike_ce : snapshot.session.strike_pe) && String(event.expiry ?? '') === snapshot.session.expiry)
    const openTradeIds = Array.isArray(event.open_trade_ids) ? new Set(event.open_trade_ids.map(String)) : null
    const trades = snapshot.trades.some(item => item.trade_id === trade.trade_id) ? snapshot.trades : [...snapshot.trades, trade]
    return {
      ...snapshot,
      event_cursor: cursor,
      current_time: Math.max(snapshot.current_time, Number(event.filled_at) || 0),
      open_orders: snapshot.open_orders.filter(order => order.order_id !== orderId),
      trades: openTradeIds ? trades.map(item => item.session_id === snapshot.session.session_id ? { ...item, is_open: openTradeIds.has(item.trade_id) } : item) : trades,
      positions: primaryContract ? { ...snapshot.positions, [right ?? 'equity']: position } : snapshot.positions,
      positions_by_contract: contractKey ? { ...snapshot.positions_by_contract, [contractKey]: position } : snapshot.positions_by_contract,
      pnl: event.pnl as DesktopTradingSnapshot['pnl'],
      wallet_balance: typeof event.wallet_balance === 'number' ? event.wallet_balance : snapshot.wallet_balance,
    }
  }
  if (event.type === 'order_filled' && orderId) {
    // Legacy servers omit committed position data. Hide the executed order now;
    // the stream coordinator recovers positions and P&L in the background.
    return { ...snapshot, event_cursor: cursor, open_orders: snapshot.open_orders.filter(order => order.order_id !== orderId) }
  }
  if (event.type === 'bar_paused') {
    const barIndex = Number(event.bar_index)
    return Number.isFinite(barIndex) ? { ...snapshot, current_bar_index: barIndex, event_cursor: Number.isFinite(eventId) ? eventId : snapshot.event_cursor } : snapshot
  }
  if (event.type !== 'tick') return { ...snapshot, event_cursor: cursor }
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
    const strike = Number(event.strike)
    const expiry = String(event.expiry ?? '')
    const primaryOption = !contractKey || (Number.isFinite(strike) && strike === (right === 'CE' ? snapshot.session.strike_ce : snapshot.session.strike_pe) && expiry === snapshot.session.expiry)
    if (right === 'CE' && primaryOption) next = { ...next, current_price_ce: price }
    else if (right === 'PE' && primaryOption) next = { ...next, current_price_pe: price }
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
