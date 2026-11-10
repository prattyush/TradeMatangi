import { statsResponse, type StatsMockState } from './statsMock'

/** Mock data for the analysis endpoints (`/api/desktop/v1/analysis/*`), shaped like the real server's responses. */

export interface MockSession {
  session_id: string; user_id: string; symbol: string; date: string; start_time: string | null
  instrument_type: string; session_type: string; strike: number | null; expiry: string | null
  session_capital: number; net_pnl: number; pnl_pct: number; total_commission: number
  trade_count: number; round_trip_count: number; buy_count: number; sell_count: number
  trading_style: 'intraday' | 'swing'; portfolio_id?: string; shared?: boolean
}

export const epoch = (date: string, hour: number, minute: number, second = 0) =>
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

/** Three captured events for an options day: an order placed, filled, and its stoploss edited. */
export function snapshotsFor(session: MockSession) {
  if (session.instrument_type !== 'options' || session.session_type === 'sim' || session.trading_style === 'swing') return []
  const flat = { side: 'FLAT', quantity: 0, avg_entry_price: 0, pnl: 0, pnl_pct: 0 }
  const long = { side: 'LONG', quantity: 75, avg_entry_price: 120, pnl: 150, pnl_pct: 1.7 }
  const make = (i: number, type: string, description: string, hour: number, minute: number, second: number, open: boolean, stoploss: boolean) => {
    const timestamp = epoch(session.date, hour, minute, second)
    return {
      event_id: `${session.session_id}-e${i}`, session_id: session.session_id, user_id: 'u1', symbol: session.symbol, date: session.date,
      instrument_type: 'options', session_type: session.session_type, timestamp,
      event: { type, description, details: {} },
      snapshot: {
        current_price: 24410, current_price_ce: 118, current_price_pe: 96, bar_time: Math.floor(timestamp / 180) * 180,
        bar_ohlc: { open: 24400, high: 24420, low: 24395, close: 24410 }, bar_observation_resolution_seconds: 1,
        position: flat, position_ce: open ? long : flat, position_pe: flat,
        combined_pnl: open ? 150 : 0, combined_pnl_pct: open ? 0.03 : 0, session_pnl: open ? 130 : 0, session_pnl_pct: open ? 0.026 : 0,
        wallet_balance: open ? 491000 : 500000, session_capital: 500000, wallet_used_pct: open ? 1.8 : 0, active_positions: open ? 1 : 0,
        open_orders: stoploss ? [{ order_id: `${session.session_id}-sl`, session_id: session.session_id, side: 'SELL', order_type: 'STOP', trigger_price: 110, limit_price: 0, quantity: 75, is_stoploss: true, right: 'CE' }] : [],
        strike_ce: session.strike, strike_pe: session.session_id === 's-0911-a' ? session.strike : null, expiry: session.expiry,
        event_timestamp: timestamp, quantity_mode: 'quantity', filled_trades: open ? [{ trade_id: `${session.session_id}-b0`, side: 'BUY', price: 120, timestamp: epoch(session.date, 10, 5), right: 'CE', strike: session.strike, expiry: session.expiry, quantity: 75, kotak_order_id: null }] : [],
        seq: i, capture_v: 2,
      },
    }
  }
  return [
    make(1, 'order_placed', 'BUY LIMIT placed @ 120', 10, 4, 40, false, false),
    make(2, 'order_filled', 'BUY order filled @ 120', 10, 5, 0, true, false),
    make(3, 'order_edited', 'Stoploss edited to 110', 10, 20, 0, true, true),
  ]
}

