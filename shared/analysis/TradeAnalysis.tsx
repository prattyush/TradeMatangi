import type { AnalysisChartProps, OptionsChartProps, AnalysisChartPanelProps } from './chartProps'
import StoredOrders from './StoredOrders'
import { useAnalysisError } from './environment'
import { useAnalysisApi, useAnalysisEnvironment } from './environment'
import { useCallback, useEffect, useRef, useState } from 'react'

import { SessionSummary, SessionDetail, AnalysisTrade, EventSnapshot } from './api'
import EventSnapshotViewer from './EventSnapshotViewer'
import TradeLabeling from './TradeLabeling'
import StatsModal from './StatsModal'
import PatternVsTradeComparison from './PatternVsTradeComparison'

interface Props {
  onClose: () => void
  historicalDays?: number
}

const SYMBOLS = ['NIFTY', 'BSESEN', 'TATPOW', 'TATMOT', 'RELIND']
const INSTRUMENT_TYPES = [
  { value: '', label: 'All' },
  { value: 'equity', label: 'Equity' },
  { value: 'options', label: 'Options' },
]



// ── Session grouping ──────────────────────────────────────────────────────────

export interface SessionGroup {
  key: string
  date: string
  symbol: string
  instrument_type: string
  session_type: string
  sessions: SessionSummary[]
  totalPnl: number
  totalTrades: number
  totalCommission: number
  sessionCapital: number
}

