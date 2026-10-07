import type { SnapshotChartProps, SnapshotOptionsChartProps } from './chartProps'
import { useState, useEffect } from 'react'

import { EventSnapshot, SessionSummary } from './api'
import { useAnalysisEnvironment } from './environment'

interface Props {
  readOnly?: boolean
  session: SessionSummary
  snapshots: EventSnapshot[]
  onClose: () => void
  onDeleteAll: () => void
}

export default function EventSnapshotViewer({ readOnly=false, session, snapshots, onClose, onDeleteAll }: Props) {
  // Sort by timestamp ascending for chronological event list
  const sorted = snapshots.length > 0 ? [...snapshots].sort((a, b) => a.timestamp - b.timestamp) : snapshots
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [deleteError,setDeleteError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Filter sorted snapshots by search query (case-insensitive, * = wildcard)
  const filtered = !searchQuery.trim()
    ? sorted
    : sorted.filter(s => {
        const target = `${s.event.description} ${s.event.type}`.toLowerCase()
        const q = searchQuery.trim().toLowerCase()
        const regexStr = q
          .split('*')
          .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')
        try { return new RegExp(regexStr).test(target) }
        catch { return target.includes(q) }
      })

  // Reset selection when filter changes
  useEffect(() => { setSelectedIdx(0) }, [searchQuery])

  const snap = filtered[selectedIdx] ?? null

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${snapshots.length} event snapshots for ${session.date}?`)) return
    setDeleting(true)
    setDeleteError('')
    try { await onDeleteAll() } catch (error) { setDeleteError(String(error)) } finally { setDeleting(false) }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return
      if (e.key === 'ArrowUp') setSelectedIdx(i => Math.max(0, i - 1))
      if (e.key === 'ArrowDown') setSelectedIdx(i => Math.max(0,Math.min(filtered.length - 1, i + 1)))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered.length])

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000)
    return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })
  }

  const eventIcon = (type: string) => {
    if (type === 'order_placed') return '🆕'
    if (type === 'order_edited') return '✏️'
    if (type === 'order_converted') return '🔄'
    if (type === 'order_filled') return '✅'
    return '📌'
  }

  return (
    <div className="analysis-snapshot-viewer" role="dialog" aria-label="Event snapshots" style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0d1117', display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', background: '#161b22',
        borderBottom: '1px solid #30363d', flexShrink: 0,
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>
          Event Snapshots — {session.date} {session.symbol}
        </span>
        <span style={{ fontSize: 12, color: '#484f58' }}>{snapshots.length} event(s)</span>
        <div style={{ flex: 1 }} />
        <button hidden={readOnly} onClick={handleDeleteAll} disabled={deleting}
          style={{ background: '#3d1010', border: '1px solid #8b1a1a', color: '#f85149', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >{deleting ? 'Deleting...' : '🗑 Delete All'}</button>
        <button onClick={onClose}
          style={{ background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >✕ Close</button>
      </div>

      {deleteError && <p role="alert">Snapshots were not fully deleted: {deleteError} Retry Delete All when available.</p>}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 280, minWidth: 280, borderRight: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', background: '#0d1117', borderBottom: '1px solid #21262d', fontSize: 11, color: '#484f58', fontWeight: 600 }}>
            Events (↑↓ to navigate)
          </div>
          <div style={{
            padding: '6px 12px', borderBottom: '1px solid #21262d',
            background: '#0d1117',
          }}>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search... (* = wildcard)"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#161b22', border: '1px solid #30363d',
                borderRadius: 4, padding: '4px 8px',
                fontSize: 11, color: '#c9d1d9',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 11, color: '#484f58', textAlign: 'center' }}>
                {searchQuery.trim() ? 'No matching events' : 'No snapshots yet'}
              </div>
            ) : (
              filtered.map((s, i) => (
              <div key={`${s.session_id}:${s.event_id}`} role="button" tabIndex={0} aria-pressed={selectedIdx===i} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelectedIdx(i)}}} onClick={() => setSelectedIdx(i)}
                style={{
                  padding: '8px 12px', cursor: 'pointer',
                  background: i === selectedIdx ? '#1f6feb22' : 'transparent',
                  borderLeft: i === selectedIdx ? '3px solid #1f6feb' : '3px solid transparent',
                  borderBottom: '1px solid #21262d',
                }}>
                <div style={{ fontSize: 11, color: '#484f58' }}>{formatTime(s.timestamp)}</div>
                <div style={{ fontSize: 12, color: '#c9d1d9', marginTop: 2 }}>{eventIcon(s.event.type)} {s.event.description}</div>
                <div style={{ fontSize: 11, color: '#8b949e', marginTop: 1 }}>
                  {s.event.type.replace('_', ' ')}
                  {s.snapshot.session_pnl_pct != null ? (
                    <span style={{ marginLeft: 8, color: s.snapshot.session_pnl >= 0 ? '#3fb950' : '#f85149' }}>
                      S: {(s.snapshot.session_pnl_pct ?? 0) >= 0 ? '+' : ''}{s.snapshot.session_pnl_pct?.toFixed(1)}%
                    </span>
                  ) : s.snapshot.position.side !== 'FLAT' && (
                    <span style={{ marginLeft: 8, color: s.snapshot.position.pnl >= 0 ? '#3fb950' : '#f85149' }}>
                      P: {s.snapshot.position.pnl_pct > 0 ? '+' : ''}{s.snapshot.position.pnl_pct}%
                    </span>
                  )}
                </div>
              </div>
              )))}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {snap ? <SnapshotDetail snapshot={snap} /> : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58', fontSize: 14 }}>
              No snapshot selected
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SnapshotDetail({ snapshot }: { snapshot: EventSnapshot }) {
  const isOptions = snapshot.instrument_type === 'options'
  const snap = snapshot.snapshot
  const event = snapshot.event
  const timestamp = snapshot.timestamp
  const [optionTab, setOptionTab] = useState<'underlying' | 'CE' | 'PE'>('underlying')

  // Use new combined_pnl fields or fall back to computed values
  const combinedPnl = snap.combined_pnl ?? (snap.wallet_balance - snap.session_capital)
  const combinedPnlPct = snap.combined_pnl_pct ?? (snap.session_capital > 0 ? (combinedPnl / snap.session_capital) * 100 : 0)
  const pnlColor = combinedPnl >= 0 ? '#3fb950' : '#f85149'
  // Fallback: compute active positions from snap data
  const activePosCount = [
    snap.position.side !== 'FLAT' ? 1 : 0,
    isOptions && snap.position_ce.side !== 'FLAT' ? 1 : 0,
    isOptions && snap.position_pe.side !== 'FLAT' ? 1 : 0,
  ].reduce((a, b) => a + b, 0)
  const activePos = snap.active_positions ?? activePosCount

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Summary bar */}
      <div style={{
        padding: '6px 16px', background: '#0d1117', borderBottom: '1px solid #21262d',
        display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: '#8b949e', flexShrink: 0,
      }}>
        <span>💰 Wallet: <span style={{ color: '#e6edf3' }}>₹{snap.wallet_balance.toLocaleString('en-IN')}</span> / ₹{snap.session_capital.toLocaleString('en-IN')}</span>
        <span>📊 Used: <span style={{ color: '#e6edf3' }}>{snap.wallet_used_pct}%</span></span>
        <span>📈 P&L: <span style={{ color: pnlColor, fontWeight: 600 }}>
          {combinedPnl >= 0 ? '+' : ''}₹{Math.abs(combinedPnl).toFixed(2)} ({combinedPnlPct >= 0 ? '+' : ''}{combinedPnlPct.toFixed(2)}%)
        </span></span>
        {snap.session_pnl != null && (
          <span>💼 Sess: <span style={{ color: snap.session_pnl >= 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
            {snap.session_pnl >= 0 ? '+' : ''}₹{Math.abs(snap.session_pnl).toFixed(2)} ({(snap.session_pnl_pct ?? 0) >= 0 ? '+' : ''}{(snap.session_pnl_pct ?? 0).toFixed(2)}%)
          </span></span>
        )}
        {activePos > 0 && (
          <span>🎯 {activePos} position{activePos > 1 ? 's' : ''}</span>
        )}
        <span>📋 {snap.open_orders.length} order{snap.open_orders.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Open orders strip with event description */}
      <div style={{ padding: '6px 16px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: '#d29922', fontWeight: 600, marginBottom: 4 }}>
          📍 {event.description} — {formatTimestamp(timestamp)} ({formatBarTime(snap.bar_time)})
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: '#484f58' }}>Open orders:</span>
          {snap.open_orders.length === 0 && <span style={{ fontSize: 10, color: '#484f58' }}>none</span>}
          {snap.open_orders.map(o => (
            <span key={o.order_id} style={{
              background: o.is_stoploss ? '#3d1010' : '#161b22', borderRadius: 4, padding: '2px 8px',
              border: `1px solid ${o.is_stoploss ? '#8b1a1a' : '#21262d'}`, fontSize: 10, color: '#c9d1d9',
            }}>
              {o.side} {o.order_type}{o.is_stoploss ? ' SL' : ''} @{o.trigger_price || o.limit_price} · {snap.quantity_mode === 'funds_ratio' && (event.details as any)?._fundsRatioPct != null ? `${((event.details as any)._fundsRatioPct * 100)}%` : `Qty:${o.quantity}`}{snap.quantity_mode !== 'funds_ratio' ? `Qty:${o.quantity}` : ``}{o.right ? ` ${o.right}` : ''}
            </span>
          ))}
        </div>
      </div>

      {/* Charts area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 8, gap: 8 }}>
        {isOptions ? (
          <>
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {(['underlying', 'CE', 'PE'] as const).map(tab => (
                <button key={tab} onClick={() => setOptionTab(tab)}
                  style={{
                    padding: '4px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    background: optionTab === tab ? '#1f6feb' : '#21262d',
                    border: optionTab === tab ? '1px solid #388bfd' : '1px solid #30363d',
                    color: optionTab === tab ? '#fff' : '#8b949e',
                  }}
                >{tab === 'underlying' ? `Underlying` : tab + (tab === 'CE' ? (snap.strike_ce ? ` ${snap.strike_ce}` : '') : (snap.strike_pe ? ` ${snap.strike_pe}` : ''))}</button>
              ))}
            </div>

            {/* Chart panes */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', gap: 0 }}>
              {optionTab === 'underlying' && (
                <div style={{ flex: 1 }}>
                  <SnapshotChart
                    sessionId={snapshot.session_id} symbol={snapshot.symbol} date={snapshot.date}
                    observationResolution={snap.bar_observation_resolution_seconds ?? undefined} barTime={snap.bar_time} barOhlc={snap.bar_ohlc}
                    currentPrice={snap.current_price}
                    openOrders={snap.open_orders}
                    position={snap.position}
                    filledTrades={snap.filled_trades || []}
                  />
                </div>
              )}
              {optionTab === 'CE' && snap.strike_ce && snap.expiry && (
                <div style={{ flex: 1 }}>
                  <SnapshotOptionsChart
                    sessionId={snapshot.session_id} symbol={snapshot.symbol} date={snapshot.date}
                    observationResolution={snap.option_observation_ce?.resolution_seconds ?? undefined} barTime={snap.option_observation_ce?.time ?? snap.bar_time} barOhlc={snap.option_observation_ce?.ohlc ?? null}
                    currentPrice={snap.current_price_ce}
                    position={snap.position_ce}
                    openOrders={snap.open_orders.filter(o => !o.right || o.right === 'CE')}
                    strike={snap.strike_ce} expiry={snap.expiry} right="CE"
                    filledTrades={snap.filled_trades || []}
                  />
                </div>
              )}
              {optionTab === 'PE' && snap.strike_pe && snap.expiry && (
                <div style={{ flex: 1 }}>
                  <SnapshotOptionsChart
                    sessionId={snapshot.session_id} symbol={snapshot.symbol} date={snapshot.date}
                    observationResolution={snap.option_observation_pe?.resolution_seconds ?? undefined} barTime={snap.option_observation_pe?.time ?? snap.bar_time} barOhlc={snap.option_observation_pe?.ohlc ?? null}
                    currentPrice={snap.current_price_pe}
                    position={snap.position_pe}
                    openOrders={snap.open_orders.filter(o => !o.right || o.right === 'PE')}
                    strike={snap.strike_pe} expiry={snap.expiry} right="PE"
                    filledTrades={snap.filled_trades || []}
                  />
                </div>
              )}
              {optionTab === 'CE' && (!snap.strike_ce || !snap.expiry) && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58' }}>No CE strike/expiry data</div>
              )}
              {optionTab === 'PE' && (!snap.strike_pe || !snap.expiry) && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58' }}>No PE strike/expiry data</div>
              )}
            </div>
          </>
        ) : (
          /* Equity: single chart */
          <div style={{ flex: 1 }}>
            <SnapshotChart
              sessionId={snapshot.session_id} symbol={snapshot.symbol} date={snapshot.date}
              observationResolution={snap.bar_observation_resolution_seconds ?? undefined} barTime={snap.bar_time} barOhlc={snap.bar_ohlc}
              currentPrice={snap.current_price}
              openOrders={snap.open_orders}
              position={snap.position}
              filledTrades={snap.filled_trades || []}
            />
          </div>
        )}

        {/* Position cards */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', flexShrink: 0, paddingTop: 4 }}>
          {renderPositionCard(snap.position, isOptions ? 'Underlying' : 'Position', snap.current_price)}
          {isOptions && snap.strike_ce && renderPositionCard(snap.position_ce, `CE ${snap.strike_ce}`, snap.current_price_ce)}
          {isOptions && snap.strike_pe && renderPositionCard(snap.position_pe, `PE ${snap.strike_pe}`, snap.current_price_pe)}
        </div>
      </div>
    </div>
  )
}

function renderPositionCard(pos: { side: string; quantity: number; avg_entry_price: number; pnl: number; pnl_pct: number }, label: string, ltp: number) {
  const formatPnl = (pnl: number) => (pnl >= 0 ? '+' : '') + pnl.toFixed(2)
  return (
    <div key={label} style={{ background: '#161b22', borderRadius: 6, padding: '6px 12px', border: '1px solid #21262d', fontSize: 12 }}>
      <span style={{ color: '#484f58', fontSize: 11 }}>{label}: </span>
      <span style={{ color: '#e6edf3', fontWeight: 600 }}>
        {pos.side === 'FLAT' ? 'Flat' : `${pos.side} ${pos.quantity} @${pos.avg_entry_price.toFixed(2)}`}
      </span>
      {(pos.side !== 'FLAT' && ltp > 0) && (
        <span style={{ marginLeft: 8, fontSize: 11, color: '#8b949e' }}>
          LTP: {ltp.toFixed(2)}
          <span style={{ marginLeft: 6, color: pos.pnl >= 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
            P&L: {formatPnl(pos.pnl)} ({pos.pnl_pct > 0 ? '+' : ''}{pos.pnl_pct}%)
          </span>
        </span>
      )}
    </div>
  )
}

function formatBarTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })
}

export function SnapshotChart(props: SnapshotChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.SnapshotChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer SnapshotChart is not configured')
  return <Override {...props} />
}

export function SnapshotOptionsChart(props: SnapshotOptionsChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.SnapshotOptionsChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer SnapshotOptionsChart is not configured')
  return <Override {...props} />
}
