/** Mock data for the analysis endpoints (`/api/desktop/v1/analysis/*`), shaped like the real server's responses. */

export interface MockSession {
  session_id: string; user_id: string; symbol: string; date: string; start_time: string | null
  instrument_type: string; session_type: string; strike: number | null; expiry: string | null
  session_capital: number; net_pnl: number; pnl_pct: number; total_commission: number
  trade_count: number; round_trip_count: number; buy_count: number; sell_count: number
  trading_style: 'intraday' | 'swing'; portfolio_id?: string; shared?: boolean
}

const epoch = (date: string, hour: number, minute: number, second = 0) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour, minute, second) / 1000

/** Deterministic wavy candles for one trading day (IST wall clock stored as UTC, like the backend). */
export function dayCandles(date: string, interval = 3, start = 24400) {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = []
  let price = start
  for (let t = 9 * 60 + 15; t < 15 * 60 + 30; t += interval) {
    price += Math.sin(t / 37) * 8 + ((t % 7) - 3)
    const open = price
    const close = price + Math.cos(t / 23) * 6
    out.push({
      time: epoch(date, Math.floor(t / 60), t % 60),
      open: +open.toFixed(2), high: +(Math.max(open, close) + 4).toFixed(2), low: +(Math.min(open, close) - 4).toFixed(2),
      close: +close.toFixed(2), volume: 1000 + (t % 11) * 100,
    })
  }
  return out
}

const base = { user_id: 'u1', start_time: '09:15:00', session_capital: 500000, total_commission: 80, trading_style: 'intraday' as const }

export const SESSIONS: MockSession[] = [
  { ...base, session_id: 's-0911-a', symbol: 'NIFTY', date: '2026-11-09', instrument_type: 'options', session_type: 'paper', strike: 24500, expiry: '2026-11-13', net_pnl: 3200, pnl_pct: 0.64, trade_count: 4, round_trip_count: 2, buy_count: 2, sell_count: 2 },
  { ...base, session_id: 's-0911-b', symbol: 'TATPOW', date: '2026-11-09', instrument_type: 'equity', session_type: 'real', strike: null, expiry: null, net_pnl: -1250, pnl_pct: -0.25, trade_count: 2, round_trip_count: 1, buy_count: 1, sell_count: 1 },
  { ...base, session_id: 's-0911-c1', symbol: 'NIFTY', date: '2026-11-07', instrument_type: 'options', session_type: 'sim', strike: 24400, expiry: '2026-11-13', net_pnl: 900, pnl_pct: 0.18, trade_count: 2, round_trip_count: 1, buy_count: 1, sell_count: 1 },
  { ...base, session_id: 's-0911-c2', symbol: 'NIFTY', date: '2026-11-07', instrument_type: 'options', session_type: 'sim', strike: 24400, expiry: '2026-11-13', net_pnl: -300, pnl_pct: -0.06, trade_count: 2, round_trip_count: 1, buy_count: 1, sell_count: 1, start_time: '11:00:00' },
  { ...base, session_id: 's-0905', symbol: 'NIFTY', date: '2026-11-05', instrument_type: 'options', session_type: 'stepwise', strike: 24300, expiry: '2026-11-06', net_pnl: -4500, pnl_pct: -0.9, trade_count: 2, round_trip_count: 1, buy_count: 1, sell_count: 1 },
  { ...base, session_id: 's-swing', symbol: 'HDFCBANK', date: '2026-11-04', instrument_type: 'equity', session_type: 'paper', strike: null, expiry: null, net_pnl: 2100, pnl_pct: 0.42, trade_count: 2, round_trip_count: 1, buy_count: 1, sell_count: 1, trading_style: 'swing', portfolio_id: 'pf1' },
]

