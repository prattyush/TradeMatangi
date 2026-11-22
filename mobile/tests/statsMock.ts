/** Mock data for Stats and Habits (`performance*` and `behavior/habit-ledger`), shaped like the real server's responses. */
import type { MockResponse } from './analysisMock'

const metrics = (count: number, net: number, wins: number, losses: number) => ({
  count, net_pnl: net, fees: count * 40, wins, losses, breakeven: count - wins - losses,
  win_pct: count ? (wins / count) * 100 : null, expectancy: count ? net / count : null, median_pnl: count ? net / count : null,
  mean_pnl_pct: count ? net / count / 5000 : null, median_pnl_pct: count ? net / count / 5000 : null,
  profit_factor: losses ? 1.4 : null, quantity: count * 75,
})
const row = (key: string, count: number, net: number, wins: number, losses: number) => ({ key, ...metrics(count, net, wins, losses) })

const DATES = ['2026-11-09', '2026-11-07', '2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02']
const PNL = [3200, -1250, 900, -300, -4500, 2100, 1800, -700, 650, -150, 2400, -2200]

function cycle(index: number) {
  const date = DATES[index % DATES.length]
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 10, 5 + index) / 1000
  const pnl = PNL[index % PNL.length]
  return {
    cycle_id: `c-${index}`, session_id: `s-${index % 4}`, symbol: 'NIFTY', right: index % 2 ? 'PE' : 'CE', strike: 24400 + (index % 4) * 100, expiry: '2026-11-13',
    date, mode: index % 3 === 0 ? 'paper' : index % 3 === 1 ? 'real' : 'sim', direction: 'LONG', state: 'CLOSED',
    entry_time: base, exit_time: base + 1800, entry_count: 1, exit_count: 1, net_pnl: pnl, pnl_pct: pnl / 5000, fees: 40, open_quantity: 0,
    executions: [], entries: [], matches: [], label: null, behavior: [],
    instrument_type: 'options', trading_style: 'intraday', capital: 500000,
  }
}

export const CYCLES = Array.from({ length: 12 }, (_, index) => cycle(index))

export function performanceReport() {
  const wins = PNL.filter(value => value > 0).length
  const losses = PNL.filter(value => value < 0).length
  const total = PNL.reduce((sum, value) => sum + value, 0)
  let running = 0
  return {
    version: 1,
    summary: { ...metrics(PNL.length, total, wins, losses), realized_pnl: total, open_cycles: 0, open_entry_fees: 0, drawdown: -5100, days: DATES.length, mean_interval: null },
    comparisons: {
      modes: [row('paper', 4, 3500, 3, 1), row('real', 4, -4600, 1, 3), row('sim', 4, 4150, 3, 1)],
      entries: [row('MARKET', 8, 2400, 5, 3), row('LIMIT', 4, -1100, 1, 3)],
      exits: [row('MARKET', 7, 1500, 4, 3), row('STOPLOSS', 3, -2800, 0, 3), row('TARGET', 2, 4200, 2, 0)],
      exit_sizes: [row('FULL', 9, 1000, 5, 4)],
      sizing: [row('CAPITAL', 12, 1300, 6, 6)],
      percentages: [row('10', 6, 800, 3, 3), row('20', 6, 500, 3, 3)],
      entry_tag: [row('BREAKOUT', 5, 2100, 3, 2)],
      exit_tag: [row('TARGET', 4, 3000, 3, 1)],
      expected_strategy: [row('Opening Range', 4, 1900, 3, 1)],
      actual_strategy: [row('Trend Pullback', 5, 700, 3, 2)],
    },
    behavior: [
      { ...row('Chased the move', 4, -3100, 1, 3), dimension: 'entry' },
      { ...row('Waited for confirmation', 5, 4300, 4, 1), dimension: 'entry' },
      { ...row('Exited too early', 3, -900, 1, 2), dimension: 'exit' },
    ],
    curve: PNL.map((value, index) => ({ time: 1_762_650_000 + index * 3600, pnl: (running += value), drawdown: Math.min(0, running), cycle_id: `c-${index}` })),
    daily: DATES.map((date, index) => ({ date, net_pnl: PNL[index] + PNL[index + 6], fees: 80, cycles: 2 })),
    matrix: [{ entry: 'MARKET', exit: 'TARGET', ...metrics(2, 4200, 2, 0) }, { entry: 'MARKET', exit: 'STOPLOSS', ...metrics(3, -2800, 0, 3) }],
    distributions: PNL.map((value, index) => ({ cycle_id: `c-${index}`, pnl: value, pnl_pct: value / 5000, date: DATES[index % DATES.length], mode: 'paper' })),
    coverage: { entries: 12, known_entries: 12, labeled_cycles: 7, order_level_cycles: 12 },
    insights: [{ text: 'STOPLOSS exits lost money in all 3 of 3 cycles.', dimension: 'exit_method', key: 'STOPLOSS' }],
    day_paths: [],
  }
}

