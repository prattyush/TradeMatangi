import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopOrder, DesktopTradingSnapshot } from './contracts'
import { StepInput } from './StepInput'
import { availableExitQuantity, orderPosition } from './orderEditing'
import { entryUnavailableReason, validateEntryStop } from './tradingInstrument'
import type { PreparationTile } from './sessionPreparation'

export interface FloatingOrderDraft {
  type: 'MARKET' | 'LIMIT' | 'TARGET' | 'STOPLOSS'; side: 'BUY' | 'SELL'
  price?: number; quantity?: number; funds_ratio_pct?: number; risk_pct?: number; entry_sl_price?: number; group_id: string
}
const identity = (tile: PreparationTile) => tile.kind === 'option' ? `${tile.symbol}:${tile.expiry}:${tile.strike}:${tile.right}` : tile.symbol
const label = (tile: PreparationTile) => tile.kind === 'option' ? `${tile.right} ${tile.strike}` : tile.symbol
const fullLabel = (tile: PreparationTile) => `${tile.symbol}${tile.kind === 'option' ? ` · ${tile.right} ${tile.strike} · ${tile.expiry}` : ''}`

export function FloatingOrderWindow({ visible, tiles, activeTileId, snapshot, priceForTile, onSubmit, onReconcile, onClose }: {
  visible: boolean; tiles: PreparationTile[]; activeTileId: string; snapshot: DesktopTradingSnapshot
  priceForTile: (tile: PreparationTile) => number
  onSubmit: (tile: PreparationTile, draft: FloatingOrderDraft) => Promise<void>
  onReconcile: () => Promise<DesktopTradingSnapshot>; onClose: () => void
}) {
  const contracts = useMemo(() => [...new Map(tiles.map(tile => [identity(tile), tile])).values()], [tiles])
  const [selected, setSelected] = useState(() => identity(tiles.find(tile => tile.id === activeTileId) ?? tiles[0]))
  const tile = contracts.find(item => identity(item) === selected)
  const [type, setType] = useState<FloatingOrderDraft['type']>('MARKET')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [sizing, setSizing] = useState<'quantity' | 'capital' | 'risk'>(() => snapshot.settings.desktop_order_size_mode === 'funds_ratio' ? 'capital' : snapshot.settings.desktop_order_size_mode === 'risk_ratio' ? 'risk' : 'quantity')
  const [size, setSize] = useState('1'), [ratio, setRatio] = useState<'l' | 'm' | 'h'>('l')
  const [price, setPrice] = useState(''), [stop, setStop] = useState(''), [attached, setAttached] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState<string | null>(null)
  const pending = useRef(false), box = useRef<HTMLElement>(null)
  const [point, setPoint] = useState({ x: Math.max(8, window.innerWidth - 360), y: 65 })
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const reason = tile ? entryUnavailableReason(tile.kind, tile.symbol, snapshot) : 'Choose a displayed contract'
  const lot = tile?.kind === 'option' ? snapshot.option_lot_size ?? snapshot.session.lot_size : 1
  const lastPrice = tile ? priceForTile(tile) : 0
  const probe = { symbol: tile?.symbol ?? '', right: tile?.kind === 'option' ? tile.right : null, strike: tile?.kind === 'option' ? Number(tile.strike) : null, expiry: tile?.kind === 'option' ? tile.expiry : null, side: 'SELL', quantity: 0, order_type: 'STOPLOSS', is_stoploss: true } as DesktopOrder
  const position = orderPosition(probe, snapshot)
  const closingSide = position?.side === 'SHORT' ? 'BUY' : 'SELL'
  probe.side = closingSide
  const maxSl = availableExitQuantity(probe, position, snapshot.open_orders)
  const clamp = (x: number, y: number) => ({ x: Math.max(8, Math.min(x, window.innerWidth - (box.current?.offsetWidth ?? 340) - 8)), y: Math.max(8, Math.min(y, window.innerHeight - Math.min(box.current?.offsetHeight ?? 300, window.innerHeight - 16) - 8)) })
  useEffect(() => {
    if (!tile) { setPrice(''); setStop(''); setSize(''); setNotice('Selected chart is no longer displayed. Choose a contract.') }
  }, [tile ? identity(tile) : null])
  useEffect(() => {
    const resize = () => setPoint(current => clamp(current.x, current.y))
    window.addEventListener('resize', resize)
    const observer = new ResizeObserver(resize)
    if (box.current) observer.observe(box.current)
    return () => { window.removeEventListener('resize', resize); observer.disconnect() }
  }, [visible])
  useEffect(() => {
    const move = (event: PointerEvent) => { if (drag.current) setPoint(clamp(drag.current.left + event.clientX - drag.current.x, drag.current.top + event.clientY - drag.current.y)) }
    const up = () => { drag.current = null }
    const key = (event: KeyboardEvent) => { if (visible && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose() } }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key, true) }
  }, [visible, onClose])
  const choose = (next: PreparationTile) => { setSelected(identity(next)); setPrice(''); setStop(''); setSize(''); setError(''); setNotice('') }
  const submit = async () => {
    if (!tile || reason || pending.current || uncertain) return
    setError(''); setNotice('')
    let draft: FloatingOrderDraft
    const group = crypto.randomUUID()
    try {
      if (type === 'MARKET' && !(lastPrice > 0)) throw new Error('Waiting for an authoritative price')
      const entry = type === 'MARKET' ? lastPrice : Number(price)
      if (!(entry > 0 && Number.isFinite(entry))) throw new Error('Enter a positive price')
      draft = { type, side: type === 'STOPLOSS' ? closingSide : side, group_id: group }
      if (type !== 'MARKET') draft.price = entry
      if (type === 'STOPLOSS') {
        const qty = Number(size)
        if (!Number.isInteger(qty) || qty < lot || qty % lot || qty > maxSl) throw new Error(`Stoploss quantity must be complete lots of ${lot}, at most ${maxSl}`)
        draft.quantity = qty
      } else {
        if (sizing === 'quantity') {
          if (!Number.isInteger(Number(size)) || Number(size) < 1) throw new Error('Enter a positive whole quantity')
          draft.quantity = Number(size) * lot
        } else if (sizing === 'capital') draft.funds_ratio_pct = snapshot.settings[`funds_ratio_${ratio}_pct`]
        else draft.risk_pct = snapshot.settings[`risk_ratio_${ratio}_pct`]
        if (attached) { validateEntryStop(side, entry, Number(stop)); draft.entry_sl_price = Number(stop) }
      }
    } catch (cause) { setError(String(cause)); return }
    pending.current = true; setBusy(true)
    try { await onSubmit(tile, draft); setPrice(''); setSize(''); setStop(''); setNotice('Order submitted') }
    catch (cause) {
      const message = String(cause)
      if (!/\((400|401|403|404|409|422)\)/.test(message)) setUncertain(group)
      setError(message)
    } finally { pending.current = false; setBusy(false) }
  }
  const reconcile = async () => {
    setBusy(true)
    try {
      const next = await onReconcile()
      const found = [...next.open_orders, ...next.trades].some(item => (item as Record<string, unknown>).group_id === uncertain)
      if (found) { setUncertain(null); setNotice('Submitted order found; trading state refreshed'); setError(''); setSize(''); setPrice(''); setStop('') }
      else setError('Submission is still unconfirmed. Do not submit another order; check History and reconnect before restarting this session.')
    } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const settings = snapshot.settings
  return <section ref={box} hidden={!visible} className="floating-order-window" role="dialog" aria-modal="false" aria-label="Order window" style={{ left: point.x, top: point.y }} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <header onPointerDown={event => { if (!(event.target as HTMLElement).closest('button')) { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: point.x, top: point.y } } }}><strong>Order</strong><button aria-label="Close order window" onClick={onClose}>×</button></header>
    <div className="order-contracts">{contracts.map(item => <button key={identity(item)} aria-pressed={selected === identity(item)} title={fullLabel(item)} disabled={busy} onClick={() => choose(item)}>{label(item)}{contracts.some(other => identity(other) !== identity(item) && label(other) === label(item)) && <small>{item.expiry}</small>}</button>)}</div>
    <div className="order-identity">{tile ? fullLabel(tile) : 'Choose a displayed contract'}</div>
    {reason && <p role="status">{reason}. Select a tradable contract.</p>}
    <div className="order-types">{(['MARKET', 'LIMIT', 'TARGET', 'STOPLOSS'] as const).map(value => <button disabled={busy} aria-pressed={type === value} key={value} onClick={() => { setType(value); setPrice(''); setSize('') }}>{value === 'STOPLOSS' ? 'SL' : value[0] + value.slice(1).toLowerCase()}</button>)}</div>
    <div className="order-row"><label>Side<select aria-label="Order side" value={type === 'STOPLOSS' ? closingSide : side} disabled={busy || type === 'STOPLOSS'} onChange={event => setSide(event.target.value as 'BUY' | 'SELL')}><option>BUY</option><option>SELL</option></select></label><span>LTP <b>{lastPrice > 0 ? lastPrice.toFixed(2) : 'Waiting'}</b></span></div>
    {type !== 'MARKET' && <label>{type === 'LIMIT' ? 'Limit price' : 'Trigger price'}<StepInput aria-label="New order price" min={0.01} step={0.25} value={price} onValue={setPrice} disabled={busy} /></label>}
    {type === 'TARGET' && Number(price) > 0 && <small>Limit ₹{(Number(price) * (side === 'BUY' ? 1 + settings.target_deviation_pct : 1 - settings.target_deviation_pct)).toFixed(2)}</small>}
    {type !== 'STOPLOSS' && <label>Sizing<select aria-label="Order sizing" value={sizing} disabled={busy} onChange={event => { setSizing(event.target.value as typeof sizing); setSize('') }}><option value="quantity">Fixed quantity</option><option value="capital">Capital %</option><option value="risk">Risk %</option></select></label>}
    {type === 'STOPLOSS' || sizing === 'quantity' ? <label>{type === 'STOPLOSS' ? 'SL units' : tile?.kind === 'option' ? 'Lots' : 'Shares'}<StepInput aria-label="New order quantity" value={size} onValue={setSize} min={type === 'STOPLOSS' ? lot : 1} step={type === 'STOPLOSS' ? lot : 1} max={type === 'STOPLOSS' ? maxSl : undefined} disabled={busy} /></label> : <div className="order-ratios">{(['l', 'm', 'h'] as const).map(value => <button key={value} disabled={busy} aria-pressed={ratio === value} onClick={() => setRatio(value)}>{value.toUpperCase()} {sizing === 'capital' ? (settings[`funds_ratio_${value}_pct`] * 100).toFixed(1) : settings[`risk_ratio_${value}_pct`]}%</button>)}</div>}
    {type === 'STOPLOSS' ? <small>Lot {lot} · available {maxSl} units</small> : <><label className="attach-stop"><input type="checkbox" checked={attached} disabled={busy} onChange={event => setAttached(event.target.checked)} />Attach entry SL</label>{attached && <label>Entry stop<StepInput aria-label="Attached entry stop" min={0.01} step={0.25} value={stop} onValue={setStop} disabled={busy} /></label>}</>}
    {sizing === 'risk' && type !== 'STOPLOSS' && <small>Risk sizing uses the supplied stop or saved default. Minimum one lot/share may exceed the selected budget; backend funds and risk checks apply.</small>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {uncertain && <button disabled={busy} onClick={() => void reconcile()}>Refresh submission status</button>}
    <button className="order-submit" disabled={busy || Boolean(reason) || Boolean(uncertain) || (type === 'MARKET' && lastPrice <= 0) || (type === 'STOPLOSS' && maxSl < lot)} onClick={() => void submit()}>{busy ? 'Working…' : `Submit ${type === 'STOPLOSS' ? closingSide : side}`}</button>
  </section>
}
