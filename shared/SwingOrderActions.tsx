import { useEffect, useState } from 'react'
import { snapSwingPrice, swingOrderTick } from './swingOrderPrice'

export default function SwingOrderActions({ order, editing, initialPrice, busy, error, ltp, picking, onPick, onClose, onPreview, onSave, onCancel }: {
  order: any; editing: boolean; initialPrice?: number; busy: boolean; error?: string;
  ltp?: {price: number; time: number} | null; picking?: boolean;
  onPick: (receive: (price: number) => void) => void;
  onPreview: (price: number, quantity: number) => Promise<any>;
  onClose: () => void; onSave: (price: number, quantity: number, approval?: any) => Promise<boolean>; onCancel: () => Promise<boolean>;
}) {
  const [edit, setEdit] = useState(editing)
  const [price, setPrice] = useState(String(initialPrice ?? (order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price)))
  const [quantity, setQuantity] = useState(String(order.quantity))
  const [preview, setPreview] = useState<any>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const disabled = busy || previewBusy
  const setDraftPrice = (value: number) => { setPrice(String(snapSwingPrice(value, swingOrderTick(order)))); setPreview(null) }
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [disabled, onClose])
  const futuresEntry = (order.instrument_type === 'futures' || Boolean(order.analytics?.futures)) && order.execution_role !== 'exit'
  const filled = order.broker_filled_quantity ?? order.filled_quantity ?? 0
  const [clock, setClock] = useState(Date.now())
  useEffect(() => { const timer=setInterval(() => setClock(Date.now()),5000); return () => clearInterval(timer) }, [])
  const fresh = ltp && Number.isFinite(ltp.price) && ltp.price > 0 && clock/1000 + 19800 - ltp.time >= -5 && clock/1000 + 19800 - ltp.time < 120
  const save = async () => {
    if (futuresEntry && !preview) {
      setPreviewBusy(true); setPreviewError('')
      try { setPreview(await onPreview(Number(price), Number(quantity))) }
      catch (reason) { setPreviewError(String(reason)) }
      finally { setPreviewBusy(false) }
      return
    }
    const ok = await onSave(Number(price), Number(quantity), preview && {
      approved_budget: preview.required_funds, capital_revision: preview.capital_revision,
      fee_hash: preview.fee_hash, order_fingerprint: preview.order_fingerprint,
    })
    if (ok) onClose()
    else setPreview(null)
  }
  return <div className="swing-order-backdrop" style={picking ? {display:'none'} : undefined} onClick={event => { if (event.target === event.currentTarget && !disabled) onClose() }}>
    <section role="dialog" aria-modal="true" aria-label="Swing order actions" className="swing-order-dialog">
      <header><strong>{order.symbol} {order.right} {order.strike} {order.expiry} · {order.side} {order.order_type}</strong><button disabled={disabled} onClick={onClose} aria-label="Close order actions">×</button></header>
      <p>Filled {filled} · Remaining {Math.max(0, order.quantity - filled)}</p>
      {edit ? <form onSubmit={event => { event.preventDefault(); void save() }}>
        <label>{order.order_type === 'LIMIT' ? 'Limit price' : 'Trigger price'}<input autoFocus aria-label="Order price" type="number" min={swingOrderTick(order)} step={swingOrderTick(order)} required value={price} onChange={event => {setPrice(event.target.value);setPreview(null)}} disabled={disabled}/></label>
        <button type="button" disabled={disabled || !fresh} title={fresh ? 'Use the latest quote for this contract' : 'Fresh quote unavailable for this contract'} onClick={() => { if (fresh && ltp) setDraftPrice(ltp.price) }}>LTP</button>
        <button type="button" disabled={disabled} onClick={() => onPick(setDraftPrice)}>Pick on chart</button>
        {order.order_type !== 'LIMIT' && <small>Execution limit is calculated from the trigger. Current limit ₹{order.limit_price}.</small>}
        <label>Total quantity<input aria-label="Order total quantity" type="number" min={filled + 1} step="1" required value={quantity} onChange={event => {setQuantity(event.target.value);setPreview(null)}} disabled={disabled}/></label>
        {preview && <div role="status"><p>Margin ₹{preview.margin} · Fees ₹{preview.fees} · Required ₹{preview.required_funds}</p><p>Reserved ₹{preview.existing_reservation} · Additional funds ₹{preview.additional_funds}</p><small>{preview.message}</small></div>}
        <button disabled={disabled} type="submit">{disabled ? 'Saving…' : futuresEntry ? preview ? 'Confirm amendment' : 'Preview amendment' : 'Save order'}</button>
      </form> : <button disabled={disabled} onClick={() => setEdit(true)}>Edit order</button>}
      <button disabled={disabled} onClick={() => { void onCancel().then(ok => { if (ok) onClose() }) }}>Cancel order</button>
      {(error || previewError) && <p role="alert">{error || previewError}</p>}
    </section>
  </div>
}
