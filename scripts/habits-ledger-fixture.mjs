/** Deterministic multi-day habit ledger shared by the Habits browser checks (the shape of GET /api/behavior/habit-ledger). */
const DAYS = Array.from({ length: 10 }, (_, d) => `2026-09-${String(14 + d + (d >= 5 ? 2 : 0)).padStart(2, '0')}`) // skips a weekend
const q = (question_id, kind, text, status = 'active') => ({ question_id, kind, text, status, sort_order: 0, created_at: '2026-09-01', archived_at: status === 'archived' ? '2026-09-20T10:00:00Z' : null })
export const questions = [
  q('qa', 'entry', 'Chased the move'),
  q('qb', 'exit', 'Exited after one bar in profit'),
  q('qc', 'entry', 'Waited for the retest'),
  q('qd', 'entry', 'Old revenge habit', 'archived'),
  q('qe', 'exit', 'Moved the stoploss out'),
]
let serial = 0
const row = (date, hour, pnl_pct, capital_pct, bars, habits, extra = {}) => {
  serial += 1
  const entry_time = Date.parse(`${date}T${String(9 + hour).padStart(2, '0')}:20:00Z`) / 1000
  return {
    cycle_id: `cycle-${serial}`, session_id: `session-${date}`, date, entry_time, exit_time: entry_time + 60 * bars, symbol: 'NIFTY', right: 'CE', strike: 24000, direction: 'LONG',
    net_pnl: Math.round(pnl_pct * 1000 * 100) / 100, pnl_pct, capital_pct, risk_pct: capital_pct == null ? null : capital_pct / 10, entries: 1, exits: 1,
    holding_seconds: 60 * bars, bars, r_multiple: null, entry_method: 'MANUAL', habits, ...extra,
  }
}
export const trades = []
DAYS.forEach((date, d) => {
  const chasedCapital = 22 - 1.5 * d                                    // the habit is still taken, but with smaller size each day
  trades.push(row(date, 0, -chasedCapital / 20, chasedCapital, 1 + (d % 2), ['qa']))                                  // chased: always a loss
  trades.push(row(date, 1, d % 3 === 0 ? 0.1 : -0.3, 10, 1, ['qb'], { entries: 1, exits: 2 }))                         // exited early within 1 bar
  trades.push(row(date, 2, 0.8, 12, 5, ['qc'], { entries: 2 }))                                                      // waited for the retest: wins
  trades.push(row(date, 3, d % 2 ? -0.2 : 0.4, 10, 3, d < 3 ? ['qd'] : []))                                          // some old habit marks, otherwise the baseline
  trades.push(row(date, 4, d % 2 ? -0.1 : 0.3, d === 4 ? null : 8, d === 6 ? null : 2, d < 4 ? ['qa'] : []))        // baseline (and a few chased trades early on)
})
export const coverage = {
  closed_trades: trades.length, marked_trades: trades.filter(t => t.habits.length).length, marks: trades.reduce((n, t) => n + t.habits.length, 0),
  unmatched_marks: 2, open_marked_trades: 1, trades_without_capital: trades.filter(t => t.capital_pct == null).length,
  trades_without_bars: trades.filter(t => t.bars == null).length, truncated: false,
}
export const ledger = { questions, trades, coverage }

/** Independent expectations (plain loops, not the app's code) for the numbers the checks assert. */
export function expected() {
  const out = {}
  for (const question of questions) {
    const own = trades.filter(t => t.habits.includes(question.question_id))
    if (!own.length) continue
    const pcts = own.map(t => t.pnl_pct)
    out[question.question_id] = {
      trades: own.length,
      net_pct: pcts.reduce((a, b) => a + b, 0),
      profit_pct: pcts.filter(p => p > 0).reduce((a, b) => a + b, 0),
      loss_pct: pcts.filter(p => p < 0).reduce((a, b) => a + b, 0),
      net_pnl: own.reduce((a, t) => a + t.net_pnl, 0),
      avg_capital: own.filter(t => t.capital_pct != null).reduce((a, t, _, list) => a + t.capital_pct / list.length, 0),
    }
  }
  return out
}
export const signedPct = n => `${n > 0 ? '+' : ''}${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`
