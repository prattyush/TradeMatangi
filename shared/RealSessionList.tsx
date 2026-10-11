import { useCallback, useEffect, useState } from 'react'

export interface RealBook {
  session_id: string; broker: string; trading_style: 'intraday' | 'swing'; state: string
  capital?: number; available?: number; allocation_pct?: number
  funding_status?: { state: string; available: number; shortfall?: number | null }
}
interface Verification { current_submission_ids?: string[]; undated_submission_ids?: string[]; closure_blocked?: boolean; verified_flat: boolean; positions: unknown[]; pending_orders: unknown[]; history_warning?: string | null; reconciliation_error?: string; message: string }
export interface RealStatus {
  active_sessions?: RealBook[]; recovery_ready?: boolean
  availability?: { trading_style: string; occupied: boolean; owned_by_you: boolean }[]
}
export type RealBookRequest = <T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<T>

export default function RealSessionList({ request, onAttach }: { request: RealBookRequest; onAttach?: (id: string) => void }) {
  const [status, setStatus] = useState<RealStatus | null>(null)
  const [fractions, setFractions] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [verification, setVerification] = useState<Record<string, Verification>>({})
  const [closing, setClosing] = useState<string | null>(null)
  const [acknowledgeUndated, setAcknowledgeUndated] = useState(false)
  const recover = async (book: RealBook, close = false) => {
    setBusy(true); setError('')
    try {
      if (close) { await request(`${book.session_id}/stop`, 'POST', { acknowledge_undated_submission_ids: acknowledgeUndated ? verification[book.session_id]?.undated_submission_ids ?? [] : [] }); setClosing(null); setNotice('Closure requested. Refresh for completion; older history warnings remain in the book record.'); await load() }
      else { const value = await request<Verification>(`${book.session_id}/reconcile`, 'POST'); setVerification(previous => ({ ...previous, [book.session_id]: value })); await load() }
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const load = useCallback(async () => setStatus(await request<RealStatus>('status', 'GET')), [request])
  useEffect(() => { let active = true; void request<RealStatus>('status', 'GET').then(value => { if (active) setStatus(value) }).catch(reason => { if (active) setError(String(reason)) }); return () => { active = false } }, [request])
  const save = async (book: RealBook) => {
    setBusy(true); setError('')
    try {
      setStatus(await request<RealStatus>(`${book.session_id}/allocation`, 'POST', { fraction: Number(fractions[book.session_id] ?? String((book.allocation_pct ?? 1) * 100)) / 100, request_id: crypto.randomUUID() }))
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <section aria-label="Your Real sessions" style={{ margin: '12px 0' }}>
    <strong>Your Real sessions</strong>{' '}<button type="button" title="Refresh session and recovery status" disabled={busy} onClick={() => void load().catch(reason => setError(String(reason)))}>Refresh</button>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {status?.recovery_ready === false && <p role="status">Server ownership recovery is pending. Existing books retain their slots.</p>}
    {status?.active_sessions?.map(book => <div key={book.session_id} style={{ marginTop: 8 }}>
      <span>{book.broker === 'kite' ? 'Kite' : 'Kotak'} · {book.trading_style === 'intraday' ? 'Day' : 'Swing'} · {book.state.replace(/_/g, ' ')}</span>
      {book.capital != null && <small> · Capital ₹{book.capital.toLocaleString('en-IN')}</small>}
      {book.available != null && <small> · Book available ₹{book.available.toLocaleString('en-IN')}</small>}
      {book.funding_status?.available != null && <small> · Shared broker available ₹{book.funding_status.available.toLocaleString('en-IN')}</small>}
      {book.funding_status && book.funding_status.state !== 'verified' && <p role="status">Shared account funding: {book.funding_status.state}{book.funding_status.shortfall != null ? ` · gap ₹${book.funding_status.shortfall.toLocaleString('en-IN')}` : ''}. Entries wait; exits remain available.</p>}
      {book.trading_style === 'intraday' && <button type="button" disabled={busy} onClick={() => void recover(book)}>Reconcile with broker</button>}
      {verification[book.session_id] && <div role="status">
        <p>{verification[book.session_id].verified_flat ? "Broker confirms this book’s scope is flat with no pending orders." : `${verification[book.session_id].positions.length} current positions · ${verification[book.session_id].pending_orders.length} pending orders.`}</p>
        <p>{verification[book.session_id].history_warning ?? verification[book.session_id].message}</p>
        {verification[book.session_id].reconciliation_error && <p>{verification[book.session_id].reconciliation_error}</p>}
        {verification[book.session_id].verified_flat && <button type="button" disabled={busy} onClick={() => { setAcknowledgeUndated(false); setClosing(book.session_id) }}>Close verified book…</button>}
        {closing === book.session_id && <div role="alertdialog" aria-label="Confirm verified book closure"><p>Verify again and close this book? Older history warnings remain in its record.</p>{Boolean(verification[book.session_id].current_submission_ids?.length) && <p>Current-day submissions are unresolved; closure remains blocked.</p>}{Boolean(verification[book.session_id].undated_submission_ids?.length) && <label><input type="checkbox" checked={acknowledgeUndated} onChange={event => setAcknowledgeUndated(event.target.checked)} /> I acknowledge the undated attempts. Retain the history warning and close only after broker verification.</label>}<button type="button" disabled={busy || Boolean(verification[book.session_id].current_submission_ids?.length) || (Boolean(verification[book.session_id].undated_submission_ids?.length) && !acknowledgeUndated)} onClick={() => void recover(book, true)}>Confirm closure</button><button type="button" onClick={() => setClosing(null)}>Keep book</button></div>}
      </div>}
      {onAttach && book.trading_style === 'intraday' && <button type="button" onClick={() => onAttach(book.session_id)}>Open session</button>}
      {book.allocation_pct != null && book.trading_style === 'intraday' && book.state === 'running' && <label> Allocation % <input aria-label={`${book.broker} Day allocation percent`} type="number" min="0.01" max="100" step="0.01" style={{ width: 65 }} value={fractions[book.session_id] ?? String(Math.round(book.allocation_pct * 10000) / 100)} onChange={event => setFractions(previous => ({ ...previous, [book.session_id]: event.target.value }))} /><button type="button" disabled={busy} onClick={() => void save(book)}>Apply</button></label>}
    </div>)}
    {status?.active_sessions?.length === 0 && <p>No outstanding Real sessions.</p>}
    {status?.availability?.map(slot => <small key={slot.trading_style} style={{ display: 'block' }}>Selected broker · {slot.trading_style === 'intraday' ? 'Day' : 'Swing'}: {slot.occupied ? slot.owned_by_you ? 'your session' : 'occupied by another user' : 'available'}</small>)}
  </section>
}
