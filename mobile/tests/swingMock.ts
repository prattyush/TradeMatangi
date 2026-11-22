/** A stand-in for the swing routes (`/api/desktop/v1/swing/portfolios/*`): one portfolio whose orders and positions change as the phone acts. */

export interface SwingMock {
  /** What the account may do. */
  realAllowed: boolean
  brokerConnected: boolean
  futuresEnabled: boolean
  /** The portfolio, once started (or seeded by a test). */
  portfolio: Record<string, unknown> | null
  positions: Array<Record<string, unknown>>
  orders: Array<Record<string, unknown>>
  /** Everything the phone sent. */
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }>
  /** Fail the next order placement with this status (once). */
  failNextOrder?: { status: number; detail: string }
  /** Answer capabilities with 404 like an older server. */
  old: boolean
  seq: number
  placedByRequest: Map<string, Record<string, unknown>>
}

export const BASE = '/api/desktop/v1/swing/portfolios'

export const newSwingState = (): SwingMock => ({
  realAllowed: true, brokerConnected: true, futuresEnabled: true, portfolio: null, positions: [], orders: [], requests: [], old: false, seq: 0, placedByRequest: new Map(),
})

/** Seed a running paper portfolio with a long equity, a short future, one stoploss. */
export function seedPortfolio(state: SwingMock, mode: 'paper' | 'real' = 'paper') {
  state.portfolio = { session_id: `pf-${mode}`, mode, state: 'running', entries_paused: false, session_capital: 1000000, guardrail_epoch: 3, paper_broker: 'kite', execution_broker: mode === 'real' ? 'kite' : undefined }
  state.positions = [
    { session_id: 's-hdfc', symbol: 'HDFCBANK', instrument_type: 'equity', side: 'LONG', quantity: 100, avg_entry_price: 1500, mark_price: 1600, quote_status: 'live', invested_value: 150000, unrealized_pnl: 10000, unrealized_pnl_pct: 6.67 },
    { session_id: 's-rel', symbol: 'RELIND', instrument_type: 'futures', side: 'SHORT', quantity: 500, avg_entry_price: 1300, mark_price: 1290, expiry: '2026-11-26', quote_status: 'live', invested_value: 120000, held_margin: 120000, unrealized_pnl: 5000, unrealized_pnl_pct: 4.16, notional_exposure: 645000 },
  ]
  state.orders = [
    { order_id: 'o-sl', session_id: 's-hdfc', symbol: 'HDFCBANK', side: 'SELL', order_type: 'STOPLOSS', quantity: 100, trigger_price: 1450, limit_price: 1440, status: 'PENDING', instrument_type: 'equity', tick_size: 0.05, lot_size: 1, execution_role: 'exit' },
  ]
}

export function snapshot(state: SwingMock) {
  if (!state.portfolio) return { portfolio: null }
  const pnl = state.positions.reduce((sum, position) => sum + Number(position.unrealized_pnl ?? 0), 0)
  return {
    portfolio: state.portfolio, positions: state.positions, open_orders: state.orders, trades: [], contexts: [],
    wallet_balance: 850000, pnl, pnl_pct: pnl / 10000, valuation_status: 'live', reconciliation_pending: [], restrictions_enabled: false,
    undated_submission_ids: [], delivery_review_context_ids: [], current_submission_ids: [],
  }
}

const OPTION_STRIKES = [24400, 24450, 24500, 24550, 24600]
const optionContracts = () => ['2026-11-26', '2026-12-03'].flatMap(expiry => (['CE', 'PE'] as const).flatMap(right => OPTION_STRIKES.map(strike => ({ expiry, right, strike, lot_size: 75, tick_size: 0.05, entry_eligible: true }))))

function candles(count: number) {
  const start = Date.UTC(2026, 10, 10, 3, 45) / 1000 + 19800 - 19800
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + Math.sin(index / 6) * 8
    return { time: start + index * 300, open: base, high: base + 2, low: base - 2, close: base + 1, volume: 100 }
  })
}

