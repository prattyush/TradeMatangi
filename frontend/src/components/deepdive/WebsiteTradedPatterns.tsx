import { useMemo } from 'react'
import { tradedApi } from '../../services/api'
import { withWebsiteAnalysis } from '../../services/analysisEnvironment'
import { useAnalysisChartRenderer } from '../../hooks/useAnalysisChartRenderer'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import TradedPatterns from '../../../../shared/traded/ui/TradedPatterns'
import type { TradedHost } from '../../../../shared/traded/ui/host'
import { loadHistoricalDays } from '../SettingsModal'
import DeepDiveLightChart from './DeepDiveLightChart'
import './deepDiveWeb.css'

function Page({ onEdit }: { onEdit: (chartId: string) => void | Promise<void> }) {
  const env = useAnalysisEnvironment()
  const renderer = useAnalysisChartRenderer()
  const historicalDays = loadHistoricalDays()
  const host = useMemo<TradedHost>(() => ({
    api: tradedApi,
    // KLine: the shared Analysis chart. Lightweight: the page's own candles, EMA and marks (the same chart the Deep Dive uses).
    Chart: (renderer === 'kline' && env.charts?.AnalysisChart ? env.charts.AnalysisChart : DeepDiveLightChart) as TradedHost['Chart'],
    historicalDays, onEdit,
  }), [renderer, env.charts, historicalDays, onEdit])
  return <div className="dd-web"><TradedPatterns host={host} /></div>
}

/** The Pattern Library's "From your trades" on the website and webapp, on whichever chart renderer Analysis & Patterns uses. */
export default withWebsiteAnalysis(Page)
