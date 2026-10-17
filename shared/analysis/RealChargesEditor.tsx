import { useEffect, useState } from 'react'
import { useAnalysisEnvironment, useAnalysisError } from './environment'
import type { RealFeesDay } from './performance'

const accountKey = (item: RealFeesDay['accounts'][number]) => `${item.execution_broker ?? 'kotak'}:${item.account_id}`

export default function RealChargesEditor({ initialDate, onSaved, onClose }: { initialDate: string; onSaved: () => void; onClose: () => void }) {
  const { performance, onDataChanged } = useAnalysisEnvironment()
  const [date, setDate] = useState(initialDate)
  const [day, setDay] = useState<RealFeesDay | null>(null)
  const [account, setAccount] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useAnalysisError(error, 'Real analytics charges')
  const selected = day?.accounts.find(item => accountKey(item) === account)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setDay(null); setAccount(''); setAmount(''); setError(''); setNotice('')
    if (!date) { setLoading(false); return () => controller.abort() }
    performance.getRealFees!(date, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setDay(result); setAccount(result.accounts[0] ? accountKey(result.accounts[0]) : '')
      setAmount(result.accounts[0]?.actual_total == null ? '' : String(result.accounts[0].actual_total))
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [date, performance])
  const update = async (remove = false) => {
    if (!selected || busy || loading) return
    const value = Number(amount)
    if (!remove && (!amount.trim() || !Number.isFinite(value) || value < 0)) { setError('Enter a nonnegative finalized charge total'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const result = remove ? await performance.deleteRealFees!(date, selected.account_id, selected.execution_broker ?? "kotak") : await performance.saveRealFees!(date, selected.account_id, value, selected.execution_broker ?? "kotak")
      setDay(result); setAmount(remove ? '' : String(result.accounts.find(item => accountKey(item) === account)?.actual_total ?? value))
      setNotice(remove ? 'Estimated charges restored' : 'Actual charges saved; per-trade amounts are allocated')
      onDataChanged?.(); onSaved()
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  return <section className="pa-card" aria-label="Actual Real charges">
    <div className="pa-card-title"><h3>Finalized Real trading charges</h3><button type="button" disabled={busy} onClick={onClose}>Close charges</button></div>
    <p>Enter finalized trading charges (brokerage, taxes and fees) for your loaded Real Day orders in this broker account/date. Swing charges remain estimated. Current symbol filters do not narrow the bill. If the statement includes other trades, load their Real history first or enter only charges attributable to these orders.</p>
    <form onSubmit={event => { event.preventDefault(); void update() }}>
      <div className="pa-filters">
        <label>Trading date<input aria-label="Charges trading date" type="date" required value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></label>
        <label>Your broker account<select aria-label="Charges broker account" value={account} disabled={busy || loading || !day?.accounts.length} onChange={event => { setAccount(event.target.value); const item = day?.accounts.find(a => accountKey(a) === event.target.value); setAmount(item?.actual_total == null ? '' : String(item.actual_total)); setNotice('') }}>{day?.accounts.map(item => <option key={accountKey(item)} value={accountKey(item)}>{item.execution_broker === "kite" ? "Kite" : "Kotak"} · {item.account_id} · {item.order_count} orders</option>)}</select></label>
        <label>Actual total charges (₹)<input aria-label="Actual total charges" type="number" min="0" step="0.01" required value={amount} disabled={busy || loading || !selected} onChange={event => setAmount(event.target.value)} /></label>
        <button type="submit" disabled={busy || loading || !selected || !amount.trim()}>{busy ? 'Saving…' : 'Save actual charges'}</button>
        <button type="button" disabled={busy || loading || selected?.actual_total == null} onClick={() => void update(true)}>Use estimate</button>
      </div>
    </form>
    {loading && <p role="status">Reading owned Real trades…</p>}
    {!loading && day && !day.accounts.length && <p>No Real Day broker-account trades found for this date. Legacy history without an account identity cannot accept a bill correction.</p>}
    {selected && <p>Calculated estimate ₹{selected.estimated_total.toLocaleString('en-IN', {maximumFractionDigits: 2})}{selected.actual_total != null && ` · Saved actual ₹${selected.actual_total.toLocaleString('en-IN', {maximumFractionDigits: 2})}`}</p>}
    {selected?.history_changed && <p role="status">Real order history changed since this bill was saved. New or changed orders use estimates; save the finalized total again to reconcile the date.</p>}
    <p>Analytics only: orders, wallet and live trading stay unchanged. The total is allocated across orders using estimated costs (turnover if estimates are zero). Individual fees are allocated, not broker-confirmed. Open-position entry charges remain separate from closed P&amp;L. Shared accounts are read-only.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
