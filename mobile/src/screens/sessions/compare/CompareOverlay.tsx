import PatternVsTradeComparison from '../../../../../shared/analysis/PatternVsTradeComparison'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import { useBackHandler } from '../../../app/Nav'
import './compare.css'

/**
 * Compare: the day's trades beside the saved pattern annotations for the same day, the shared screen with the phone's
 * layout (compare.css). Full screen; Back or Close returns to the session. Read-only.
 */
export function CompareOverlay({ group, trades, historicalDays, onClose }: { group: SessionGroup; trades: AnalysisTrade[]; historicalDays: number; onClose: () => void }) {
  useBackHandler(() => { onClose(); return true })
  return (
    <div className="phone-compare">
      <PatternVsTradeComparison
        symbol={group.symbol}
        date={group.date}
        instrumentType={group.instrument_type}
        sessionIds={group.sessions.map(session => session.session_id)}
        allTrades={trades}
        historicalDays={historicalDays}
        onClose={onClose}
      />
    </div>
  )
}
