import { createContext, useContext, useEffect, type ComponentType, type ReactNode } from 'react'
import type websiteApi from '../../frontend/src/services/api'
import type { PerformanceCycle, PerformanceFilters, PerformanceReport } from './performance'

export type AnalysisApi = Pick<typeof websiteApi,
  'getAnalysisSessions' | 'getSessionDetail' | 'getRoundTrips' | 'getLabels' | 'saveLabels' |
  'getEntryTags' | 'getExitTags' | 'getHistorical' | 'getPreSession' | 'getOptionsHistorical' |
  'getExpiry' | 'getSnapshots' | 'deleteSnapshots' | 'patternListStrategies' |
  'patternListCategories' | 'patternGetChartByDate' | 'patternOhlcEquity' | 'patternOhlcOptions'>
export interface AnalysisEnvironment {
  api: AnalysisApi
  performance: {
    getPerformance: (filters: PerformanceFilters, signal?: AbortSignal) => Promise<PerformanceReport>
    getPerformanceCycles: (filters: PerformanceFilters, offset?: number, signal?: AbortSignal) => Promise<{ items: PerformanceCycle[]; total: number; next_offset: number | null }>
    getPerformanceDetail: (cycle: PerformanceCycle, enrich?: boolean, signal?: AbortSignal) => Promise<PerformanceCycle>
  }
  // Each adapter implements the existing chart's public props. The heterogeneous
  // snapshot/pattern inputs are normalized inside the desktop renderer boundary.
  charts?: Record<string, ComponentType<any>>
  reportError?: (error: string, source: string) => void
  desktop?: boolean
  onSelectExecution?: (trade: import('./api').AnalysisTrade) => void
}
const Context = createContext<AnalysisEnvironment | null>(null)
export function AnalysisProvider({ value, children }: { value: AnalysisEnvironment; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useAnalysisEnvironment(): AnalysisEnvironment {
  const value = useContext(Context)
  if (!value) throw new Error('Analysis must have an authenticated provider')
  return value
}
export function useAnalysisApi() { return useAnalysisEnvironment().api }

export function useAnalysisError(error: string | null | undefined, source: string) {
  const report = useAnalysisEnvironment().reportError
  useEffect(() => { if (error) report?.(error, source) }, [error, source, report])
}
