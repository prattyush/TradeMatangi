import { Trade } from '../services/api'

interface Props {
  trades: Trade[]
}

function fmt(n: number) {
  return n.toFixed(2)
}

function toDate(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
}

export default function TradeHistory({ trades }: Props) {
  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
      overflow: 'hidden', minWidth: 320,
    }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #30363d', fontSize: 13, fontWeight: 600 }}>
        Trade History ({trades.length})
      </div>
      {trades.length === 0 ? (
        <div style={{ padding: 16, fontSize: 12, color: '#484f58', textAlign: 'center' }}>
          No trades yet
        </div>
      ) : (
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                {['Time (IST)', 'Side', 'Qty', 'Price'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...trades].reverse().map(t => (
                <tr key={t.trade_id} style={{ borderBottom: '1px solid #21262d' }}>
                  <td style={{ padding: '6px 10px', color: '#8b949e' }}>{toDate(t.timestamp)}</td>
                  <td style={{ padding: '6px 10px', fontWeight: 600, color: t.side === 'BUY' ? '#26a641' : '#f85149' }}>
                    {t.side}
                  </td>
                  <td style={{ padding: '6px 10px' }}>{t.quantity}</td>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
