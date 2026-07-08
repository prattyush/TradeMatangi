import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  LineData,
  Time,
} from 'lightweight-charts'
import api, { SessionSummary, SessionDetail, AnalysisTrade, OHLCCandle } from '../services/api'
import EventSnapshotViewer from './EventSnapshotViewer'
import { EventSnapshot } from '../services/api'

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

function effectiveSideForChart(trade: AnalysisTrade): 'BUY' | 'SELL' {
  if (!trade.right) return trade.side
  if (trade.right === 'CE') return trade.side === 'BUY' ? 'BUY' : 'SELL'
  return trade.side === 'BUY' ? 'SELL' : 'BUY'
}

// ── Session grouping ──────────────────────────────────────────────────────────

interface SessionGroup {
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

function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>()
  for (const s of sessions) {
    if (s.trade_count === 0) continue
    const key = `${s.date}|${s.symbol}|${s.instrument_type}|${s.session_type ?? ''}`
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
    g.totalTrades += s.trade_count
    g.totalCommission += s.total_commission
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date)
    return a.symbol.localeCompare(b.symbol)
  })
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

function AnalysisChart({
  symbol, date, trades, historicalDays = 2, title = 'Underlying',
  isMaximized = false, onMaximize,
}: {
  symbol: string
  date: string
  trades: AnalysisTrade[]
  historicalDays?: number
  title?: string
  isMaximized?: boolean
  onMaximize?: () => void
}) {
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
      const text = t.right
        ? `${t.right} ${t.side === 'BUY' ? 'B' : 'S'}`
        : (t.side === 'BUY' ? 'B' : 'S')
      
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

function OptionsChart({
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

function AnalysisChartPanel({
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
            <AnalysisChart
              symbol={symbol} date={date} trades={allTrades}
              historicalDays={historicalDays} title="Underlying"
              isMaximized onMaximize={() => setMaximizedChart(null)}
            />
          ) : optTab ? (
            <OptionsChart
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
        <AnalysisChart
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
        <AnalysisChart
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
          <OptionsChart
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

// ── Trade table ───────────────────────────────────────────────────────────────

function TradeTable({ trades }: { trades: AnalysisTrade[] }) {
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
  )
}

// ── Group card ────────────────────────────────────────────────────────────────

function GroupCard({ group, historicalDays = 2 }: { group: SessionGroup; historicalDays?: number }) {
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<Map<string, SessionDetail>>(new Map())
  const [loading, setLoading] = useState(false)
  const [viewingSnapshots, setViewingSnapshots] = useState<EventSnapshot[] | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)

  const handleExpand = async () => {
    if (!expanded && details.size === 0) {
      setLoading(true)
      try {
        const fetched = await Promise.all(
          group.sessions.map(s => api.getSessionDetail(s.session_id))
        )
        const m = new Map<string, SessionDetail>()
        fetched.forEach(d => m.set(d.session_id, d))
        setDetails(m)
      } catch { /* ignore */ } finally {
        setLoading(false)
      }
    }
    setExpanded(v => !v)
  }

  const allTrades = group.sessions.flatMap(s => details.get(s.session_id)?.trades ?? [])
  const multiSession = group.sessions.length > 1

  const pnlColor = group.totalPnl > 0 ? '#26a641' : group.totalPnl < 0 ? '#f85149' : '#8b949e'
  const pnlSign = group.totalPnl >= 0 ? '+' : ''
  const pnlPct = group.sessionCapital > 0 ? (group.totalPnl / group.sessionCapital) * 100 : 0
  const typeLabel = group.instrument_type === 'options' ? 'Options' : 'Equity'
  const sessionTypeLabel = group.session_type === 'paper' ? 'Paper' : group.session_type === 'real' ? 'Real' : 'Sim'

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
            {sessionTypeLabel}{multiSession ? ` · ${group.sessions.length} sessions` : ''}
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
          {/* Snapshots button — queries first session in the group */}
          <button
            onClick={async (e) => {
              e.stopPropagation()
              setSnapshotLoading(true)
              try {
                const snaps = await api.getSnapshots(group.sessions[0].session_id)
                if (snaps.length > 0) setViewingSnapshots(snaps)
              } catch { /* ignore */ }
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
          <span style={{ fontSize: 16, color: '#484f58' }}>
            {loading ? '⟳' : expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {/* Event snapshot viewer modal */}
      {viewingSnapshots && (
        <EventSnapshotViewer
          session={group.sessions[0]}
          snapshots={viewingSnapshots}
          onClose={() => setViewingSnapshots(null)}
          onDeleteAll={async () => {
            await api.deleteSnapshots(group.sessions[0].session_id)
            setViewingSnapshots(null)
          }}
        />
      )}

      {/* Expanded detail */}
      {expanded && details.size > 0 && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #21262d' }}>
          {group.sessions.map((s, idx) => {
            const d = details.get(s.session_id)
            if (!d || d.trades.length === 0) return null
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
                  <TradeTable trades={d.trades} />
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
        </div>
      )}
    </div>
  )
}

// ── Main TradeAnalysis component ─────────────────────────────────────────────

export default function TradeAnalysis({ onClose, historicalDays = 2 }: Props) {
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10)

  const [symbol, setSymbol] = useState<string>('')
  const [instrumentType, setInstrumentType] = useState<string>('')
  const [sessionType, setSessionType] = useState<string>('')
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
        sessionType: sessionType || undefined,
      })
      setSessions(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load analysis data')
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [symbol, instrumentType, sessionType, startDate, endDate])

  useEffect(() => { handleSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
          {error && (
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
    </div>
  )
}
