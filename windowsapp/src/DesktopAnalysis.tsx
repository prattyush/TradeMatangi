import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AnalysisProvider, type AnalysisEnvironment } from '../../shared/analysis/environment'
import TradeAnalysis from '../../shared/analysis/TradeAnalysis'
import PerformanceDashboard from '../../shared/analysis/PerformanceDashboard'
import type { AnalysisTrade, SessionDetail } from '../../shared/analysis/api'
import type { PerformanceCycle } from '../../shared/analysis/performance'
import DesktopAnalysisChart, { clearAnalysisViewports, ComparisonChart } from './AnalysisChart'
import { analysisRequest, createAnalysisApi, type AnalysisRequest } from './analysisApi'
import { executionRoles } from './analysisMarkers'
import './desktopAnalysis.css'

function Evidence({ title, value }: { title: string; value: unknown }) {
  return <section><h3>{title}</h3>{value == null ? <p>Unknown · evidence not captured</p> : <pre>{JSON.stringify(value, null, 2)}</pre>}</section>
}
export default function DesktopAnalysis({ baseUrl, token, active, onClose }: { baseUrl: string; token: string; active: boolean; onClose: () => void }) {
  const adapter = useMemo(() => {
    const native: AnalysisRequest | undefined = '__TAURI_INTERNALS__' in window
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} }) : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, native))
  }, [baseUrl, token])
  const [statsVisited, setStatsVisited] = useState(false)
  const mountVersion = useRef(0)
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
    api: adapter.api, performance: adapter.performance, desktop: true, active,
    charts: { AnalysisChart: DesktopAnalysisChart, OptionsChart: DesktopAnalysisChart, SnapshotChart: DesktopAnalysisChart, SnapshotOptionsChart: DesktopAnalysisChart, TradesChart: ComparisonChart, PatternChart: ComparisonChart },
    onSelectExecution: setTrade,
  }), [adapter, active])
  const roles = trade && detail ? executionRoles(trade, detail.cycles ?? []) : []
  return <AnalysisProvider value={environment}><div className="desktop-analysis" hidden={!active}>
    <nav className="analysis-navigation" aria-label="Analysis views"><button aria-pressed={view === 'Sessions'} onClick={() => setView('Sessions')}>Sessions</button><button aria-pressed={view === 'Stats'} onClick={() => { setStatsVisited(true); setView('Stats') }}>Stats</button><button onClick={onClose}>Return to Workspace</button></nav>
    <div className="analysis-sessions" hidden={view !== 'Sessions'}><AnalysisProvider value={{...environment, active: active && view === 'Sessions'}}><TradeAnalysis onClose={onClose} /></AnalysisProvider></div>
    <div className="analysis-stats" hidden={view !== 'Stats'}>{statsVisited && <AnalysisProvider value={{...environment, active: active && view === 'Stats'}}><PerformanceDashboard onClose={() => setView('Sessions')} defaultSymbol="" defaultStartDate="" defaultEndDate="" defaultInstrumentType="" defaultSessionType="" selectedCycle={cycle} /></AnalysisProvider>}</div>
    {trade && <aside className="analysis-execution-inspector" role="dialog" aria-label="Execution inspector"><header><strong>{trade.side} {trade.quantity} @ {trade.price}</strong><button onClick={() => setTrade(null)}>Close</button></header>
      {error && <p role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
      {!detail && !error && <p role="status">Reading stored execution evidence…</p>}
      <Evidence title="Physical execution" value={trade} />
      {detail && !roles.length && <p>Canonical execution membership unavailable. Captured evidence only.</p>}
      {roles.map(({cycle: owningCycle, row}, i) => <section key={`${owningCycle.cycle_id}:${i}`}><h3>{row.role ?? 'Unknown role'} · {row.quantity}</h3><button onClick={() => { setCycle(owningCycle); setStatsVisited(true); setView('Stats'); setTrade(null) }}>Open cycle</button><Evidence title="FIFO role and captured analytics" value={row} /><Evidence title="Matched FIFO portions" value={owningCycle.matches.filter(m => (m.entry_execution_id ?? m.entry_id) === (trade.execution_id ?? trade.trade_id) || (m.exit_execution_id ?? m.exit_id) === (trade.execution_id ?? trade.trade_id))} /><Evidence title="Cycle context" value={{ cycle_id: owningCycle.cycle_id, direction: owningCycle.direction, state: owningCycle.state, net_pnl: owningCycle.net_pnl, pnl_pct: owningCycle.pnl_pct, fees: owningCycle.fees, open_quantity: owningCycle.open_quantity, label: owningCycle.label, excursion: owningCycle.excursion }} /></section>)}
    </aside>}
  </div></AnalysisProvider>
}
