import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  SeriesMarker,
  Time,
} from 'lightweight-charts'
import api, { SessionSummary, SessionDetail, AnalysisTrade, OHLCCandle } from '../services/api'

interface Props {
  onClose: () => void
}

// Symbols list (mirrors SUPPORTED_SYMBOLS in config.py)
const SYMBOLS = ['NIFTY', 'BSESEN', 'TATPOW', 'TATMOT', 'RELIND']
const INSTRUMENT_TYPES = [
  { value: '', label: 'All' },
  { value: 'equity', label: 'Equity' },
  { value: 'options', label: 'Options' },
]

// Convert options trade direction to underlying chart marker direction:
// Buy CE / Sell PE → bullish → BUY marker
// Sell CE / Buy PE → bearish → SELL marker
function effectiveSideForChart(trade: AnalysisTrade): 'BUY' | 'SELL' {
  if (!trade.right) return trade.side  // equity
  if (trade.right === 'CE') return trade.side === 'BUY' ? 'BUY' : 'SELL'
  // PE: Buy PE = bearish view = SELL marker; Sell PE = bullish view = BUY marker
  return trade.side === 'BUY' ? 'SELL' : 'BUY'
}

// ── Mini Analysis Chart ───────────────────────────────────────────────────────

function AnalysisChart({ symbol, date, trades }: { symbol: string; date: string; trades: AnalysisTrade[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  // Init chart once — height is 45% of container width, min 300
  useEffect(() => {
    if (!containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = Math.max(300, Math.floor(w * 0.45))
    const chart = createChart(containerRef.current, {
      width: w,
      height: h,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 1 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width
      const height = Math.max(300, Math.floor(width * 0.45))
      chart.applyOptions({ width, height })
    })
    ro.observe(containerRef.current)

    return () => { ro.disconnect(); chart.remove() }
  }, []) // mount only

  // Load prior-2-days history AND full trading-day candles in parallel, then merge.
  // getHistorical returns only prior trading days (not the session date itself), so
  // trade markers would land on timestamps absent from the chart and pile up on the
  // last prior-day bar. getPreSession('15:30:00') fills in the full trading day.
  useEffect(() => {
    if (!seriesRef.current || !symbol || !date) return
    let cancelled = false
    ;(async () => {
      try {
        const toCandle = (c: OHLCCandle): CandlestickData => ({
          time: c.time as Time,
          open: c.open, high: c.high, low: c.low, close: c.close,
        })
        const [histResp, tradingDayCandles] = await Promise.all([
          api.getHistorical(symbol, date, 3),
          api.getPreSession(symbol, date, '15:30:00', 3),
        ])
        if (cancelled || !seriesRef.current) return

        const all = [
          ...histResp.candles.map(toCandle),
          ...tradingDayCandles.map(toCandle),
        ]
        // deduplicate by timestamp (Map overwrites earlier with later), then sort
        const byTime = new Map<number, CandlestickData>()
        all.forEach(c => byTime.set(c.time as number, c))
        const sorted = Array.from(byTime.values()).sort(
          (a, b) => (a.time as number) - (b.time as number)
        )
        if (sorted.length > 0) {
          seriesRef.current.setData(sorted)
          chartRef.current?.timeScale().fitContent()
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date])

  // Trade markers — options trades mapped to underlying chart direction
  useEffect(() => {
    if (!seriesRef.current) return
    if (trades.length === 0) { seriesRef.current.setMarkers([]); return }

    const intervalSecs = 3 * 60
    const markers: SeriesMarker<Time>[] = trades.map(t => {
      const side = effectiveSideForChart(t)
      const label = t.right
        ? `${t.right} ${t.side} ${t.quantity}@${t.price.toFixed(0)}`
        : `${t.side} ${t.quantity}@${t.price.toFixed(0)}`
      return {
        time: (Math.floor(t.timestamp / intervalSecs) * intervalSecs) as Time,
        position: side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: side === 'BUY' ? '#26a641' : '#f85149',
        shape: side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: label,
        size: 1,
      }
    })
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    try { seriesRef.current.setMarkers(markers) } catch { /* disposed */ }
  }, [trades])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', borderRadius: 6, overflow: 'hidden', marginTop: 8 }}
    />
  )
}

// ── Session card ─────────────────────────────────────────────────────────────

interface SessionCardProps {
  summary: SessionSummary
}

function SessionCard({ summary }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(false)

  const handleExpand = async () => {
    if (!expanded && !detail) {
      setLoading(true)
      try {
        const d = await api.getSessionDetail(summary.session_id)
        setDetail(d)
      } catch { /* ignore */ } finally {
        setLoading(false)
      }
    }
    setExpanded(v => !v)
  }

  const pnlColor = summary.net_pnl > 0 ? '#26a641' : summary.net_pnl < 0 ? '#f85149' : '#8b949e'
  const pnlSign = summary.net_pnl >= 0 ? '+' : ''
  const typeLabel = summary.instrument_type === 'options'
    ? `Options${summary.strike ? ` (${summary.strike})` : ''}`
    : 'Equity'

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
          padding: '12px 16px', cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3' }}>{summary.date}</div>
          <div style={{ fontSize: 11, color: '#484f58', marginTop: 2 }}>
            {summary.start_time?.slice(0, 5) ?? '—'}
          </div>
        </div>

        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>{summary.symbol}</div>
          <div style={{ fontSize: 11, color: '#484f58' }}>{typeLabel}</div>
        </div>

        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Capital</div>
          <div style={{ fontSize: 13, color: '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>
            ₹{summary.session_capital.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
        </div>

        <div style={{ minWidth: 110 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Net P&L</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {pnlSign}₹{Math.abs(summary.net_pnl).toFixed(2)}
          </div>
        </div>

        <div style={{ minWidth: 70 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>P&L %</div>
          <div style={{ fontSize: 13, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>
            {pnlSign}{summary.pnl_pct.toFixed(2)}%
          </div>
        </div>

        <div style={{ minWidth: 60 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Trades</div>
          <div style={{ fontSize: 13, color: '#e6edf3' }}>{summary.trade_count}</div>
        </div>

        <div style={{ minWidth: 80 }}>
          <div style={{ fontSize: 12, color: '#8b949e' }}>Commission</div>
          <div style={{ fontSize: 12, color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>
            ₹{summary.total_commission.toFixed(2)}
          </div>
        </div>

        <div style={{ marginLeft: 'auto', fontSize: 16, color: '#484f58' }}>
          {loading ? '⟳' : expanded ? '▲' : '▼'}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && detail && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #21262d' }}>
          {/* Trade table */}
          {detail.trades.length > 0 ? (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
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
                  {detail.trades.map(t => {
                    const time = new Date(t.timestamp * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    const value = t.price * t.quantity
                    return (
                      <tr key={t.trade_id} style={{ borderBottom: '1px solid #1a1f27' }}>
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
          ) : (
            <div style={{ padding: '12px 0', color: '#484f58', fontSize: 13 }}>No trades in this session.</div>
          )}

          {/* Chart with markers (underlying symbol) */}
          <AnalysisChart
            symbol={detail.symbol}
            date={detail.date}
            trades={detail.trades}
          />
        </div>
      )}
    </div>
  )
}

// ── Main TradeAnalysis component ─────────────────────────────────────────────

export default function TradeAnalysis({ onClose }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)

  const [symbol, setSymbol] = useState<string>('')
  const [instrumentType, setInstrumentType] = useState<string>('')
  const [startDate, setStartDate] = useState<string>(thirtyDaysAgo)
  const [endDate, setEndDate] = useState<string>(today)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)

  const handleSearch = useCallback(async () => {
    setLoading(true)
    setError(null)
    setHasSearched(true)
    try {
      const data = await api.getAnalysisSessions({
        symbol: symbol || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        instrumentType: instrumentType || undefined,
      })
      setSessions(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load analysis data')
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [symbol, instrumentType, startDate, endDate])

  // Auto-search on mount
  useEffect(() => { handleSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Summary metrics across shown sessions
  const totalPnl = sessions.reduce((s, x) => s + x.net_pnl, 0)
  const totalTrades = sessions.reduce((s, x) => s + x.trade_count, 0)
  const winningSessions = sessions.filter(x => x.net_pnl > 0).length

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

          {/* Aggregate stats */}
          {hasSearched && sessions.length > 0 && (
            <>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 20 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>Sessions</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>{sessions.length}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: '#484f58' }}>Win Rate</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>
                    {sessions.length > 0 ? Math.round(winningSessions / sessions.length * 100) : 0}%
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
            </>
          )}
        </div>

        {/* Session list */}
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

          {!loading && hasSearched && sessions.length === 0 && !error && (
            <div style={{ color: '#484f58', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
              No sessions found for the selected filters.
            </div>
          )}

          {sessions.map(s => (
            <SessionCard key={s.session_id} summary={s} />
          ))}
        </div>
      </div>
    </div>
  )
}
