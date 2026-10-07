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
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import type { OHLCCandle } from '../../../../shared/analysis/api'
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

export function WebsiteSnapshotChart({
  symbol, date, barTime, barOhlc, currentPrice, openOrders, position, filledTrades,
}: {
  symbol: string; date: string
  sessionId?: string
  observationResolution?: number
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  position: { side: string; quantity: number; avg_entry_price: number; pnl: number; pnl_pct: number } | null
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}) {
  const api = useAnalysisApi()

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

  // Load OHLC data — fetched once per symbol+date, not re-fetched on every event
  const baseDataRef = useRef<CandlestickData[]>([])
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
        const sorted = Array.from(byTime.values()).sort((a, b) => (a.time as number) - (b.time as number))
        baseDataRef.current = sorted
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
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date])

  // Per-event: replace the bar at the snapshot moment with in-progress OHLC
  // using series.update() so zoom/scroll is preserved across events
  useEffect(() => {
    const series = seriesRef.current
    if (!series || barTime <= 0 || !barOhlc || baseDataRef.current.length === 0) return
    try {
      series.update({
        time: barTime as Time,
        open: barOhlc.open,
        high: barOhlc.high,
        low: barOhlc.low,
        close: barOhlc.close,
      })
    } catch { /* ignore */ }
  }, [barTime, barOhlc])

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

export function WebsiteSnapshotOptionsChart({
  symbol, date, barTime, barOhlc, currentPrice, openOrders,
  strike, expiry, right, filledTrades,
}: {
  symbol: string; date: string
  sessionId?: string
  observationResolution?: number
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  position?: {side:string;quantity:number;avg_entry_price:number} | null
  strike: number; expiry: string; right: string
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}) {
  const api = useAnalysisApi()

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