/** One closed round trip per BUY/SELL pair, shaped like the server's cycles (what the journey and the inspector read). */
function cyclesFor(session: MockSession, trades: ReturnType<typeof tradesFor>) {
  const cycles = []
  for (let i = 0; i + 1 < trades.length; i += 2) {
    const entry = trades[i], exit = trades[i + 1]
    const pnl = Math.round((exit.price - entry.price) * entry.quantity)
    cycles.push({
      user_id: 'u1', cycle_id: `${session.session_id}-c${i / 2}`, session_id: session.session_id, symbol: session.symbol, right: entry.right, strike: entry.strike, expiry: entry.expiry,
      date: session.date, mode: session.session_type, direction: 'long', state: 'closed', entry_time: entry.timestamp, exit_time: exit.timestamp, exit_sort_time: null,
      entry_count: 1, exit_count: 1, net_pnl: pnl, pnl_pct: +(pnl / session.session_capital * 100).toFixed(2), fees: 40, open_quantity: 0, matches: [],
      capital: session.session_capital, peak_capital_pct: 1.8, holding_seconds: exit.timestamp - entry.timestamp,
      entries: [{ entry_id: `${session.session_id}-e${i / 2}`, entry_method: 'MARKET', client: 'desktop', timestamp: entry.timestamp, quantity: entry.quantity, matched_quantity: entry.quantity, open_quantity: 0, average_price: entry.price, net_pnl: pnl, pnl_pct: 0, sizing_method: 'CAPITAL', requested_pct: 2, r_multiple: null, analytics: { effective_allocation_pct: 1.8, effective_risk_pct: 0.3, margin_rate: 1, capital: session.session_capital, initial_stop: +(entry.price * 0.9).toFixed(2) } }],
      exits: [{ exit_id: `${session.session_id}-x${i / 2}`, exit_method: pnl < 0 ? 'STOPLOSS' : 'TargetProfit', quantity: exit.quantity, price: exit.price, timestamp: exit.timestamp, analytics: {} }],
      label_index: i / 2,
      executions: [{ trade_id: entry.trade_id, execution_id: entry.trade_id, role: 'entry', side: entry.side, quantity: entry.quantity, price: entry.price, timestamp: entry.timestamp, commission: 20 }, { trade_id: exit.trade_id, execution_id: exit.trade_id, role: 'exit', side: exit.side, quantity: exit.quantity, price: exit.price, timestamp: exit.timestamp, commission: 20 }],
    })
  }
  return cycles
}

/** The round trips of a session (one per BUY/SELL pair), as the server's round-trips endpoint returns them. */
export function roundTripsFor(session: MockSession) {
  const trades = tradesFor(session)
  const trips = []
  for (let i = 0; i + 1 < trades.length; i += 2) {
    const entry = trades[i], exit = trades[i + 1]
    const leg = (trade: typeof entry) => ({ trade_id: trade.trade_id, side: trade.side, quantity: trade.quantity, price: trade.price, timestamp: trade.timestamp, right: trade.right, strike: trade.strike })
    const pnl = Math.round((exit.price - entry.price) * entry.quantity)
    trips.push({ index: i / 2, cycle_id: `${session.session_id}-c${i / 2}`, right: entry.right, entry_trades: [leg(entry)], exit_trades: [leg(exit)], pnl, pnl_pct: +(pnl / session.session_capital * 100).toFixed(2), max_capital_pct: 1.8 })
  }
  return trips
}

export const QUESTIONS = [
  { question_id: 'q-entry-1', kind: 'entry', text: 'Chased the entry', status: 'active', sort_order: 1, created_at: '2026-10-01', archived_at: null },
  { question_id: 'q-entry-2', kind: 'entry', text: 'Waited for confirmation', status: 'active', sort_order: 2, created_at: '2026-10-02', archived_at: null },
  { question_id: 'q-exit-1', kind: 'exit', text: 'Exited too early', status: 'active', sort_order: 1, created_at: '2026-10-03', archived_at: null },
]

