import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useServices } from './AppContext'

/** How much detail the chart draws over the candles (time, open/high/low/close, indicator values). */
export type ChartInfo = 'follow_cross' | 'always' | 'none'
export const CHART_INFO_DEFAULT: ChartInfo = 'follow_cross'
export const CHART_INFO_LABELS: Record<ChartInfo, string> = { follow_cross: 'While touching', always: 'Always', none: 'Never' }
const KEY = 'tm.chart_info'

export const parseChartInfo = (value: string | null): ChartInfo =>
  value === 'always' || value === 'none' || value === 'follow_cross' ? value : CHART_INFO_DEFAULT

interface ChartInfoValue { chartInfo: ChartInfo; setChartInfo(next: ChartInfo): void }
const ChartInfoContext = createContext<ChartInfoValue>({ chartInfo: CHART_INFO_DEFAULT, setChartInfo: () => {} })
export const useChartInfo = (): ChartInfoValue => useContext(ChartInfoContext)

/** The chart-details choice, remembered on the phone. The default shows them only while a finger is on the chart. */
export function ChartInfoProvider({ children }: { children: ReactNode }) {
  const { prefs } = useServices()
  const [chartInfo, setValue] = useState<ChartInfo>(CHART_INFO_DEFAULT)
  useEffect(() => { void prefs.get(KEY).then(value => setValue(parseChartInfo(value))) }, [prefs])
  const setChartInfo = useCallback((next: ChartInfo) => { setValue(next); void prefs.set(KEY, next) }, [prefs])
  const value = useMemo(() => ({ chartInfo, setChartInfo }), [chartInfo, setChartInfo])
  return <ChartInfoContext.Provider value={value}>{children}</ChartInfoContext.Provider>
}
