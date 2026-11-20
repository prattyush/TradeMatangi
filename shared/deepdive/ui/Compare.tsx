import { useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisIntervalScope } from '../../analysis/environment'
import { friendlyError } from './errors'
import { formatDay } from '../model'
import type { Dive, DiveSummary } from '../types'
import ChartFrame from './ChartFrame'
import { comparableDives, dayKey, dayOptionLabel, daysNewestFirst, diveKey, legOrUnderlying, legsFor, sideLeg, type CompareLeg } from './compareModel'
import { DeepDiveHostProvider, useDeepDiveHost, type DeepDiveHost } from './host'
import { markCount } from './inDepthModel'
import { useFillWindow } from './useFillWindow'
import { useViewStrikes } from './useViewStrikes'
import './deepdive.css'

/**
 * Compare (the Pattern Library's tab): two marked days side by side, each from its own strategy, to look at them together, for example
 * a reversal that ended with the trend resuming against one that ended against it. Each pane picks a strategy, one of its marked days
 * and a chart (Underlying, CE or PE), so one pane can be a Buy day on its CE and the other a Sell day on its PE. View only: it reads
 * deep dives and saves nothing. The day's marks are drawn; each pane has its own candle interval, starting at the day's saved one.
 */
export default function Compare({ host }: { host: DeepDiveHost }) {
  return <DeepDiveHostProvider host={host}><ComparePanes /></DeepDiveHostProvider>
}

function ComparePanes() {
  const { api } = useDeepDiveHost()
  const [dives, setDives] = useState<DiveSummary[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.listDives().then(list => { if (live) setDives(comparableDives(list)) }).catch(error => { if (live) { setFailed(friendlyError(error)); setDives([]) } })
    return () => { live = false }
  }, [api])

  if (dives === null) return <p className="pl-muted">Loading your deep dives…</p>
  if (failed) return <p className="pl-error" role="alert">Your deep dives could not be loaded: {failed}</p>
  if (!dives.length) return <p className="pl-muted dd-empty" role="status">Nothing to compare yet. Mark days in a deep dive first: Compare shows the days you have marked.</p>
  return <PaneArea dives={dives} />
}

/** The two panes, sized to run to the bottom of the window. A component of its own so the area exists when the size is first fitted. */
function PaneArea({ dives }: { dives: DiveSummary[] }) {
  const [maximized, setMaximized] = useState<'A' | 'B' | null>(null)
  const area = useRef<HTMLDivElement>(null)
  useFillWindow(area, { minHeight: 520 })
  return <div className="dd-compare" ref={area}>
    <ComparePane id="A" dives={dives} initial={0} maximized={maximized === 'A'} hidden={maximized === 'B'} onToggle={() => setMaximized(current => (current === 'A' ? null : 'A'))} />
    <ComparePane id="B" dives={dives} initial={dives.length > 1 ? 1 : 0} maximized={maximized === 'B'} hidden={maximized === 'A'} onToggle={() => setMaximized(current => (current === 'B' ? null : 'B'))} />
  </div>
}

interface PaneProps {
  id: 'A' | 'B'
  dives: DiveSummary[]
  initial: number
  maximized: boolean
  hidden: boolean
  onToggle: () => void
}