export interface AnalysisMockState extends StatsMockState {
  /** Labels saved so far, per session (what GET labels returns), and every save request received. */
  labels: Record<string, Array<Record<string, unknown>>>
  labelPosts: Array<{ labels: Array<Record<string, unknown>> }>
  /** Behavior marks per session (what GET behavior/marks returns) and every save request received. */
  marks: Record<string, Array<{ round_trip_index: number; question_id: string; kind: string }>>
  markPosts: Array<{ session_id: string; round_trip_index: number; answers: Record<string, boolean> }>
  /** Make the labels endpoint fail once (500) on save, or on every load. */
  labelSave?: 'fail-once'
  labelsLoad?: 'fail'
  failedSaveOnce?: boolean
  /** Make the snapshots endpoint answer 404 like an older server. */
  snapshotsOld?: boolean
  /** What the sessions endpoint should do: normal, return nothing, fail once with 500, or 404 like an old server. */
  sessions: 'ok' | 'empty' | 'fail-once' | 'old'
  failedOnce: boolean
  sessionsRequests: URLSearchParams[]
  /** Saved videos per session id. */
  /** Make the saved-videos list answer 404 like an older server. */
  videosOld?: boolean
  /** The round-trips endpoint lists the trades in reverse (the walkthrough must still go by entry time). */
  tripsReversed?: boolean
  /** Saved what-ifs, as the server stores them, and a switch to answer 404 like an older server. */
  whatIfSaved: Array<Record<string, any>>
  whatIfOld?: boolean
  /** The session detail carries no cycles (an older server: no entry and exit details). */
  cyclesOld?: boolean
  /** Compare: saved pattern annotations exist for the day. */
  patterns?: boolean
  patternRequests: URLSearchParams[]
  videos: Record<string, Array<{ video_id: string; title: string; privacy: string; url: string; chapters: string; uploaded_at: string; session_id: string }>>
}

export const newAnalysisState = (): AnalysisMockState => ({ sessions: 'ok', failedOnce: false, performanceRequests: [], ledgerRequests: [], patternRequests: [], whatIfSaved: [], sessionsRequests: [], videos: {}, labels: {}, labelPosts: [], marks: {}, markPosts: [] })

export interface MockResponse { status: number; body?: unknown }

