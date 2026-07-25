/**
 * PatternVsTradeComparison — full-page side-by-side view comparing actual
 * trades against saved pattern annotations for the same date/symbol.
 *
 * Layout replicates TradeLabeling: underlying chart with All/CE/PE filter,
 * optional CE/PE striked charts below.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  createChart, IChartApi, ISeriesApi, CandlestickData, Time,
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

interface OptionTab {
  key: string; label: string; right: string; strike: number; expiry: string; trades: AnalysisTrade[]
}

function nextEMA(prev: number, close: number, k: number): number { return close * k + prev * (1 - k) }
function computeEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return []
  const r: (number | null)[] = []
  const k = 2 / (period + 1); let ema: number | null = null; let warmup = 0, sum = 0
  for (let i = 0; i < closes.length; i++) { sum += closes[i]; warmup++; if (warmup < period) r.push(null); else if (warmup === period) { ema = sum / period; r.push(ema) } else { ema = nextEMA(ema!, closes[i], k); r.push(ema) } }
  return r
}
function effectiveSideForChart(t: AnalysisTrade): 'BUY' | 'SELL' { return t.right === 'PE' ? (t.side === 'BUY' ? 'SELL' : 'BUY') : t.side }

function useOptionTabs(allTrades: AnalysisTrade[], isOptions: boolean): OptionTab[] {
  return useMemo(() => {
    if (!isOptions) return []
    const m = new Map<string, OptionTab>()
    for (const t of allTrades) {
      if (!t.right || t.strike == null || !t.expiry) continue
      const k = `${t.right}-${t.strike}-${t.expiry}`
      if (!m.has(k)) m.set(k, { key: k, label: `${t.right} ${t.strike}`, right: t.right, strike: t.strike, expiry: t.expiry, trades: [] })
      m.get(k)!.trades.push(t)
    }
    return [...m.values()].sort((a, b) => a.right !== b.right ? (a.right === 'CE' ? -1 : 1) : a.strike - b.strike)
  }, [allTrades, isOptions])
}

// ── Trades Chart (Left Side) ────────────────────────────────────────────

function TradesChart({
  symbol, date, allTrades, showEma, getMarkerText, historicalDays, optionTabs,
}: {
  symbol: string; date: string; allTrades: AnalysisTrade[]; showEma: boolean
  getMarkerText: (t: AnalysisTrade) => string; historicalDays: number; optionTabs: OptionTab[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerPool = useRef<ISeriesApi<'Line'>[]>([])
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])
  const [markerFilter, setMarkerFilter] = useState<'all' | 'CE' | 'PE'>('all')

  useEffect(() => {
    const el = containerRef.current; if (!el) return
    const chart = createChart(el, { width: el.clientWidth || 500, height: Math.max(400, window.innerHeight * 0.5), layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' }, grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } }, timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' }, crosshair: { mode: 0 } })
    chartRef.current = chart; seriesRef.current = chart.addCandlestickSeries({ upColor: '#26a641', downColor: '#f85149', borderVisible: false, wickUpColor: '#26a641', wickDownColor: '#f85149' })
    ema9Ref.current = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    ema21Ref.current = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    const ro = new ResizeObserver(e => { chart.applyOptions({ width: e[0].contentRect.width }) }); ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    const s = seriesRef.current; if (!s || !symbol || !date) return; let cancelled = false
    ;(async () => {
      try {
        const tc = (c: OHLCCandle): CandlestickData => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })
        const [h, td] = await Promise.all([api.getHistorical(symbol, date, 3, historicalDays), api.getPreSession(symbol, date, '15:30:00', 3)])
        if (cancelled || !seriesRef.current) return
        const all = [...h.candles.map(tc), ...td.map(tc)]; const byTime = new Map<number, CandlestickData>(); all.forEach(c => byTime.set(c.time as number, c))
        const sorted = [...byTime.values()].sort((a, b) => (a.time as number) - (b.time as number)); s.setData(sorted); setCandles(sorted)
        const cl = sorted.map(c => c.close); const e9 = computeEMA(cl, 9); const e21 = computeEMA(cl, 21)
        ema9Ref.current?.setData(sorted.map((c, i) => ({ time: c.time, value: e9[i]! })).filter(d => d.value !== null))
        ema21Ref.current?.setData(sorted.map((c, i) => ({ time: c.time, value: e21[i]! })).filter(d => d.value !== null))
        chartRef.current?.timeScale().fitContent()
      } catch {}
    })(); return () => { cancelled = true }
  }, [symbol, date, historicalDays])

  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma }); ema21Ref.current?.applyOptions({ visible: showEma }) }, [showEma])

  const displayTrades = markerFilter === 'all' ? allTrades : allTrades.filter(t => !t.right || t.right === markerFilter)
  const intervalSecs = 3 * 60
  useEffect(() => {
    const c = chartRef.current; if (!c) return; for (const s of markerPool.current) { try { c.removeSeries(s) } catch {} }; markerPool.current = []
    if (displayTrades.length === 0) return
    for (const t of displayTrades) {
      const slot = Math.floor(t.timestamp / intervalSecs) * intervalSecs
      const markerPrice = t.right ? (t.underlying_price ?? candles.find(cc => (cc.time as number) === slot)?.close) : t.price
      if (markerPrice === undefined) continue
      try {
        const s = c.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false })
        s.setData([{ time: slot as Time, value: markerPrice }])
        s.setMarkers([{ time: slot as Time, position: 'inBar', color: effectiveSideForChart(t) === 'BUY' ? '#FFFFFF' : '#00AAFF', shape: 'circle', text: getMarkerText(t), size: 0.6 }])
        markerPool.current.push(s)
      } catch {}
    }
  }, [displayTrades, candles, getMarkerText])

  const hasOptions = allTrades.some(t => t.right)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {hasOptions && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          {(['all', 'CE', 'PE'] as const).map(f => (
            <button key={f} onClick={() => setMarkerFilter(f)} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 4, border: `1px solid ${markerFilter === f ? '#58a6ff' : '#30363d'}`, background: markerFilter === f ? '#1f3a5f' : '#161b22', color: markerFilter === f ? '#58a6ff' : '#8b949e', cursor: 'pointer' }}>{f === 'all' ? 'All' : f}</button>
          ))}
        </div>
      )}
      <div ref={containerRef} />
      {optionTabs.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {optionTabs.map(ot => <OptionsChartMini key={ot.key} symbol={symbol} date={date} strike={ot.strike} expiry={ot.expiry} right={ot.right} trades={ot.trades} showEma={showEma} getMarkerText={getMarkerText} historicalDays={historicalDays} />)}
        </div>
      )}
    </div>
  )
}

// ── Mini Options Chart (below underlying) ───────────────────────────────

function OptionsChartMini({
  symbol, date, strike, expiry, right, trades, showEma, getMarkerText, historicalDays,
}: {
  symbol: string; date: string; strike: number; expiry: string; right: string; trades: AnalysisTrade[]; showEma: boolean; getMarkerText: (t: AnalysisTrade) => string; historicalDays: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerPool = useRef<ISeriesApi<'Line'>[]>([])
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])
  const [toggleOpen, setToggleOpen] = useState(false)

  useEffect(() => {
    if (!toggleOpen) return
    const el = containerRef.current; if (!el) return
    const chart = createChart(el, { width: el.clientWidth || 400, height: 250, layout: { background: { color: '#0d1117' }, textColor: '#8b949e' }, grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } }, timeScale: { timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false } })
    chartRef.current = chart; seriesRef.current = chart.addCandlestickSeries({ upColor: right === 'CE' ? '#22c55e' : '#7c3aed', downColor: '#ef4444', borderVisible: false, wickUpColor: right === 'CE' ? '#22c55e' : '#7c3aed', wickDownColor: '#ef4444' })
    ema9Ref.current = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema21Ref.current = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const ro = new ResizeObserver(e => { chart.applyOptions({ width: e[0].contentRect.width }) }); ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [toggleOpen])

  useEffect(() => {
    if (!toggleOpen) return
    const s = seriesRef.current; if (!s) return; let cancelled = false
    ;(async () => {
      try {
        const r = await api.patternOhlcOptions(symbol, date, strike, expiry, right, 3, historicalDays)
        if (cancelled || !seriesRef.current) return
        const data: CandlestickData[] = r.candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
        s.setData(data); setCandles(data)
        const cl = data.map(c => c.close); const e9 = computeEMA(cl, 9); const e21 = computeEMA(cl, 21)
        ema9Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e9[i]! })).filter(d => d.value !== null))
        ema21Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e21[i]! })).filter(d => d.value !== null))
        chartRef.current?.timeScale().fitContent()
      } catch {}
    })(); return () => { cancelled = true }
  }, [toggleOpen, symbol, date, strike, expiry, right, historicalDays])

  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma }); ema21Ref.current?.applyOptions({ visible: showEma }) }, [showEma])

  const intervalSecs = 3 * 60
  useEffect(() => {
    if (!toggleOpen) return; const c = chartRef.current; if (!c) return; for (const s of markerPool.current) { try { c.removeSeries(s) } catch {} }; markerPool.current = []
    if (trades.length === 0) return
    for (const t of trades) {
      const slot = Math.floor(t.timestamp / intervalSecs) * intervalSecs
      const markerPrice = t.price
      try {
        const s = c.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false })
        s.setData([{ time: slot as Time, value: markerPrice }])
        s.setMarkers([{ time: slot as Time, position: 'inBar', color: t.side === 'BUY' ? '#FFFFFF' : '#00AAFF', shape: 'circle', text: getMarkerText(t), size: 0.6 }])
        markerPool.current.push(s)
      } catch {}
    }
  }, [toggleOpen, trades, candles, getMarkerText])

  return (
    <div>
      <button onClick={() => setToggleOpen(v => !v)} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 4, border: `1px solid ${toggleOpen ? (right === 'CE' ? '#22c55e' : '#7c3aed') : '#30363d'}`, background: toggleOpen ? '#161b22' : '#161b22', color: toggleOpen ? (right === 'CE' ? '#22c55e' : '#7c3aed') : '#484f58', cursor: 'pointer' }}>{toggleOpen ? '▲' : '▼'} {right} {strike}</button>
      {toggleOpen && <div ref={containerRef} style={{ marginTop: 4, width: '100%', height: 250 }} />}
    </div>
  )
}

// ── Pattern Chart (Right Side) ──────────────────────────────────────────

function PatternChartPanel({
  symbol, date, annotations, topPatterns, activeStrategy, activeCategory, tab, onTabChange, showEma, instrumentType, historicalDays,
}: {
  symbol: string; date: string; annotations: PatternAnnotation[]; topPatterns: TopPatterns
  activeStrategy: string | null; activeCategory: string | null
  tab: string; onTabChange: (t: string) => void; showEma: boolean; instrumentType: string; historicalDays: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])

  const filtered = useMemo(() => {
    if (instrumentType === 'equity') return annotations.filter(a => a.instrument === 'underlying')
    if (tab === 'underlying') return annotations.filter(a => a.instrument === 'underlying')
    return annotations.filter(a => a.instrument === tab)
  }, [annotations, instrumentType, tab])

  useEffect(() => {
    const el = containerRef.current; if (!el) return
    const chart = createChart(el, { width: el.clientWidth || 500, height: Math.max(400, window.innerHeight * 0.5), layout: { background: { color: '#0d1117' }, textColor: '#8b949e' }, grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } }, timeScale: { timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false } })
    chartRef.current = chart; seriesRef.current = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
    ema9Ref.current = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema21Ref.current = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const ro = new ResizeObserver(e => { chart.applyOptions({ width: e[0].contentRect.width }) }); ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [])

  useEffect(() => {
    const s = seriesRef.current; if (!s) return; let cancelled = false
    ;(async () => {
      let cl: OHLCCandle[] = []
      try {
        if (instrumentType === 'equity' || tab === 'underlying') {
          cl = (await api.patternOhlcEquity(symbol, date, 3, historicalDays)).candles
        } else {
          const ann = annotations.find(a => a.instrument === tab); if (!ann) return
          const chart = await api.patternGetChartByDate(symbol, date, 'options').catch(() => null)
          const strike = chart?.strike; if (!strike) return
          const er = await api.getExpiry(symbol, date).catch(() => null); const exp = er?.expiry; if (!exp) return
          cl = (await api.patternOhlcOptions(symbol, date, strike, exp, tab, 3, historicalDays)).candles
        }
      } catch { return }
      if (cancelled || !seriesRef.current || cl.length === 0) return
      const data: CandlestickData[] = cl.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
      s.setData(data); setCandles(data)
      const cls = data.map(c => c.close); const e9 = computeEMA(cls, 9); const e21 = computeEMA(cls, 21)
      ema9Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e9[i]! })).filter(d => d.value !== null))
      ema21Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e21[i]! })).filter(d => d.value !== null))
      chartRef.current?.timeScale().fitContent()
    })(); return () => { cancelled = true }
  }, [symbol, date, tab, instrumentType, historicalDays, annotations])

  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma }); ema21Ref.current?.applyOptions({ visible: showEma }) }, [showEma])

  useEffect(() => {
    const s = seriesRef.current; if (!s || candles.length === 0) return
    s.setMarkers(buildMarkers(filtered, activeStrategy, activeCategory, topPatterns))
  }, [candles, filtered, activeStrategy, activeCategory, topPatterns])

  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma }); ema21Ref.current?.applyOptions({ visible: showEma }) }, [showEma])

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {instrumentType === 'options' && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <PatternTab active={tab === 'underlying'} label="Underlying" onClick={() => onTabChange('underlying')} />
          <PatternTab active={tab === 'CE'} label="CE" onClick={() => onTabChange('CE')} />
          <PatternTab active={tab === 'PE'} label="PE" onClick={() => onTabChange('PE')} />
        </div>
      )}
      <div ref={containerRef} />
      {instrumentType === 'options' && tab !== 'underlying' && (
        <div style={{ marginTop: 8 }}>
          <PatternOptionsMini symbol={symbol} date={date} right={tab} annotations={annotations} topPatterns={topPatterns} activeStrategy={activeStrategy} activeCategory={activeCategory} showEma={showEma} historicalDays={historicalDays} />
        </div>
      )}
    </div>
  )
}

function PatternTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button onClick={onClick} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 4, border: `1px solid ${active ? '#58a6ff' : '#30363d'}`, background: active ? '#1f3a5f' : '#161b22', color: active ? '#58a6ff' : '#8b949e', cursor: 'pointer' }}>{label}</button>
}

function PatternOptionsMini({
  symbol, date, right, annotations, topPatterns, activeStrategy, activeCategory, showEma, historicalDays,
}: {
  symbol: string; date: string; right: string; annotations: PatternAnnotation[]; topPatterns: TopPatterns; activeStrategy: string | null; activeCategory: string | null; showEma: boolean; historicalDays: number
}) {
  const [[toggleOpen, strike], setToggle] = useState<[boolean, number | null]>([false, null])
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<CandlestickData[]>([])

  const filtered = annotations.filter(a => a.instrument === right)

  useEffect(() => {
    if (!toggleOpen || !strike) return
    const el = containerRef.current; if (!el) return
    const chart = createChart(el, { width: el.clientWidth || 400, height: 250, layout: { background: { color: '#0d1117' }, textColor: '#8b949e' }, grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } }, timeScale: { timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false } })
    chartRef.current = chart; seriesRef.current = chart.addCandlestickSeries({ upColor: right === 'CE' ? '#22c55e' : '#7c3aed', downColor: '#ef4444', borderVisible: false, wickUpColor: right === 'CE' ? '#22c55e' : '#7c3aed', wickDownColor: '#ef4444' })
    ema9Ref.current = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema21Ref.current = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const ro = new ResizeObserver(e => { chart.applyOptions({ width: e[0].contentRect.width }) }); ro.observe(el)
    return () => { ro.disconnect(); chart.remove() }
  }, [toggleOpen, strike])

  useEffect(() => {
    if (!toggleOpen || !strike) return
    const s = seriesRef.current; if (!s) return; let cancelled = false
    ;(async () => {
      try {
        const er = await api.getExpiry(symbol, date).catch(() => null); const exp = er?.expiry; if (!exp) return
        const r = await api.patternOhlcOptions(symbol, date, strike, exp, right, 3, historicalDays)
        if (cancelled || !seriesRef.current) return
        const data: CandlestickData[] = r.candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
        s.setData(data); setCandles(data)
        const cls = data.map(c => c.close); const e9 = computeEMA(cls, 9); const e21 = computeEMA(cls, 21)
        ema9Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e9[i]! })).filter(d => d.value !== null))
        ema21Ref.current?.setData(data.map((c, i) => ({ time: c.time, value: e21[i]! })).filter(d => d.value !== null))
        chartRef.current?.timeScale().fitContent()
      } catch {}
    })(); return () => { cancelled = true }
  }, [toggleOpen, strike, symbol, date, right, historicalDays])

  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma }); ema21Ref.current?.applyOptions({ visible: showEma }) }, [showEma])

  useEffect(() => {
    if (!toggleOpen || !seriesRef.current || candles.length === 0) return
    seriesRef.current.setMarkers(buildMarkers(filtered, activeStrategy, activeCategory, topPatterns))
  }, [toggleOpen, candles, filtered, activeStrategy, activeCategory, topPatterns])

  const handleToggle = async () => {
    if (toggleOpen) { setToggle([false, null]); return }
    // Resolve strike from pattern chart
    const chart = await api.patternGetChartByDate(symbol, date, 'options').catch(() => null)
    const st = chart?.strike
    if (st) setToggle([true, st])
  }

  return (
    <div>
      <button onClick={handleToggle} style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 4, border: `1px solid ${toggleOpen ? (right === 'CE' ? '#22c55e' : '#7c3aed') : '#30363d'}`, background: '#161b22', color: toggleOpen ? (right === 'CE' ? '#22c55e' : '#7c3aed') : '#484f58', cursor: 'pointer' }}>{toggleOpen ? '▲' : '▼'} {right} Chart</button>
      {toggleOpen && <div ref={containerRef} style={{ marginTop: 4, width: '100%', height: 250 }} />}
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
  const [patternTab, setPatternTab] = useState('underlying')

  const isOptions = instrumentType === 'options'
  const optionTabs = useOptionTabs(allTrades, isOptions)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [rtResults, labelResults, patternChart, cats, strats] = await Promise.all([
        Promise.all(sessionIds.map(sid => api.getRoundTrips(sid).catch(() => []))),
        Promise.all(sessionIds.map(sid => api.getLabels(sid).catch(() => []))),
        api.patternGetChartByDate(symbol, date, isOptions ? 'options' : 'equity').catch(() => null),
        api.patternListCategories().catch(() => ({ categories: [] })),
        api.patternListStrategies().catch(() => ({ strategies: [] })),
      ])
      if (cancelled) return
      const map = new Map<string, TradeLabel>()
      for (let si = 0; si < sessionIds.length; si++) {
        const sessionRTs = rtResults[si] ?? []; const sessionLabels = labelResults[si] ?? []
        const rtByIndex = new Map(sessionRTs.map(rt => [rt.index, rt]))
        for (const l of sessionLabels) {
          const rt = rtByIndex.get(l.round_trip_index)
          if (rt) { for (const t of rt.entry_trades) map.set(t.trade_id, l); for (const t of rt.exit_trades) map.set(t.trade_id, l) }
        }
      }
      setLabelByTradeId(map)
      if (patternChart) { setPatternAnnotations(patternChart.annotations); setTopPatterns(patternChart.top_patterns || {}) }
      setCategories(cats.categories); setStrategies(strats.strategies)
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line

  const getMarkerText = useCallback((t: AnalysisTrade): string => {
    const l = labelByTradeId.get(t.trade_id)
    if (l?.expected_strategy) { const cat = l.expected_category ? l.expected_category.slice(0, 5) + '/' : ''; return cat + l.expected_strategy.slice(0, 10) }
    return t.side === 'BUY' ? 'B' : 'S'
  }, [labelByTradeId])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99, background: '#0d1117', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
        <div><div style={{ fontSize: 18, color: '#e6edf3', fontWeight: 600 }}>📊 Pattern vs Trade: {symbol} · {date}</div><div style={{ fontSize: 12, color: '#484f58', marginTop: 4 }}>Compare actual trades against saved pattern annotations</div></div>
        <div style={{ width: 1, height: 24, background: '#30363d', margin: '0 8px' }} />
        <span style={{ fontSize: 11, color: '#8b949e' }}>Filter:</span>
        <select value={activeCategory} onChange={e => setActiveCategory(e.target.value)} style={selectStyle}><option value="">All categories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select value={activeStrategy} onChange={e => setActiveStrategy(e.target.value)} style={selectStyle}><option value="">All strategies</option>{strategies.map(s => <option key={s} value={s}>{s}</option>)}</select>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowEma(v => !v)} style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 4, border: `1px solid ${showEma ? '#f0883e' : '#30363d'}`, background: showEma ? '#1f3a5f' : '#161b22', color: showEma ? '#f0883e' : '#484f58', cursor: 'pointer' }}>EMA 9/21</button>
        <span style={{ fontSize: 11, color: '#484f58' }}>{patternAnnotations.length} annotations · {labelByTradeId.size} labeled trades</span>
        <button onClick={onClose} style={{ background: 'none', border: '1px solid #30363d', borderRadius: 6, color: '#8b949e', fontSize: 13, cursor: 'pointer', padding: '6px 16px' }}>✕ Close</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 8px', borderRight: '1px solid #21262d' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#58a6ff', marginBottom: 6 }}>TRADES</div>
          <TradesChart symbol={symbol} date={date} allTrades={allTrades} showEma={showEma} getMarkerText={getMarkerText} historicalDays={historicalDays} optionTabs={optionTabs} />
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f0883e', marginBottom: 6 }}>PATTERNS</div>
          <PatternChartPanel symbol={symbol} date={date} annotations={patternAnnotations} topPatterns={topPatterns} activeStrategy={activeStrategy || null} activeCategory={activeCategory || null} tab={patternTab} onTabChange={setPatternTab} showEma={showEma} instrumentType={instrumentType} historicalDays={historicalDays} />
        </div>
      </div>
    </div>
  )
}

const selectStyle: React.CSSProperties = { background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 4, padding: '4px 8px', fontSize: 11, minWidth: 140 }
