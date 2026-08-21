import { Position } from '../services/api'
import { SessionState, PendingExitRt, ActiveEntryStrategy } from '../hooks/useSimulation'
import PendingLabelPanel from './PendingLabelPanel'

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
  fundsRatioMode?: boolean
  // In-session trade labeling
  sessionId?: string | null
  pendingExitLabels?: PendingExitRt[]
  openLegs?: { right: string | null; rtIndex: number; label: string }[]
  savedEntryRtKeys?: string[]
  activeEntryStrategies?: Record<string, ActiveEntryStrategy>
  onSaveEntry?: (
    rtIndex: number,
    right: string | null,
    fields: { expected_category: string; expected_strategy: string; entry_tag: string },
  ) => Promise<void> | void
  onSaveExit?: (
    rtIndex: number,
    right: string | null,
    fields: { actual_category: string; actual_strategy: string; exit_tag: string },
  ) => Promise<void> | void
}

function fmt(n: number) { return n.toFixed(2) }

export default function TradePanel({
  sessionState, currentPrice, position, pnl, sessionPnl,
  activeRight = null, activeLabel, pnlPctMode, sessionCapital, fundsRatioMode,
  sessionId,
  pendingExitLabels = [],
  openLegs = [],
  savedEntryRtKeys = [],
  activeEntryStrategies = {},
  onSaveEntry,
  onSaveExit,
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

  const showLabels = active && sessionId && onSaveEntry && onSaveExit

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

      {Object.keys(activeEntryStrategies).length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          background: '#1c2333', borderRadius: 4, padding: '5px 8px',
        }}>
          {Object.entries(activeEntryStrategies).map(([key, entry]) => (
            <div key={key} style={{ fontSize: 11, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}>
              {entry.right && (
                <span style={{
                  fontSize: 9, fontWeight: 700, color: entry.right === 'CE' ? '#26a641' : '#f85149',
                  background: entry.right === 'CE' ? '#1a2f1a' : '#2d1518',
                  borderRadius: 3, padding: '1px 4px',
                }}>
                  {entry.right}
                </span>
              )}
              <span style={{ color: '#58a6ff', fontWeight: 600 }}>{entry.strategy}</span>
              {entry.category && (
                <span style={{ color: '#484f58' }}>/ {entry.category}</span>
              )}
            </div>
          ))}
        </div>
      )}

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
          <div style={{ fontSize: 12, color: '#8b949e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Avg entry: <span style={{ color: '#e6edf3' }}>{fmt(position.avg_entry_price)}</span></span>
            {!fundsRatioMode && (
              <span>Qty: <span style={{ color: '#e6edf3' }}>{position.quantity}</span>
              </span>
            )}
            {fundsRatioMode && (
              <span>
                <span style={{ color: '#e6edf3' }}>
                  {sessionCapital && sessionCapital > 0
                    ? ((position.quantity * position.avg_entry_price / sessionCapital) * 100).toFixed(1)
                    : '—'}
                </span>
                <span style={{ color: '#484f58' }}>% wallet</span>
              </span>
            )}
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

      {showLabels && (
        <PendingLabelPanel
          sessionId={sessionId!}
          pendingExitLabels={pendingExitLabels}
          openLegs={openLegs}
          savedEntryRtKeys={savedEntryRtKeys}
          onSaveEntry={onSaveEntry!}
          onSaveExit={onSaveExit!}
        />
      )}
    </div>
  )
}