const Q = [
  { question_id: 'q-entry-1', kind: 'entry', text: 'Chased the move', status: 'active', sort_order: 1, created_at: '2026-10-01', archived_at: null },
  { question_id: 'q-entry-2', kind: 'entry', text: 'Waited for confirmation', status: 'active', sort_order: 2, created_at: '2026-10-02', archived_at: null },
  { question_id: 'q-exit-1', kind: 'exit', text: 'Exited too early', status: 'active', sort_order: 1, created_at: '2026-10-03', archived_at: null },
]

/** 12 closed trades; "Chased the move" costs money, "Waited for confirmation" pays. */
export function habitLedger() {
  const trades = CYCLES.map((c, index) => ({
    cycle_id: c.cycle_id, session_id: c.session_id, date: c.date, created_at: null, created_date: null, session_seq: index % 4,
    entry_time: c.entry_time, exit_time: c.exit_time, symbol: 'NIFTY', right: c.right, strike: c.strike, direction: 'LONG',
    net_pnl: c.net_pnl, pnl_pct: c.pnl_pct, capital_pct: 10, risk_pct: 1, entries: 1, exits: 1, holding_seconds: 1800, bars: 10,
    r_multiple: c.net_pnl / 500, entry_method: 'MARKET',
    habits: c.net_pnl < 0 ? ['q-entry-1', ...(index % 2 ? ['q-exit-1'] : [])] : ['q-entry-2'],
  }))
  return { questions: Q, trades, coverage: { closed_trades: 12, marked_trades: 12, marks: 14, unmatched_marks: 0, open_marked_trades: 0, trades_without_capital: 0, trades_without_bars: 0, truncated: false } }
}

export interface StatsMockState {
  /** What the performance endpoints do: normal, no trades in range, or 404 like an old server. */
  stats?: 'ok' | 'empty' | 'old' | 'fail-once'
  failedStatsOnce?: boolean
  /** Query of each request, to check the date range and filters that were sent. */
  performanceRequests: URLSearchParams[]
  ledgerRequests: URLSearchParams[]
  habitsOld?: boolean
}

/** Returns null for a route that is not a Stats route. */
export function statsResponse(route: string, query: URLSearchParams, state: StatsMockState): MockResponse | null {
  const isPerformance = route === 'performance' || route.startsWith('performance/')
  const isLedger = route === 'behavior/habit-ledger'
  if (!isPerformance && !isLedger) return null
  if (isLedger) {
    state.ledgerRequests.push(query)
    if (state.habitsOld) return { status: 404, body: { detail: 'Not Found' } }
    return { status: 200, body: state.stats === 'empty' ? { ...habitLedger(), trades: [], coverage: { ...habitLedger().coverage, closed_trades: 0, marked_trades: 0 } } : habitLedger() }
  }
  if (route.startsWith('performance/real-fees')) return { status: 404, body: { detail: 'Not Found' } }
  if (route === 'performance') state.performanceRequests.push(query)
  if (state.stats === 'old') return { status: 404, body: { detail: 'Not Found' } }
  if (state.stats === 'fail-once' && route === 'performance' && !state.failedStatsOnce) { state.failedStatsOnce = true; return { status: 500, body: { detail: 'Internal error' } } }
  if (route === 'performance') {
    if (state.stats === 'empty') {
      const empty = performanceReport()
      return { status: 200, body: { ...empty, summary: { ...empty.summary, ...metrics(0, 0, 0, 0), realized_pnl: 0, days: 0 }, comparisons: Object.fromEntries(Object.keys(empty.comparisons).map(key => [key, []])), behavior: [], curve: [], daily: [], matrix: [], distributions: [], insights: [], coverage: { entries: 0, known_entries: 0, labeled_cycles: 0, order_level_cycles: 0 } } }
    }
    return { status: 200, body: performanceReport() }
  }
  if (route === 'performance/cycles') {
    const items = state.stats === 'empty' ? [] : CYCLES
    return { status: 200, body: { items, total: items.length, next_offset: null } }
  }
  const detail = route.match(/^performance\/cycles\/([A-Za-z0-9_-]+)$/)
  if (detail) {
    // Cycles of the Sessions mock days are not in the Stats list; any id opens a plausible cycle.
    const found = CYCLES.find(c => c.cycle_id === detail[1]) ?? { ...CYCLES[0], cycle_id: detail[1], session_id: query.get('session_id') ?? 's' }
    return { status: 200, body: found }
  }
  if (route === 'performance/swing') return { status: 404, body: { detail: 'Not Found' } }
  return { status: 404, body: { detail: 'Not Found' } }
}
