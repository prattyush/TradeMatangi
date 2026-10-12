import SwingChart from './SwingChart'
import type {SwingChartProps} from '../../shared/SwingWorkspace'
import type {SwingRequest} from '../../shared/SwingPortfolioPanel'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

export default function DesktopAnalysis({ viewSelector, baseUrl, token, active, onClose, onUnauthorized, historicalDays=2,initialPortfolioId,onNavigationReady }:  { onNavigationReady?:(guard:(()=>boolean)|null)=>void;initialPortfolioId?:string; viewSelector?: ReactNode; historicalDays?:number; onUnauthorized?:()=>void; baseUrl: string; token: string; active: boolean; onClose: () => void }) {
  const adapter = useMemo(() => {
    const native: AnalysisRequest | undefined = '__TAURI_INTERNALS__' in window
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} }) : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, native,onUnauthorized))
  }, [baseUrl, token,onUnauthorized])
  const drawingRequest=useCallback(async<T,>(path:string,method:'GET'|'POST'|'PUT'|'DELETE',body:Record<string,unknown>={})=>{if('__TAURI_INTERNALS__' in window)return invoke<T>('desktop_drawing_request',{baseUrl,path,method,body});const response=await fetch(`${baseUrl.replace(/\/$/,'')}/api/desktop/v1/${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});if(!response.ok)throw new Error('Swing analytics could not read this portfolio');return response.json() as Promise<T>},[baseUrl,token])
  const swingRequest=useCallback<SwingRequest>((path,method,body)=>drawingRequest(`swing/portfolios/${path}`,method,body),[drawingRequest])
  const swingRenderer=useCallback((props:SwingChartProps)=><SwingChart {...props} drawingRequest={drawingRequest}/>,[drawingRequest])
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
  useEffect(()=>{setView('Sessions');setCycle(undefined);setTrade(null)},[initialPortfolioId])
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
    swingRequest, api: adapter.api, performance: adapter.performance, desktop: true, active, dataRevision, historicalDays,
    onDataChanged: () => setDataRevision(n => n + 1),
    onLabelSavingChange: saving => { labelSaving.current = saving; if(!saving)setNavigationMessage('') },
    charts: { SwingChart:swingRenderer,AnalysisChartPanel: AnalysisPanels, LabelCharts: AnalysisPanels, AnalysisChart: DesktopAnalysisChart, OptionsChart: DesktopAnalysisChart, SnapshotChart: DesktopAnalysisChart, SnapshotOptionsChart: DesktopAnalysisChart, TradesChart: ComparisonChart, PatternChart: ComparisonChart },
    onSelectExecution: setTrade,
    onDirtyChange: value => { dirty.current = value },
    confirmDiscard: () => { if(labelSaving.current){setNavigationMessage('Labels are saving. Wait for the result before changing sessions.');return false}; if (!dirty.current || window.confirm('Discard unsaved labels?')) { dirty.current = false; return true }; return false },
    onSelectionContextChange: () => setTrade(null),
  }), [adapter, active, dataRevision,historicalDays,swingRequest,swingRenderer])
  const navigationReady = useRef(onNavigationReady);
  navigationReady.current = onNavigationReady;
  const guard = useRef(environment.confirmDiscard);
  guard.current = environment.confirmDiscard;
  useEffect(() => {
    navigationReady.current?.(() => guard.current?.() !== false);
    return () => navigationReady.current?.(null);
  }, []);
  return <AnalysisProvider value={environment}><div className="desktop-analysis" hidden={!active}>
    <nav className="analysis-navigation" aria-label="Analysis views">{viewSelector}<button aria-pressed={view === 'Sessions'} onClick={() => {if(environment.confirmDiscard?.()!==false)setView('Sessions')}}>Sessions</button><button aria-pressed={view === 'Stats'} onClick={() => { if(environment.confirmDiscard?.()===false)return;setStatsVisited(true); setView('Stats') }}>Stats</button>{!viewSelector && <button onClick={()=>{if(environment.confirmDiscard?.()!==false)onClose()}}>Return to Workspace</button>}</nav>
    {navigationMessage && <p className="analysis-navigation-message" role="status">{navigationMessage}</p>}
    <div className="analysis-sessions" hidden={view !== 'Sessions'}><AnalysisProvider value={{...environment, active: active && view === 'Sessions'}}><DesktopAnalysisSessions key={initialPortfolioId??'all'} initialPortfolioId={initialPortfolioId}/></AnalysisProvider></div>
    <div className="analysis-stats" hidden={view !== 'Stats'}>{statsVisited && <AnalysisProvider value={{...environment, active: active && view === 'Stats'}}><PerformanceDashboard key={initialPortfolioId??'all'} onClose={() => setView('Sessions')} defaultSymbol="" defaultStartDate="" defaultEndDate="" defaultInstrumentType="" defaultSessionType="" defaultTradingStyle={initialPortfolioId?'swing':undefined} defaultPortfolioId={initialPortfolioId} selectedCycle={cycle} /></AnalysisProvider>}</div>
    {trade && <ExecutionInspector trade={trade} detail={detail} error={error} onRetry={()=>setRetry(n=>n+1)} onClose={()=>setTrade(null)} onCycle={value=>{setCycle(value);setStatsVisited(true);setView('Stats');setTrade(null)}} />}

  </div></AnalysisProvider>
}
