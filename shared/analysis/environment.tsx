import { createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import type { OHLCCandle } from './api'
import type websiteApi from '../../frontend/src/services/api'
import type { PerformanceCycle, PerformanceFilters, PerformanceReport, RealFeesDay } from './performance'
import type { HabitLedger } from './habits/types'
import type { VideoLinksSource } from './videoLinks'
import type { WhatIfSource } from './whatif/scenarios'
import type { DayNotesSource } from './notes/types'
import type { DayScoreSource } from './dayScore/types'
import type { DaySummarySource } from './summary/types'
import type { StatsAllEntry } from '../deepdive/types'
import type { DiveChartProps } from '../deepdive/ui/host'
import type { PracticeApi } from '../practice/types'

export type AnalysisApi = Pick<typeof websiteApi,
  'getAnalysisSessions' | 'getSessionDetail' | 'getRoundTrips' | 'getLabels' | 'saveLabels' |
  'getEntryTags' | 'getExitTags' | 'getBehaviorQuestions' | 'addBehaviorQuestion' | 'updateBehaviorQuestion' |
  'archiveBehaviorQuestion' | 'restoreBehaviorQuestion' | 'getBehaviorMarks' | 'saveBehaviorMarks' | 'getHistorical' | 'getPreSession' | 'getOptionsHistorical' |
  'getExpiry' | 'getSnapshots' | 'deleteSnapshots' | 'patternListStrategies' |
  'patternListCategories' | 'patternAddStrategy' | 'patternAddCategory' | 'patternGetChartByDate' | 'patternOhlcEquity' | 'patternOhlcOptions'> & {
  getSnapshotCandle?: (sessionId: string, eventId: string, instrument: 'underlying' | 'CE' | 'PE', signal?: AbortSignal) => Promise<{candle: OHLCCandle | null}>
  /** Phase 26: the Deep Dive percentages of every strategy that has marked days, for the label forms. Absent (an older server or host) => no panel. */
  getDeepDiveStats?: () => Promise<StatsAllEntry[]>
}
export interface AnalysisEnvironment {
  swingRequest?: import('../SwingPortfolioPanel').SwingRequest
  /** Transport for `/api/desktop/v1/*` (persisted KLine drawings, chart settings). Absent => drawing tools stay disabled. */
  drawingRequest?: (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>) => Promise<unknown>
  /** Catalogue kind/exchange of an underlying, so Analysis drawings share the trading chart's instrument key. */
  resolveSymbolInstrument?: (symbol: string) => Promise<{ kind: string; exchange: string } | undefined>
  /** The charts show saved drawings but offer no tools to make or change them (the phone). */
  drawingsReadOnly?: boolean
  /** Scopes locally-stored chart preferences (indicators) to the signed-in account. */
  accountKey?: string
  api: AnalysisApi
  /** YouTube videos uploaded for a session (owner only). Absent => Analysis shows no videos. */
  videoLinks?: VideoLinksSource
  /** True when this host's Analysis charts can take a price by clicking them (KLine): What If then offers "pick on chart". */
  chartPicking?: boolean
  /** Saved What If scenarios (owner only). Absent => What If is a playground that is lost on refresh. */
  whatIf?: WhatIfSource
  /** Day notes and carried-over TODOs (Phase 27). Without it the Notes tab is not offered. */
  dayNotes?: DayNotesSource
  /** The day score (Phase 27). Without it no score is shown. */
  dayScore?: DayScoreSource
  /** The Summary's day cards (Phase 27). Without it the Summary is not offered (the phone). */
  daySummary?: DaySummarySource
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
  /**
   * Strategy Practice (Phase 26): what the review of a practice run needs (its read-only API and a chart that draws marks). Absent where
   * the host cannot show it, and the Practice review button is then not offered.
   */
  practice?: { api: Pick<PracticeApi, 'runs' | 'evaluate'>; Chart: ComponentType<DiveChartProps>; historicalDays?: number }
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
/**
 * A chart (or a pair of charts) with a candle interval of its own. Every Analysis chart reads the interval from the environment, which
 * is one shared setting; inside this scope the interval is local, starting at `initial` (re-applied when it changes), and a change
 * the user makes on a chart stays in the scope. Used by Compare, where two panes show different days with their own intervals.
 */
export function AnalysisIntervalScope({ initial, children }: { initial: number; children: ReactNode }) {
  const env = useAnalysisEnvironment()
  const [minutes, setMinutes] = useState(initial)
  useEffect(() => { setMinutes(initial) }, [initial])
  const value = useMemo(() => ({ ...env, intervalMinutes: minutes, setIntervalMinutes: setMinutes }), [env, minutes])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useAnalysisEnvironment(): AnalysisEnvironment {
  const value = useContext(Context)
  if (!value) throw new Error('Analysis must have an authenticated provider')
  return value
}
/** The environment, or null outside an Analysis provider (a chart that can run without one). */
export function useOptionalAnalysisEnvironment(): AnalysisEnvironment | null { return useContext(Context) }
export function useAnalysisApi() { return useAnalysisEnvironment().api }

export function useAnalysisError(error: string | null | undefined, source: string) {
  const report = useAnalysisEnvironment().reportError
  useEffect(() => { if (error) report?.(error, source) }, [error, source, report])
}