export function swingResponse(path: string, method: string, query: URLSearchParams, body: any, state: SwingMock): { status: number; body?: unknown; stream?: string } {
  state.requests.push({ method, path, query, body })
  const rest = path.slice(BASE.length)
  if (rest === '/capabilities') return state.old ? { status: 404, body: { detail: 'Not Found' } } : { status: 200, body: { real_trading_enabled: state.realAllowed, user_id: 'u' } }
  if (rest === '/broker-status') return { status: 200, body: { broker: query.get('execution_broker'), authenticated: state.brokerConnected } }
  if (rest === '/active') {
    if (query.get('mode') === 'real' && !state.realAllowed) return { status: 403, body: { detail: 'Real trading is not enabled for this account' } }
    return { status: 200, body: state.portfolio && state.portfolio.mode === query.get('mode') ? snapshot(state) : { portfolio: null } }
  }
  if (rest === '' && method === 'POST') {
    state.portfolio = { session_id: `pf-${body.mode}`, mode: body.mode, state: 'running', entries_paused: false, session_capital: body.mode === 'paper' ? body.capital : 1000000, guardrail_epoch: 1, paper_broker: body.paper_broker, execution_broker: body.execution_broker }
    state.positions = []; state.orders = []
    return { status: 200, body: snapshot(state) }
  }
  if (rest === '/contracts/metadata') return { status: 200, body: { symbol: query.get('symbol'), contracts: optionContracts() } }
  if (rest === '/contracts/futures') return { status: 200, body: { symbol: query.get('symbol'), provider: query.get('provider'), contracts: [{ expiry: '2026-11-26', lot_size: 500, tick_size: 0.05 }, { expiry: '2026-12-31', lot_size: 500, tick_size: 0.05 }], paper_enabled: state.futuresEnabled, real_enabled: state.futuresEnabled, execution_enabled: state.futuresEnabled } }
  const match = rest.match(/^\/([\w-]+)(\/.*)?$/)
  if (!match) return { status: 404, body: { detail: 'Not Found' } }
  const [, , tail = ''] = match
  if (tail === '' && method === 'GET') return { status: 200, body: snapshot(state) }
  if (tail === '/events') return { status: 200, stream: `data: ${JSON.stringify({ type: 'portfolio_snapshot', ...snapshot(state) })}\n\n` }
  if (tail === '/order-preview') {
    if (body.instrument_type === 'futures') return { status: 200, body: { quantity: body.quantity, lot_size: 500, budget: 120000, fees: 90, margin: 119000, required_funds: 120090, capital_revision: body.capital_revision, fee_hash: 'f'.repeat(64), execution_enabled: state.futuresEnabled, evidence: { live: true, source: 'test' } } }
    return { status: 200, body: { quantity: body.instrument_type === 'options' ? 150 : 66, lot_size: body.instrument_type === 'options' ? 75 : 1, budget: 100000, fees: 40, required_funds: 99000, unused_budget: 10, minimum_funds: 99000, capital_revision: body.capital_revision } }
  }
  if (tail === '/orders' && method === 'POST') {
    const existing = state.placedByRequest.get(body.request_id)
    if (existing) return { status: 200, body: { ...snapshot(state), order_id: existing.order_id } }
    if (state.failNextOrder) { const failure = state.failNextOrder; state.failNextOrder = undefined; return { status: failure.status, body: { detail: failure.detail } } }
    const order = { order_id: `o-${++state.seq}`, session_id: 's-new', symbol: body.symbol, side: body.side, order_type: body.order_type, quantity: body.quantity, trigger_price: body.price, limit_price: body.price, status: 'PENDING', instrument_type: body.instrument_type, right: body.right ?? null, strike: body.strike ?? null, expiry: body.expiry ?? null, tick_size: 0.05, lot_size: body.instrument_type === 'options' ? 75 : body.instrument_type === 'futures' ? 500 : 1 }
    state.orders.push(order)
    state.placedByRequest.set(body.request_id, order)
    return { status: 200, body: { ...snapshot(state), order_id: order.order_id } }
  }
  const order = state.orders.find(item => tail.startsWith(`/orders/${item.order_id}`))
  if (order && tail.endsWith('/amend-preview')) return { status: 200, body: { margin: 119000, fees: 90, required_funds: 120090, existing_reservation: 100000, additional_funds: 20090, capital_revision: 3, fee_hash: 'a'.repeat(64), order_fingerprint: 'fp', message: 'estimate' } }
  if (order && tail.endsWith('/cancel')) { state.orders = state.orders.filter(item => item !== order); return { status: 200, body: snapshot(state) } }
  if (order && method === 'PATCH') { Object.assign(order, { quantity: body.quantity ?? order.quantity, ...(order.order_type === 'LIMIT' ? { limit_price: body.price } : { trigger_price: body.price }) }); return { status: 200, body: snapshot(state) } }
  if (tail === '/pause') { state.portfolio = { ...state.portfolio!, entries_paused: body.paused }; return { status: 200, body: snapshot(state) } }
  if (tail === '/close') { state.portfolio = { ...state.portfolio!, state: 'ended' }; state.positions = []; state.orders = []; return { status: 200, body: snapshot(state) } }
  if (tail === '/charts/history') return { status: 200, body: { candles: candles(120), interval: body.interval, provider: 'kite', more: false, before: null } }
  return { status: 404, body: { detail: 'Not Found' } }
}
