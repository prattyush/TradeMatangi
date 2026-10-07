import type { RealTradingDayStatus } from './api'
/** A delayed HTTP response must not undo a newer closing/done SSE status. */
export function mergeRealTradingDayStatus(previous: RealTradingDayStatus | null, next: RealTradingDayStatus): RealTradingDayStatus {
  if (previous && next.date < previous.date) return previous
  const rank = { active: 0, closing: 1, done: 2 }
  if (previous?.date === next.date && rank[previous.state] > rank[next.state]) return previous
  return next
}
