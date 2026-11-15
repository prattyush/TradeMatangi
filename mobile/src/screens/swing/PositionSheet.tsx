import { Sheet } from '../../shell/Sheet'
import { contractName, price, quoteNote, rupees, signedPct, signedRupees, sideWord, tone } from './swingFormat'
import type { Position, Snapshot } from './swingTypes'

export type PositionAction = 'buy_more' | 'exit' | 'stoploss'

/** One position: what it is worth now, and the three things to do with it. */
export function PositionSheet({ snapshot, position, onAction, onChart, onClose }: {
  snapshot: Snapshot; position: Position; onAction: (action: PositionAction) => void; onChart: () => void; onClose: () => void
}) {
  const portfolio = snapshot.portfolio!
  const real = portfolio.mode === 'real'
  const canEnter = portfolio.state === 'running' && !portfolio.entries_paused
  const futures = position.instrument_type === 'futures'
  const short = position.side === 'SHORT'
  const canTrade = portfolio.state === 'running'
  return (
    <Sheet title={contractName(position)} onClose={onClose}>
      <div className={`swing-banner swing-banner-${portfolio.mode}`} role="status">{real ? 'REAL MONEY' : 'PAPER (practice)'}</div>
      <dl className="swing-facts" aria-label="Position">
        <dt>Position</dt><dd>{sideWord(position)} {position.quantity}</dd>
        <dt>Average</dt><dd>{price(position.avg_entry_price)}</dd>
        <dt>Last price</dt><dd>{price(position.mark_price)} <small className="muted">{quoteNote(position)}</small></dd>
        <dt>Open P&L</dt><dd className={tone(position.unrealized_pnl)}>{signedRupees(position.unrealized_pnl)} <small>{signedPct(position.unrealized_pnl_pct)}</small></dd>
        {futures ? <><dt>Margin held</dt><dd>{rupees(position.held_margin)}</dd><dt>Exposure</dt><dd>{rupees(position.notional_exposure)}</dd></> : <><dt>Invested</dt><dd>{rupees(position.invested_value)}</dd></>}
      </dl>
      <div className="swing-actions">
        <button type="button" className="btn" disabled={!canTrade} onClick={() => onAction('exit')}>{futures && short ? 'Buy to cover' : 'Exit'}</button>
        <button type="button" className="btn" disabled={!canTrade} onClick={() => onAction('stoploss')}>{short ? 'Add stoploss above' : 'Add stoploss'}</button>
        <button type="button" className="btn" disabled={!canEnter} onClick={() => onAction('buy_more')}>{futures && short ? 'Sell more' : 'Buy more'}</button>
        <button type="button" className="btn" onClick={onChart}>Chart</button>
      </div>
      {!canEnter && canTrade && <p className="muted">Entries are paused: you can still exit.</p>}
      {position.quote_status !== 'live' && <p className="muted">The price is not live. P&L uses the last known price.</p>}
    </Sheet>
  )
}