/** `route` is the path after `/api/desktop/v1/analysis/`. */
export function analysisResponse(route: string, query: URLSearchParams, state: AnalysisMockState, method = 'GET', body?: unknown): MockResponse {
  const stats = statsResponse(route, query, state)
  if (stats) return stats
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
    return session ? { status: 200, body: { ...session, trades: tradesFor(session), orders: [], cycles: state.cyclesOld ? [] : cyclesFor(session, tradesFor(session)) } } : { status: 404, body: { detail: 'Session not found' } }
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

  if (route === 'round-trips') {
    const session = SESSIONS.find(item => item.session_id === query.get('session_id'))
    const trips = session ? roundTripsFor(session) : []
    return { status: 200, body: state.tripsReversed ? [...trips].reverse() : trips }
  }
  if (route === 'labels') {
    if (method === 'POST') {
      if (state.labelSave === 'fail-once' && !state.failedSaveOnce) { state.failedSaveOnce = true; return { status: 500, body: { detail: 'Could not save' } } }
      const posted = (body as { labels: Array<Record<string, unknown>> }).labels
      state.labelPosts.push({ labels: posted })
      for (const label of posted) {
        const id = String(label.session_id)
        state.labels[id] = [...(state.labels[id] ?? []).filter(row => row.round_trip_index !== label.round_trip_index), label]
      }
      return { status: 200, body: { saved: posted.length } }
    }
    if (state.labelsLoad === 'fail') return { status: 500, body: { detail: 'Labels unavailable' } }
    return { status: 200, body: state.labels[query.get('session_id') ?? ''] ?? [] }
  }
  if (route === 'entry-tags') return { status: 200, body: { tags: ['AS_PER_PATTERN', 'BREAKOUT'] } }
  if (route === 'exit-tags') return { status: 200, body: { tags: ['AS_PER_PATTERN', 'TARGET'] } }
  if (route === 'pattern/strategies') return { status: 200, body: { strategies: ['Opening Range', 'Trend Pullback'] } }
  if (route === 'pattern/categories') return { status: 200, body: { categories: ['Breakout', 'Reversal'] } }
  if (route === 'behavior/questions') return { status: 200, body: { questions: QUESTIONS } }
  if (route === 'behavior/marks') {
    if (method === 'POST') {
      const posted = body as { session_id: string; round_trip_index: number; answers: Record<string, boolean> }
      state.markPosts.push(posted)
      const rows = (state.marks[posted.session_id] ?? []).filter(mark => !(mark.round_trip_index === posted.round_trip_index && posted.answers[mark.question_id] === false))
      for (const [questionId, showed] of Object.entries(posted.answers)) {
        if (showed && !rows.some(mark => mark.round_trip_index === posted.round_trip_index && mark.question_id === questionId)) {
          rows.push({ round_trip_index: posted.round_trip_index, question_id: questionId, kind: QUESTIONS.find(item => item.question_id === questionId)?.kind ?? 'entry' })
        }
      }
      state.marks[posted.session_id] = rows
      return { status: 200, body: { marks: rows } }
    }
    return { status: 200, body: { marks: state.marks[query.get('session_id') ?? ''] ?? [] } }
  }
  if (route === 'whatif' || route === 'whatif/range') {
    if (state.whatIfOld) return { status: 404, body: { detail: 'Not Found' } }
    if (route === 'whatif/range') return { status: 200, body: { scenarios: state.whatIfSaved.map(({ edits, ...rest }) => rest) } }
    if (method === 'POST') {
      const posted = body as { session_id: string; name: string; edits: unknown[]; summary: Record<string, unknown> }
      const id = posted.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      const session = SESSIONS.find(item => item.session_id === posted.session_id)!
      const row = { session_id: posted.session_id, scenario_id: id, name: posted.name, date: session.date, symbol: session.symbol, session_type: session.session_type, instrument_type: session.instrument_type, summary: posted.summary, edits: posted.edits, version: 1, updated_at: new Date().toISOString() }
      state.whatIfSaved = [...state.whatIfSaved.filter(item => !(item.session_id === posted.session_id && item.scenario_id === id)), row]
      return { status: 200, body: row }
    }
    if (method === 'DELETE') {
      state.whatIfSaved = state.whatIfSaved.filter(item => !(item.session_id === query.get('session_id') && item.scenario_id === query.get('scenario_id')))
      return { status: 200, body: { deleted: true } }
    }
    return { status: 200, body: { scenarios: state.whatIfSaved.filter(item => item.session_id === query.get('session_id')) } }
  }
  if (route === 'video-links/mine') {
    if (state.videosOld) return { status: 404, body: { detail: 'Not Found' } }
    return { status: 200, body: { links: Object.values(state.videos).flat().sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1)) } }
  }
  if (route === 'video-links') return { status: 200, body: { links: state.videos[query.get('session_id') ?? ''] ?? [] } }
  if (route === 'snapshots') {
    if (state.snapshotsOld) return { status: 404, body: { detail: 'Not Found' } }
    const session = SESSIONS.find(item => item.session_id === query.get('session_id'))
    return { status: 200, body: session ? snapshotsFor(session) : [] }
  }
  if (/^snapshots\/[A-Za-z0-9_-]+\/candle$/.test(route)) return { status: 200, body: { candle: null } }
  if (route === 'pattern/chart/by-date') {
    if (!state.patterns) return { status: 404, body: { detail: 'No chart' } }
    const date = query.get('date') ?? '2026-11-09'
    state.patternRequests.push(query)
    return { status: 200, body: {
      chart_id: 'pc1', user_id: 'u1', symbol: query.get('symbol'), date, instrument_type: query.get('instrument_type'), strike: 24500, notes: '',
      annotations: [
        { id: 'a1', time: epoch(date, 10, 5), price: 24420, type: 'entry', instrument: 'underlying', strategy_name: 'Opening Range', category: 'Breakout', text: 'Opening Range entry' },
        { id: 'a2', time: epoch(date, 10, 40), price: 24480, type: 'exit', instrument: 'underlying', strategy_name: 'Opening Range', category: 'Breakout', text: 'Opening Range exit' },
      ],
      top_patterns: {},
    } }
  }
  if (route === 'data/expiry') return { status: 200, body: { symbol: query.get('symbol'), date: query.get('date'), expiry: '2026-11-13' } }
  return { status: 404, body: { detail: 'Not Found' } }
}