export function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>()
  for (const s of sessions) {
    if (s.trade_count === 0 && s.session_type !== 'real') continue
    const key = `${s.user_id}|${s.date}|${s.symbol}|${s.instrument_type}|${s.session_type ?? ''}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        date: s.date,
        symbol: s.symbol,
        instrument_type: s.instrument_type,
        session_type: s.session_type ?? '',
        sessions: [],
        totalPnl: 0,
        totalTrades: 0,
        totalCommission: 0,
        sessionCapital: s.session_capital,
      })
    }
    const g = map.get(key)!
    g.sessions.push(s)
    g.totalPnl += s.net_pnl
    g.totalTrades += s.round_trip_count ?? s.trade_count
    g.totalCommission += s.total_commission
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date)
    return a.symbol.localeCompare(b.symbol)
  })
}

export function AnalysisChartPanel(props: AnalysisChartPanelProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.AnalysisChartPanel
  if (!Override) throw new Error('Analysis chart renderer AnalysisChartPanel is not configured')
  return <Override {...props} />
}

// ── Trade table ───────────────────────────────────────────────────────────────

function TradeTable({ trades }: { trades: AnalysisTrade[] }) {
  const { onSelectExecution } = useAnalysisEnvironment()
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: '#484f58', borderBottom: '1px solid #21262d' }}>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>Time</th>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>Side</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Qty</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Price</th>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>Right</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Strike</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Commission</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(t => {
            const time = new Date(t.timestamp * 1000).toLocaleTimeString('en-IN', {
              timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit',
            })
            const value = t.price * t.quantity
            return (
              <tr key={`${t.session_id}:${t.trade_id}`} tabIndex={onSelectExecution ? 0 : undefined} role={onSelectExecution ? 'button' : undefined} aria-label={onSelectExecution ? `Inspect ${t.side} execution at ${time}` : undefined} onClick={() => onSelectExecution?.(t)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectExecution?.(t) } }} style={{ cursor: onSelectExecution ? 'pointer' : undefined, borderBottom: '1px solid #1a1f27' }}>
                <td style={{ padding: '5px 8px', color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>{time}</td>
                <td style={{ padding: '5px 8px', fontWeight: 600, color: t.side === 'BUY' ? '#26a641' : '#f85149' }}>{t.side}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', color: '#e6edf3' }}>{t.quantity}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>{t.price.toFixed(2)}</td>
                <td style={{ padding: '5px 8px', color: '#8b949e' }}>{t.right ?? '—'}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', color: '#8b949e' }}>{t.strike ?? '—'}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>₹{t.commission.toFixed(2)}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>₹{value.toFixed(0)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Group card ────────────────────────────────────────────────────────────────

export function GroupCard({ group, historicalDays = 2, initiallyExpanded = false }: { group: SessionGroup; historicalDays?: number; initiallyExpanded?: boolean }) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()

  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<Map<string, SessionDetail>>(new Map())
  const [loading, setLoading] = useState(false)
  const [viewingSnapshots, setViewingSnapshots] = useState<{ session: SessionSummary; snapshots: EventSnapshot[]; sessionIds: string[] } | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'trades' | 'labels'>('trades')
  const [detailError, setDetailError] = useState('')
  const [hasPattern, setHasPattern] = useState(false)
  const [showComparison, setShowComparison] = useState(false)

  const handleExpand = async () => {
    if (expanded && environment.confirmDiscard?.() === false) return
    if (!expanded && details.size === 0) {
      setLoading(true)
      try {
        const fetched = await Promise.all(
          group.sessions.map(s => api.getSessionDetail(s.session_id))
        )
        const m = new Map<string, SessionDetail>()
        fetched.forEach(d => m.set(d.session_id, d))
        setDetails(m)
        api.patternGetChartByDate(group.symbol, group.date, group.instrument_type).then(c => setHasPattern(!!c)).catch(() => {})
      } catch (error) { setDetailError(String(error)) } finally {
        setLoading(false)
      }
    }
    setExpanded(!expanded)
  }

  useEffect(() => { if (initiallyExpanded) void handleExpand() }, [])

  const allTrades = group.sessions.flatMap(s => details.get(s.session_id)?.trades ?? [])
  const multiSession = group.sessions.length > 1

  const pnlColor = group.totalPnl > 0 ? '#26a641' : group.totalPnl < 0 ? '#f85149' : '#8b949e'
  const pnlSign = group.totalPnl >= 0 ? '+' : ''
  const pnlPct = group.sessionCapital > 0 ? (group.totalPnl / group.sessionCapital) * 100 : 0
  const typeLabel = group.instrument_type === 'options' ? 'Options' : 'Equity'
  const sessionTypeLabel = group.session_type === 'paper' ? 'Paper' : group.session_type === 'real' ? 'Real' : group.session_type === 'stepwise' ? 'Stepwise' : 'Sim'

  return (
    <div style={{
      background: '#161b22', border: '1px solid #21262d', borderRadius: 8,
      overflow: 'hidden', marginBottom: 10,
    }}>
      {/* Summary row */}
      <div
        onClick={handleExpand}
        style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '12px 16px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3' }}>{group.date}</div>
          <div style={{ fontSize: 11, color: '#484f58', marginTop: 2 }}>
            {sessionTypeLabel}{group.sessions[0]?.shared ? ` · Shared by ${group.sessions[0].owner_email ?? group.sessions[0].user_id}` : ''}{multiSession ? ` · ${group.sessions.length} sessions` : ''}
          </div>
        </div>

        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>{group.symbol}</div>
          <div style={{ fontSize: 11, color: '#484f58' }}>{typeLabel}</div>
        </div>

        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Capital</div>
          <div style={{ fontSize: 13, color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>
            ₹{group.sessionCapital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
        </div>

        <div style={{ minWidth: 110 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Net P&L</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {pnlSign}₹{Math.abs(group.totalPnl).toFixed(2)}
          </div>
        </div>

        <div style={{ minWidth: 70 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>P&L %</div>
          <div style={{ fontSize: 13, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {pnlSign}{pnlPct.toFixed(2)}%
          </div>
        </div>

        <div style={{ minWidth: 60 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Trades</div>
          <div style={{ fontSize: 13, color: '#e6edf3' }}>{group.totalTrades}</div>
        </div>

        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Commission</div>
          <div style={{ fontSize: 12, color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>
            ₹{group.totalCommission.toFixed(2)}
          </div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Snapshots button — queries all sessions in the group */}
          <button
            onClick={async (e) => {
              e.stopPropagation()
              setSnapshotLoading(true)
              try {
                // Aggregate snapshots from all sessions in this group
                const allSnapshots: EventSnapshot[] = []
                const sessionIds = [...new Set(group.sessions.flatMap(s => s.snapshot_session_ids?.length ? s.snapshot_session_ids : [s.session_id]))]
                const firstSession = group.sessions[0]
                for (const id of sessionIds) {
                  const snaps = await api.getSnapshots(id)
                  allSnapshots.push(...snaps)
                }
                if (firstSession) {
                  setViewingSnapshots({ session: firstSession, snapshots: allSnapshots, sessionIds })
                }
              } catch (error) { setDetailError(String(error)) }
              finally { setSnapshotLoading(false) }
            }}
            title="View event snapshots"
            style={{
              background: '#21262d', border: '1px solid #30363d',
              color: '#d29922', borderRadius: 6, padding: '3px 10px',
              fontSize: 11, cursor: 'pointer', fontWeight: 600,
            }}
          >
            {snapshotLoading ? '...' : '📸 Snapshots'}
          </button>
          {(hasPattern || environment.desktop) && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowComparison(true) }}
              title="Compare trades vs pattern annotations"
              style={{
                background: '#21262d', border: '1px solid #30363d',
                color: '#58a6ff', borderRadius: 6, padding: '3px 10px',
                fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}
            >
              📊 Compare
            </button>
          )}
          <span style={{ fontSize: 16, color: '#484f58' }}>
            {loading ? '⟳' : expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {/* Event snapshot viewer modal */}
      {viewingSnapshots && (
        <EventSnapshotViewer
          readOnly={group.sessions.some(s => s.shared)}
          session={viewingSnapshots.session}
          snapshots={viewingSnapshots.snapshots}
          onClose={() => setViewingSnapshots(null)}
          onDeleteAll={async () => {
            for (const sid of viewingSnapshots.sessionIds) {
              await api.deleteSnapshots(sid)
            }
            setViewingSnapshots(null)
          }}
        />
      )}

      {/* Pattern vs Trade comparison modal */}
      {showComparison && (
        <PatternVsTradeComparison
          symbol={group.symbol}
          date={group.date}
          instrumentType={group.instrument_type}
          sessionIds={group.sessions.map(s => s.session_id)}
          allTrades={allTrades}
          historicalDays={historicalDays}
          onClose={() => setShowComparison(false)}
        />
      )}

      {detailError && <div role="alert">{detailError}<button onClick={() => { setDetailError(''); setExpanded(false); void handleExpand() }}>Retry</button></div>}
      {/* Expanded detail */}
      {expanded && details.size > 0 && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #21262d' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, marginTop: 12, marginBottom: 12 }}>
            <button
              onClick={() => { if (environment.confirmDiscard?.() !== false) setActiveTab('trades') }}
              style={{
                padding: '6px 16px', border: 'none',
                borderBottom: activeTab === 'trades' ? '2px solid #58a6ff' : '2px solid transparent',
                background: activeTab === 'trades' ? '#1c2333' : 'transparent',
                color: activeTab === 'trades' ? '#58a6ff' : '#8b949e',
                cursor: 'pointer', fontSize: 13,
                fontWeight: activeTab === 'trades' ? 600 : 400,
                borderRadius: '4px 4px 0 0',
              }}
            >Trades</button>
            <button
              onClick={() => setActiveTab('labels')}
              style={{
                padding: '6px 16px', border: 'none',
                borderBottom: activeTab === 'labels' ? '2px solid #58a6ff' : '2px solid transparent',
                background: activeTab === 'labels' ? '#1c2333' : 'transparent',
                color: activeTab === 'labels' ? '#58a6ff' : '#8b949e',
                cursor: 'pointer', fontSize: 13,
                fontWeight: activeTab === 'labels' ? 600 : 400,
                borderRadius: '4px 4px 0 0',
              }}
            >Label Trades</button>
          </div>

          {activeTab === 'trades' ? (
            <>
              {group.sessions.map((s, idx) => {
                const d = details.get(s.session_id)
                if (!d) return null
                return (
                  <div key={s.session_id}>
                    {idx > 0 && (
                      <div style={{
                        margin: '14px 0 8px',
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <div style={{ flex: 1, borderTop: '1px dashed #30363d' }} />
                        <span style={{ fontSize: 11, color: '#484f58', whiteSpace: 'nowrap' }}>
                          Session {idx + 1} · {s.start_time?.slice(0, 5) ?? s.session_id.slice(0, 8)}
                        </span>
                        <div style={{ flex: 1, borderTop: '1px dashed #30363d' }} />
                      </div>
                    )}
                    {idx === 0 && multiSession && (
                      <div style={{ fontSize: 11, color: '#484f58', marginTop: 10, marginBottom: 4 }}>
                        Session 1 · {s.start_time?.slice(0, 5) ?? s.session_id.slice(0, 8)}
                      </div>
                    )}
                    <div style={{ marginTop: idx === 0 && !multiSession ? 12 : 4 }}>
                      {d.trades.length === 0 && <p>No executions yet.</p>}
                      <TradeTable trades={d.trades} />
                      {d.orders && <StoredOrders orders={d.orders} />}
                    </div>
                  </div>
                )
              })}

              <AnalysisChartPanel
                symbol={group.symbol}
                date={group.date}
                allTrades={allTrades}
                isOptions={group.instrument_type === 'options'}
                historicalDays={historicalDays}
              />
            </>
          ) : (
            <TradeLabeling
              readOnly={group.sessions.some(s => s.shared)}
              symbol={group.symbol}
              date={group.date}
              sessionIds={group.sessions.map(s => s.session_id)}
              allTrades={allTrades}
              historicalDays={historicalDays}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ── Main TradeAnalysis component ─────────────────────────────────────────────

export default function TradeAnalysis({ onClose, historicalDays = 2 }: Props) {
  const api = useAnalysisApi()

  const environment = useAnalysisEnvironment()
  const today = environment.desktop ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) : new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date(Date.parse(today + 'T00:00:00Z') - (environment.desktop ? 29 : 30) * 86400 * 1000).toISOString().slice(0, 10)

  const [symbol, setSymbol] = useState<string>('')
  const [instrumentType, setInstrumentType] = useState<string>('')
  const [sessionType, setSessionType] = useState<string>('')
  const [startDate, setStartDate] = useState<string>(thirtyDaysAgo)
  const [endDate, setEndDate] = useState<string>(today)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAnalysisError(error, 'TradeAnalysis')
  const [hasSearched, setHasSearched] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)

  const searchGeneration = useRef(0)
  const handleSearch = useCallback(async () => {
    const revision = ++searchGeneration.current
    setLoading(true)
    setError(null)
    setHasSearched(true)
    try {
      const data = await api.getAnalysisSessions({
        symbol: symbol || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        instrumentType: instrumentType || undefined,
        sessionType: sessionType || undefined,
      })
      if (revision !== searchGeneration.current) return
      setSessions(data)
    } catch (err: unknown) {
      if (revision !== searchGeneration.current || (err instanceof DOMException && err.name === 'AbortError')) return
      setError(err instanceof Error ? err.message : 'Failed to load analysis data')
      setSessions([])
    } finally {
      if (revision === searchGeneration.current) setLoading(false)
    }
  }, [api, symbol, instrumentType, sessionType, startDate, endDate])

  useEffect(() => { void handleSearch(); return () => { searchGeneration.current++ } }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = groupSessions(sessions)
  const totalPnl = groups.reduce((s, g) => s + g.totalPnl, 0)
  const totalTrades = groups.reduce((s, g) => s + g.totalTrades, 0)
  const winningGroups = groups.filter(g => g.totalPnl > 0).length

  const inputStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 6, padding: '5px 10px', fontSize: 13,
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', flexDirection: 'column',
      zIndex: 1000,
    }}>
      <div style={{
        flex: 1,
        background: '#0d1117',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Modal header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px', background: '#161b22',
          borderBottom: '1px solid #30363d',
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#58a6ff' }}>Trade Analysis</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 18 }}
          >✕</button>
        </div>

        {/* Filters */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '12px 20px', background: '#161b22',
          borderBottom: '1px solid #21262d',
        }}>
          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            Symbol:
            <select value={symbol} onChange={e => setSymbol(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            Type:
            <select value={instrumentType} onChange={e => setInstrumentType(e.target.value)} style={inputStyle}>
              {INSTRUMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            Session:
            <select value={sessionType} onChange={e => setSessionType(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              <option value="sim">Simulated</option>
              <option value="stepwise">Stepwise</option>
              <option value="paper">Paper</option>
              <option value="real">Real</option>
            </select>
          </label>

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            From:
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </label>

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            To:
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle} />
          </label>

          <button
            onClick={handleSearch}
            disabled={loading}
            style={{
              background: '#238636', border: 'none', color: '#fff',
              borderRadius: 6, padding: '5px 16px', fontSize: 13,
              cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 600,
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Loading…' : 'Search'}
          </button>

          <button
            onClick={() => setStatsOpen(true)}
            style={{
              background: '#21262d', border: '1px solid #30363d',
              color: '#d29922', borderRadius: 6,
              padding: '5px 16px', fontSize: 13,
              cursor: 'pointer', fontWeight: 600,
            }}
          >
            📊 Stats
          </button>

          {hasSearched && groups.length > 0 && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 20 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#484f58' }}>Days</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>{groups.length}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#484f58' }}>Win Rate</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>
                  {groups.length > 0 ? Math.round(winningGroups / groups.length * 100) : 0}%
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#484f58' }}>Total Trades</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>{totalTrades}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#484f58' }}>Total P&L</div>
                <div style={{
                  fontSize: 14, fontWeight: 700,
                  color: totalPnl > 0 ? '#26a641' : totalPnl < 0 ? '#f85149' : '#8b949e',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Group list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {error && !environment.reportError && (
            <div style={{
              padding: '10px 14px', background: '#3d1f1f',
              border: '1px solid #f85149', borderRadius: 6,
              color: '#f85149', fontSize: 13, marginBottom: 12,
            }}>
              {error}
            </div>
          )}

          {!loading && hasSearched && groups.length === 0 && !error && (
            <div style={{ color: '#484f58', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
              No sessions with trades found for the selected filters.
            </div>
          )}

          {groups.map(g => (
            <GroupCard key={g.key} group={g} historicalDays={historicalDays} />
          ))}
        </div>
      </div>

      {statsOpen && (
        <StatsModal
          onClose={() => setStatsOpen(false)}
          defaultSymbol={symbol}
          defaultStartDate={startDate}
          defaultEndDate={endDate}
          defaultInstrumentType={instrumentType}
          defaultSessionType={sessionType}
        />
      )}
    </div>
  )
}

export function AnalysisChart(props: AnalysisChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.AnalysisChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer AnalysisChart is not configured')
  return <Override {...props} />
}

export function OptionsChart(props: OptionsChartProps) {
  const environment = useAnalysisEnvironment()
  const Override = environment.charts?.OptionsChart
  if (environment.desktop && environment.active === false) return null
  if (!Override) throw new Error('Analysis chart renderer OptionsChart is not configured')
  return <Override {...props} />
}
