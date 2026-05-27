import { Position } from '../services/api'
import { SessionState } from '../hooks/useSimulation'

interface Props {
  sessionState: SessionState
  currentPrice: number
  position: Position
  pnl: number           // unrealized position P&L
  sessionPnl?: number   // realized + unrealized - commission for the full session
  // Options mode extras
  activeRight?: 'CE' | 'PE' | null   // null = equity pane active (no quick-trade)
  activeLabel?: string               // e.g. "NIFTY CE 24000"
  // P&L display mode
  pnlPctMode?: boolean
  sessionCapital?: number
}

function fmt(n: number) { return n.toFixed(2) }

export default function TradePanel({
  sessionState, currentPrice, position, pnl, sessionPnl,
  activeRight = null, activeLabel, pnlPctMode, sessionCapital,
}: Props) {
  const pnlColor = pnl > 0 ? '#26a641' : pnl < 0 ? '#f85149' : '#8b949e'
  const sessionPnlColor = (sessionPnl ?? 0) > 0 ? '#26a641' : (sessionPnl ?? 0) < 0 ? '#f85149' : '#8b949e'

  const fmtPnl = (val: number) => {
    if (pnlPctMode && sessionCapital && sessionCapital > 0) {
      const pct = (val / sessionCapital) * 100
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    }
    return `${val >= 0 ? '+' : ''}${fmt(val)}`
  }
  const sideColor = position.side === 'LONG' ? '#26a641' : position.side === 'SHORT' ? '#f85149' : '#8b949e'
  const active = sessionState === 'running' || sessionState === 'paused'

  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 200,
    }}>
      {activeLabel && (
        <div style={{ fontSize: 11, color: '#58a6ff', marginBottom: -4 }}>{activeLabel}</div>
      )}

      <div style={{ fontSize: 13, color: '#8b949e' }}>
        LTP&nbsp;
        <span style={{ fontSize: 20, fontWeight: 700, color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>
          {currentPrice ? fmt(currentPrice) : '—'}
        </span>
      </div>

      {activeRight === null && active && (
        <div style={{ fontSize: 12, color: '#484f58', textAlign: 'center', padding: '4px 0' }}>
          Select a CE/PE pane to trade
        </div>
      )}

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
          Pos P&L&nbsp;
          <span style={{ fontWeight: 700, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {fmtPnl(pnl)}
          </span>
        </div>
        {active && sessionPnl !== undefined && (
          <div style={{ fontSize: 13, color: '#8b949e' }}>
            Session P&L&nbsp;
            <span style={{ fontWeight: 700, color: sessionPnlColor, fontVariantNumeric: 'tabular-nums' }}>
              {fmtPnl(sessionPnl)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
