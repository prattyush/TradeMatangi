import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import { useAnalysisApi, useAnalysisEnvironment } from '../../../../../shared/analysis/environment'
import { eventIcon, sortSnapshots } from '../../../../../shared/analysis/snapshotModel'
import { describeError, isNotAvailable } from '../../../api/errors'
import { useLoad } from '../../../app/useLoad'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../../shell/States'
import { clockTime } from '../format'
import { EventListSheet } from './EventListSheet'
import { PhoneSnapshotChart, type SnapshotTab } from './PhoneSnapshotChart'
import { SnapshotDetailsSheet } from './SnapshotDetailsSheet'

/**
 * Event snapshots of a day: the chart as it was when each order was placed, edited, converted or filled.
 * One 40 px strip steps through the events (◀ ▶ or a searchable list); Details shows the numbers.
 */
export function SnapshotsView({ group, lead }: { group: SessionGroup; lead: ReactNode }) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const load = useLoad(async () => sortSnapshots((await Promise.all(group.sessions.map(session => api.getSnapshots(session.session_id)))).flat()), [group.key, api])
  const snapshots = load.data ?? []
  const [index, setIndex] = useState(0)
  const [tab, setTab] = useState<SnapshotTab>('underlying')
  const [sheet, setSheet] = useState<'events' | 'details' | null>(null)
  const current = snapshots[Math.min(index, Math.max(0, snapshots.length - 1))]
  const options = useMemo(() => ({ ce: current?.snapshot.strike_ce ?? null, pe: current?.snapshot.strike_pe ?? null }), [current])
  // A contract that this event does not have falls back to the underlying.
  useEffect(() => { if ((tab === 'CE' && options.ce == null) || (tab === 'PE' && options.pe == null)) setTab('underlying') }, [tab, options])

  const bar = (content?: ReactNode) => <div className="detail-bar">{lead}<span className="grow" />{content}</div>
  if (load.loading && !load.data) return <>{bar()}<Spinner label="Loading snapshots" /></>
  if (load.error != null && !load.data) {
    return <>{bar()}{isNotAvailable(load.error) ? <NotAvailable what="Snapshots" /> : <ErrorState message={describeError(load.error)} onRetry={load.reload} />}</>
  }
  if (!current) {
    return <>{bar()}<EmptyState title="No snapshots for this day">A snapshot is captured at each order event while a session runs on the website or the desktop. This day has none.</EmptyState></>
  }

  const isOptions = current.instrument_type === 'options'
  const go = (next: number) => setIndex(Math.max(0, Math.min(snapshots.length - 1, next)))
  const position = snapshots.indexOf(current)
  const toolbarStart = (
    <div className="phone-toolbar-start">
      {lead}
      {isOptions && (
        <div className="segmented" role="group" aria-label="Snapshot chart">
          <button type="button" aria-pressed={tab === 'underlying'} onClick={() => setTab('underlying')}>Underlying</button>
          {options.ce != null && <button type="button" aria-pressed={tab === 'CE'} onClick={() => setTab('CE')}>CE {options.ce}</button>}
          {options.pe != null && <button type="button" aria-pressed={tab === 'PE'} onClick={() => setTab('PE')}>PE {options.pe}</button>}
        </div>
      )}
    </div>
  )

  return (
    <div className="snapshot-view">
      <div className="snapshot-strip">
        <button type="button" className="step-button" aria-label="Previous event" disabled={position === 0} onClick={() => go(position - 1)}>◀</button>
        <button type="button" className="event-button" aria-label={`Event ${position + 1} of ${snapshots.length}: ${current.event.description}`} onClick={() => setSheet('events')}>
          <span className="event-count">{position + 1}/{snapshots.length}</span>
          <span className="event-time mono">{clockTime(current.timestamp)}</span>
          <span className="event-desc">{eventIcon(current.event.type)} {current.event.description}</span>
          <span aria-hidden="true" className="caret">▾</span>
        </button>
        <button type="button" className="step-button" aria-label="Next event" disabled={position === snapshots.length - 1} onClick={() => go(position + 1)}>▶</button>
        <button type="button" className="menu-button" onClick={() => setSheet('details')}>Details</button>
      </div>
      <div className="phone-chart">
        <PhoneSnapshotChart snapshot={current} tab={tab} historicalDays={environment.historicalDays ?? 2} toolbarStart={toolbarStart} />
      </div>
      {sheet === 'events' && <EventListSheet snapshots={snapshots} selected={position} onSelect={setIndex} onClose={() => setSheet(null)} />}
      {sheet === 'details' && <SnapshotDetailsSheet snapshot={current} onClose={() => setSheet(null)} />}
    </div>
  )
}
