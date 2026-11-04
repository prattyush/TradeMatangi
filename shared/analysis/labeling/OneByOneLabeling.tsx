import { useEffect, type ReactNode } from 'react'
import type { TradeLabel } from '../api'
import { contractName, isLabeled, legsText, money, tripKey, type LabeledRoundTrip } from './model'
import type { SaverState } from './saver'

const RT_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787']

interface Props {
  trips: LabeledRoundTrip[]
  index: number
  sessionCount: number
  labels: Map<string, TradeLabel>
  busy: boolean
  readOnly: boolean
  save: SaverState
  /** Shown beside the counter: view switch, maximize. */
  controls: ReactNode
  /** Extra label sections below the pattern form (behavior checklists). */
  children: ReactNode
  active: boolean
  onGo: (to: number) => void
  onRetry: () => void
}

const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null
  return !!element && (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) || element.isContentEditable)
}

/** Header, trade summary and save status of the one-round-trip-at-a-time view. The label fields are its children. */
export default function OneByOneLabeling({ trips, index, sessionCount, labels, busy, readOnly, save, controls, children, active, onGo, onRetry }: Props) {
  const total = trips.length
  const rt = trips[index]

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); onGo(index - 1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); onGo(index + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, index, onGo])

  if (!rt) return <div className="tl-empty">No round trips in this selection.</div>
  const up = rt.pnl > 0, down = rt.pnl < 0
  const sessions = [...new Set(trips.map(trip => trip.session_id))]
  return (
    <div className="tl-panel">
      <div className="tl-head">
        <div className="tl-nav">
          <button type="button" className="tl-nav-button" disabled={busy || index === 0} onClick={() => onGo(index - 1)} aria-label="Previous trade">◀ Prev</button>
          <div className="tl-counter" role="status" aria-live="polite">
            Trade {index + 1} of {total}
            {sessionCount > 1 && <small>Session {sessions.indexOf(rt.session_id) + 1} of {sessions.length} · RT#{rt.index}</small>}
          </div>
          <button type="button" className="tl-nav-button primary" disabled={busy || index >= total - 1} onClick={() => onGo(index + 1)} aria-label="Next trade">Next ▶</button>
        </div>
        <div className="tl-meta">
          <span className="tl-dot" style={{ background: RT_COLORS[rt.index % RT_COLORS.length] }} />
          <span className="tl-contract">RT#{rt.index} — {contractName(rt)}</span>
          <span className={`tl-pnl ${up ? 'up' : down ? 'down' : ''}`}>{money(rt.pnl)}</span>
          <span className="tl-grow" />
          {controls}
        </div>
        {total > 1 && (
          <div className="tl-strip" role="group" aria-label="Round trips">
            {trips.map((trip, position) => (
              <button key={tripKey(trip)} type="button" disabled={busy}
                className={`tl-chip ${trip.pnl > 0 ? 'up' : trip.pnl < 0 ? 'down' : ''} ${position === index ? 'current' : ''} ${isLabeled(labels.get(tripKey(trip))) ? 'done' : ''}`}
                aria-current={position === index ? 'true' : undefined} title={`RT#${trip.index} · ${contractName(trip)} · ${money(trip.pnl)}`}
                onClick={() => onGo(position)}>{position + 1}</button>
            ))}
          </div>
        )}
      </div>
      <div className="tl-summary">
        <strong>{legsText(rt.entry_trades, 'B')}</strong>{' → '}<strong>{legsText(rt.exit_trades, 'S') || 'open'}</strong>
      </div>
      <div className="tl-card">{children}</div>
      <div className="tl-status" role="status">
        {readOnly ? <span>Shared history · read only</span>
          : save.error ? <><span className="bad" role="alert">{save.error}</span><button type="button" onClick={onRetry}>Retry save</button></>
          : save.saving ? <span>Saving…</span>
          : save.pending ? <span>Unsaved changes…</span>
          : save.savedCount ? <span className="ok">Saved ✓</span> : <span>Changes save automatically.</span>}
      </div>
    </div>
  )
}
