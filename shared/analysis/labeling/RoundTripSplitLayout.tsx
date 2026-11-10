import type { ReactNode } from 'react'
import type { AnalysisTrade } from '../api'
import { useAnalysisEnvironment } from '../environment'
import LabelChartPanes from './LabelChartPanes'
import type { WhatIfChartExtras } from '../whatif/chartExtras'
import './labeling.css'

/**
 * Charts on the left, the round trip's panel (children) on the right: the layout of Label Trades, Trade Walkthrough and
 * What If. Desktop gets its workflow wrapper; maximized covers the whole window. `footer` is for modals that live inside
 * the root (the behavior question manager).
 */
export default function RoundTripSplitLayout({ symbol, date, historicalDays, chartTrades, getMarkerText, focusTime, maximized, children, footer, chartExtras }: {
  symbol: string
  date: string
  historicalDays: number
  chartTrades: AnalysisTrade[]
  getMarkerText: (trade: AnalysisTrade, forOption?: boolean) => string
  focusTime: number | undefined
  maximized: boolean
  children: ReactNode
  footer?: ReactNode
  /** What If: price picking and the edited legs, passed to charts that support them. */
  chartExtras?: WhatIfChartExtras
}) {
  const environment = useAnalysisEnvironment()
  const LabelCharts = environment.charts?.LabelCharts
  const content = (
    <div className={`tl-root tl-layout ${maximized ? 'maximized' : ''}`}>
      {/* Chart */}
      <div className="label-chart-container tl-chart-col">
        {LabelCharts
          ? <LabelCharts symbol={symbol} date={date} allTrades={chartTrades} historicalDays={historicalDays} getMarkerText={getMarkerText} focusTime={focusTime} labelContractMarkers layout={maximized ? 'split' : 'single'} {...chartExtras} />
          : <LabelChartPanes symbol={symbol} date={date} trades={chartTrades} historicalDays={historicalDays} getMarkerText={getMarkerText} focusTime={focusTime} maximized={maximized} extras={chartExtras} />}
      </div>

      {/* Round-trip panel */}
      <div className="tl-side-col">{children}</div>
      {footer}
    </div>
  )
  if (environment.desktop) return <div className={`desktop-label-workflow ${maximized ? 'labels-maximized' : ''}`}>{content}</div>
  if (maximized) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0d1117', display: 'flex', flexDirection: 'column', padding: 12 }}>
        {content}
      </div>
    )
  }
  return content
}
