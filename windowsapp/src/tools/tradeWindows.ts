import type { PlanTrade } from './cutPlan'

/** The parts of a round-trip row (`/analysis/round-trips`) this tool needs. */
export interface RoundTripLike {
  index: number
  right?: string | null
  state?: string | null
  entry_trades: Array<{ timestamp: number; right?: string | null; strike?: number | null }>
  exit_trades: Array<{ timestamp: number }>
  pnl_pct?: number | null
}

export interface SessionTrips {
  sessionId: string
  roundTrips: RoundTripLike[]
}

export function contractLabel(rt: RoundTripLike): string {
  const first = rt.entry_trades[0]
  const right = (rt.right ?? first?.right ?? '').toUpperCase()
  if (right !== 'CE' && right !== 'PE') return 'EQ'
  return first?.strike ? `${right} ${first.strike}` : right
}

/**
 * Trades to look for in the video.
 * One session: the number is the round-trip number (index + 1), matching Trade Labeling.
 * Several sessions: numbered 1, 2, 3 ... in entry-time order across all of them.
 * Round trips with no entry are skipped. A trip with no exit, or still marked open, is an open trade.
 */
export function buildPlanTrades(sessions: SessionTrips[]): PlanTrade[] {
  const out: PlanTrade[] = []
  for (const s of sessions) {
    for (const rt of s.roundTrips) {
      if (!rt.entry_trades.length) continue
      const entryTime = Math.min(...rt.entry_trades.map(t => t.timestamp))
      const open = rt.state === 'open' || rt.exit_trades.length === 0
      out.push({
        key: `${s.sessionId}#${rt.index}`,
        sessionId: s.sessionId,
        number: rt.index + 1,
        label: contractLabel(rt),
        entryTime,
        exitTime: open ? null : Math.max(...rt.exit_trades.map(t => t.timestamp)),
        pnlPct: typeof rt.pnl_pct === 'number' && Number.isFinite(rt.pnl_pct) ? rt.pnl_pct : null,
      })
    }
  }
  out.sort((a, b) => a.entryTime - b.entryTime || a.key.localeCompare(b.key))
  if (sessions.length > 1) out.forEach((t, i) => { t.number = i + 1 })
  return out
}
