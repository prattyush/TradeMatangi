import { useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { describeSwingError } from './swingErrors'
import type { SwingApi } from './swingApi'
import type { Snapshot } from './swingTypes'

/** Pause / resume entries, and close the portfolio (with the acknowledgements the server asks for). */
export function PortfolioSheet({ api, snapshot, onApply, onClose, confirmReal }: {
  api: SwingApi; snapshot: Snapshot; onApply: (snapshot: Snapshot) => void; onClose: () => void
  /** Real only: ask the phone's lock before the portfolio is closed. */
  confirmReal: () => Promise<boolean>
}) {
  const portfolio = snapshot.portfolio!
  const real = portfolio.mode === 'real'
  const [closing, setClosing] = useState(false)
  const [undated, setUndated] = useState(false)
  const [delivery, setDelivery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = portfolio.state === 'running'
  const undatedIds = snapshot.undated_submission_ids ?? []
  const deliveryIds = snapshot.delivery_review_context_ids ?? []
  const blocked = Boolean(snapshot.current_submission_ids?.length)
  const needsAck = (undatedIds.length > 0 && !undated) || (deliveryIds.length > 0 && !delivery)

  async function act(run: () => Promise<Snapshot>, done?: () => void) {
    if (busy) return
    setBusy(true); setError(null)
    try { onApply(await run()); done?.() } catch (caught) { setError(describeSwingError(caught)) } finally { setBusy(false) }
  }

  async function beginClose() {
    if (real && !(await confirmReal())) return
    setClosing(true)
  }

  return (
    <Sheet title="Portfolio" onClose={onClose}>
      <dl className="swing-facts">
        <dt>Account</dt><dd><span className={`badge badge-${portfolio.mode}`}>{real ? 'REAL' : 'PAPER'}</span></dd>
        <dt>State</dt><dd>{portfolio.state}</dd>
        <dt>Entries</dt><dd>{portfolio.entries_paused ? 'Paused' : 'Allowed'}</dd>
      </dl>
      {running && (
        <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.pause(portfolio.session_id, !portfolio.entries_paused))}>
          {portfolio.entries_paused ? 'Resume entries' : 'Pause entries'}
        </button>
      )}
      <p className="muted">Pausing blocks new entries only. Exits, stoplosses and open orders keep working.</p>
      {running && !closing && (
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void beginClose()}>Close portfolio…</button>
      )}
      {closing && (
        <div role="alertdialog" aria-label="Confirm portfolio closure" className="swing-confirm">
          <p><strong>Close all positions at the available prices and cancel entries?</strong> Closing waits for executable prices and ends the portfolio.</p>
          {blocked && <p className="form-error">Broker submissions from today are not confirmed yet. Closing stays blocked until they are.</p>}
          {undatedIds.length > 0 && (
            <label className="swing-check"><input type="checkbox" checked={undated} onChange={event => setUndated(event.target.checked)} />
              <span>I acknowledge {undatedIds.length} undated broker attempt(s). Close only after the broker confirms no current positions or pending orders.</span></label>
          )}
          {deliveryIds.length > 0 && (
            <label className="swing-check"><input type="checkbox" checked={delivery} onChange={event => setDelivery(event.target.checked)} />
              <span>I reviewed stock futures delivery and settlement at the broker. Close only after derivative exposure is confirmed flat.</span></label>
          )}
          <div className="row">
            <button type="button" className="btn btn-danger" disabled={busy || needsAck || blocked}
              onClick={() => void act(() => api.close(portfolio.session_id, {
                acknowledge_delivery_context_ids: delivery ? deliveryIds : [],
                acknowledge_undated_submission_ids: undated ? undatedIds : [],
              }), onClose)}>{busy ? 'Closing…' : real ? 'Close REAL portfolio' : 'Close portfolio'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setClosing(false)}>Keep it</button>
          </div>
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
    </Sheet>
  )
}
