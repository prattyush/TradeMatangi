import { useCallback, useEffect, useRef, useState } from 'react'
import { SymbolSearch, type SymbolChoice } from './SymbolSearch'

export type SwingRequest = <T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<T>
interface Portfolio { session_id: string; state: string; entries_paused: boolean; guardrail_ban?: boolean; session_capital: number; guardrail_epoch: number }
interface Position { symbol: string; right?: string; strike?: number; expiry?: string; quantity: number; avg_entry_price: number; mark_price?: number }
interface PendingOrder { order_id: string; symbol: string; side: string; order_type: string; quantity: number; limit_price: number; right?: string; strike?: number; expiry?: string }
interface Snapshot { portfolio: Portfolio | null; wallet_balance?: number; pnl?: number | null; guardrail_pnl?: number | null; positions?: Position[]; open_orders?: PendingOrder[] }
const money = (value?: number | null) => value == null ? 'Waiting for prices' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 })

/** Account-owned controls: dismissing this view never stops the portfolio. */
export default function SwingPortfolioPanel({ request, loadSymbols, onDetach }: {
  request: SwingRequest; loadSymbols: () => Promise<SymbolChoice[]>; onDetach: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [symbols, setSymbols] = useState<SymbolChoice[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [capital, setCapital] = useState('100000')
  const [loss, setLoss] = useState('')
  const [symbol, setSymbol] = useState('HDFCBANK')
  const [kind, setKind] = useState<'equity' | 'options'>('equity')
  const [right, setRight] = useState('CE')
  const [strike, setStrike] = useState('')
  const [expiry, setExpiry] = useState('')
  const [side, setSide] = useState('BUY')
  const [type, setType] = useState('LIMIT')
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const requestIdentity = useRef<string | null>(null)
  const mounted = useRef(false)
  const mutation = useRef(false)
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const started = revision.current
    const value = await request<Snapshot>('active', 'GET')
    if (mounted.current && !mutation.current && started === revision.current) setSnapshot(value)
  }, [request])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() } catch (reason) { if (mounted.current) setError(String(reason)) }
      if (mounted.current) timer = setTimeout(poll, 2000)
    }
    void poll()
    void loadSymbols().then(value => { if (mounted.current) setSymbols(value) }).catch(reason => { if (mounted.current) setError(String(reason)) })
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [refresh, loadSymbols])
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    if (mutation.current) return false
    mutation.current = true; revision.current++; setBusy(true); setError('')
    try {
      const value = await request<Snapshot>(path, 'POST', body)
      if (mounted.current) setSnapshot(value)
      return true
    } catch (reason) { if (mounted.current) setError(String(reason)); return false }
    finally { mutation.current = false; if (mounted.current) setBusy(false) }
  }
  const portfolio = snapshot?.portfolio
  const prefix = portfolio?.session_id
  const order = async () => {
    requestIdentity.current ??= crypto.randomUUID()
    const sent = await act(`${prefix}/orders`, { symbol, instrument_type: kind, side, order_type: type,
      quantity: Number(quantity), price: Number(price), request_id: requestIdentity.current,
      ...(kind === 'options' ? { right, strike: Number(strike), expiry } : {}) })
    if (sent) requestIdentity.current = null
  }
  // Editing instructions starts a new request; retrying unchanged instructions preserves identity.
  useEffect(() => { requestIdentity.current = null }, [symbol, kind, right, strike, expiry, side, type, quantity, price])
  return <section aria-label="Paper Swing portfolio" style={{ padding: 20, color: '#e5e7eb', background: '#0d1117', minHeight: 360 }}>
    <header style={{ display: 'flex', gap: 16, alignItems: 'center' }}><h2>Paper Swing</h2><button title="Detach screen; keep portfolio running" onClick={onDetach}>Detach screen</button></header>
    {error && <p role="alert">{error}</p>}
    {!snapshot ? <p role="status">Loading portfolio…</p> : !portfolio ? <form onSubmit={event => { event.preventDefault(); void act('', { capital: Number(capital), ...(loss ? { loss_limit_pct: Number(loss) / 100 } : {}) }) }}>
      <p>Hold shares and long options across days in one portfolio.</p>
      <label>Starting capital ₹ <input type="number" min="1" step="0.01" required value={capital} onChange={event => setCapital(event.target.value)} /></label>{' '}
      <label>Portfolio loss limit % <input type="number" min="0.01" max="100" step="0.01" value={loss} onChange={event => setLoss(event.target.value)} placeholder="Optional" /></label>{' '}
      <button disabled={busy}>Start portfolio</button>
    </form> : <>
      <p>Funds ₹{money(snapshot.wallet_balance)} · Capital ₹{money(portfolio.session_capital)} · P&amp;L ₹{money(snapshot.pnl)} · {portfolio.state}</p>
      {portfolio.guardrail_ban && <p role="status">Portfolio loss limit reached. Exits remain available.</p>}
      {portfolio.state === 'running' && <div style={{ display: 'flex', gap: 12 }}>
        <button disabled={busy} onClick={() => void act(`${prefix}/pause`, { paused: !portfolio.entries_paused })}>{portfolio.entries_paused ? 'Resume entries' : 'Pause entries'}</button>
        <button onClick={() => { setCapital(String(portfolio.session_capital)); setResetOpen(true) }}>Reset capital</button>
        <button onClick={() => setConfirmClose(true)}>Close portfolio…</button>
      </div>}
      {confirmClose && <div role="alertdialog" aria-label="Confirm portfolio closure"><p>Close all managed positions at available market quotes and cancel entries? Closure waits for executable prices.</p><button disabled={busy} onClick={() => void act(`${prefix}/close`).then(ok => { if (ok) setConfirmClose(false) })}>Confirm close portfolio</button><button onClick={() => setConfirmClose(false)}>Keep portfolio</button></div>}
      {resetOpen && <form onSubmit={event => { event.preventDefault(); void act(`${prefix}/capital`, { capital: Number(capital) }).then(ok => { if (ok) setResetOpen(false) }) }}><p>Reset the sizing reference and loss-limit period. Cash, positions and history stay intact.</p><label>Capital ₹ <input type="number" min="1" step="0.01" required value={capital} onChange={event => setCapital(event.target.value)} /></label><button disabled={busy}>Confirm reset</button><button type="button" onClick={() => setResetOpen(false)}>Cancel</button></form>}
      <h3>Positions</h3>
      {snapshot.positions?.length ? <table><thead><tr><th>Instrument</th><th>Quantity</th><th>Average</th><th>Current</th></tr></thead><tbody>{snapshot.positions.map(position => <tr key={`${position.symbol}:${position.right}:${position.strike}:${position.expiry}`}><td>{position.symbol} {position.right} {position.strike} {position.expiry}</td><td>{position.quantity}</td><td>{money(position.avg_entry_price)}</td><td>{money(position.mark_price)}</td></tr>)}</tbody></table> : <p>No open positions.</p>}
      <h3>Pending intentions</h3>
      {snapshot.open_orders?.length ? <table><thead><tr><th>Instrument</th><th>Side</th><th>Type</th><th>Quantity</th><th>Limit</th><th>Action</th></tr></thead><tbody>{snapshot.open_orders.map(order => <tr key={order.order_id}><td>{order.symbol} {order.right} {order.strike} {order.expiry}</td><td>{order.side}</td><td>{order.order_type}</td><td>{order.quantity}</td><td>{money(order.limit_price)}</td><td><button disabled={busy} onClick={() => void act(`${prefix}/orders/${order.order_id}/cancel`)}>Cancel</button></td></tr>)}</tbody></table> : <p>No pending orders.</p>}
      {portfolio.state === 'running' && <form onSubmit={event => { event.preventDefault(); void order() }} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <SymbolSearch value={symbol} options={symbols} onChange={setSymbol} />
        <label>Instrument <select value={kind} onChange={event => setKind(event.target.value as 'equity' | 'options')}><option value="equity">Equity</option><option value="options">Options</option></select></label>
        {kind === 'options' && <><label>Right <select value={right} onChange={event => setRight(event.target.value)}><option>CE</option><option>PE</option></select></label><label>Strike <input type="number" min="0.01" step="any" required value={strike} onChange={event => setStrike(event.target.value)} /></label><label>Expiry <input type="date" required value={expiry} onChange={event => setExpiry(event.target.value)} /></label></>}
        <label>Side <select value={side} onChange={event => { setSide(event.target.value); if (event.target.value === 'SELL' && type === 'TARGET') setType('LIMIT') }}><option>BUY</option><option>SELL</option></select></label>
        <label>Order <select value={type} onChange={event => setType(event.target.value)}><option>LIMIT</option>{side === 'BUY' && <option>TARGET</option>}{side === 'SELL' && <option>STOPLOSS</option>}</select></label>
        <label>Quantity <input type="number" min="1" step="1" required value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
        <label>{type === 'LIMIT' ? 'Limit' : 'Trigger'} ₹ <input type="number" min="0.01" step="0.01" required value={price} onChange={event => setPrice(event.target.value)} /></label>
        <button disabled={busy || (side === 'BUY' && (portfolio.entries_paused || portfolio.guardrail_ban))}>Place intention</button>
      </form>}
      <p>Equity uses full purchase value. Paper option exits start 15 minutes before expiry-day market close.</p>
    </>}
  </section>
}
