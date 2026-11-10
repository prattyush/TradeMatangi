import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import { PhoneChartPanel } from '../PhoneChartPanel'
import { useLabelingHost } from './context'

/**
 * The chart renderer the shared Label Trades screen asks the environment for (`charts.LabelCharts`).
 * It is the session chart (Underlying | Option, strike menu, all in the chart's header row) with a Back button in front,
 * centred on the viewed trade and marking only its executions.
 */
export default function PhoneLabelCharts({ symbol, date, allTrades, historicalDays, getMarkerText, focusTime, labelContractMarkers }: {
  symbol: string; date: string; allTrades: AnalysisTrade[]; historicalDays: number; getMarkerText?: (trade: AnalysisTrade) => string
  focusTime?: number; labelContractMarkers?: boolean; layout?: 'single' | 'split'
}) {
  const { requestClose } = useLabelingHost()
  return (
    <PhoneChartPanel symbol={symbol} date={date} trades={allTrades} historicalDays={historicalDays}
      getMarkerText={getMarkerText} focusTime={focusTime} labelContractMarkers={labelContractMarkers} allowMaximize={false}
      toolbarLead={<button type="button" className="back-button" aria-label="Close labeling" onClick={requestClose}>←</button>} />
  )
}
