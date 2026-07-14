import { useCallback, useEffect, useState } from 'react'
import api, { AnalysisStats } from '../services/api'

interface StatsModalProps {
  onClose: () => void
  defaultSymbol: string
  defaultStartDate: string
  defaultEndDate: string
  defaultInstrumentType: string
  defaultSessionType: string
}

const SYMBOLS = ['NIFTY', 'BSESEN', 'TATPOW', 'TATMOT', 'RELIND']

export default function StatsModal({
  onClose, defaultSymbol, defaultStartDate, defaultEndDate,
  defaultInstrumentType, defaultSessionType,
}: StatsModalProps) {
  const [symbol, setSymbol] = useState(defaultSymbol)
  const [instrumentType, setInstrumentType] = useState(defaultInstrumentType)
  const [sessionType, setSessionType] = useState(defaultSessionType)
  const [startDate, setStartDate] = useState(defaultStartDate)
  const [endDate, setEndDate] = useState(defaultEndDate)
  const [stats, setStats] = useState<AnalysisStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getAnalysisStats({
        symbol: symbol || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        instrument_type: instrumentType || undefined,
        session_type: sessionType || undefined,
      })
      setStats(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [symbol, instrumentType, sessionType, startDate, endDate])

  useEffect(() => { fetchStats() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const inputStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 6, padding: '5px 10px', fontSize: 13,
  }

  const cardStyle: React.CSSProperties = {
    background: '#161b22', border: '1px solid #21262d',
    borderRadius: 8, padding: 16,
  }

  const sectionTitle: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: '#8b949e',
    marginBottom: 12, textTransform: 'uppercase' as const, letterSpacing: 1,
  }

  const tableHeaderStyle: React.CSSProperties = {
    fontSize: 11, color: '#484f58', fontWeight: 600,
    paddingBottom: 6, borderBottom: '1px solid #21262d',
  }

  const tableCellStyle: React.CSSProperties = {
    fontSize: 13, color: '#e6edf3', padding: '4px 0',
    fontVariantNumeric: 'tabular-nums' as const,
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', flexDirection: 'column',
      zIndex: 2000,
    }}>
      <div style={{
        flex: 1, background: '#0d1117',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px', background: '#161b22',
          borderBottom: '1px solid #30363d',
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#58a6ff' }}>Stats</span>

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
              <option value="">All</option>
              <option value="equity">Equity</option>
              <option value="options">Options</option>
            </select>
          </label>

          <label style={{ fontSize: 12, color: '#484f58', display: 'flex', alignItems: 'center', gap: 6 }}>
            Session:
            <select value={sessionType} onChange={e => setSessionType(e.target.value)} style={inputStyle}>
              <option value="">All</option>
              <option value="sim">Simulated</option>
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
            onClick={fetchStats}
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

          <div style={{ flex: 1 }} />

          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 18 }}
          >✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {error && (
            <div style={{
              padding: '10px 14px', background: '#3d1f1f',
              border: '1px solid #f85149', borderRadius: 6,
              color: '#f85149', fontSize: 13, marginBottom: 12,
            }}>
              {error}
            </div>
          )}

          {loading && !stats && (
            <div style={{ color: '#484f58', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
              Loading stats...
            </div>
          )}

          {!loading && stats && stats.total_trades === 0 && (
            <div style={{ color: '#484f58', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
              No labeled trades found. Label your trades in the Analysis view first.
            </div>
          )}

          {stats && stats.total_trades > 0 && (
            <>
              {/* Core metrics */}
              <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
                <div style={cardStyle}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>Total Trades</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', marginTop: 4 }}>
                    {stats.total_trades}
                  </div>
                </div>
                <div style={cardStyle}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>Win %</div>
                  <div style={{
                    fontSize: 22, fontWeight: 700,
                    color: stats.win_pct >= 50 ? '#26a641' : '#f85149',
                    marginTop: 4,
                  }}>
                    {stats.win_pct}%
                  </div>
                </div>
                <div style={cardStyle}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>Avg PnL%</div>
                  <div style={{
                    fontSize: 22, fontWeight: 700,
                    color: stats.avg_pnl_pct > 0 ? '#26a641' : stats.avg_pnl_pct < 0 ? '#f85149' : '#8b949e',
                    marginTop: 4,
                  }}>
                    {stats.avg_pnl_pct > 0 ? '+' : ''}{stats.avg_pnl_pct.toFixed(2)}%
                  </div>
                </div>
                <div style={cardStyle}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>P95 PnL%</div>
                  <div style={{
                    fontSize: 22, fontWeight: 700,
                    color: stats.pnl_95th_percentile > 0 ? '#26a641' : stats.pnl_95th_percentile < 0 ? '#f85149' : '#8b949e',
                    marginTop: 4,
                  }}>
                    {stats.pnl_95th_percentile > 0 ? '+' : ''}{stats.pnl_95th_percentile.toFixed(2)}%
                  </div>
                </div>
              </div>

              {/* Per Expected Pattern */}
              <div style={{ ...cardStyle, marginBottom: 16 }}>
                <div style={sectionTitle}>By Expected Pattern</div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr 1fr', gap: 0 }}>
                  <div style={tableHeaderStyle}>Category</div>
                  <div style={tableHeaderStyle}>Strategy</div>
                  <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>Trades</div>
                  <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>Win%</div>
                  <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>Avg PnL%</div>
                  {stats.per_pattern.map((p, i) => (
                    <>
                      <div key={`cat-${i}`} style={{ ...tableCellStyle, borderTop: '1px solid #21262d' }}>{p.category || '—'}</div>
                      <div key={`strat-${i}`} style={{ ...tableCellStyle, borderTop: '1px solid #21262d' }}>{p.strategy || '—'}</div>
                      <div key={`cnt-${i}`} style={{ ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d' }}>{p.count}</div>
                      <div key={`wr-${i}`} style={{
                        ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d',
                        color: p.win_pct >= 50 ? '#26a641' : '#f85149',
                      }}>{p.win_pct}%</div>
                      <div key={`avg-${i}`} style={{
                        ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d',
                        color: p.avg_pnl_pct > 0 ? '#26a641' : p.avg_pnl_pct < 0 ? '#f85149' : '#8b949e',
                      }}>{p.avg_pnl_pct > 0 ? '+' : ''}{p.avg_pnl_pct.toFixed(2)}%</div>
                    </>
                  ))}
                </div>
              </div>

              {/* Mismatch */}
              <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
                <div style={{ ...cardStyle, flex: 1 }}>
                  <div style={sectionTitle}>Mismatch</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#d29922' }}>
                    {stats.mismatch.mismatch_pct}%
                  </div>
                  <div style={{ fontSize: 12, color: '#8b949e', marginTop: 8 }}>
                    Profit when matched: <span style={{ color: '#26a641', fontWeight: 600 }}>{stats.mismatch.profit_pct_matched}%</span>
                    {' | '}
                    Profit when mismatched: <span style={{ color: '#f85149', fontWeight: 600 }}>{stats.mismatch.profit_pct_mismatched}%</span>
                  </div>
                </div>
                {stats.mismatch.most_mismatched_expected && (
                  <div style={{ ...cardStyle, flex: 1 }}>
                    <div style={sectionTitle}>Most Mismatched Expected</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>
                      {stats.mismatch.most_mismatched_expected.category} / {stats.mismatch.most_mismatched_expected.strategy}
                    </div>
                    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                      {stats.mismatch.most_mismatched_expected.count} mismatches
                    </div>
                  </div>
                )}
                {stats.mismatch.most_mismatched_actual && (
                  <div style={{ ...cardStyle, flex: 1 }}>
                    <div style={sectionTitle}>Most Mismatched Actual</div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>
                      {stats.mismatch.most_mismatched_actual.category} / {stats.mismatch.most_mismatched_actual.strategy}
                    </div>
                    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }}>
                      {stats.mismatch.most_mismatched_actual.count} mismatches
                    </div>
                  </div>
                )}
              </div>

              {/* By tags */}
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ ...cardStyle, flex: 1 }}>
                  <div style={sectionTitle}>By Entry Tag</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 0 }}>
                    <div style={tableHeaderStyle}>Tag</div>
                    <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>N</div>
                    <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>Avg PnL%</div>
                    {stats.by_entry_tag.map((t, i) => (
                      <>
                        <div key={`et-t-${i}`} style={{ ...tableCellStyle, borderTop: '1px solid #21262d' }}>{t.tag}</div>
                        <div key={`et-n-${i}`} style={{ ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d' }}>{t.count}</div>
                        <div key={`et-a-${i}`} style={{
                          ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d',
                          color: t.avg_pnl_pct > 0 ? '#26a641' : t.avg_pnl_pct < 0 ? '#f85149' : '#8b949e',
                        }}>{t.avg_pnl_pct > 0 ? '+' : ''}{t.avg_pnl_pct.toFixed(2)}%</div>
                      </>
                    ))}
                  </div>
                </div>
                <div style={{ ...cardStyle, flex: 1 }}>
                  <div style={sectionTitle}>By Exit Tag</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 0 }}>
                    <div style={tableHeaderStyle}>Tag</div>
                    <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>N</div>
                    <div style={{ ...tableHeaderStyle, textAlign: 'right' }}>Avg PnL%</div>
                    {stats.by_exit_tag.map((t, i) => (
                      <>
                        <div key={`xt-t-${i}`} style={{ ...tableCellStyle, borderTop: '1px solid #21262d' }}>{t.tag}</div>
                        <div key={`xt-n-${i}`} style={{ ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d' }}>{t.count}</div>
                        <div key={`xt-a-${i}`} style={{
                          ...tableCellStyle, textAlign: 'right', borderTop: '1px solid #21262d',
                          color: t.avg_pnl_pct > 0 ? '#26a641' : t.avg_pnl_pct < 0 ? '#f85149' : '#8b949e',
                        }}>{t.avg_pnl_pct > 0 ? '+' : ''}{t.avg_pnl_pct.toFixed(2)}%</div>
                      </>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
