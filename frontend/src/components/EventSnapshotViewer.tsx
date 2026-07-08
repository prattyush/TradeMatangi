import { useState, useEffect } from 'react'
import { EventSnapshot, SessionSummary } from '../services/api'

// This component opens as a full-screen modal to view event snapshots for a session.
// Left panel: event list   Right panel: snapshot chart detail

interface Props {
  session: SessionSummary
  snapshots: EventSnapshot[]
  onClose: () => void
  onDeleteAll: () => void
}

export default function EventSnapshotViewer({ session, snapshots, onClose, onDeleteAll }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const snap = snapshots[selectedIdx] ?? null

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${snapshots.length} event snapshots for ${session.date}?`)) return
    setDeleting(true)
    try {
      await onDeleteAll()
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Arrow key navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setSelectedIdx(i => Math.max(0, i - 1))
      if (e.key === 'ArrowDown') setSelectedIdx(i => Math.min(snapshots.length - 1, i + 1))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [snapshots.length])

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000)
    return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const eventIcon = (type: string) => {
    if (type === 'order_placed') return '🆕'
    if (type === 'order_edited') return '✏️'
    if (type === 'order_converted') return '🔄'
    return '📌'
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0d1117', display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', background: '#161b22',
        borderBottom: '1px solid #30363d', flexShrink: 0,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>
          Event Snapshots — {session.date} {session.symbol}
        </span>
        <span style={{ fontSize: 12, color: '#484f58' }}>
          {snapshots.length} event(s)
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={handleDeleteAll}
          disabled={deleting}
          title="Delete all snapshots for this session"
          style={{
            background: '#3d1010', border: '1px solid #8b1a1a',
            color: '#f85149', borderRadius: 6, padding: '4px 10px',
            fontSize: 12, cursor: 'pointer',
          }}
        >
          {deleting ? 'Deleting...' : '🗑 Delete All'}
        </button>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: '1px solid #30363d',
            color: '#8b949e', borderRadius: 6, padding: '4px 10px',
            fontSize: 12, cursor: 'pointer',
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left panel — Event list */}
        <div style={{
          width: 280, minWidth: 280,
          borderRight: '1px solid #21262d',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '8px 12px', background: '#0d1117',
            borderBottom: '1px solid #21262d',
            fontSize: 11, color: '#484f58', fontWeight: 600,
          }}>
            Events (↑↓ to navigate)
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {snapshots.map((s, i) => (
              <div
                key={s.event_id}
                onClick={() => setSelectedIdx(i)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  background: i === selectedIdx ? '#1f6feb22' : 'transparent',
                  borderLeft: i === selectedIdx ? '3px solid #1f6feb' : '3px solid transparent',
                  borderBottom: '1px solid #21262d',
                }}
              >
                <div style={{ fontSize: 11, color: '#484f58' }}>
                  {formatTime(s.timestamp)}
                </div>
                <div style={{ fontSize: 12, color: '#c9d1d9', marginTop: 2 }}>
                  {eventIcon(s.event.type)} {s.event.description}
                </div>
                <div style={{ fontSize: 11, color: '#8b949e', marginTop: 1 }}>
                  {s.event.type.replace('_', ' ')}
                  {s.snapshot.position.side !== 'FLAT' && (
                    <span style={{
                      marginLeft: 8,
                      color: s.snapshot.position.pnl >= 0 ? '#3fb950' : '#f85149',
                    }}>
                      P&L: {s.snapshot.position.pnl_pct > 0 ? '+' : ''}{s.snapshot.position.pnl_pct}%
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel — Snapshot Detail */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {snap ? (
            <SnapshotDetail snapshot={snap} />
          ) : (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#484f58', fontSize: 14,
            }}>
              No snapshot selected
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Snapshot Detail (right panel) ─────────────────────────────────────────

function SnapshotDetail({ snapshot }: { snapshot: EventSnapshot }) {
  const isOptions = snapshot.instrument_type === 'options'
  const snap = snapshot.snapshot
  const event = snapshot.event
  const timestamp = snapshot.timestamp

  const formatPnl = (pnl: number) => {
    return (pnl >= 0 ? '+' : '') + pnl.toFixed(2)
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* State summary bar */}
      <div style={{
        padding: '8px 16px', background: '#0d1117',
        borderBottom: '1px solid #21262d',
        display: 'flex', gap: 16, flexWrap: 'wrap',
        fontSize: 12, color: '#8b949e', flexShrink: 0,
      }}>
        <span>💰 <span style={{ color: '#e6edf3' }}>₹{snap.wallet_balance.toLocaleString('en-IN')}</span> / ₹{snap.session_capital.toLocaleString('en-IN')}</span>
        <span>📊 Used: <span style={{ color: '#e6edf3' }}>{snap.wallet_used_pct}%</span></span>
        <span>📉 Price: <span style={{ color: '#e6edf3' }}>{snap.current_price?.toFixed(2)}</span></span>
        {isOptions && (
          <>
            <span>CE: <span style={{ color: '#e6edf3' }}>{snap.current_price_ce?.toFixed(2)}</span></span>
            <span>PE: <span style={{ color: '#e6edf3' }}>{snap.current_price_pe?.toFixed(2)}</span></span>
          </>
        )}
      </div>

      {/* Position info */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #21262d',
        display: 'flex', gap: 20, flexWrap: 'wrap',
        fontSize: 12, flexShrink: 0,
      }}>
        {/* Equity / Underlying position */}
        <div style={{
          background: '#161b22', borderRadius: 6, padding: '8px 12px',
          border: '1px solid #21262d',
        }}>
          <div style={{ color: '#484f58', fontSize: 11 }}>Position {isOptions ? '(Underlying)' : ''}</div>
          <div style={{ color: '#e6edf3', fontWeight: 600 }}>
            {snap.position.side === 'FLAT' ? 'Flat' : `${snap.position.side} ${snap.position.quantity}`}
          </div>
          {snap.position.side !== 'FLAT' && (
            <>
              <div style={{ color: '#8b949e' }}>Avg: {snap.position.avg_entry_price.toFixed(2)}</div>
              <div style={{ color: snap.position.pnl >= 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                P&L: {formatPnl(snap.position.pnl)} ({snap.position.pnl_pct > 0 ? '+' : ''}{snap.position.pnl_pct}%)
              </div>
            </>
          )}
        </div>
        {/* CE position */}
        {isOptions && (
          <div style={{
            background: '#161b22', borderRadius: 6, padding: '8px 12px',
            border: '1px solid #21262d',
          }}>
            <div style={{ color: '#484f58', fontSize: 11 }}>CE {snap.strike_ce}</div>
            <div style={{ color: '#e6edf3', fontWeight: 600 }}>
              {snap.position_ce.side === 'FLAT' ? 'Flat' : `${snap.position_ce.side} ${snap.position_ce.quantity}`}
            </div>
            {snap.position_ce.side !== 'FLAT' && (
              <div style={{ color: snap.position_ce.pnl >= 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                P&L: {formatPnl(snap.position_ce.pnl)} ({snap.position_ce.pnl_pct > 0 ? '+' : ''}{snap.position_ce.pnl_pct}%)
              </div>
            )}
          </div>
        )}
        {/* PE position */}
        {isOptions && (
          <div style={{
            background: '#161b22', borderRadius: 6, padding: '8px 12px',
            border: '1px solid #21262d',
          }}>
            <div style={{ color: '#484f58', fontSize: 11 }}>PE {snap.strike_pe}</div>
            <div style={{ color: '#e6edf3', fontWeight: 600 }}>
              {snap.position_pe.side === 'FLAT' ? 'Flat' : `${snap.position_pe.side} ${snap.position_pe.quantity}`}
            </div>
            {snap.position_pe.side !== 'FLAT' && (
              <div style={{ color: snap.position_pe.pnl >= 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                P&L: {formatPnl(snap.position_pe.pnl)} ({snap.position_pe.pnl_pct > 0 ? '+' : ''}{snap.position_pe.pnl_pct}%)
              </div>
            )}
          </div>
        )}
      </div>

      {/* Open orders */}
      {snap.open_orders.length > 0 && (
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid #21262d',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: '#484f58', marginBottom: 4 }}>Open Orders</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {snap.open_orders.map(o => (
              <div key={o.order_id} style={{
                background: '#161b22', borderRadius: 4, padding: '4px 8px',
                border: '1px solid #21262d', fontSize: 11, color: '#c9d1d9',
              }}>
                {o.side} {o.order_type} {o.trigger_price || o.limit_price}
                {o.is_stoploss ? ' SL' : ''} Qty: {o.quantity}
                {o.right ? ` ${o.right}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chart area placeholder — shows bar info */}
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {snap.bar_ohlc ? (
          <div style={{
            padding: 24, background: '#161b22', borderRadius: 8,
            border: '1px solid #21262d', textAlign: 'center',
          }}>
            <div style={{ fontSize: 12, color: '#484f58', marginBottom: 8 }}>
              Bar at {formatBarTime(snap.bar_time)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 80px)', gap: 12 }}>
              <div><div style={{ color: '#484f58', fontSize: 10 }}>Open</div><div style={{ color: '#e6edf3', fontSize: 16, fontWeight: 600 }}>{snap.bar_ohlc.open.toFixed(2)}</div></div>
              <div><div style={{ color: '#484f58', fontSize: 10 }}>High</div><div style={{ color: '#3fb950', fontSize: 16, fontWeight: 600 }}>{snap.bar_ohlc.high.toFixed(2)}</div></div>
              <div><div style={{ color: '#484f58', fontSize: 10 }}>Low</div><div style={{ color: '#f85149', fontSize: 16, fontWeight: 600 }}>{snap.bar_ohlc.low.toFixed(2)}</div></div>
              <div><div style={{ color: '#484f58', fontSize: 10 }}>Close</div><div style={{ color: '#58a6ff', fontSize: 16, fontWeight: 600 }}>{snap.bar_ohlc.close.toFixed(2)}</div></div>
            </div>
            <div style={{ marginTop: 16, fontSize: 14, color: '#d29922', fontWeight: 600 }}>
              📍 {event.description}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#8b949e' }}>
              Event: {event.type.replace('_', ' ')} at {formatTimestamp(timestamp)}
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: '#484f58', fontStyle: 'italic' }}>
              Full chart rendering with OHLC + order overlay coming in Phase XIII.
              Current state data is shown above and can be used to analyze decision-making context.
            </div>
          </div>
        ) : (
          <div style={{ color: '#484f58', fontSize: 14 }}>
            No bar data available at snapshot time
          </div>
        )}
      </div>
    </div>
  )
}

function formatBarTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
