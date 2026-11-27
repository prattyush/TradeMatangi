import { useEffect, useMemo, useState } from 'react'
import { useAnalysisApi, useAnalysisEnvironment } from '../environment'
import type { AnalysisTrade, SessionSummary } from '../api'
import { notesScope } from '../../charts/scopedDrawings'
import { daySessions, daySymbols, tradesBySymbol } from './dayChartModel'

/**
 * The chart of a market date, all its symbols at once: a tab per symbol, and under it the usual Underlying and CE / PE charts with the
 * buy and sell markers of that symbol's trades (the chart panel of the active renderer, KLine or Lightweight). The drawings and texts on it
 * belong to the day's Notes (`notesScope(date)`): they start from the other charts' drawings and everything changed here stays here.
 * `readOnly` shows them without tools (the Summary).
 */
export default function DayChart({ date, readOnly = false, symbol: pinned, onSymbolChange }: { date: string; readOnly?: boolean; symbol?: string; onSymbolChange?: (symbol: string) => void }) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const Panel = environment.charts?.AnalysisChartPanel
  const [loaded, setLoaded] = useState<{ sessions: SessionSummary[]; trades: AnalysisTrade[][] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [own, setOwn] = useState('')

  useEffect(() => {
    let live = true
    setLoaded(null); setError(null)
    api.getAnalysisSessions({ startDate: date, endDate: date })
      .then(async rows => {
        const sessions = rows.filter(session => session.date === date)
        const details = await Promise.all(daySessions(sessions).map(session => api.getSessionDetail(session.session_id)))
        if (live) setLoaded({ sessions: daySessions(sessions), trades: details.map(detail => detail.trades ?? []) })
      })
      .catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { live = false }
  }, [api, date, environment.dataRevision])

  const symbols = useMemo(() => (loaded ? daySymbols(loaded.sessions) : []), [loaded])
  const chosen = symbols.includes(pinned ?? own) ? (pinned ?? own) : symbols[0] ?? ''
  const choose = (symbol: string) => { setOwn(symbol); onSymbolChange?.(symbol) }
  const trades = useMemo(() => (loaded ? tradesBySymbol(loaded.sessions, loaded.trades).get(chosen) ?? [] : []), [loaded, chosen])

  if (!Panel) return null
  if (error) return <p role="alert" className="pl-error">The day's chart could not be loaded: {error}</p>
  if (!loaded) return <p role="status" className="pl-muted">Loading the day's chart…</p>
  if (!symbols.length) return <p className="pl-muted" role="status">No trades on this date to chart.</p>
  return <div className="dn-chart" aria-label={`Charts for ${date}`}>
    {symbols.length > 1 && <nav className="dn-chart-tabs" aria-label="Symbol">
      {symbols.map(symbol => <button key={symbol} type="button" aria-pressed={symbol === chosen} onClick={() => choose(symbol)}>{symbol}</button>)}
    </nav>}
    <Panel key={`${date}:${chosen}`} symbol={chosen} date={date} allTrades={trades} isOptions={trades.some(trade => trade.right)}
      drawingScope={notesScope(date)} drawingsReadOnly={readOnly} />
  </div>
}
