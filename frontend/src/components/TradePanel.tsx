import { Position } from '../services/api'
import { SessionState } from '../hooks/useSimulation'

interface Props {
  sessionState: SessionState
  currentPrice: number
  position: Position
  pnl: number
  onBuy: () => Promise<void>
  onSell: () => Promise<void>
}

function fmt(n: number) {
  return n.toFixed(2)
}

export default function TradePanel({ sessionState, currentPrice, position, pnl, onBuy, onSell }: Props) {
  const active = sessionState === 'running' || sessionState === 'paused'
  const pnlColor = pnl > 0 ? '#26a641' : pnl < 0 ? '#f85149' : '#8b949e'

  const sideColor = position.side === 'LONG' ? '#26a641' : position.side === 'SHORT' ? '#f85149' : '#8b949e'

  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 200,
    }}>
      <div style={{ fontSize: 13, color: '#8b949e' }}>
        LTP&nbsp;
        <span style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>
          {currentPrice ? fmt(currentPrice) : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onBuy}
          disabled={!active}
          style={{
            flex: 1, background: active ? '#26a641' : '#21262d',
            color: active ? '#fff' : '#484f58', border: 'none', borderRadius: 6,
            padding: '10px 0', fontSize: 15, fontWeight: 700,
            cursor: active ? 'pointer' : 'not-allowed',
          }}
        >
          BUY
        </button>
        <button
          onClick={onSell}
          disabled={!active}
          style={{
            flex: 1, background: active ? '#f85149' : '#21262d',
            color: active ? '#fff' : '#484f58', border: 'none', borderRadius: 6,
            padding: '10px 0', fontSize: 15, fontWeight: 700,
            cursor: active ? 'pointer' : 'not-allowed',
          }}
        >
          SELL
        </button>
      </div>

      <div style={{ borderTop: '1px solid #30363d', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, color: '#8b949e' }}>
          Position&nbsp;
          <span style={{ fontWeight: 700, color: sideColor }}>
            {position.side === 'FLAT' ? 'FLAT' : `${position.side} ${position.quantity}`}
          </span>
        </div>
        {position.side !== 'FLAT' && (
          <div style={{ fontSize: 12, color: '#8b949e' }}>
            Avg entry: <span style={{ color: '#e6edf3' }}>{fmt(position.avg_entry_price)}</span>
          </div>
        )}
        <div style={{ fontSize: 13, color: '#8b949e' }}>
          P&L&nbsp;
          <span style={{ fontWeight: 700, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {pnl >= 0 ? '+' : ''}{fmt(pnl)}
          </span>
        </div>
      </div>
    </div>
  )
}
