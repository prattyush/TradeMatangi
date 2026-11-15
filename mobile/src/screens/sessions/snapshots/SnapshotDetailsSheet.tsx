import type { EventSnapshot, SnapshotPosition } from '../../../../../shared/analysis/api'
import { eventIcon } from '../../../../../shared/analysis/snapshotModel'
import { Sheet } from '../../../shell/Sheet'
import { clockTime, formatPnl, pnlClass } from '../format'

const inr = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
const sign = (value: number) => (value >= 0 ? '+' : '')

function PositionLine({ label, position, ltp }: { label: string; position: SnapshotPosition; ltp: number }) {
  if (position.side === 'FLAT') return <div className="detail-line"><span>{label}</span><strong className="muted">Flat</strong></div>
  return (
    <div className="detail-line">
      <span>{label}</span>
      <strong>{position.side} {position.quantity} @ {position.avg_entry_price.toFixed(2)}</strong>
      <small>{ltp > 0 ? `LTP ${ltp.toFixed(2)} · ` : ''}<span className={pnlClass(position.pnl)}>{formatPnl(position.pnl, true)} ({sign(position.pnl_pct)}{position.pnl_pct}%)</span></small>
    </div>
  )
}

/** The numbers behind one snapshot: money, open orders and positions at the moment of the event. */
export function SnapshotDetailsSheet({ snapshot, onClose }: { snapshot: EventSnapshot; onClose: () => void }) {
  const data = snapshot.snapshot
  const options = snapshot.instrument_type === 'options'
  const combined = data.combined_pnl ?? data.wallet_balance - data.session_capital
  const combinedPct = data.combined_pnl_pct ?? (data.session_capital > 0 ? (combined / data.session_capital) * 100 : 0)
  return (
    <Sheet title="Snapshot details" onClose={onClose}>
      <p className="detail-event">{eventIcon(snapshot.event.type)} <strong>{snapshot.event.description}</strong><br /><small className="muted">{clockTime(snapshot.timestamp)} · candle {data.bar_time ? clockTime(data.bar_time).slice(0, 5) : ''}</small></p>
      <div className="detail-group" role="group" aria-label="Money">
        <div className="detail-line"><span>Wallet</span><strong>{inr(data.wallet_balance)} <small className="muted">of {inr(data.session_capital)}</small></strong></div>
        <div className="detail-line"><span>Capital in use</span><strong>{data.wallet_used_pct ?? 0}%</strong></div>
        <div className="detail-line"><span>Open P&L</span><strong className={pnlClass(combined)}>{formatPnl(combined, true)} ({sign(combinedPct)}{combinedPct.toFixed(2)}%)</strong></div>
        {data.session_pnl != null && <div className="detail-line"><span>Session P&L</span><strong className={pnlClass(data.session_pnl)}>{formatPnl(data.session_pnl, true)} ({sign(data.session_pnl_pct ?? 0)}{(data.session_pnl_pct ?? 0).toFixed(2)}%)</strong></div>}
      </div>
      <div className="detail-group" role="group" aria-label="Open orders">
        <h4>Open orders ({data.open_orders.length})</h4>
        {data.open_orders.length === 0 && <p className="muted">None</p>}
        {data.open_orders.map(order => (
          <div key={order.order_id} className="detail-line">
            <span>{order.side} {order.order_type}{order.is_stoploss ? ' · SL' : ''}</span>
            <strong>@ {order.trigger_price || order.limit_price} × {order.quantity}</strong>
          </div>
        ))}
      </div>
      <div className="detail-group" role="group" aria-label="Positions">
        <h4>Positions</h4>
        <PositionLine label={options ? 'Underlying' : 'Position'} position={data.position} ltp={data.current_price} />
        {options && data.strike_ce != null && <PositionLine label={`CE ${data.strike_ce}`} position={data.position_ce} ltp={data.current_price_ce} />}
        {options && data.strike_pe != null && <PositionLine label={`PE ${data.strike_pe}`} position={data.position_pe} ltp={data.current_price_pe} />}
      </div>
    </Sheet>
  )
}
