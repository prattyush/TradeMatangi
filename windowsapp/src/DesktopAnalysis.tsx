import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AnalysisProvider, type AnalysisEnvironment } from '../../shared/analysis/environment'
import DesktopAnalysisSessions from './DesktopAnalysisSessions'
import AnalysisPanels from './AnalysisPanels'
import PerformanceDashboard from '../../shared/analysis/PerformanceDashboard'
import type { AnalysisTrade, SessionDetail } from '../../shared/analysis/api'
import type { PerformanceCycle } from '../../shared/analysis/performance'
import DesktopAnalysisChart, { clearAnalysisViewports, ComparisonChart } from './AnalysisChart'
import { analysisRequest, createAnalysisApi, type AnalysisRequest } from './analysisApi'
import ExecutionInspector from './ExecutionInspector'
import './desktopAnalysis.css'

export default function DesktopAnalysis({ viewSelector, baseUrl, token, active, onClose, onUnauthorized, historicalDays=2 }: { viewSelector?: ReactNode; historicalDays?:number; onUnauthorized?:()=>void; baseUrl: string; token: string; active: boolean; onClose: () => void }) {
  const adapter = useMemo(() => {
    const native: AnalysisRequest | undefined = '__TAURI_INTERNALS__' in window
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} }) : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, native,onUnauthorized))
  }, [baseUrl, token,onUnauthorized])
  const [statsVisited, setStatsVisited] = useState(false)
  const mountVersion = useRef(0)
  const dirty = useRef(false)
  const labelSaving = useRef(false)
  const [dataRevision,setDataRevision] = useState(0)
  const [navigationMessage,setNavigationMessage] = useState('')
  const [view, setView] = useState<'Sessions' | 'Stats'>('Sessions')
  const [trade, setTrade] = useState<AnalysisTrade | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [cycle, setCycle] = useState<PerformanceCycle | undefined>()
  useEffect(() => {
    const version = ++mountVersion.current
    return () => {
      adapter.clear(); clearAnalysisViewports()
      // StrictMode replays effects with the same adapter. Fence old work now,
      // then retire the transport only if it was not immediately remounted.
      queueMicrotask(() => { if (mountVersion.current === version) adapter.dispose() })
    }
  }, [adapter])
  useEffect(() => {
    if (!trade) { setDetail(null); return }
    let cancelled = false
    setDetail(null); setError('')
    void adapter.api.getSessionDetail(trade.session_id).then(value => { if (!cancelled) setDetail(value) }).catch(reason => { if (!cancelled && reason?.name !== 'AbortError') setError(String(reason)) })
    return () => { cancelled = true }
  }, [adapter, trade, retry])
  useEffect(() => {
    if (!active || !trade) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setTrade(null) } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [active, trade])
  const environment: AnalysisEnvironment = useMemo(() => ({
    api: adapter.api, performance: adapter.performance, desktop: true, active, dataRevision, historicalDays,
    onDataChanged: () => setDataRevision(n => n + 1),
    onLabelSavingChange: saving => { labelSaving.current = saving; if(!saving)setNavigationMessage('') },
    charts: { AnalysisChartPanel: AnalysisPanels, LabelCharts: AnalysisPanels, AnalysisChart: DesktopAnalysisChart, OptionsChart: DesktopAnalysisChart, SnapshotChart: DesktopAnalysisChart, SnapshotOptionsChart: DesktopAnalysisChart, TradesChart: ComparisonChart, PatternChart: ComparisonChart },
    onSelectExecution: setTrade,
    onDirtyChange: value => { dirty.current = value },
    confirmDiscard: () => { if(labelSaving.current){setNavigationMessage('Labels are saving. Wait for the result before changing sessions.');return false}; if (!dirty.current || window.confirm('Discard unsaved labels?')) { dirty.current = false; return true }; return false },
    onSelectionContextChange: () => setTrade(null),
  }), [adapter, active, dataRevision,historicalDays])
  return <AnalysisProvider value={environment}><div className="desktop-analysis" hidden={!active}>
    <nav className="analysis-navigation" aria-label="Analysis views">{viewSelector}<button aria-pressed={view === 'Sessions'} onClick={() => setView('Sessions')}>Sessions</button><button aria-pressed={view === 'Stats'} onClick={() => { setStatsVisited(true); setView('Stats') }}>Stats</button>{!viewSelector && <button onClick={onClose}>Return to Workspace</button>}</nav>
    {navigationMessage && <p className="analysis-navigation-message" role="status">{navigationMessage}</p>}
    <div className="analysis-sessions" hidden={view !== 'Sessions'}><AnalysisProvider value={{...environment, active: active && view === 'Sessions'}}><DesktopAnalysisSessions /></AnalysisProvider></div>
    <div className="analysis-stats" hidden={view !== 'Stats'}>{statsVisited && <AnalysisProvider value={{...environment, active: active && view === 'Stats'}}><PerformanceDashboard onClose={() => setView('Sessions')} defaultSymbol="" defaultStartDate="" defaultEndDate="" defaultInstrumentType="" defaultSessionType="" selectedCycle={cycle} /></AnalysisProvider>}</div>
    {trade && <ExecutionInspector trade={trade} detail={detail} error={error} onRetry={()=>setRetry(n=>n+1)} onClose={()=>setTrade(null)} onCycle={value=>{setCycle(value);setStatsVisited(true);setView('Stats');setTrade(null)}} />}

  </div></AnalysisProvider>
}
