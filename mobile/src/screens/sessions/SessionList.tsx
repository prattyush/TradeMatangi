import type { SessionGroup } from '../../../../shared/analysis/TradeAnalysis'
import { dateParts, formatPnl, instrumentLabel, modeLabel, pnlClass } from './format'

/** One line per trading day and instrument: date, what was traded, how it went. */
export function SessionRow({ group, selected, onSelect }: { group: SessionGroup; selected: boolean; onSelect: () => void }) {
  const parts = dateParts(group.date)
  const sessions = group.sessions.length > 1 ? ` · ${group.sessions.length} sessions` : ''
  return (
    <button type="button" className="session-row" aria-current={selected ? 'true' : undefined} onClick={onSelect}
      aria-label={`${parts.day} ${parts.month} ${group.symbol} ${instrumentLabel(group.instrument_type)}, ${formatPnl(group.totalPnl)}`}>
      <span className="session-date">
        <strong>{parts.day}</strong>
        <small>{parts.month}</small>
      </span>
      <span className="session-what">
        <strong>{group.symbol}</strong>
        <small>
          {instrumentLabel(group.instrument_type)}
          <span className={`badge badge-${group.session_type || 'sim'}`}>{modeLabel(group.session_type)}</span>
          {group.trading_style === 'swing' && <span className="badge badge-swing">Swing</span>}
          {sessions}
        </small>
      </span>
      <span className="session-result">
        <strong className={pnlClass(group.totalPnl)}>{formatPnl(group.totalPnl)}</strong>
        <small>{group.totalTrades} {group.totalTrades === 1 ? 'trade' : 'trades'}</small>
      </span>
    </button>
  )
}
