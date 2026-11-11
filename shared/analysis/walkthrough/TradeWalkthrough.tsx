import { useEffect, useMemo, useState } from 'react'
import type { AnalysisTrade } from '../api'
import { useAnalysisApi, useAnalysisEnvironment } from '../environment'
import type { PerformanceCycle } from '../performance'
import { orderRoundTripsByEntry, tripKey, type LabeledRoundTrip } from '../labeling/model'
import OneByOneLabeling from '../labeling/OneByOneLabeling'
import RoundTripSplitLayout from '../labeling/RoundTripSplitLayout'
import { useMaximized, useRoundTripView } from '../labeling/useRoundTripView'
import WalkthroughPanel from './WalkthroughPanel'
import { buildWalkthrough } from './walkthroughModel'

const NO_LABELS = new Map()
const IDLE = { pending: 0, saving: false, error: '', savedCount: 0 }
const noop = () => undefined

/**
 * Trade Walkthrough: Label Trades' layout, read-only. Charts on the left; on the right one round trip at a time with its
 * entries, exits, how each exit happened, peak capital, and the day's P&L before and after it. `cycles` are the day's
 * cycles (from the session details), `capitals` the session capital per session.
 */
export default function TradeWalkthrough({ symbol, date, sessionIds, allTrades, historicalDays, cycles, capitals }: {
  symbol: string
  date: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
  cycles: PerformanceCycle[]
  capitals: Map<string, number>
}) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const [trips, setTrips] = useState<LabeledRoundTrip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [index, setIndex] = useState(0)
  const [showAllMarkers, setShowAllMarkers] = useState(false)
  const [maximized, setMaximized] = useMaximized()
  const sessionKey = sessionIds.join('|')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    void Promise.all(sessionIds.map(id => api.getRoundTrips(id)))
      .then(pages => {
        if (cancelled) return
        setTrips(orderRoundTripsByEntry(pages.flatMap((rows, i) => rows.map(rt => ({ ...rt, session_id: sessionIds[i] }))), sessionIds))
        setIndex(0)
      })
      .catch(cause => { if (!cancelled) setError(String(cause)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey, retry])

  const current = trips[index]
  const { getMarkerText, focusTime, chartTrades } = useRoundTripView(trips, current, allTrades, showAllMarkers)
  const story = useMemo(() => buildWalkthrough(trips, cycles, capitals), [trips, cycles, capitals])
  const sessionCount = new Set(trips.map(trip => trip.session_id)).size

  if (loading) return <p role="status">Loading round trips…</p>
  if (error) return <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>Retry</button></p>

  const maximizeButton = (
    <button type="button" className="tl-ghost" onClick={() => setMaximized(!maximized)} aria-pressed={maximized}
      aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore (Esc): one chart with a switcher' : 'Maximize: larger view, Underlying and strike charts stacked'}>{maximized ? '⤡ Restore' : '⤢ Maximize'}</button>
  )
  const info = current ? story.get(tripKey(current)) : undefined
  return (
    <RoundTripSplitLayout labelContractMarkers={false} symbol={symbol} date={date} historicalDays={historicalDays} chartTrades={chartTrades} getMarkerText={getMarkerText} focusTime={focusTime} maximized={maximized}>
      <OneByOneLabeling
        trips={trips} index={Math.min(index, Math.max(trips.length - 1, 0))} sessionCount={sessionCount} labels={NO_LABELS}
        busy={false} readOnly save={IDLE} status={null} active={environment.active !== false}
        pnlMode={environment.pnlDisplayMode} onGo={setIndex} onRetry={noop}
        controls={<>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Show every trade's markers on the chart, not just this trade's">
            <input type="checkbox" checked={showAllMarkers} onChange={event => setShowAllMarkers(event.target.checked)} /> All markers
          </label>
          {maximizeButton}
        </>}
      >
        {info && <WalkthroughPanel trip={info} pnlMode={environment.pnlDisplayMode} />}
      </OneByOneLabeling>
    </RoundTripSplitLayout>
  )
}
