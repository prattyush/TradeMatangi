/**
 * PatternVsTradeComparison — side-by-side modal comparing actual trades
 * against saved pattern annotations for the same day/symbol.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createChart, IChartApi, ISeriesApi, CandlestickData, Time, SeriesMarker,
} from 'lightweight-charts'
import api, { AnalysisTrade, TradeLabel, OHLCCandle, PatternAnnotation, TopPatterns } from '../services/api'
import { buildMarkers } from '../services/patternMarkers'
import { AnalysisChart, OptionsChart } from './TradeAnalysis'

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
  const [loading, setLoading] = useState(true)
  const [tradeTab, setTradeTab] = useState<string>('underlying')
  const [patternTab, setPatternTab] = useState<string>('underlying')

  // Derive unique CE/PE strike combos for tab pills
  const optionTabs = [...new Map(
    allTrades.filter(t => t.right).map(t => [`${t.right}:${t.strike}:${t.expiry}`, { right: t.right!, strike: t.strike!, expiry: t.expiry! }])
  ).values()]

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [rtResults, labelResults, patternChart, cats, strats] = await Promise.all([
          Promise.all(sessionIds.map(sid => api.getRoundTrips(sid).catch(() => []))),
          Promise.all(sessionIds.map(sid => api.getLabels(sid).catch(() => []))),
          api.patternGetChartByDate(symbol, date, instrumentType === 'options' ? 'options' : 'equity').catch(() => null),
          api.patternListCategories().catch(() => ({ categories: [] })),
          api.patternListStrategies().catch(() => ({ strategies: [] })),
        ])
        if (cancelled) return

        const rts = rtResults.flat()
        const labels = labelResults.flat()
        const map = new Map<string, TradeLabel>()
        for (const l of labels) {
          for (const rt of rts) {
            if (rt.index === l.round_trip_index) {
              for (const t of rt.entry_trades) map.set(t.trade_id, l)
              for (const t of rt.exit_trades) map.set(t.trade_id, l)
            }
          }
        }
        setLabelByTradeId(map)
        if (patternChart) {
          setPatternAnnotations(patternChart.annotations)
          setTopPatterns(patternChart.top_patterns || {})
        }
        setCategories(cats.categories)
        setStrategies(strats.strategies)
      } catch { /* ignore */ }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const getMarkerText = useCallback((t: AnalysisTrade): string => {
    const label = labelByTradeId.get(t.trade_id)
    if (label?.expected_strategy) {
      const cat = label.expected_category ? label.expected_category.slice(0, 5) + '/' : ''
      return cat + label.expected_strategy.slice(0, 10)
    }
    return t.side === 'BUY' ? 'B' : 'S'
  }, [labelByTradeId])

  const resolvedActiveStrategy = activeStrategy || null
  const resolvedActiveCategory = activeCategory || null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.9)',
      display: 'flex', flexDirection: 'column', padding: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>
          📊 Pattern vs Trade: {symbol} · {date}
        </span>
        <div style={{ width: 1, height: 20, background: '#30363d' }} />
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
        <span style={{ fontSize: 11, color: '#484f58' }}>
          {patternAnnotations.length} pattern annotation{patternAnnotations.length !== 1 ? 's' : ''}
          {labelByTradeId.size > 0 && ` · ${labelByTradeId.size} labeled trades`}
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: '1px solid #30363d', borderRadius: 6,
          color: '#8b949e', fontSize: 14, cursor: 'pointer', padding: '4px 12px',
        }}>✕ Close</button>
      </div>

      {/* Main content: side-by-side */}
      <div style={{ flex: 1, display: 'flex', gap: 8, minHeight: 0 }}>
        {/* Left: Trades */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#58a6ff', marginBottom: 4 }}>TRADES</div>
          {(instrumentType === 'options') && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <TabPill label="Underlying" active={tradeTab === 'underlying'} onClick={() => setTradeTab('underlying')} />
              {optionTabs.map(ot => (
                <TabPill key={`${ot.right}:${ot.strike}`} label={`${ot.right} ${ot.strike}`} active={tradeTab === `${ot.right}:${ot.strike}`} onClick={() => setTradeTab(`${ot.right}:${ot.strike}`)} />
              ))}
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            {tradeTab === 'underlying' ? (
              <AnalysisChart symbol={symbol} date={date} trades={allTrades} historicalDays={historicalDays} title="" getMarkerText={getMarkerText} />
            ) : (() => {
              const ot = optionTabs.find(o => `${o.right}:${o.strike}` === tradeTab)
              if (!ot) return null
              return (
                <OptionsChart symbol={symbol} date={date} strike={ot.strike} expiry={ot.expiry} right={ot.right} trades={allTrades.filter(t => t.right === ot.right && t.strike === ot.strike)} historicalDays={historicalDays} />
              )
            })()}
          </div>
        </div>

        {/* Right: Patterns */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#f0883e', marginBottom: 4 }}>PATTERNS</div>
          {(instrumentType === 'options') && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <TabPill label="Underlying" active={patternTab === 'underlying'} onClick={() => setPatternTab('underlying')} />
              <TabPill label="CE" active={patternTab === 'CE'} onClick={() => setPatternTab('CE')} />
              <TabPill label="PE" active={patternTab === 'PE'} onClick={() => setPatternTab('PE')} />
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <PatternChartPanel
              symbol={symbol} date={date}
              annotations={patternAnnotations}
              topPatterns={topPatterns}
              activeStrategy={resolvedActiveStrategy}
              activeCategory={resolvedActiveCategory}
              tab={patternTab}
              instrumentType={instrumentType}
              historicalDays={historicalDays}
              loading={loading}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Pattern Chart Panel (right side) ────────────────────────────────────────

function PatternChartPanel({
  symbol, date, annotations, topPatterns, activeStrategy, activeCategory, tab, instrumentType, historicalDays, loading,
}: {
  symbol: string; date: string; annotations: PatternAnnotation[]; topPatterns: TopPatterns
  activeStrategy: string | null; activeCategory: string | null
  tab: string; instrumentType: string; historicalDays: number; loading: boolean
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
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: { vertTouchDrag: false },
    })
    const series = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    chartRef.current = chart; seriesRef.current = series; ema9Ref.current = e9; ema21Ref.current = e21

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    let cancelled = false
    ;(async () => {
      let cl: OHLCCandle[] = []
      try {
        if (instrumentType === 'equity' || tab === 'underlying') {
          const r = await api.patternOhlcEquity(symbol, date, 3, historicalDays)
          cl = r.candles
        } else {
          // For options CE/PE tab, try loading from first matching annotation's strike
          const ann = annotations.find(a => a.instrument === tab)
          if (!ann) return
          const expiryRes = await api.getExpiry(symbol, date).catch(() => null)
          if (!expiryRes) return
          const strikeRes = await api.patternGetChartByDate(symbol, date, 'options').catch(() => null)
          const strike = strikeRes?.strike ?? (await api.getPriceAt(symbol, date, '09:15').then(r => Math.round(r.price / 50) * 50).catch(() => 0))
          if (!strike) return
          const r = await api.patternOhlcOptions(symbol, date, strike, expiryRes.expiry, tab, 3, historicalDays)
          cl = r.candles
        }
      } catch { return }
      if (cancelled) return
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
    const series = seriesRef.current
    if (!series || candles.length === 0) return
    const markers: SeriesMarker<Time>[] = buildMarkers(filtered, activeStrategy, activeCategory, topPatterns)
    series.setMarkers(markers)
  }, [candles, filtered, activeStrategy, activeCategory, topPatterns])

  if (loading) return <div style={{ color: '#484f58', fontSize: 12, padding: 20 }}>Loading pattern data…</div>

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function TabPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '2px 10px', fontSize: 11, fontWeight: 600,
      borderRadius: 4, border: `1px solid ${active ? '#58a6ff' : '#30363d'}`,
      background: active ? '#1f3a5f' : '#161b22',
      color: active ? '#58a6ff' : '#8b949e', cursor: 'pointer',
    }}>{label}</button>
  )
}

const selectStyle: React.CSSProperties = {
  background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 4, padding: '4px 8px', fontSize: 11, minWidth: 140,
}
