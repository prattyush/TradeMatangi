import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  IPriceLine,
  LineData,
  Time,
  LineStyle,
} from 'lightweight-charts'
import { EventSnapshot, SessionSummary, OHLCCandle } from '../services/api'
import api from '../services/api'

interface Props {
  session: SessionSummary
  snapshots: EventSnapshot[]
  onClose: () => void
  onDeleteAll: () => void
}

export default function EventSnapshotViewer({ session, snapshots, onClose, onDeleteAll }: Props) {
  // Sort by timestamp ascending for chronological event list
  const sorted = snapshots.length > 0 ? [...snapshots].sort((a, b) => a.timestamp - b.timestamp) : snapshots
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [deleting, setDeleting] = useState(false)
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
    try { await onDeleteAll() } finally { setDeleting(false) }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') setSelectedIdx(i => Math.max(0, i - 1))
      if (e.key === 'ArrowDown') setSelectedIdx(i => Math.min(filtered.length - 1, i + 1))
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
    <div style={{
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
        <button onClick={handleDeleteAll} disabled={deleting}
          style={{ background: '#3d1010', border: '1px solid #8b1a1a', color: '#f85149', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >{deleting ? 'Deleting...' : '🗑 Delete All'}</button>
        <button onClick={onClose}
          style={{ background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
        >✕ Close</button>
      </div>

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
              <div key={s.event_id} onClick={() => setSelectedIdx(i)}
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

// ── EMA helpers ──────────────────────────────────────────────────────────────

function nextEMA(prev: number, close: number, k: number): number { return close * k + prev * (1 - k) }

function computeEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return []
  const result: (number | null)[] = []
  const k = 2 / (period + 1)
  let ema: number | null = null
  let warmup = 0, sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]; warmup++
    if (warmup < period) result.push(null)
    else if (warmup === period) { ema = sum / period; result.push(ema) }
    else { ema = nextEMA(ema!, closes[i], k); result.push(ema) }
  }
  return result
}

// ── Trade marker style helper (matches Chart.tsx convention) ──────────────
function crossChartMarkerStyle(tradeRight: string, side: 'BUY' | 'SELL'): { color: string; text: string } {
  if (tradeRight === 'CE') {
    return side === 'BUY'
      ? { color: '#FFFFFF', text: 'CB' }
      : { color: '#00AAFF', text: 'CS' }
  }
  return side === 'BUY'
    ? { color: '#00AAFF', text: 'PS' }
    : { color: '#FFFFFF', text: 'PB' }
}

// ── Snapshot Chart ─────────────────────────────────────────────────────────

function SnapshotChart({
  symbol, date, barTime, barOhlc, currentPrice, openOrders, position, filledTrades,
}: {
  symbol: string; date: string
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  position: { side: string; quantity: number; avg_entry_price: number; pnl: number; pnl_pct: number } | null
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = Math.max(250, containerRef.current.clientHeight || 350)
    const chart = createChart(containerRef.current, {
      width: w, height: h,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 0 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149', borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })

    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      chart.applyOptions({ width: cw, height: Math.max(250, ch) })
    })
    ro.observe(containerRef.current)

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  // Load OHLC data
  useEffect(() => {
    if (!seriesRef.current || !symbol || !date) return
    let cancelled = false
    ;(async () => {
      try {
        const toCandle = (c: OHLCCandle): CandlestickData => ({
          time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
        })
        const [histResp, tradingDayCandles] = await Promise.all([
          api.getHistorical(symbol, date, 3, 2),
          api.getPreSession(symbol, date, '15:30:00', 3),
        ])
        if (cancelled || !seriesRef.current) return
        const all = [...histResp.candles.map(toCandle), ...tradingDayCandles.map(toCandle)]
        const byTime = new Map<number, CandlestickData>()
        all.forEach(c => byTime.set(c.time as number, c))
        let sorted = Array.from(byTime.values()).sort((a, b) => (a.time as number) - (b.time as number))

        // Replace the bar at the snapshot moment with the in-progress OHLC
        // the user actually saw. Keep all other bars (before and after) visible
        // so navigating through events progressively reveals the full session.
        if (barTime > 0 && sorted.length > 0 && barOhlc) {
          const idx = sorted.findIndex(c => (c.time as number) === barTime)
          if (idx >= 0) {
            sorted[idx] = {
              time: barTime as Time,
              open: barOhlc.open,
              high: barOhlc.high,
              low: barOhlc.low,
              close: barOhlc.close,
            }
          }
        }

        if (sorted.length > 0) {
          seriesRef.current.setData(sorted)

          const closes = sorted.map(c => c.close)
          const ema9Vals = computeEMA(closes, 9)
          const ema21Vals = computeEMA(closes, 21)
          const e9 = chartRef.current?.addLineSeries({
            color: '#f0883e', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
          })
          const e21 = chartRef.current?.addLineSeries({
            color: '#79c0ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
          })
          const e9d = sorted.map((c, i) => ({ time: c.time, value: ema9Vals[i] })).filter((d): d is LineData => d.value !== null)
          const e21d = sorted.map((c, i) => ({ time: c.time, value: ema21Vals[i] })).filter((d): d is LineData => d.value !== null)
          e9?.setData(e9d)
          e21?.setData(e21d)

          // Show enough bars for context: last ~90 min (30 bars at 3-min)
          const lastTime = sorted[sorted.length - 1].time as number
          const firstTime = Math.max(sorted[0].time as number, lastTime - 5400)
          try {
            chartRef.current?.timeScale().setVisibleRange({
              from: firstTime as Time,
              to: lastTime as Time,
            })
          } catch {
            chartRef.current?.timeScale().fitContent()
          }
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date, barTime, barOhlc])

  // Draw snapshot overlays — cleaned up when snapshot changes
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !barTime) return

    const overlaySeries: ISeriesApi<'Line'>[] = []
    const priceLines: IPriceLine[] = []

    // Vertical bar marker
    try {
      const vLine = chart.addLineSeries({
        lineVisible: false, crosshairMarkerVisible: false,
        lastValueVisible: false, priceLineVisible: false,
      })
      overlaySeries.push(vLine)
      const markerPrice = barOhlc?.high ?? currentPrice ?? 0
      vLine.setData([{ time: barTime as Time, value: markerPrice }])
      vLine.setMarkers([{
        time: barTime as Time,
        position: 'aboveBar' as const,
        color: '#d29922',
        shape: 'arrowDown' as const,
        text: '📍',
        size: 2,
      }])
      // Also draw a vertical dashed price line at the bar
      const pl = seriesRef.current?.createPriceLine({
        price: markerPrice,
        color: '#d29922',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      })
      if (pl) priceLines.push(pl)
    } catch { /* ignore */ }

    // Current price horizontal line
    if (currentPrice > 0) {
      try {
        const pl = seriesRef.current?.createPriceLine({
          price: currentPrice,
          color: '#388bfd',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'LTP',
        })
        if (pl) priceLines.push(pl)
      } catch { /* ignore */ }
    }

    // Open order lines
    for (const o of openOrders) {
      try {
        const price = o.order_type === 'LIMIT' ? o.limit_price : o.trigger_price
        if (!price || price <= 0) continue
        const label = `${o.side[0]}${o.order_type[0]}${o.is_stoploss ? ' SL' : ''}${o.right ? ' ' + o.right : ''}`
        const pl = seriesRef.current?.createPriceLine({
          price,
          color: o.is_stoploss ? '#f85149' : o.side === 'BUY' ? '#3fb950' : '#a371f7',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: label,
        })
        if (pl) priceLines.push(pl)
      } catch { /* ignore */ }
    }

    // Position entry marker
    if (position && position.side !== 'FLAT' && position.avg_entry_price > 0) {
      try {
        const posLine = chart.addLineSeries({
          lineVisible: false, crosshairMarkerVisible: false,
          lastValueVisible: false, priceLineVisible: false,
        })
        overlaySeries.push(posLine)
        posLine.setData([{ time: barTime as Time, value: position.avg_entry_price }])
        posLine.setMarkers([{
          time: barTime as Time,
          position: 'inBar' as const,
          color: position.side === 'LONG' ? '#FFFFFF' : '#00AAFF',
          shape: 'circle' as const,
          text: position.side === 'LONG' ? 'B' : 'S',
          size: 0.8,
        }])
        chipPositionPnlRef.current = position
      } catch { /* ignore */ }
    } else {
      chipPositionPnlRef.current = null
    }

    // Trade markers — B/S circles for filled trades up to this event time
    const intervalSecs = 3 * 60
    const paneTrades = (filledTrades ?? []).filter(t => !t.right || t.underlying_price !== undefined)
    for (const t of paneTrades) {
      try {
        const markerPrice = (t.right !== undefined && t.underlying_price !== undefined)
          ? t.underlying_price
          : t.price
        const slot = (Math.floor(t.timestamp / intervalSecs) * intervalSecs) as Time
        const tradeSeries = chart.addLineSeries({
          lineVisible: false, crosshairMarkerVisible: false,
          lastValueVisible: false, priceLineVisible: false,
        })
        overlaySeries.push(tradeSeries)
        tradeSeries.setData([{ time: slot, value: markerPrice }])

        let color: string
        let text: string
        if (t.right) {
          const style = crossChartMarkerStyle(t.right, t.side)
          color = style.color
          text = style.text
        } else {
          color = t.side === 'BUY' ? '#FFFFFF' : '#00AAFF'
          text = t.side === 'BUY' ? 'B' : 'S'
        }

        tradeSeries.setMarkers([{
          time: slot,
          position: 'inBar' as const,
          color,
          shape: 'circle' as const,
          text,
          size: 0.6,
        }])
      } catch { /* chart disposed mid-loop */ }
    }

    return () => {
      for (const s of overlaySeries) {
        try { chart.removeSeries(s) } catch { /* removed */ }
      }
      for (const pl of priceLines) {
        try { seriesRef.current?.removePriceLine(pl) } catch { /* removed */ }
      }
      setPnlCoord(null)
    }
  }, [barTime, barOhlc, currentPrice, openOrders, position, filledTrades])

  const chipPositionPnlRef = useRef<{ side: string; quantity: number; avg_entry_price: number; pnl: number; pnl_pct: number } | null>(null)
  const [pnlCoord, setPnlCoord] = useState<{ x: number; y: number } | null>(null)

  // Update P&L overlay position
  const updatePnlOverlay = useCallback(() => {
    const chart = chartRef.current
    const pos = chipPositionPnlRef.current
    if (!chart || !barTime || !pos || pos.side === 'FLAT') { setPnlCoord(null); return }
    const x = chart.timeScale().timeToCoordinate(barTime as Time)
    const y = chartRef.current ? seriesRef.current?.priceToCoordinate(barOhlc?.high ?? currentPrice) : null
    if (x != null && y != null) setPnlCoord({ x: x - 30, y: y - 14 })
  }, [barTime, barOhlc, currentPrice])

  useEffect(() => {
    updatePnlOverlay()
    const chart = chartRef.current
    if (!chart) return
    const handler = () => updatePnlOverlay()
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => { try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler as any) } catch {} }
  }, [updatePnlOverlay])

  const pos = chipPositionPnlRef.current
  const pnlColor = pos ? (pos.pnl >= 0 ? '#3fb950' : '#f85149') : '#8b949e'

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {pos && pos.side !== 'FLAT' && pnlCoord && (
        <div style={{
          position: 'absolute', left: Math.max(0, pnlCoord.x), top: Math.max(0, pnlCoord.y),
          transform: 'translateX(-50%)',
          background: 'rgba(13,17,23,0.9)', border: '1px solid #30363d',
          borderRadius: 4, padding: '2px 8px',
          fontSize: 11, fontWeight: 600, color: pnlColor,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 10,
        }}>
          {pos.pnl >= 0 ? '+' : ''}{pos.pnl.toFixed(2)} ({pos.pnl_pct > 0 ? '+' : ''}{pos.pnl_pct}%)
        </div>
      )}
    </div>
  )
}

// ── Options variant of SnapshotChart ─────────────────────────────────────────

function SnapshotOptionsChart({
  symbol, date, barTime, barOhlc, currentPrice, openOrders,
  strike, expiry, right, filledTrades,
}: {
  symbol: string; date: string
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  strike: number; expiry: string; right: string
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = Math.max(200, containerRef.current.clientHeight || 250)
    const chart = createChart(containerRef.current, {
      width: w, height: h,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 0 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149', borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    chartRef.current = chart; seriesRef.current = series

    const ro = new ResizeObserver(entries => {
      const { width: cw, height: ch } = entries[0].contentRect
      chart.applyOptions({ width: cw, height: Math.max(200, ch) })
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || !symbol || !date || !strike || !expiry || !right) return
    let cancelled = false
    ;(async () => {
      try {
        const toCandle = (c: OHLCCandle): CandlestickData => ({
          time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
        })
        const histResp = await api.getOptionsHistorical(symbol, date, strike, expiry, right, 3, 2)
        if (cancelled || !seriesRef.current) return
        const byTime = new Map<number, CandlestickData>()
        histResp.candles.map(toCandle).forEach(c => byTime.set(c.time as number, c))
        let sorted = Array.from(byTime.values()).sort((a, b) => (a.time as number) - (b.time as number))

        // Replace the bar at the snapshot moment with the in-progress OHLC
        // the user actually saw. Keep all other bars visible.
        if (barTime > 0 && sorted.length > 0 && barOhlc) {
          const idx = sorted.findIndex(c => (c.time as number) === barTime)
          if (idx >= 0) {
            sorted[idx] = {
              time: barTime as Time,
              open: barOhlc.open,
              high: barOhlc.high,
              low: barOhlc.low,
              close: barOhlc.close,
            }
          }
        }

        if (sorted.length > 0) {
          seriesRef.current.setData(sorted)

          const lastTime = sorted[sorted.length - 1].time as number
          const firstTime = Math.max(sorted[0].time as number, lastTime - 5400)
          try {
            chartRef.current?.timeScale().setVisibleRange({
              from: firstTime as Time,
              to: lastTime as Time,
            })
          } catch {
            chartRef.current?.timeScale().fitContent()
          }
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date, strike, expiry, right])

  // Snapshot overlays — cleaned up when snapshot changes
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !barTime) return

    const overlaySeries: ISeriesApi<'Line'>[] = []
    const priceLines: IPriceLine[] = []

    try { // bar marker
      const vLine = chart.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false })
      overlaySeries.push(vLine)
      const mp = barOhlc?.high ?? currentPrice ?? 0
      vLine.setData([{ time: barTime as Time, value: mp }])
      vLine.setMarkers([{ time: barTime as Time, position: 'aboveBar' as const, color: '#d29922', shape: 'arrowDown' as const, text: '📍', size: 2 }])
    } catch {}

    if (currentPrice > 0) {
      try {
        const pl = seriesRef.current?.createPriceLine({ price: currentPrice, color: '#388bfd', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'LTP' })
        if (pl) priceLines.push(pl)
      } catch {}
    }

    // Only show orders matching this chart's right
    const paneOrders = openOrders.filter(o => !o.right || o.right === right)
    for (const o of paneOrders) {
      try {
        const price = o.order_type === 'LIMIT' ? o.limit_price : o.trigger_price
        if (!price || price <= 0) continue
        const pl = seriesRef.current?.createPriceLine({
          price, color: o.is_stoploss ? '#f85149' : o.side === 'BUY' ? '#3fb950' : '#a371f7',
          lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
          title: `${o.side[0]}${o.order_type[0]}${o.is_stoploss ? 'SL' : ''}`,
        })
        if (pl) priceLines.push(pl)
      } catch {}
    }

    // Trade markers — B/S circles for filled trades matching this pane's right+strike
    const intervalSecs = 3 * 60
    const paneTrades = (filledTrades ?? []).filter(t => t.right === right && t.strike === strike)
    for (const t of paneTrades) {
      try {
        const slot = (Math.floor(t.timestamp / intervalSecs) * intervalSecs) as Time
        const tradeSeries = chart.addLineSeries({
          lineVisible: false, crosshairMarkerVisible: false,
          lastValueVisible: false, priceLineVisible: false,
        })
        overlaySeries.push(tradeSeries)
        tradeSeries.setData([{ time: slot, value: t.price }])
        tradeSeries.setMarkers([{
          time: slot,
          position: 'inBar' as const,
          color: t.side === 'BUY' ? '#FFFFFF' : '#00AAFF',
          shape: 'circle' as const,
          text: t.side === 'BUY' ? 'B' : 'S',
          size: 0.6,
        }])
      } catch { /* disposed */ }
    }

    return () => {
      for (const s of overlaySeries) {
        try { chart.removeSeries(s) } catch { /* removed */ }
      }
      for (const pl of priceLines) {
        try { seriesRef.current?.removePriceLine(pl) } catch { /* removed */ }
      }
    }
  }, [barTime, barOhlc, currentPrice, openOrders, right, filledTrades])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

// ── Snapshot Detail (right panel) ─────────────────────────────────────────

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
                    symbol={snapshot.symbol} date={snapshot.date}
                    barTime={snap.bar_time} barOhlc={snap.bar_ohlc}
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
                    symbol={snapshot.symbol} date={snapshot.date}
                    barTime={snap.bar_time} barOhlc={null}
                    currentPrice={snap.current_price_ce}
                    openOrders={snap.open_orders.filter(o => !o.right || o.right === 'CE')}
                    strike={snap.strike_ce} expiry={snap.expiry} right="CE"
                    filledTrades={snap.filled_trades || []}
                  />
                </div>
              )}
              {optionTab === 'PE' && snap.strike_pe && snap.expiry && (
                <div style={{ flex: 1 }}>
                  <SnapshotOptionsChart
                    symbol={snapshot.symbol} date={snapshot.date}
                    barTime={snap.bar_time} barOhlc={null}
                    currentPrice={snap.current_price_pe}
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
              symbol={snapshot.symbol} date={snapshot.date}
              barTime={snap.bar_time} barOhlc={snap.bar_ohlc}
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
