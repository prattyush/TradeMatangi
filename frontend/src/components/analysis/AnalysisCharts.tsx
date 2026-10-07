import { useState, useEffect, useRef, useMemo } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  LineData,
  Time,
} from 'lightweight-charts'
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import type { AnalysisTrade, OHLCCandle } from '../../../../shared/analysis/api'
function effectiveSideForChart(trade: AnalysisTrade): 'BUY' | 'SELL' {
  if (!trade.right) return trade.side
  if (trade.right === 'CE') return trade.side === 'BUY' ? 'BUY' : 'SELL'
  return trade.side === 'BUY' ? 'SELL' : 'BUY'
}
// ── EMA helpers (mirrored from Chart.tsx) ────────────────────────────────────

function nextEMA(prev: number, close: number, k: number): number {
  return close * k + prev * (1 - k)
}

function computeEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return []
  const result: (number | null)[] = []
  const k = 2 / (period + 1)
  let ema: number | null = null
  let warmup = 0
  let sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]
    warmup++
    if (warmup < period) {
      result.push(null)
    } else if (warmup === period) {
      ema = sum / period
      result.push(ema)
    } else {
      ema = nextEMA(ema!, closes[i], k)
      result.push(ema)
    }
  }
  return result
}

// ── Chart toolbar ─────────────────────────────────────────────────────────────

function ChartToolbar({ title, isMaximized = false, onMaximize }: {
  title: string
  isMaximized?: boolean
  onMaximize?: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '3px 8px', background: '#161b22',
      borderBottom: '1px solid #21262d',
    }}>
      <span style={{ fontSize: 11, color: '#8b949e', fontWeight: 600 }}>{title}</span>
      {onMaximize && (
        <button
          onClick={onMaximize}
          title={isMaximized ? 'Restore' : 'Maximize'}
          style={{
            background: 'none', border: 'none', color: '#484f58',
            cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1,
          }}
        >
          {isMaximized ? '⤡' : '⤢'}
        </button>
      )}
    </div>
  )
}

// ── Underlying Chart ──────────────────────────────────────────────────────────