function ComparePane({ id, dives, initial, maximized, hidden, onToggle }: PaneProps) {
  const { api, settings, Chart } = useDeepDiveHost()
  const [diveId, setDiveId] = useState(() => diveKey(dives[Math.min(initial, dives.length - 1)]))
  const summary = dives.find(dive => diveKey(dive) === diveId) ?? dives[0]
  const [loaded, setLoaded] = useState<{ id: string; dive: Dive } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dayId, setDayId] = useState<string | null>(null)
  const [leg, setLeg] = useState<CompareLeg>('underlying')

  // A shared deep dive is read through its owner; the others are the user's own.
  useEffect(() => {
    let live = true
    setError(null)
    api.getDive({ category: summary.category, strategy: summary.strategy }, summary.can_edit ? undefined : summary.owner_id)
      .then(dive => { if (live) { setLoaded({ id: diveKey(summary), dive }); setDayId(null) } })
      .catch(cause => { if (live) setError(friendlyError(cause)) })
    return () => { live = false }
  }, [api, summary])

  const dive = loaded && loaded.id === diveKey(summary) ? loaded.dive : null
  const days = useMemo(() => (dive ? daysNewestFirst(dive.setups) : []), [dive])
  const setup = days.find(day => dayKey(day) === dayId) ?? days[0] ?? null
  const shownLeg = setup ? legOrUnderlying(leg, setup.symbol) : 'underlying'
  const strikes = useViewStrikes(setup, shownLeg !== 'underlying')
  const strike = strikes.state === 'ready' ? (shownLeg === 'CE' ? strikes.ce : strikes.pe) : undefined
  const label = `${id} · ${summary.strategy}`

  return <section className="dd-compare-pane" hidden={hidden} aria-label={`Pane ${id}`}>
    <div className="pl-bar dd-compare-bar">
      <strong>{id}</strong>
      <label className="pl-muted">Strategy <select aria-label={`Strategy ${id}`} value={diveKey(summary)} onChange={event => setDiveId(event.target.value)}>
        {dives.map(dive => <option key={diveKey(dive)} value={diveKey(dive)}>{dive.category} / {dive.strategy}{dive.can_edit ? '' : ' (shared)'} · {dive.days} {dive.days === 1 ? 'day' : 'days'}</option>)}</select></label>
      <label className="pl-muted">Day <select aria-label={`Day ${id}`} value={setup ? dayKey(setup) : ''} onChange={event => setDayId(event.target.value)} disabled={!days.length}>
        {days.map(day => <option key={dayKey(day)} value={dayKey(day)}>{dayOptionLabel(day, formatDay)}</option>)}</select></label>
      {setup && <span className="pl-muted dd-view" role="tablist" aria-label={`Chart ${id}`}>
        {legsFor(setup.symbol).map(choice => <button key={choice} role="tab" aria-selected={shownLeg === choice} aria-pressed={shownLeg === choice}
          title={choice === sideLeg(setup) ? `The leg this ${setup.side} setup is traded on` : undefined} onClick={() => setLeg(choice)}>{choice === 'underlying' ? 'Underlying' : choice}</button>)}
      </span>}
    </div>
    {error && <p className="pl-error" role="alert">{error}</p>}
    {!dive && !error && <p className="pl-muted dd-empty">Loading {summary.strategy}…</p>}
    {dive && !setup && <p className="pl-muted dd-empty">This deep dive has no marked days.</p>}
    {dive && setup && <ChartFrame className="dd-chartbox dd-compare-box" label={label} isMaximized={maximized} isHidden={false} onToggle={onToggle}>
      <AnalysisIntervalScope key={dayKey(setup)} initial={setup.interval_minutes}>
        {shownLeg === 'underlying'
          ? <Chart key={`${dayKey(setup)}-ul`} symbol={setup.symbol} date={setup.date} title={`${setup.symbol} · ${formatDay(setup.date)} · ${markCount(setup, 'underlying')} marks`}
            historicalDays={settings.historicalDays} annotations={setup.annotations.filter(a => a.instrument === 'underlying')} activeStrategy={summary.strategy} activeCategory={summary.category} />
          : strikes.state === 'ready' && strike !== undefined
            ? <Chart key={`${dayKey(setup)}-${shownLeg}-${strike}`} symbol={setup.symbol} date={setup.date} title={`${setup.symbol} ${shownLeg} ${strike} · ${formatDay(setup.date)} · ${markCount(setup, shownLeg)} marks`}
              strike={strike} right={shownLeg} expiry={strikes.expiry} historicalDays={settings.historicalDays}
              annotations={setup.annotations.filter(a => a.instrument === shownLeg)} activeStrategy={summary.strategy} activeCategory={summary.category} />
            : strikes.state === 'error'
              ? <p className="pl-error" role="alert">Could not pick the {shownLeg} strike: {strikes.error}</p>
              : <p className="pl-muted dd-empty">Picking the {shownLeg} strike…</p>}
      </AnalysisIntervalScope>
    </ChartFrame>}
    {dive && setup && <p className="pl-muted dd-compare-note">
      {setup.outcome === 'failed' ? 'Failed' : setup.outcome === 'success' ? `Success${setup.strength ? ` (${setup.strength})` : ''}` : 'No outcome marked'}
      {shownLeg !== 'underlying' && strikes.state === 'ready' ? ` · strike ${strikes.source === 'saved' ? 'saved with the day' : 'picked for a look (Max Price at 09:30, premium at most 75)'}` : ''}
      {setup.notes ? ` · ${setup.notes}` : ''}
    </p>}
  </section>
}
