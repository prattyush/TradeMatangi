import { useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { useToast } from '../../shell/Toast'
import { snapSwingPrice, swingOrderTick } from '../../../../shared/swingOrderPrice'
import { describeSwingError } from './swingErrors'
import type { SwingApi } from './swingApi'
import { contractName, orderSummary, price as priceText, rupees } from './swingFormat'
import type { AmendPreview, PendingOrder, Snapshot } from './swingTypes'

/** One pending order: change its price or quantity, or cancel it. A futures entry is previewed before it is changed. */
export function OrderSheet({ api, snapshot, order, onClose, onApply }: {
  api: SwingApi; snapshot: Snapshot; order: PendingOrder; onClose: () => void; onApply: (snapshot: Snapshot) => void
}) {
  const portfolio = snapshot.portfolio!
  const real = portfolio.mode === 'real'
  const toast = useToast()
  const tick = swingOrderTick(order)
  const filled = order.broker_filled_quantity ?? order.filled_quantity ?? 0
  const [price, setPrice] = useState(String(order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price))
  const [quantity, setQuantity] = useState(String(order.quantity))
  const [preview, setPreview] = useState<AmendPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const futuresEntry = order.instrument_type === 'futures' && order.execution_role !== 'exit'
  const priceValue = Number(price)
  const quantityValue = Number(quantity)
  const lot = order.lot_size ?? 1
  const problem =
    !(priceValue > 0) ? 'Enter a price.' :
    Math.abs(priceValue - snapSwingPrice(priceValue, tick)) > 1e-9 ? `The price must be a multiple of ${tick}.` :
    !Number.isInteger(quantityValue) || quantityValue <= filled ? `The quantity must be a whole number above the ${filled} already filled.` :
    quantityValue % lot !== 0 ? `The quantity must be whole lots of ${lot}.` : null
  const unchanged = priceValue === (order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price) && quantityValue === order.quantity

  async function run(action: () => Promise<Snapshot>, message: string) {
    if (busy) return
    setBusy(true); setError(null)
    try { onApply(await action()); toast(message); onClose() } catch (caught) { setError(describeSwingError(caught)); setBusy(false) }
  }

  async function save() {
    if (busy || problem || unchanged) return
    if (futuresEntry && !preview) {
      setBusy(true); setError(null)
      try { setPreview(await api.amendPreview(portfolio.session_id, order.order_id, priceValue, quantityValue)) } catch (caught) { setError(describeSwingError(caught)) } finally { setBusy(false) }
      return
    }
    await run(() => api.amendOrder(portfolio.session_id, order.order_id, {
      price: priceValue, quantity: quantityValue,
      ...(preview ? { approved_budget: preview.required_funds, capital_revision: preview.capital_revision, fee_hash: preview.fee_hash, order_fingerprint: preview.order_fingerprint } : {}),
    }), 'Order changed')
  }

  return (
    <Sheet title="Order" onClose={onClose}>
      <div className={`swing-banner swing-banner-${portfolio.mode}`} role="status">{real ? 'REAL MONEY' : 'PAPER (practice)'}</div>
      <p><strong>{contractName(order)}</strong><br /><span className="muted">{orderSummary(order)}</span></p>
      {order.swing_reconcile_pending && <p className="form-error">The broker has not confirmed this order yet. Refresh before changing it.</p>}
      <div className="field-row">
        <label className="field">{order.order_type === 'LIMIT' ? 'Limit price' : 'Trigger price'}
          <input type="number" inputMode="decimal" step={tick} aria-label="Order price" value={price} disabled={busy} onChange={event => { setPrice(event.target.value); setPreview(null) }} />
        </label>
        <label className="field">Total quantity
          <input type="number" inputMode="numeric" step={lot} min={filled + 1} aria-label="Order quantity" value={quantity} disabled={busy} onChange={event => { setQuantity(event.target.value); setPreview(null) }} />
        </label>
      </div>
      {problem && <p className="form-error" role="status">{problem}</p>}
      {preview && (
        <div className="swing-estimate" role="status" aria-label="Amendment estimate">
          Margin {rupees(preview.margin ?? preview.required_funds)} · Fees {rupees(preview.fees)} · Needs {rupees(preview.required_funds)} · Extra funds {rupees(preview.additional_funds)}
          {preview.message && <small className="muted"> {preview.message}</small>}
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        <button type="button" className="btn btn-primary" disabled={busy || Boolean(problem) || unchanged} onClick={() => void save()}>
          {busy ? 'Working…' : futuresEntry ? (preview ? 'Confirm change' : 'Preview change') : 'Save change'}
        </button>
      </div>
      {confirmCancel ? (
        <div className="swing-confirm" role="alertdialog" aria-label="Confirm cancel">
          <p>Cancel this order{filled ? ` (the ${filled} already filled stay)` : ''}?</p>
          <div className="row">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void run(() => api.cancelOrder(portfolio.session_id, order.order_id), 'Order cancelled')}>Cancel the order</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep it</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel order…</button>
      )}
      <p className="muted">Last price {priceText(order.limit_price)} limit. Changes go to the broker for a real portfolio.</p>
    </Sheet>
  )
}