export function WebsiteAnalysisChart({
  symbol, date, trades, historicalDays = 2, title = 'Underlying',
  isMaximized = false, onMaximize,
  getMarkerText,
}: {
  symbol: string
  date: string
  trades: AnalysisTrade[]
  historicalDays?: number
  title?: string
  isMaximized?: boolean
  onMaximize?: () => void
  getMarkerText?: (trade: AnalysisTrade) => string
}) {
  const api = useAnalysisApi()

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const tradeMarkerPoolRef = useRef<ISeriesApi<'Line'>[]>([])
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])
  const [markerFilter, setMarkerFilter] = useState<'all' | 'CE' | 'PE'>('all')

  useEffect(() => {
    if (!containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = isMaximized ? (containerRef.current.clientHeight || 500) : Math.max(300, Math.floor(w * 0.6))
    const chart = createChart(containerRef.current, {
      width: w,
      height: h,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 0 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    const ema9 = chart.addLineSeries({
      color: '#f0883e', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    const ema21 = chart.addLineSeries({
      color: '#79c0ff', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    const markerSeries = chart.addLineSeries({
      lineVisible: false, crosshairMarkerVisible: false,
      lastValueVisible: false, priceLineVisible: false,
    })

    chartRef.current = chart
    seriesRef.current = series
    ema9Ref.current = ema9
    ema21Ref.current = ema21
    tradeMarkerPoolRef.current = [markerSeries]

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      const newHeight = isMaximized ? height : Math.max(300, Math.floor(width * 0.6))
      chart.applyOptions({ width, height: newHeight })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      for (const s of tradeMarkerPoolRef.current) {
        try { chart.removeSeries(s) } catch { /* disposed */ }
      }
      tradeMarkerPoolRef.current = []
      ema9Ref.current = null
      ema21Ref.current = null
      chart.remove()
    }
  }, [isMaximized])

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
          api.getHistorical(symbol, date, 3, historicalDays),
          api.getPreSession(symbol, date, '15:30:00', 3),
        ])
        if (cancelled || !seriesRef.current) return

        const all = [
          ...histResp.candles.map(toCandle),
          ...tradingDayCandles.map(toCandle),
        ]
        const byTime = new Map<number, CandlestickData>()
        all.forEach(c => byTime.set(c.time as number, c))
        const sorted = Array.from(byTime.values()).sort(
          (a, b) => (a.time as number) - (b.time as number)
        )
        if (sorted.length > 0) {
          seriesRef.current.setData(sorted)

          const closes = sorted.map(c => c.close)
          const ema9Vals = computeEMA(closes, 9)
          const ema21Vals = computeEMA(closes, 21)
          const ema9Data = sorted
            .map((c, i) => ({ time: c.time, value: ema9Vals[i] }))
            .filter((d): d is LineData => d.value !== null)
          const ema21Data = sorted
            .map((c, i) => ({ time: c.time, value: ema21Vals[i] }))
            .filter((d): d is LineData => d.value !== null)
          ema9Ref.current?.setData(ema9Data)
          ema21Ref.current?.setData(ema21Data)

          setCandles(sorted)
          chartRef.current?.timeScale().fitContent()
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date, historicalDays])

  const hasOptions = trades.some(t => t.right)

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    for (const s of tradeMarkerPoolRef.current) {
      try { chart.removeSeries(s) } catch { /* disposed */ }
    }
    tradeMarkerPoolRef.current = []

    const displayTrades = markerFilter === 'all'
      ? trades
      : trades.filter(t => !t.right || t.right === markerFilter)

    if (displayTrades.length === 0) {
      return
    }

    const intervalSecs = 3 * 60

    for (const t of displayTrades) {
      const slot = Math.floor(t.timestamp / intervalSecs) * intervalSecs
      const effectiveSide = effectiveSideForChart(t)
      const defaultText = t.right
        ? `${t.right} ${t.side === 'BUY' ? 'B' : 'S'}`
        : (t.side === 'BUY' ? 'B' : 'S')
      const text = getMarkerText ? getMarkerText(t) : defaultText
      
      let markerPrice: number | undefined
      if (t.right) {
        // Options trade mirrored on underlying
        markerPrice = t.underlying_price ?? candles.find(c => (c.time as number) === slot)?.close
      } else {
        // Equity trade
        markerPrice = t.price
      }

      if (markerPrice === undefined) continue
      const position = 'inBar'

      try {
        const markerSeries = chart.addLineSeries({
          lineVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        markerSeries.setData([{ time: slot as Time, value: markerPrice }])
        markerSeries.setMarkers([{
          time: slot as Time,
          position,
          color: effectiveSide === 'BUY' ? '#FFFFFF' : '#00AAFF',
          shape: 'circle' as const,
          text,
          size: 0.6,
        }])
        tradeMarkerPoolRef.current.push(markerSeries)
      } catch { /* disposed */ }
    }
  }, [trades, candles, markerFilter])

  return (
    <div style={{
      width: '100%',
      height: isMaximized ? '100%' : 'auto',
      display: 'flex',
      flexDirection: 'column',
      borderRadius: 6,
      overflow: 'hidden'
    }}>
      <ChartToolbar title={title} isMaximized={isMaximized} onMaximize={onMaximize} />
      {hasOptions && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 8px', background: '#161b22', flexShrink: 0 }}>
          {(['all', 'CE', 'PE'] as const).map(f => (
            <button
              key={f}
              onClick={() => setMarkerFilter(f)}
              style={{
                padding: '2px 10px',
                borderRadius: 4,
                border: `1px solid ${markerFilter === f ? '#388bfd' : '#30363d'}`,
                background: markerFilter === f ? '#1f3a6e' : 'transparent',
                color: markerFilter === f ? '#79c0ff' : '#8b949e',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: markerFilter === f ? 600 : 400,
              }}
            >
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', flex: 1 }} />
    </div>
  )
}

// ── Options Chart ─────────────────────────────────────────────────────────────

export function WebsiteOptionsChart({
  symbol, date, strike, expiry, right, trades, historicalDays = 2,
  isMaximized = false, onMaximize,
}: {
  symbol: string
  date: string
  strike: number
  expiry: string
  right: string
  trades: AnalysisTrade[]
  historicalDays?: number
  isMaximized?: boolean
  onMaximize?: () => void
}) {
  const api = useAnalysisApi()

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const tradeMarkerPoolRef = useRef<ISeriesApi<'Line'>[]>([])
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const w = containerRef.current.clientWidth
    const h = isMaximized ? (containerRef.current.clientHeight || 500) : Math.max(300, Math.floor(w * 0.6))
    const chart = createChart(containerRef.current, {
      width: w,
      height: h,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      crosshair: { mode: 0 },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    const ema9 = chart.addLineSeries({
      color: '#f0883e', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    const ema21 = chart.addLineSeries({
      color: '#79c0ff', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
    })
    const markerSeries = chart.addLineSeries({
      lineVisible: false, crosshairMarkerVisible: false,
      lastValueVisible: false, priceLineVisible: false,
    })

    chartRef.current = chart
    seriesRef.current = series
    ema9Ref.current = ema9
    ema21Ref.current = ema21
    tradeMarkerPoolRef.current = [markerSeries]

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      const newHeight = isMaximized ? height : Math.max(300, Math.floor(width * 0.6))
      chart.applyOptions({ width, height: newHeight })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      for (const s of tradeMarkerPoolRef.current) {
        try { chart.removeSeries(s) } catch { /* disposed */ }
      }
      tradeMarkerPoolRef.current = []
      ema9Ref.current = null
      ema21Ref.current = null
      chart.remove()
    }
  }, [isMaximized])

  useEffect(() => {
    if (!seriesRef.current || !symbol || !date || !strike || !expiry || !right) return
    let cancelled = false
    ;(async () => {
      try {
        const toCandle = (c: OHLCCandle): CandlestickData => ({
          time: c.time as Time,
          open: c.open, high: c.high, low: c.low, close: c.close,
        })
        const histResp = await api.getOptionsHistorical(symbol, date, strike, expiry, right, 3, historicalDays)
        if (cancelled || !seriesRef.current) return

        const byTime = new Map<number, CandlestickData>()
        histResp.candles.map(toCandle).forEach(c => byTime.set(c.time as number, c))
        const sorted = Array.from(byTime.values()).sort(
          (a, b) => (a.time as number) - (b.time as number)
        )
        if (sorted.length > 0) {
          seriesRef.current.setData(sorted)

          const closes = sorted.map(c => c.close)
          const ema9Vals = computeEMA(closes, 9)
          const ema21Vals = computeEMA(closes, 21)
          const ema9Data = sorted
            .map((c, i) => ({ time: c.time, value: ema9Vals[i] }))
            .filter((d): d is LineData => d.value !== null)
          const ema21Data = sorted
            .map((c, i) => ({ time: c.time, value: ema21Vals[i] }))
            .filter((d): d is LineData => d.value !== null)
          ema9Ref.current?.setData(ema9Data)
          ema21Ref.current?.setData(ema21Data)

          chartRef.current?.timeScale().fitContent()
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date, strike, expiry, right, historicalDays])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    for (const s of tradeMarkerPoolRef.current) {
      try { chart.removeSeries(s) } catch { /* disposed */ }
    }
    tradeMarkerPoolRef.current = []

    if (trades.length === 0) {
      return
    }

    const intervalSecs = 3 * 60

    for (const t of trades) {
      const slot = Math.floor(t.timestamp / intervalSecs) * intervalSecs
      try {
        const markerSeries = chart.addLineSeries({
          lineVisible: false,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false,
        })
        markerSeries.setData([{ time: slot as Time, value: t.price }])
        markerSeries.setMarkers([{
          time: slot as Time,
          position: 'inBar' as const,
          color: t.side === 'BUY' ? '#FFFFFF' : '#00AAFF',
          shape: 'circle' as const,
          text: t.side === 'BUY' ? 'B' : 'S',
          size: 0.6,
        }])
        tradeMarkerPoolRef.current.push(markerSeries)
      } catch { /* disposed */ }
    }
  }, [trades])

  return (
    <div style={{
      width: '100%',
      height: isMaximized ? '100%' : 'auto',
      display: 'flex',
      flexDirection: 'column',
      borderRadius: 6,
      overflow: 'hidden'
    }}>
      <ChartToolbar
        title={`${right} ${strike}`}
        isMaximized={isMaximized}
        onMaximize={onMaximize}
      />
      <div ref={containerRef} style={{ width: '100%', flex: 1 }} />
    </div>
  )
}

// ── Chart Panel (split layout + maximize) ────────────────────────────────────

interface OptionTab {
  key: string
  label: string
  right: string
  strike: number
  expiry: string
  trades: AnalysisTrade[]
}

export function WebsiteAnalysisChartPanel({
  symbol, date, allTrades, isOptions, historicalDays = 2,
}: {
  symbol: string
  date: string
  allTrades: AnalysisTrade[]
  isOptions: boolean
  historicalDays?: number
}) {
  const optionTabs = useMemo<OptionTab[]>(() => {
    if (!isOptions) return []
    const tabMap = new Map<string, OptionTab>()
    for (const t of allTrades) {
      if (!t.right || t.strike == null || !t.expiry) continue
      const key = `${t.right}-${t.strike}-${t.expiry}`
      if (!tabMap.has(key)) {
        tabMap.set(key, { key, label: `${t.right} ${t.strike}`, right: t.right, strike: t.strike, expiry: t.expiry, trades: [] })
      }
      tabMap.get(key)!.trades.push(t)
    }
    return Array.from(tabMap.values()).sort((a, b) => {
      if (a.right !== b.right) return a.right === 'CE' ? -1 : 1
      return a.strike - b.strike
    })
  }, [allTrades, isOptions])

  const [activeTab, setActiveTab] = useState<string>('')
  const [maximizedChart, setMaximizedChart] = useState<'underlying' | string | null>(null)

  useEffect(() => {
    if (optionTabs.length > 0 && !optionTabs.find(t => t.key === activeTab)) {
      setActiveTab(optionTabs[0].key)
    }
  }, [optionTabs, activeTab])

  useEffect(() => {
    if (!maximizedChart) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximizedChart(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximizedChart])

  const activeTabData = optionTabs.find(t => t.key === activeTab) ?? null

  // ── Fullscreen overlay ────────────────────────────────────────────────────
  if (maximizedChart) {
    const isUnderlying = maximizedChart === 'underlying'
    const optTab = isUnderlying ? null : optionTabs.find(t => t.key === maximizedChart) ?? null
    const overlayTitle = isUnderlying ? 'Underlying' : (optTab?.label ?? '')

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0d1117', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 16px', background: '#161b22', borderBottom: '1px solid #30363d',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>{overlayTitle}</span>
          <span style={{ fontSize: 12, color: '#484f58' }}>{symbol} · {date}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setMaximizedChart(null)}
            title="Restore"
            style={{
              background: 'none', border: '1px solid #30363d', color: '#8b949e',
              borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
            }}
          >
            ⤡ Restore
          </button>
        </div>
        <div style={{ flex: 1, padding: 8, overflow: 'hidden' }}>
          {isUnderlying ? (
            <WebsiteAnalysisChart
              symbol={symbol} date={date} trades={allTrades}
              historicalDays={historicalDays} title="Underlying"
              isMaximized onMaximize={() => setMaximizedChart(null)}
            />
          ) : optTab ? (
            <WebsiteOptionsChart
              symbol={symbol} date={date}
              strike={optTab.strike} expiry={optTab.expiry} right={optTab.right}
              trades={optTab.trades} historicalDays={historicalDays}
              isMaximized onMaximize={() => setMaximizedChart(null)}
            />
          ) : null}
        </div>
      </div>
    )
  }

  // ── Equity: single chart ──────────────────────────────────────────────────
  if (!isOptions || optionTabs.length === 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <WebsiteAnalysisChart
          symbol={symbol} date={date} trades={allTrades}
          historicalDays={historicalDays} title="Underlying"
          onMaximize={() => setMaximizedChart('underlying')}
        />
      </div>
    )
  }

  // ── Options: side-by-side ─────────────────────────────────────────────────
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
      {/* Underlying — left */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <WebsiteAnalysisChart
          symbol={symbol} date={date} trades={allTrades}
          historicalDays={historicalDays} title="Underlying"
          onMaximize={() => setMaximizedChart('underlying')}
        />
      </div>

      {/* Options — right */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
          {optionTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', border: 'none',
                background: tab.key === activeTab ? '#58a6ff' : '#21262d',
                color: tab.key === activeTab ? '#0d1117' : '#8b949e',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeTabData && (
          <WebsiteOptionsChart
            key={activeTab}
            symbol={symbol} date={date}
            strike={activeTabData.strike} expiry={activeTabData.expiry} right={activeTabData.right}
            trades={activeTabData.trades} historicalDays={historicalDays}
            onMaximize={() => setMaximizedChart(activeTab)}
          />
        )}
      </div>
    </div>
  )
}

