import type { AnalysisTrade } from '../../../../../shared/analysis/api'
import { PhoneChartPanel } from '../PhoneChartPanel'
import type { WhatIfChartExtras } from '../../../../../shared/analysis/whatif/chartExtras'
import { useLabelingHost } from './context'

/**
 * The chart renderer the shared Label Trades screen asks the environment for (`charts.LabelCharts`).
 * It is the session chart (Underlying | Option, strike menu, all in the chart's header row) with a Back button in front,
 * centred on the viewed trade and marking only its executions. The option chart's markers carry no text on a phone (the colour
 * says buy or sell and only one trade is shown), whichever of Label Trades, Walkthrough or What If it serves.
 */
export default function PhoneLabelCharts({ symbol, date, allTrades, historicalDays, getMarkerText, focusTime, pickTarget, onPick, onPickCancel, pickHint, whatIfMarkers }: {
  symbol: string; date: string; allTrades: AnalysisTrade[]; historicalDays: number; getMarkerText?: (trade: AnalysisTrade, forOption?: boolean) => string
  focusTime?: number; labelContractMarkers?: boolean; layout?: 'single' | 'split'
} & WhatIfChartExtras) {
  const { requestClose } = useLabelingHost()
  return (
    <PhoneChartPanel symbol={symbol} date={date} trades={allTrades} historicalDays={historicalDays}
      getMarkerText={getMarkerText} focusTime={focusTime} labelContractMarkers={false} allowMaximize={false}
      pickTarget={pickTarget} onPick={onPick} onPickCancel={onPickCancel} pickHint={pickHint} whatIfMarkers={whatIfMarkers}
      toolbarLead={<button type="button" className="back-button" aria-label="Close labeling" onClick={requestClose}>←</button>} />
  )
}
