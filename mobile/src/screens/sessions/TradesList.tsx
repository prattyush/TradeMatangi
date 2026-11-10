import type { AnalysisTrade } from '../../../../shared/analysis/api'
import { clockTime, formatPnl } from './format'

const contract = (trade: AnalysisTrade) => (trade.strike != null && trade.right ? `${trade.strike} ${trade.right}` : trade.symbol)

/** Executions as a compact table that fits the phone's width: time, side, quantity, price, contract. */
export function TradesList({ trades }: { trades: AnalysisTrade[] }) {
  if (trades.length === 0) return <p className="muted pad">No executions in this session.</p>
  return (
    <table className="trades-table">
      <thead>
        <tr><th>Time</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th>Contract</th><th className="num">Value</th></tr>
      </thead>
      <tbody>
        {trades.map(trade => (
          <tr key={`${trade.session_id}:${trade.trade_id}`}>
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
