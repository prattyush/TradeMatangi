import type { ReactNode } from 'react'
import type { groupSessions } from '../../shared/analysis/TradeAnalysis'

type Group = ReturnType<typeof groupSessions>[number]

/** Winning, losing or flat: the colour cue of a day in the Analysis navigator (the website and the phone colour days the same way). */
export const dayTone = (pnl: number): 'win' | 'loss' | 'flat' => (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat')

export function signedMoney(value: number): string {
  const text = `₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
}

/** One day (a group of sessions) in the left-hand list of Analysis, with a green or red edge and P&L for a winning or losing day. */
/** Share of closed round trips that won, as text (" · 60% wins"); empty when unknown (older backend) or the day has none. */
export function winText(group: Pick<Group, 'winningTrades' | 'totalTrades'>): string {
  return group.winningTrades !== undefined && group.totalTrades > 0 ? ` · ${Math.round((group.winningTrades / group.totalTrades) * 100)}% wins` : ''
}

export function SessionDayButton({ group, pressed, onSelect, badge }: { group: Group; pressed: boolean; onSelect: () => void; /** The labelled-or-not mark (Analysis passes it; tests leave it out). */ badge?: ReactNode }) {
  const tone = dayTone(group.totalPnl)
  const first = group.sessions[0]
  return (
    <button type="button" className={`analysis-day day-${tone}`} aria-pressed={pressed} onClick={onSelect}>
      <strong>{group.date} · {group.symbol}</strong>
      <span>{first?.shared ? `Shared by ${first.owner_email ?? first.user_id} · ` : ''}{group.instrument_type} · {group.session_type === 'sim' ? 'Replay' : group.session_type}{group.practice ? <b className="practice-tag" title="A practice run: kept out of the Performance totals"> · Practice: {group.practice.strategy}</b> : null} · {group.sessions.length} session(s)</span>
      <span><b className={`day-pnl ${tone}`}>{signedMoney(group.totalPnl)}</b> · {group.totalTrades} closed trades{winText(group)}</span>
      {badge}
    </button>
  )
}
