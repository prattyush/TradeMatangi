import type { AnalysisTrade } from '../../../../shared/analysis/api'
import { clockTime, formatPnl } from './format'

const contract = (trade: AnalysisTrade) => (trade.strike != null && trade.right ? `${trade.strike} ${trade.right}` : trade.symbol)

/** Executions as a compact table that fits the phone's width: time, side, quantity, price, contract. */
export function TradesList({ trades, onSelect }: { trades: AnalysisTrade[]; onSelect?: (trade: AnalysisTrade) => void }) {
  if (trades.length === 0) return <p className="muted pad">No executions in this session.</p>
  return (
    <table className="trades-table">
      <thead>
        <tr><th>Time</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th>Contract</th><th className="num">Value</th></tr>
      </thead>
      <tbody>
        {trades.map(trade => (
          <tr key={`${trade.session_id}:${trade.trade_id}`} className={onSelect ? 'tappable' : undefined} tabIndex={onSelect ? 0 : undefined} role={onSelect ? 'button' : undefined}
            aria-label={onSelect ? `Inspect ${trade.side} ${trade.quantity} at ${trade.price.toFixed(2)}` : undefined}
            onClick={onSelect ? () => onSelect(trade) : undefined} onKeyDown={onSelect ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(trade) } } : undefined}>
            <td className="mono">{clockTime(trade.timestamp)}</td>
            <td className={trade.side === 'BUY' ? 'pos' : 'neg'}>{trade.side}</td>
            <td className="num">{trade.quantity}</td>
            <td className="num">{trade.price.toFixed(2)}</td>
            <td>{contract(trade)}</td>
            <td className="num">{formatPnl(trade.price * trade.quantity).replace('+', '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
