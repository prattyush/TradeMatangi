import type { groupSessions } from '../../shared/analysis/TradeAnalysis'

type Group = ReturnType<typeof groupSessions>[number]

/** Winning, losing or flat: the colour cue of a day in the Analysis navigator (the website and the phone colour days the same way). */
export const dayTone = (pnl: number): 'win' | 'loss' | 'flat' => (pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat')

export function signedMoney(value: number): string {
  const text = `₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
}

/** One day (a group of sessions) in the left-hand list of Analysis, with a green or red edge and P&L for a winning or losing day. */
export function SessionDayButton({ group, pressed, onSelect }: { group: Group; pressed: boolean; onSelect: () => void }) {
  const tone = dayTone(group.totalPnl)
  const first = group.sessions[0]
  return (
    <button type="button" className={`analysis-day day-${tone}`} aria-pressed={pressed} onClick={onSelect}>
      <strong>{group.date} · {group.symbol}</strong>
      <span>{first?.shared ? `Shared by ${first.owner_email ?? first.user_id} · ` : ''}{group.instrument_type} · {group.session_type === 'sim' ? 'Replay' : group.session_type} · {group.sessions.length} session(s)</span>
      <span><b className={`day-pnl ${tone}`}>{signedMoney(group.totalPnl)}</b> · {group.totalTrades} closed trades</span>
    </button>
  )
}
