import { useMemo } from 'react'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import { AnalysisProvider, useAnalysisEnvironment } from '../../../../../shared/analysis/environment'
import type { PerformanceCycle } from '../../../../../shared/analysis/performance'
import TradeWalkthrough from '../../../../../shared/analysis/walkthrough/TradeWalkthrough'
import { useBackHandler } from '../../../app/Nav'
import { LabelingHostContext } from '../labeling/context'
import PhoneLabelCharts from '../labeling/PhoneLabelCharts'
import '../labeling/labeling.css'
import './walkthrough.css'

/**
 * Trade Walkthrough, full screen: the chart (centred on the viewed trade) on the left, one round trip on the right with the
 * day's P&L before and after it, the entries and exits (size, capital %, time, and a colour-coded code for how each happened)
 * and a More info arrow per row. Read-only: it reuses Label trades' layout and chart, and nothing is saved. Back closes it.
 */
export function WalkthroughOverlay({ group, trades, cycles, onClose }: { group: SessionGroup; trades: AnalysisTrade[]; cycles: PerformanceCycle[]; onClose: () => void }) {
  const environment = useAnalysisEnvironment()
  useBackHandler(() => { onClose(); return true })
  const walkEnvironment = useMemo(() => ({ ...environment, charts: { ...environment.charts, LabelCharts: PhoneLabelCharts } }), [environment])
  const capitals = useMemo(() => new Map(group.sessions.map(session => [session.session_id, session.session_capital])), [group.sessions])
  return (
    <div className="phone-labeling phone-walkthrough" role="dialog" aria-label="Trade walkthrough">
      <LabelingHostContext.Provider value={{ requestClose: onClose }}>
        <AnalysisProvider value={walkEnvironment}>
          <TradeWalkthrough symbol={group.symbol} date={group.date} sessionIds={group.sessions.map(session => session.session_id)} allTrades={trades}
            historicalDays={environment.historicalDays ?? 2} cycles={cycles} capitals={capitals} />
        </AnalysisProvider>
      </LabelingHostContext.Provider>
    </div>
  )
}
