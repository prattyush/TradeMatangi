import type { AnalysisTrade, RoundTrip, TradeLabel } from '../api'

/** A round trip tagged with the session it belongs to (Label Trades can span several sessions). */
export type LabeledRoundTrip = RoundTrip & { session_id: string }
export type LabelView = 'one_by_one' | 'all'

export const labelKey = (sessionId: string, index: number) => `${sessionId}#${index}`
export const tripKey = (rt: Pick<LabeledRoundTrip, 'session_id' | 'index'>) => labelKey(rt.session_id, rt.index)

export function blankLabel(sessionId: string, index: number): TradeLabel {
  return { session_id: sessionId, round_trip_index: index, expected_category: '', expected_strategy: '', actual_category: '', actual_strategy: '', entry_tag: '', exit_tag: '' }
}

/** The values stored for a label: unset actual pattern follows the expected one, unset tags mean "as per pattern". */
export function finalizeLabel(label: TradeLabel): TradeLabel {
  return {
    ...label,
    actual_category: label.actual_category || label.expected_category,
    actual_strategy: label.actual_strategy || label.expected_strategy,
    entry_tag: label.entry_tag || 'AS_PER_PATTERN',
    exit_tag: label.exit_tag || 'AS_PER_PATTERN',
  }
}

/** True when the user has chosen at least one pattern value (tags alone default and do not count). */
export function isLabeled(label: TradeLabel | undefined): boolean {
  return Boolean(label && (label.expected_category || label.expected_strategy || label.actual_category || label.actual_strategy))
}

const identities = (trade: Pick<AnalysisTrade, 'trade_id' | 'execution_id' | 'stored_trade_id'>) =>
  [trade.trade_id, trade.execution_id, trade.stored_trade_id].filter((id): id is string => Boolean(id))

/** The executions of one round trip, matched by trade/execution identity within the same session. */
export function tradesForRoundTrip(rt: LabeledRoundTrip, trades: AnalysisTrade[]): AnalysisTrade[] {
  const ids = new Set<string>()
  for (const leg of [...rt.entry_trades, ...rt.exit_trades]) {
    if (leg.trade_id) ids.add(leg.trade_id)
    if (leg.execution_id) ids.add(leg.execution_id)
  }
  return trades.filter(trade => trade.session_id === rt.session_id && identities(trade).some(id => ids.has(id)))
}

/** Chart marker text: the round trips an execution belongs to, e.g. "#3 BUY" or "#2/#3 SELL" (a reversal). */
export function roundTripMarkerText(roundTrips: LabeledRoundTrip[], trade: AnalysisTrade): string {
  const trips = roundTrips.filter(rt => rt.session_id === trade.session_id && tradesForRoundTrip(rt, [trade]).length > 0)
  return trips.length ? `${trips.map(rt => `#${rt.index}`).join('/')} ${trade.side}` : trade.side
}

/** "EQ", "CE 24500" … from the round trip's own legs. */
export function contractName(rt: Pick<RoundTrip, 'right' | 'entry_trades' | 'exit_trades'>): string {
  if (!rt.right) return 'EQ'
  const strike = [...rt.entry_trades, ...rt.exit_trades].find(leg => leg.strike != null)?.strike
  return strike != null ? `${rt.right} ${strike}` : rt.right
}

/** Round trip order for navigation: session order as given, then by round-trip index. */
export function orderRoundTrips(trips: LabeledRoundTrip[], sessionOrder: string[]): LabeledRoundTrip[] {
  const rank = new Map(sessionOrder.map((id, position) => [id, position]))
  return [...trips].sort((a, b) => (rank.get(a.session_id) ?? 0) - (rank.get(b.session_id) ?? 0) || a.index - b.index)
}

/** Candle clock time (the backend stores IST wall-clock values as UTC epoch seconds). */
export function fmtHHMM(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })
}

export const money = (value: number) => `${value >= 0 ? '+' : '-'}₹${Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const legsText = (legs: LabeledRoundTrip['entry_trades'], letter: 'B' | 'S') =>
  legs.map(leg => `${letter} ${leg.quantity}@${leg.price.toFixed(2)} ${fmtHHMM(leg.timestamp)}`).join(', ')