function tradesFor(session: MockSession) {
  const option = session.instrument_type === 'options'
  const common = { user_id: 'u1', session_id: session.session_id, symbol: session.symbol, instrument_type: session.instrument_type, commission: 20 }
  const pairs = Math.max(1, Math.round(session.trade_count / 2))
  const rows = []
  for (let i = 0; i < pairs; i++) {
    const entry = epoch(session.date, 10 + i, 5)
    const exit = epoch(session.date, 10 + i, 40)
    // Each round trip uses the next strike up, so a day with two round trips has two option contracts.
    const contract = option ? { right: 'CE', strike: (session.strike ?? 0) + i * 100, expiry: session.expiry } : { right: null, strike: null, expiry: null }
    rows.push({ ...common, ...contract, trade_id: `${session.session_id}-b${i}`, side: 'BUY', quantity: 75, price: option ? 120 + i * 5 : 540, timestamp: entry })
    rows.push({ ...common, ...contract, trade_id: `${session.session_id}-s${i}`, side: 'SELL', quantity: 75, price: (option ? 120 + i * 5 : 540) + session.net_pnl / pairs / 75, timestamp: exit })
  }
  return rows
}

export interface AnalysisMockState {
  /** What the sessions endpoint should do: normal, return nothing, fail once with 500, or 404 like an old server. */
  sessions: 'ok' | 'empty' | 'fail-once' | 'old'
  failedOnce: boolean
  sessionsRequests: URLSearchParams[]
  /** Saved videos per session id. */
  videos: Record<string, Array<{ video_id: string; title: string; privacy: string; url: string; chapters: string; uploaded_at: string; session_id: string }>>
}

export const newAnalysisState = (): AnalysisMockState => ({ sessions: 'ok', failedOnce: false, sessionsRequests: [], videos: {} })

export interface MockResponse { status: number; body?: unknown }

/** `route` is the path after `/api/desktop/v1/analysis/`. */
export function analysisResponse(route: string, query: URLSearchParams, state: AnalysisMockState): MockResponse {
  if (route === 'sessions') {
    state.sessionsRequests.push(query)
    if (state.sessions === 'old') return { status: 404, body: { detail: 'Not Found' } }
    if (state.sessions === 'fail-once' && !state.failedOnce) { state.failedOnce = true; return { status: 500, body: { detail: 'Internal error' } } }
    if (state.sessions === 'empty') return { status: 200, body: [] }
    const start = query.get('start_date') ?? '0000-00-00'
    const end = query.get('end_date') ?? '9999-99-99'
    const list = SESSIONS.filter(s =>
      s.date >= start && s.date <= end &&
      (!query.get('session_type') || s.session_type === query.get('session_type')) &&
      (!query.get('trading_style') || s.trading_style === query.get('trading_style')) &&
      (!query.get('symbol') || s.symbol === query.get('symbol')) &&
      (!query.get('instrument_type') || s.instrument_type === query.get('instrument_type')))
    return { status: 200, body: list }
  }
  const detail = route.match(/^sessions\/([A-Za-z0-9_-]+)$/)
  if (detail) {
    const session = SESSIONS.find(s => s.session_id === detail[1])
    return session ? { status: 200, body: { ...session, trades: tradesFor(session), orders: [], cycles: [] } } : { status: 404, body: { detail: 'Session not found' } }
  }
  if (route === 'data/historical') {
    const date = query.get('trading_date') ?? '2026-11-09'
    return { status: 200, body: { symbol: query.get('symbol'), dates: ['2026-11-05', '2026-11-06'], candles: [...dayCandles('2026-11-05', +(query.get('interval_minutes') ?? 3)), ...dayCandles('2026-11-06', +(query.get('interval_minutes') ?? 3))].filter(c => c.time < epoch(date, 0, 0)) } }
  }
  if (route === 'data/pre-session') {
    const date = query.get('date') ?? '2026-11-09'
    return { status: 200, body: { symbol: query.get('symbol'), date, start_time: query.get('start_time'), candles: dayCandles(date, +(query.get('interval_minutes') ?? 3)) } }
  }
  if (route === 'data/options-historical') {
    const date = query.get('date') ?? '2026-11-09'
    return { status: 200, body: { symbol: query.get('symbol'), dates: [date], candles: dayCandles(date, +(query.get('interval_minutes') ?? 3), 120) } }
  }
  if (route === 'video-links') return { status: 200, body: { links: state.videos[query.get('session_id') ?? ''] ?? [] } }
  if (route === 'snapshots') return { status: 200, body: [] }
  if (route === 'pattern/chart/by-date') return { status: 404, body: { detail: 'No chart' } }
  return { status: 404, body: { detail: 'Not Found' } }
}
