import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { OHLCCandle } from './api'
import type websiteApi from '../../frontend/src/services/api'
import type { PerformanceCycle, PerformanceFilters, PerformanceReport, RealFeesDay } from './performance'
import type { HabitLedger } from './habits/types'
import type { VideoLinksSource } from './videoLinks'
import type { WhatIfSource } from './whatif/scenarios'

export type AnalysisApi = Pick<typeof websiteApi,
  'getAnalysisSessions' | 'getSessionDetail' | 'getRoundTrips' | 'getLabels' | 'saveLabels' |
  'getEntryTags' | 'getExitTags' | 'getBehaviorQuestions' | 'addBehaviorQuestion' | 'updateBehaviorQuestion' |
  'archiveBehaviorQuestion' | 'restoreBehaviorQuestion' | 'getBehaviorMarks' | 'saveBehaviorMarks' | 'getHistorical' | 'getPreSession' | 'getOptionsHistorical' |
  'getExpiry' | 'getSnapshots' | 'deleteSnapshots' | 'patternListStrategies' |
  'patternListCategories' | 'patternAddStrategy' | 'patternAddCategory' | 'patternGetChartByDate' | 'patternOhlcEquity' | 'patternOhlcOptions'> & {
  getSnapshotCandle?: (sessionId: string, eventId: string, instrument: 'underlying' | 'CE' | 'PE', signal?: AbortSignal) => Promise<{candle: OHLCCandle | null}>
}
export interface AnalysisEnvironment {
  swingRequest?: import('../SwingPortfolioPanel').SwingRequest
  /** Transport for `/api/desktop/v1/*` (persisted KLine drawings, chart settings). Absent => drawing tools stay disabled. */
  drawingRequest?: (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>) => Promise<unknown>
  /** Catalogue kind/exchange of an underlying, so Analysis drawings share the trading chart's instrument key. */
  resolveSymbolInstrument?: (symbol: string) => Promise<{ kind: string; exchange: string } | undefined>
  /** Scopes locally-stored chart preferences (indicators) to the signed-in account. */
  accountKey?: string
  api: AnalysisApi
  /** YouTube videos uploaded for a session (owner only). Absent => Analysis shows no videos. */
  videoLinks?: VideoLinksSource
  /** Saved What If scenarios (owner only). Absent => What If is a playground that is lost on refresh. */
  whatIf?: WhatIfSource
  performance: {
    getSwingReport?: (filters:PerformanceFilters,signal?:AbortSignal)=>Promise<any>
    getRealFees?: (date: string, signal?: AbortSignal) => Promise<RealFeesDay>
    saveRealFees?: (date: string, account: string, amount: number, broker?: "kotak" | "kite") => Promise<RealFeesDay>
    deleteRealFees?: (date: string, account: string, broker?: "kotak" | "kite") => Promise<RealFeesDay>
    getPerformance: (filters: PerformanceFilters, signal?: AbortSignal) => Promise<PerformanceReport>
    getPerformanceCycles: (filters: PerformanceFilters, offset?: number, signal?: AbortSignal) => Promise<{ items: PerformanceCycle[]; total: number; next_offset: number | null }>
    getPerformanceDetail: (cycle: Pick<PerformanceCycle, "session_id" | "cycle_id">, enrich?: boolean, signal?: AbortSignal) => Promise<PerformanceCycle>
    /** Closed own trades with their habits for the dashboard filters (Stats → Habits). */
    getHabitLedger?: (filters: PerformanceFilters, signal?: AbortSignal) => Promise<HabitLedger>
  }
  // Each adapter implements the existing chart's public props. The heterogeneous
  // snapshot/pattern inputs are normalized inside the desktop renderer boundary.
  charts?: Record<string, ComponentType<any>>
  reportError?: (error: string, source: string) => void
  active?: boolean
  desktop?: boolean
  intervalMinutes?: number
  setIntervalMinutes?: (minutes: number) => void
  /**
   * Candle and indicator details drawn over the chart (time, open/high/low/close, indicator values):
   * `always` (default, as before), `follow_cross` (only while the crosshair is active, i.e. while touching) or `none`.
   */
  chartInfo?: 'always' | 'follow_cross' | 'none'
  historicalDays?: number
  /** Label Trades layout (user setting `analysis_label_view`); absent => one trade at a time. */
  labelView?: 'one_by_one' | 'all'
  /** Persists the user's choice; the host owns the settings transport. */
  onLabelViewChange?: (view: 'one_by_one' | 'all') => void | Promise<unknown>
  /** User setting `desktop_pnl_display_mode`: Label Trades shows P&L as % of capital or as money. Absent => money. */
  pnlDisplayMode?: 'currency' | 'percent'
  dataRevision?: number
  onDataChanged?: () => void
  onLabelSavingChange?: (saving: boolean) => void
  onDirtyChange?: (dirty: boolean) => void
  confirmDiscard?: () => boolean
  onSelectionContextChange?: () => void
  onSelectExecution?: (trade: import('./api').AnalysisTrade) => void
}
const Context = createContext<AnalysisEnvironment | null>(null)
export function AnalysisProvider({ value, children }: { value: AnalysisEnvironment; children: ReactNode }) {
  const parent = useContext(Context)
  const [intervalMinutes, setIntervalMinutes] = useState(3)
  return <Context.Provider value={{...value, intervalMinutes: parent?.intervalMinutes ?? intervalMinutes, setIntervalMinutes: parent?.setIntervalMinutes ?? setIntervalMinutes}}>{children}</Context.Provider>
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
