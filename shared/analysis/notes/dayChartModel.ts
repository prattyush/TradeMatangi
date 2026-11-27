import type { AnalysisTrade, SessionSummary } from '../api'

/** The sessions of a date a chart is drawn for: the user's own intraday ones with trades (no shared, swing or practice run). */
export function daySessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter(session => !session.shared && !session.practice && session.trading_style !== 'swing' && session.trade_count > 0)
}

/** The distinct symbols of those sessions, in alphabetical order (the tabs of the day chart). */
export function daySymbols(sessions: readonly SessionSummary[]): string[] {
  return [...new Set(sessions.map(session => session.symbol))].sort((a, b) => a.localeCompare(b))
}

/** Every symbol's trades from all its sessions of the day (replay, paper and real together), oldest first. `trades[i]` belong to `sessions[i]`. */
export function tradesBySymbol(sessions: readonly SessionSummary[], trades: ReadonlyArray<readonly AnalysisTrade[]>): Map<string, AnalysisTrade[]> {
  const bySymbol = new Map<string, AnalysisTrade[]>()
  sessions.forEach((session, index) => {
    const list = bySymbol.get(session.symbol) ?? []
    list.push(...(trades[index] ?? []))
    bySymbol.set(session.symbol, list)
  })
  for (const list of bySymbol.values()) list.sort((a, b) => a.timestamp - b.timestamp)
  return bySymbol
}
