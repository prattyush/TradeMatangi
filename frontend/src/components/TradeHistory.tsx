import { useState } from 'react'
import { Trade } from '../services/api'

interface Props {
  trades: Trade[]
}

function fmt(n: number) {
  return n.toFixed(2)
}

function toDate(ts: number) {
  // Timestamps encode IST wall-clock as fake-UTC (see IST-as-UTC constraint).
  // Extract the UTC time string to get the correct chart time.
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour12: false })
}

export default function TradeHistory({ trades }: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
        overflow: 'hidden', minWidth: 320,
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid #30363d',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Trade History ({trades.length})</span>
          {trades.length > 0 && (
            <button
              onClick={() => setExpanded(true)}
              title="Expand trade history"
              style={{
                background: 'none', border: 'none', color: '#8b949e',
                cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
              }}
            >
              ⛶
            </button>
          )}
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

      {/* Expanded modal */}
      {expanded && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setExpanded(false) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
            padding: 24, maxWidth: '90vw', maxHeight: '80vh',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3' }}>
                Trade History ({trades.length})
              </span>
              <button
                onClick={() => setExpanded(false)}
                style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 16 }}
              >✕</button>
            </div>
            <div style={{ overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                <thead>
                  <tr style={{ color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                    {['Time (IST)', 'Symbol', 'Side', 'Qty', 'Price', 'Right', 'Strike', 'Trade ID'].map(h => (
                      <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...trades].reverse().map(t => (
                    <tr key={t.trade_id} style={{ borderBottom: '1px solid #21262d' }}>
                      <td style={{ padding: '7px 14px', color: '#8b949e' }}>{toDate(t.timestamp)}</td>
                      <td style={{ padding: '7px 14px', color: '#e6edf3' }}>{t.symbol}</td>
                      <td style={{ padding: '7px 14px', fontWeight: 600, color: t.side === 'BUY' ? '#26a641' : '#f85149' }}>
                        {t.side}
                      </td>
                      <td style={{ padding: '7px 14px' }}>{t.quantity}</td>
                      <td style={{ padding: '7px 14px', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.price)}</td>
                      <td style={{ padding: '7px 14px', color: '#8b949e' }}>{t.right ?? '—'}</td>
                      <td style={{ padding: '7px 14px', color: '#8b949e' }}>{t.strike ?? '—'}</td>
                      <td style={{ padding: '7px 14px', color: '#484f58', fontSize: 10 }}>
                        {t.trade_id.slice(0, 8)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
