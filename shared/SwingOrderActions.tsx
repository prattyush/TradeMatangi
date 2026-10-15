import { useEffect, useState } from 'react'

export default function SwingOrderActions({ order, editing, busy, error, onClose, onSave, onCancel }: {
  order: any; editing: boolean; busy: boolean; error?: string;
  onClose: () => void; onSave: (price: number, quantity: number) => Promise<boolean>; onCancel: () => Promise<boolean>;
}) {
  const [edit, setEdit] = useState(editing)
  const [price, setPrice] = useState(String(order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price))
  const [quantity, setQuantity] = useState(String(order.quantity))
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [busy, onClose])
  const futuresEntry = Boolean(order.analytics?.futures) && order.execution_role !== 'exit'
  const filled = order.broker_filled_quantity ?? order.filled_quantity ?? 0
  return <div className="swing-order-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section role="dialog" aria-modal="true" aria-label="Swing order actions" className="swing-order-dialog">
      <header><strong>{order.symbol} {order.right} {order.strike} {order.expiry} · {order.side} {order.order_type}</strong><button disabled={busy} onClick={onClose} aria-label="Close order actions">×</button></header>
      <p>Filled {filled} · Remaining {Math.max(0, order.quantity - filled)}</p>
      {futuresEntry && <p>Cancel this futures entry and replace it after a fresh margin preview.</p>}
      {edit && !futuresEntry ? <form onSubmit={event => { event.preventDefault(); void onSave(Number(price), Number(quantity)).then(ok => { if (ok) onClose() }) }}>
        <label>{order.order_type === 'LIMIT' ? 'Limit price' : 'Trigger price'}<input autoFocus aria-label="Order price" type="number" min="0.000001" step="any" required value={price} onChange={event => setPrice(event.target.value)} disabled={busy}/></label>
        {order.order_type !== 'LIMIT' && <small>Execution limit is calculated from the trigger. Current limit ₹{order.limit_price}.</small>}
        <label>Total quantity<input aria-label="Order total quantity" type="number" min={filled + 1} step="1" required value={quantity} onChange={event => setQuantity(event.target.value)} disabled={busy}/></label>
        <button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save order'}</button>
      </form> : !futuresEntry && <button disabled={busy} onClick={() => setEdit(true)}>Edit order</button>}
      <button disabled={busy} onClick={() => { void onCancel().then(ok => { if (ok) onClose() }) }}>Cancel order</button>
      {error && <p role="alert">{error}</p>}
    </section>
  </div>
}
