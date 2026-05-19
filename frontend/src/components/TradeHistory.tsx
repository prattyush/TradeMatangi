import { useState } from 'react'
import { Trade } from '../services/api'

interface Props {
  trades: Trade[]
  historicalTrades?: Trade[]
  sessionType?: string
  onRefresh?: () => Promise<void>
}

function fmt(n: number) {
  return n.toFixed(2)
}

function toDate(ts: number) {
  // Timestamps encode IST wall-clock as fake-UTC (see IST-as-UTC constraint).
  // Extract the UTC time string to get the correct chart time.
  return new Date(ts * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour12: false })
}

const SEPARATOR_STYLE: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 10,
  color: '#484f58',
  textAlign: 'center',
  borderBottom: '1px solid #21262d',
  letterSpacing: '0.05em',
}

const SEPARATOR_STYLE_EXPANDED: React.CSSProperties = {
  padding: '5px 14px',
  fontSize: 10,
  color: '#484f58',
  textAlign: 'center',
  borderBottom: '1px solid #21262d',
  letterSpacing: '0.05em',
}

export default function TradeHistory({ trades, historicalTrades = [], sessionType, onRefresh }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const totalCount = trades.length + historicalTrades.length
  const hasAny = totalCount > 0

  // Compact view: most-recent-first current session, then separator, then historical most-recent-first
  const currentReversed = [...trades].reverse()
  const histReversed = [...historicalTrades].reverse()

  return (
    <>
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
        overflow: 'hidden', minWidth: 320,
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid #30363d',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Trade History ({totalCount})</span>
          {sessionType === 'real' && onRefresh && (
            <button
              onClick={async () => {
                setRefreshing(true)
                try { await onRefresh() } finally { setRefreshing(false) }
              }}
              disabled={refreshing}
              title="Refresh from Kotak"
              style={{
                background: 'none', border: 'none', color: refreshing ? '#484f58' : '#8b949e',
                cursor: refreshing ? 'default' : 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
                marginLeft: 'auto',
              }}
            >
              {refreshing ? '…' : '🔄'}
            </button>
          )}
          {hasAny && (
            <button
              onClick={() => setExpanded(true)}
              title="Expand trade history"
              style={{
                background: 'none', border: 'none', color: '#8b949e',
                cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
                marginLeft: sessionType === 'real' ? undefined : 'auto',
              }}
            >
              ⛶
            </button>
          )}
        </div>
        {!hasAny ? (
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
                {currentReversed.map(t => (
                  <tr key={t.trade_id} style={{ borderBottom: '1px solid #21262d' }}>
                    <td style={{ padding: '6px 10px', color: '#8b949e' }}>{toDate(t.timestamp)}</td>
                    <td style={{ padding: '6px 10px', fontWeight: 600, color: t.side === 'BUY' ? '#26a641' : '#f85149' }}>
                      {t.side}
                    </td>
                    <td style={{ padding: '6px 10px' }}>{t.quantity}</td>
                    <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.price)}</td>
                  </tr>
                ))}
                {histReversed.length > 0 && (
                  <>
                    <tr><td colSpan={4} style={SEPARATOR_STYLE}>── Previous sessions ──</td></tr>
                    {histReversed.map(t => (
                      <tr key={t.trade_id} style={{ borderBottom: '1px solid #21262d', opacity: 0.55 }}>
                        <td style={{ padding: '6px 10px', color: '#8b949e' }}>{toDate(t.timestamp)}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600, color: t.side === 'BUY' ? '#26a641' : '#f85149' }}>
                          {t.side}
                        </td>
                        <td style={{ padding: '6px 10px' }}>{t.quantity}</td>
                        <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.price)}</td>
                      </tr>
                    ))}
                  </>
                )}
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
                Trade History ({totalCount})
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
                  {currentReversed.map(t => (
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
                  {histReversed.length > 0 && (
                    <>
                      <tr><td colSpan={8} style={SEPARATOR_STYLE_EXPANDED}>── Previous sessions ──</td></tr>
                      {histReversed.map(t => (
                        <tr key={t.trade_id} style={{ borderBottom: '1px solid #21262d', opacity: 0.55 }}>
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
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
