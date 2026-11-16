import { useMemo } from 'react'
import api, { deepDiveApi } from '../../services/api'
import { withWebsiteAnalysis } from '../../services/analysisEnvironment'
import { useAnalysisChartRenderer } from '../../hooks/useAnalysisChartRenderer'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import DeepDive from '../../../../shared/deepdive/ui/DeepDive'
import type { DeepDiveHost, DiveChartProps } from '../../../../shared/deepdive/ui/host'
import { resolveStrikes, type StrikeLookup } from '../../../../shared/deepdive/strikes'
import { loadHistoricalDays, loadMaxPriceMode, loadMaxPriceThresholdCE, loadMaxPriceThresholdPE } from '../SettingsModal'
import DeepDiveLightChart from './DeepDiveLightChart'
import './deepDiveWeb.css'

/** The strike lookups the Patterns screens use: minute data, so no second-level download. */
const lookup: StrikeLookup = {
  getExpiry: (symbol, date) => api.getExpiry(symbol, date),
  getPriceAt: (symbol, date, time) => api.getPriceAt(symbol, date, time, 'replay', 'minute'),
  findStrikeByPrice: (symbol, date, expiry, right, maxPrice, referenceTime) => api.findStrikeByPrice(symbol, date, expiry, right, maxPrice, referenceTime, 'replay', 'minute'),
}

function Page() {
  const env = useAnalysisEnvironment()
  const renderer = useAnalysisChartRenderer()
  const mode = loadMaxPriceMode(), ceCap = loadMaxPriceThresholdCE(), peCap = loadMaxPriceThresholdPE(), historicalDays = loadHistoricalDays()
  const host = useMemo<DeepDiveHost>(() => ({
    api: deepDiveApi,
    names: {
      categories: async () => (await api.patternListCategories()).categories,
      strategies: async () => (await api.patternListStrategies()).strategies,
      addCategory: name => api.patternAddCategory(name),
      addStrategy: name => api.patternAddStrategy(name),
    },
    expiry: async (symbol, date) => (await api.getExpiry(symbol, date)).expiry,
    resolveStrikes: (symbol, date, offset, settings) => resolveStrikes(lookup, symbol, date, offset, settings),
    settings: { mode, ceCap, peCap, historicalDays, loaded: true },
    // KLine: the shared Analysis chart the rest of Analysis uses. Lightweight: the page's own candles, EMA and marks.
    Chart: (renderer === 'kline' && env.charts?.AnalysisChart ? env.charts.AnalysisChart : DeepDiveLightChart) as DeepDiveHost['Chart'] & ((props: DiveChartProps) => unknown),
  }), [renderer, env.charts, mode, ceCap, peCap, historicalDays])
  return <div className="dd-web"><DeepDive host={host} /></div>
}

/** The Deep Dive on the website and webapp: the Pattern Library's third mode, on whichever chart renderer Analysis & Patterns uses. */
export default withWebsiteAnalysis(Page)
