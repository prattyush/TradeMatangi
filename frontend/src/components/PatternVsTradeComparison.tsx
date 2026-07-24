/**
 * PatternVsTradeComparison — full-page side-by-side view comparing actual
 * trades against saved pattern annotations for the same date/symbol.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createChart, IChartApi, ISeriesApi, CandlestickData, Time, SeriesMarker,
} from 'lightweight-charts'
import api, { AnalysisTrade, TradeLabel, OHLCCandle, PatternAnnotation, TopPatterns } from '../services/api'
import { buildMarkers } from '../services/patternMarkers'

interface Props {
  symbol: string
  date: string
  instrumentType: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
  onClose: () => void
}

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

function effectiveSideForChart(trade: AnalysisTrade): 'BUY' | 'SELL' {
  if (trade.right === 'PE') return trade.side === 'BUY' ? 'SELL' : 'BUY'
  return trade.side
}

// ── Left Pane: Trades Chart ─────────────────────────────────────────────

function TradesChart({
  symbol, date, trades, tab, optionTabs, setTab, getMarkerText, historicalDays, showEma,
}: {
  symbol: string; date: string; trades: AnalysisTrade[]; tab: string
  optionTabs: { right: string; strike: number; expiry: string }[]
  setTab: (t: string) => void; getMarkerText: (t: AnalysisTrade) => string
  historicalDays: number; showEma: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerPool = useRef<ISeriesApi<'Line'>[]>([])
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const w = el.clientWidth
    const h = Math.max(400, window.innerHeight * 0.55)
    const chart = createChart(el, {
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
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    chartRef.current = chart; seriesRef.current = series; ema9Ref.current = e9; ema21Ref.current = e21

    const ro = new ResizeObserver(entries => {
      chart.applyOptions({ width: entries[0].contentRect.width })
    })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  // Load OHLC
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !symbol || !date) return
    let cancelled = false
    ;(async () => {
      try {
        const toCandle = (c: OHLCCandle): CandlestickData => ({
          time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
        })
        const [histResp, tradingDayCandles] = await Promise.all([
          api.getHistorical(symbol, date, 3, historicalDays),
          api.getPreSession(symbol, date, '15:30:00', 3),
        ])
        if (cancelled || !seriesRef.current) return
        const all = [...histResp.candles.map(toCandle), ...tradingDayCandles.map(toCandle)]
        const byTime = new Map<number, CandlestickData>()
        all.forEach(c => byTime.set(c.time as number, c))
        const sorted = Array.from(byTime.values()).sort((a, b) => (a.time as number) - (b.time as number))
        series.setData(sorted)
        setCandles(sorted)
        const closes = sorted.map(c => c.close)
        const e9v = computeEMA(closes, 9); const e21v = computeEMA(closes, 21)
        ema9Ref.current?.setData(sorted.map((c, i) => ({ time: c.time, value: e9v[i]! })).filter(d => d.value !== null))
        ema21Ref.current?.setData(sorted.map((c, i) => ({ time: c.time, value: e21v[i]! })).filter(d => d.value !== null))
        chartRef.current?.timeScale().fitContent()
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [symbol, date, historicalDays])

  // EMA visibility
  useEffect(() => {
    ema9Ref.current?.applyOptions({ visible: showEma })
    ema21Ref.current?.applyOptions({ visible: showEma })
  }, [showEma])

  // Trade markers
  const intervalSecs = 3 * 60
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of markerPool.current) { try { chart.removeSeries(s) } catch {} }
    markerPool.current = []

    if (trades.length === 0) return
    for (const t of trades) {
      const slot = Math.floor(t.timestamp / intervalSecs) * intervalSecs
      const side = effectiveSideForChart(t)
      const markerPrice = t.right ? (t.underlying_price ?? candles.find(c => (c.time as number) === slot)?.close) : t.price
      if (markerPrice === undefined) continue
      try {
        const s = chart.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false })
        s.setData([{ time: slot as Time, value: markerPrice }])
        s.setMarkers([{
          time: slot as Time, position: 'inBar',
          color: side === 'BUY' ? '#FFFFFF' : '#00AAFF',
          shape: 'circle', text: getMarkerText(t), size: 0.6,
        }])
        markerPool.current.push(s)
      } catch {}
    }
  }, [trades, candles, getMarkerText])

  return (
    <div>
      {optionTabs.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <TabPill label="Underlying" active={tab === 'underlying'} onClick={() => setTab('underlying')} />
          {optionTabs.map(ot => (
            <TabPill key={`${ot.right}:${ot.strike}`} label={`${ot.right} ${ot.strike}`} active={tab === `${ot.right}:${ot.strike}`} onClick={() => setTab(`${ot.right}:${ot.strike}`)} />
          ))}
        </div>
      )}
      <div ref={containerRef} />
    </div>
  )
}

// ── Right Pane: Pattern Chart ───────────────────────────────────────────

function PatternChartPanel({
  symbol, date, annotations, topPatterns, activeStrategy, activeCategory, tab, instrumentType, historicalDays, onTabChange, showEma,
}: {
  symbol: string; date: string; annotations: PatternAnnotation[]; topPatterns: TopPatterns
  activeStrategy: string | null; activeCategory: string | null
  tab: string; instrumentType: string; historicalDays: number
  onTabChange: (t: string) => void; showEma: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])

  const filtered = (() => {
    if (instrumentType === 'equity') return annotations.filter(a => a.instrument === 'underlying')
    if (tab === 'underlying') return annotations.filter(a => a.instrument === 'underlying')
    return annotations.filter(a => a.instrument === tab)
  })()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      width: el.clientWidth || 500, height: Math.max(400, window.innerHeight * 0.55),
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false },
    })
    const series = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    chartRef.current = chart; seriesRef.current = series; ema9Ref.current = e9; ema21Ref.current = e21
    const ro = new ResizeObserver(entries => {
      chart.applyOptions({ width: entries[0].contentRect.width })
    })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    let cancelled = false
    ;(async () => {
      console.log('[PatternChartPanel] loading OHLC:', { symbol, date, tab, instrumentType })
      let cl: OHLCCandle[] = []
      try {
        if (instrumentType === 'equity' || tab === 'underlying') {
          const r = await api.patternOhlcEquity(symbol, date, 3, historicalDays)
          cl = r.candles
          console.log('[PatternChartPanel] equity candles:', cl.length)
        } else {
          // Find first matching annotation to get strike
          const ann = annotations.find(a => a.instrument === tab)
          console.log('[PatternChartPanel] first ann for tab:', ann)
          if (!ann) return
          const chart = await api.patternGetChartByDate(symbol, date, 'options').catch(() => null)
          const strike = chart?.strike
          console.log('[PatternChartPanel] chart strike:', strike)
          if (!strike) return
          const expiryRes = await api.getExpiry(symbol, date).catch(() => null)
          const exp = expiryRes?.expiry ?? ''
          console.log('[PatternChartPanel] expiry:', exp)
          if (!exp) return
          const r = await api.patternOhlcOptions(symbol, date, strike, exp, tab, 3, historicalDays)
          cl = r.candles
          console.log('[PatternChartPanel] options candles:', cl.length)
        }
      } catch (e) {
        console.error('[PatternChartPanel] OHLC error:', e)
        return
      }
      if (cancelled || !seriesRef.current) return
      if (cl.length === 0) { console.log('[PatternChartPanel] no candles'); return }
      const data: CandlestickData[] = cl.map(c => ({
        time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
      setCandles(data)
      series.setData(data)
      const closes = data.map(c => c.close)
      const e9v = computeEMA(closes, 9); const e21v = computeEMA(closes, 21)
      ema9Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e9v[i]! })).filter(d => d.value !== null))
      ema21Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e21v[i]! })).filter(d => d.value !== null))
      chartRef.current?.timeScale().fitContent()
    })()
    return () => { cancelled = true }
  }, [symbol, date, tab, instrumentType, historicalDays, annotations])

  useEffect(() => {
    ema9Ref.current?.applyOptions({ visible: showEma })
    ema21Ref.current?.applyOptions({ visible: showEma })
  }, [showEma])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || candles.length === 0) return
    const markers: SeriesMarker<Time>[] = buildMarkers(filtered, activeStrategy, activeCategory, topPatterns)
    series.setMarkers(markers)
  }, [candles, filtered, activeStrategy, activeCategory, topPatterns])

  return (
    <div>
      {instrumentType === 'options' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <TabPill label="Underlying" active={tab === 'underlying'} onClick={() => onTabChange('underlying')} />
          <TabPill label="CE" active={tab === 'CE'} onClick={() => onTabChange('CE')} />
          <TabPill label="PE" active={tab === 'PE'} onClick={() => onTabChange('PE')} />
        </div>
      )}
      <div ref={containerRef} />
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────

export default function PatternVsTradeComparison({
  symbol, date, instrumentType, sessionIds, allTrades, historicalDays, onClose,
}: Props) {
  const [labelByTradeId, setLabelByTradeId] = useState<Map<string, TradeLabel>>(new Map())
  const [patternAnnotations, setPatternAnnotations] = useState<PatternAnnotation[]>([])
  const [topPatterns, setTopPatterns] = useState<TopPatterns>({})
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState('')
  const [activeStrategy, setActiveStrategy] = useState('')
  const [showEma, setShowEma] = useState(true)
  const [tradeTab, setTradeTab] = useState('underlying')
  const [patternTab, setPatternTab] = useState('underlying')

  const optionTabs = [...new Map(
    allTrades.filter(t => t.right).map(t => [`${t.right}:${t.strike}:${t.expiry}`, { right: t.right!, strike: t.strike!, expiry: t.expiry! }])
  ).values()]

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [rtResults, labelResults, patternChart, cats, strats] = await Promise.all([
        Promise.all(sessionIds.map(sid => api.getRoundTrips(sid).catch(() => []))),
        Promise.all(sessionIds.map(sid => api.getLabels(sid).catch(() => []))),
        api.patternGetChartByDate(symbol, date, instrumentType === 'options' ? 'options' : 'equity').catch(() => null),
        api.patternListCategories().catch(() => ({ categories: [] })),
        api.patternListStrategies().catch(() => ({ strategies: [] })),
      ])
      if (cancelled) return

      console.log('[Compare] patternChart:', patternChart ? `found (${patternChart.annotations?.length} annotations)` : 'null')

      const map = new Map<string, TradeLabel>()
      for (let si = 0; si < sessionIds.length; si++) {
        const sessionRTs = rtResults[si] ?? []
        const sessionLabels = labelResults[si] ?? []
        const rtByIndex = new Map(sessionRTs.map(rt => [rt.index, rt]))
        for (const l of sessionLabels) {
          const rt = rtByIndex.get(l.round_trip_index)
          if (rt) {
            for (const t of rt.entry_trades) map.set(t.trade_id, l)
            for (const t of rt.exit_trades) map.set(t.trade_id, l)
          }
        }
      }
      console.log('[Compare] rtResults:', rtResults.flat().length, 'round-trips')
      console.log('[Compare] labels:', labelResults.flat().length, 'labels')
      console.log('[Compare] labelByTradeId size:', map.size)

      setLabelByTradeId(map)
      if (patternChart) {
        setPatternAnnotations(patternChart.annotations)
        setTopPatterns(patternChart.top_patterns || {})
      }
      setCategories(cats.categories)
      setStrategies(strats.strategies)
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line

  const getMarkerText = useCallback((t: AnalysisTrade): string => {
    const label = labelByTradeId.get(t.trade_id)
    if (label?.expected_strategy) {
      const cat = label.expected_category ? label.expected_category.slice(0, 5) + '/' : ''
      return cat + label.expected_strategy.slice(0, 10)
    }
    return t.side === 'BUY' ? 'B' : 'S'
  }, [labelByTradeId])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99, background: '#0d1117', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 18, color: '#e6edf3', fontWeight: 600 }}>📊 Pattern vs Trade: {symbol} · {date}</div>
          <div style={{ fontSize: 12, color: '#484f58', marginTop: 4 }}>
            Compare actual trades against saved pattern annotations
          </div>
        </div>
        <div style={{ width: 1, height: 24, background: '#30363d', margin: '0 8px' }} />
        <span style={{ fontSize: 11, color: '#8b949e' }}>Filter:</span>
        <select value={activeCategory} onChange={e => setActiveCategory(e.target.value)} style={selectStyle}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={activeStrategy} onChange={e => setActiveStrategy(e.target.value)} style={selectStyle}>
          <option value="">All strategies</option>
          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowEma(v => !v)} style={{
          padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 4,
          border: `1px solid ${showEma ? '#f0883e' : '#30363d'}`,
          background: showEma ? '#1f3a5f' : '#161b22',
          color: showEma ? '#f0883e' : '#484f58', cursor: 'pointer',
        }}>EMA 9/21</button>
        <span style={{ fontSize: 11, color: '#484f58' }}>
          {patternAnnotations.length} annotations · {labelByTradeId.size} labeled trades
        </span>
        <button onClick={onClose} style={{ background: 'none', border: '1px solid #30363d', borderRadius: 6, color: '#8b949e', fontSize: 13, cursor: 'pointer', padding: '6px 16px' }}>✕ Close</button>
      </div>

      {/* Charts: side-by-side */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 8px', borderRight: '1px solid #21262d' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#58a6ff', marginBottom: 6 }}>TRADES</div>
          <TradesChart
            symbol={symbol} date={date} trades={allTrades}
            tab={tradeTab} optionTabs={optionTabs} setTab={setTradeTab}
            getMarkerText={getMarkerText} historicalDays={historicalDays} showEma={showEma}
          />
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f0883e', marginBottom: 6 }}>PATTERNS</div>
          <PatternChartPanel
            symbol={symbol} date={date}
            annotations={patternAnnotations} topPatterns={topPatterns}
            activeStrategy={activeStrategy || null} activeCategory={activeCategory || null}
            tab={patternTab} instrumentType={instrumentType} historicalDays={historicalDays}
            onTabChange={setPatternTab} showEma={showEma}
          />
        </div>
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function TabPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 4,
      border: `1px solid ${active ? '#58a6ff' : '#30363d'}`,
      background: active ? '#1f3a5f' : '#161b22',
      color: active ? '#58a6ff' : '#8b949e', cursor: 'pointer',
    }}>{label}</button>
  )
}

const selectStyle: React.CSSProperties = {
  background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 4, padding: '4px 8px', fontSize: 11, minWidth: 140,
}
