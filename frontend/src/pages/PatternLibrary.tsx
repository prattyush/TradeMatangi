/**
 * Pattern Library — Trade Pattern Logger (Phase XII)
 *
 * Create mode: annotate full-day charts (3-pane options, 1-pane equity) with
 * EMA 9/21, drawing tools, entry/exit markers. Panes can be maximized, removed,
 * or replaced with a different strike. View mode: responsive gallery with
 * click-to-expand read-only chart view.
 */
import { useState, useEffect, useRef, useCallback, CSSProperties } from 'react'
import {
  createChart, IChartApi, ISeriesApi, CandlestickData, LineData, Time,
  SeriesMarker, IPriceLine, LineStyle,
} from 'lightweight-charts'
import api, { PatternAnnotation, PatternChart, PatternChartMeta, OHLCCandle, TopPatterns } from '../services/api'

// ── EMA helpers ───────────────────────────────────────────────────────────────

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

// ── Drawing types ─────────────────────────────────────────────────────────────

type DrawMode = 'none' | 'hline' | 'trendline' | 'fibretracement' | 'channel'

type Drawing =
  | { type: 'hline'; ref: IPriceLine }
  | { type: 'trendline' | 'fibretracement' | 'channel'; refs: ISeriesApi<'Line'>[] }

const FIB_LEVELS = [
  { ratio: 0,    color: '#e6edf3' },
  { ratio: 0.25, color: '#34d399' },
  { ratio: 0.5,  color: '#60a5fa' },
  { ratio: 0.75, color: '#fbbf24' },
  { ratio: 1.0,  color: '#e6edf3' },
]

const DRAW_LABEL: Partial<Record<DrawMode, string>> = {
  hline: 'H-Line', trendline: 'Trend', fibretracement: 'Fib', channel: 'Channel',
}

// ── Annotation colours ────────────────────────────────────────────────────────

const MARKER_COLORS: Record<string, { color: string; shape: 'arrowUp' | 'arrowDown' }> = {
  'entry-underlying': { color: '#3b82f6', shape: 'arrowUp' },
  'exit-underlying':  { color: '#f97316', shape: 'arrowDown' },
  'entry-CE':         { color: '#22c55e', shape: 'arrowUp' },
  'exit-CE':          { color: '#ef4444', shape: 'arrowDown' },
  'entry-PE':         { color: '#14b8a6', shape: 'arrowUp' },
  'exit-PE':          { color: '#7c3aed', shape: 'arrowDown' },
}

function markerKey(type: string, instrument: string) { return `${type}-${instrument}` }

function patternIdentity(ann: PatternAnnotation): string {
  return `${ann.strategy_name}::${ann.category || ''}::${ann.instrument}`
}

function rankingForIdentity(topPatterns: TopPatterns | undefined, identity: string): 'top_1' | 'top_2' | 'bottom_1' | null {
  if (!topPatterns) return null
  for (const rank of ['top_1', 'top_2', 'bottom_1'] as const) {
    const tp = topPatterns[rank]
    if (tp && `${tp.strategy_name}::${tp.category}::${tp.instrument}` === identity) return rank
  }
  return null
}

const TOP_RANK_STYLE: Record<string, { color: string; badge: string }> = {
  top_1: { color: '#FFD700', badge: '🥇' },
  top_2: { color: '#C0C0C0', badge: '🥈' },
  bottom_1: { color: '#ff4444', badge: '❌' },
}

function buildMarkers(
  annotations: PatternAnnotation[],
  activeStrategy: string | null,
  activeCategory: string | null,
  topPatterns?: TopPatterns,
): SeriesMarker<Time>[] {
  return annotations
    .slice()
    .sort((a, b) => a.time - b.time)
    .map(ann => {
      const cfg = MARKER_COLORS[markerKey(ann.type, ann.instrument)] ?? { color: '#8b949e', shape: 'arrowUp' as const }
      const matchedStrategy = activeStrategy === null || ann.strategy_name === activeStrategy
      const matchedCategory = activeCategory === null || ann.category === activeCategory
      const dimmed = !matchedStrategy || !matchedCategory

      const rank = rankingForIdentity(topPatterns, patternIdentity(ann))
      const rankStyle = rank ? TOP_RANK_STYLE[rank] : null

      const displayText = dimmed
        ? ''
        : [
            rankStyle ? rankStyle.badge : '',
            ann.category ? ann.category.slice(0, 5) + '/' : '',
            ann.strategy_name.slice(0, 10),
          ].join('')

      return {
        time: ann.time as Time,
        position: ann.type === 'entry' ? 'belowBar' : 'aboveBar',
        color: dimmed ? '#3d4450' : rankStyle ? rankStyle.color : cfg.color,
        shape: cfg.shape,
        text: displayText,
        size: rankStyle ? 3 : dimmed ? 1 : 2,
      } as SeriesMarker<Time>
    })
}

function getUniquePatterns(annotations: PatternAnnotation[]): { identity: string; strategy_name: string; category: string; instrument: string }[] {
  const seen = new Set<string>()
  const result: { identity: string; strategy_name: string; category: string; instrument: string }[] = []
  for (const ann of annotations) {
    const id = patternIdentity(ann)
    if (seen.has(id)) continue
    seen.add(id)
    result.push({ identity: id, strategy_name: ann.strategy_name, category: ann.category || '', instrument: ann.instrument })
  }
  return result
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const PAGE: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100vh',
  background: '#0d1117', color: '#e6edf3', fontFamily: 'monospace', overflow: 'hidden',
}
const HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
  background: '#161b22', borderBottom: '1px solid #30363d', flexWrap: 'wrap', flexShrink: 0,
}
const TOOLBAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
  background: '#161b22', borderBottom: '1px solid #30363d', flexWrap: 'wrap', flexShrink: 0,
}
const inputStyle: CSSProperties = {
  background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 6, padding: '5px 10px', fontSize: 12,
}
const selectStyle: CSSProperties = { ...inputStyle }

function btn(color: string, disabled = false): CSSProperties {
  return {
    background: disabled ? '#21262d' : color,
    color: disabled ? '#484f58' : '#fff',
    border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600,
  }
}
function toolBtn(active: boolean): CSSProperties {
  return {
    background: active ? '#21262d' : 'transparent',
    border: `1px solid ${active ? '#8b949e' : '#30363d'}`,
    color: active ? '#e6edf3' : '#8b949e',
    borderRadius: 6, padding: '4px 10px', fontSize: 11,
    cursor: 'pointer', fontWeight: active ? 700 : 400,
  }
}
function paneToolBtn(active: boolean): CSSProperties {
  return {
    padding: '3px 8px', fontSize: 11, borderRadius: 4,
    border: `1px solid ${active ? '#f0883e' : '#30363d'}`,
    background: active ? '#2a1a0a' : 'transparent',
    color: active ? '#f0883e' : '#8b949e',
    cursor: 'pointer',
  }
}
function colorDot(key: string): string { return MARKER_COLORS[key]?.color ?? '#8b949e' }

// ── Annotation tool definitions ───────────────────────────────────────────────

const TOOL_OPTIONS = [
  { key: 'entry-underlying', label: '▲ Entry UL', type: 'entry' as const, instrument: 'underlying' as const },
  { key: 'exit-underlying',  label: '▼ Exit UL',  type: 'exit'  as const, instrument: 'underlying' as const },
  { key: 'entry-CE',         label: '▲ Entry CE', type: 'entry' as const, instrument: 'CE'         as const },
  { key: 'exit-CE',          label: '▼ Exit CE',  type: 'exit'  as const, instrument: 'CE'         as const },
  { key: 'entry-PE',         label: '▲ Entry PE', type: 'entry' as const, instrument: 'PE'         as const },
  { key: 'exit-PE',          label: '▼ Exit PE',  type: 'exit'  as const, instrument: 'PE'         as const },
]

// ── Option pane data model ────────────────────────────────────────────────────

interface OptionPane {
  id: number
  right: 'CE' | 'PE'
  strike: number
  expiry: string
  candles: OHLCCandle[]
}

// ── ChartPane — full-featured pane with EMA + drawing tools ──────────────────

interface ChartPaneProps {
  candles: OHLCCandle[]
  annotations: PatternAnnotation[]
  activeStrategy: string | null
  activeCategory: string | null
  label: string
  onBarClick: (time: number, price: number) => void
  readonly?: boolean
  onMaximize?: () => void
  isMaximized?: boolean
  onRemove?: () => void
  topPatterns?: TopPatterns
}

function ChartPane({
  candles, annotations, activeStrategy, activeCategory, label, onBarClick,
  readonly = false, onMaximize, isMaximized = false, onRemove, topPatterns,
}: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const drawModeRef = useRef<DrawMode>('none')
  const drawPtsRef = useRef<{ time: number; price: number }[]>([])
  const drawingsRef = useRef<Drawing[]>([])
  const ignoreNextClickRef = useRef(false)
  const drawDropdownRef = useRef<HTMLDivElement>(null)
  const onBarClickRef = useRef(onBarClick)
  onBarClickRef.current = onBarClick

  const [showEma, setShowEma] = useState(true)
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [drawStep, setDrawStep] = useState(0)
  const [drawingCount, setDrawingCount] = useState(0)
  const [drawDropdownOpen, setDrawDropdownOpen] = useState(false)

  useEffect(() => { drawModeRef.current = drawMode }, [drawMode])

  useEffect(() => {
    if (!drawDropdownOpen) return
    const close = (e: MouseEvent) => {
      if (drawDropdownRef.current && !drawDropdownRef.current.contains(e.target as Node))
        setDrawDropdownOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [drawDropdownOpen])

  // Chart init — runs once on mount
  useEffect(() => {
    if (!containerRef.current) return
    const initW = containerRef.current.clientWidth || 800
    const initH = containerRef.current.clientHeight || 300
    const chart = createChart(containerRef.current, {
      width: initW, height: initH,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#1e2732' }, horzLines: { color: '#1e2732' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149', borderVisible: false,
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    chartRef.current = chart
    seriesRef.current = series
    ema9Ref.current = e9
    ema21Ref.current = e21

    chart.subscribeClick(param => {
      if (!param.point || !seriesRef.current) return
      if (ignoreNextClickRef.current) { ignoreNextClickRef.current = false; return }
      const price = seriesRef.current.coordinateToPrice(param.point.y)
      if (price === null || !param.time) return
      const time = param.time as number
      const mode = drawModeRef.current

      if (!readonly && mode === 'hline') {
        const line = seriesRef.current.createPriceLine({
          price, color: '#e6edf3', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: price.toFixed(0),
        })
        drawingsRef.current.push({ type: 'hline', ref: line })
        setDrawingCount(c => c + 1)
        setDrawMode('none')
      } else if (!readonly && mode === 'trendline') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]; setDrawStep(1)
        } else {
          const p1 = pts[0]
          const s = chartRef.current!.addLineSeries({ color: '#ffa657', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          s.setData([
            { time: Math.min(p1.time, time) as Time, value: p1.time <= time ? p1.price : price },
            { time: Math.max(p1.time, time) as Time, value: p1.time <= time ? price : p1.price },
          ])
          drawingsRef.current.push({ type: 'trendline', refs: [s] })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []; setDrawStep(0); setDrawMode('none')
        }
      } else if (!readonly && mode === 'fibretracement') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]; setDrawStep(1)
        } else {
          const p1 = pts[0]
          const tStart = Math.min(p1.time, time) as Time
          const tEnd = Math.max(p1.time, time) as Time
          const pLow = Math.min(p1.price, price)
          const range = Math.max(p1.price, price) - pLow
          const fibRefs: ISeriesApi<'Line'>[] = []
          for (const lvl of FIB_LEVELS) {
            const lvlPrice = pLow + range * lvl.ratio
            const ls = chartRef.current!.addLineSeries({ color: lvl.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
            ls.setData([{ time: tStart, value: lvlPrice }, { time: tEnd, value: lvlPrice }])
            fibRefs.push(ls)
          }
          drawingsRef.current.push({ type: 'fibretracement', refs: fibRefs })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []; setDrawStep(0); setDrawMode('none')
        }
      } else if (!readonly && mode === 'channel') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]; setDrawStep(1)
        } else if (pts.length === 1) {
          drawPtsRef.current = [...pts, { time, price }]; setDrawStep(2)
        } else {
          const [p1, p2] = pts
          const tStart = Math.min(p1.time, p2.time) as Time
          const tEnd = Math.max(p1.time, p2.time) as Time
          const baseStartPrice = p1.time <= p2.time ? p1.price : p2.price
          const baseEndPrice = p1.time <= p2.time ? p2.price : p1.price
          const timeDiff = (tEnd as number) - (tStart as number)
          const slope = timeDiff !== 0 ? (baseEndPrice - baseStartPrice) / timeDiff : 0
          const lineAt = (t: number) => baseStartPrice + slope * (t - (tStart as number))
          const offset = price - lineAt(time)
          const baseline = chartRef.current!.addLineSeries({ color: '#ffa657', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          baseline.setData([{ time: tStart, value: baseStartPrice }, { time: tEnd, value: baseEndPrice }])
          const parallel = chartRef.current!.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          parallel.setData([{ time: tStart, value: baseStartPrice + offset }, { time: tEnd, value: baseEndPrice + offset }])
          drawingsRef.current.push({ type: 'channel', refs: [baseline, parallel] })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []; setDrawStep(0); setDrawMode('none')
        }
      } else if (mode === 'none' && !readonly) {
        onBarClickRef.current(time, price)
      }
    })

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    ro.observe(containerRef.current)

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ema9Ref.current?.applyOptions({ visible: showEma })
    ema21Ref.current?.applyOptions({ visible: showEma })
  }, [showEma])

  useEffect(() => {
    if (!seriesRef.current || !ema9Ref.current || !ema21Ref.current) return
    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    seriesRef.current.setData(data)
    chartRef.current?.timeScale().fitContent()

    const closes = candles.map(c => c.close)
    const ema9vals = computeEMA(closes, 9)
    const ema21vals = computeEMA(closes, 21)
    const e9data: LineData[] = [], e21data: LineData[] = []
    for (let i = 0; i < candles.length; i++) {
      if (ema9vals[i] !== null) e9data.push({ time: candles[i].time as Time, value: ema9vals[i]! })
      if (ema21vals[i] !== null) e21data.push({ time: candles[i].time as Time, value: ema21vals[i]! })
    }
    ema9Ref.current.setData(e9data)
    ema21Ref.current.setData(e21data)
  }, [candles])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setMarkers(buildMarkers(annotations, activeStrategy, activeCategory, topPatterns))
  }, [annotations, activeStrategy, activeCategory, topPatterns])

  const enterDrawMode = useCallback((mode: DrawMode) => {
    setDrawDropdownOpen(false)
    setDrawMode(prev => prev === mode ? 'none' : mode)
    drawPtsRef.current = []
    setDrawStep(0)
    ignoreNextClickRef.current = false
  }, [])

  const clearLastDrawing = useCallback(() => {
    const drawing = drawingsRef.current.pop()
    if (!drawing) return
    if (drawing.type === 'hline') {
      try { seriesRef.current?.removePriceLine(drawing.ref) } catch { /* disposed */ }
    } else {
      for (const s of drawing.refs) try { chartRef.current?.removeSeries(s) } catch { /* disposed */ }
    }
    setDrawingCount(c => c - 1)
    setDrawMode('none')
    drawPtsRef.current = []
    setDrawStep(0)
  }, [])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      border: '1px solid #30363d', borderRadius: 6, overflow: 'hidden', flex: 1, minHeight: 0,
    }}>
      {/* Per-pane toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
        background: '#161b22', borderBottom: '1px solid #21262d', flexShrink: 0, flexWrap: 'wrap',
        position: 'relative',
      }}>
        <span style={{ fontSize: 11, color: '#8b949e', marginRight: 4 }}>{label}</span>
        <button onClick={() => setShowEma(v => !v)} style={paneToolBtn(showEma)}>EMA 9/21</button>
        {!readonly && (
          <>
            <div style={{ position: 'relative' }} ref={drawDropdownRef}>
              <button
                onClick={() => setDrawDropdownOpen(v => !v)}
                style={paneToolBtn(drawMode !== 'none')}
              >{DRAW_LABEL[drawMode] ?? 'Draw'} ▾</button>
              {drawDropdownOpen && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, zIndex: 200,
                  background: '#161b22', border: '1px solid #30363d',
                  borderRadius: 4, minWidth: 160, marginTop: 2,
                }}>
                  {([
                    { mode: 'hline' as DrawMode,          label: '─ Horizontal Line' },
                    { mode: 'trendline' as DrawMode,      label: '↗ Trend Line' },
                    { mode: 'fibretracement' as DrawMode, label: '◫ Fib Retracement' },
                    { mode: 'channel' as DrawMode,        label: '⊟ Parallel Channel' },
                  ]).map(({ mode: m, label: l }) => (
                    <div
                      key={m}
                      onMouseDown={() => { if (m !== drawModeRef.current) ignoreNextClickRef.current = true }}
                      onClick={() => enterDrawMode(m)}
                      style={{
                        padding: '5px 10px', cursor: 'pointer', fontSize: 11,
                        color: drawMode === m ? '#f0883e' : '#e6edf3',
                        background: drawMode === m ? '#2a1a0a' : 'transparent',
                      }}
                    >{l}</div>
                  ))}
                </div>
              )}
            </div>
            {drawingCount > 0 && (
              <button onClick={clearLastDrawing} style={paneToolBtn(false)}>Clear</button>
            )}
            {drawMode !== 'none' && (
              <span style={{ fontSize: 11, color: '#f0883e' }}>
                {drawMode === 'hline' && 'Click to place'}
                {drawMode === 'trendline' && (drawStep === 0 ? 'Click pt 1' : 'Click pt 2')}
                {drawMode === 'fibretracement' && (drawStep === 0 ? 'Click start' : 'Click end')}
                {drawMode === 'channel' && (drawStep === 0 ? 'Click start' : drawStep === 1 ? 'Click end' : 'Click offset')}
              </span>
            )}
          </>
        )}
        {readonly && <span style={{ fontSize: 10, color: '#484f58', marginLeft: 4 }}>read-only</span>}

        {/* Maximize + remove buttons — right-aligned */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {onMaximize && (
            <button
              onClick={e => { e.stopPropagation(); onMaximize() }}
              title={isMaximized ? 'Restore pane layout' : 'Maximize this pane'}
              style={{ ...paneToolBtn(isMaximized), padding: '2px 7px', fontSize: 13 }}
            >{isMaximized ? '⤡' : '⤢'}</button>
          )}
          {onRemove && (
            <button
              onClick={e => { e.stopPropagation(); onRemove() }}
              title="Remove this pane"
              style={{ padding: '2px 7px', fontSize: 13, borderRadius: 4, border: '1px solid #30363d', background: 'transparent', color: '#8b949e', cursor: 'pointer' }}
            >✕</button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          flex: 1, minHeight: 0, width: '100%',
          cursor: (!readonly && drawMode !== 'none') ? 'crosshair' : 'default',
        }}
      />
    </div>
  )
}

// ── Gallery card ───────────────────────────────────────────────────────────────

interface GalleryCardProps {
  chart: PatternChartMeta
  activeStrategy: string | null
  onLoad: (chartId: string) => void
  onDelete: (chartId: string) => void
  viewMode: boolean
}

function GalleryCard({ chart, activeStrategy: _activeStrategy, onLoad, onDelete, viewMode }: GalleryCardProps) {
  const [confirming, setConfirming] = useState(false)
  const instrBadge = chart.instrument_type === 'options' ? (chart.right ?? 'OPT') : 'EQ'
  const canDelete = chart.can_delete !== false

  const rankBadges: { rank: string; label: string; color: string }[] = []
  const tp = chart.top_patterns
  if (tp?.top_1) rankBadges.push({ rank: 'top_1', label: '🥇 Top 1', color: '#FFD700' })
  if (tp?.top_2) rankBadges.push({ rank: 'top_2', label: '🥈 Top 2', color: '#C0C0C0' })
  if (tp?.bottom_1) rankBadges.push({ rank: 'bottom_1', label: '❌ Worst', color: '#ff4444' })

  return (
    <div
      style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 12,
        cursor: viewMode ? 'pointer' : 'default',
      }}
      onClick={viewMode ? () => onLoad(chart.chart_id) : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{chart.symbol}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {!canDelete && (
            <span style={{
              fontSize: 10, background: '#21262d', borderRadius: 4, padding: '2px 6px',
              color: '#8b949e',
            }}>Shared</span>
          )}
          <span style={{
            fontSize: 10, background: '#21262d', borderRadius: 4, padding: '2px 6px',
            color: instrBadge === 'EQ' ? '#3b82f6' : instrBadge === 'CE' ? '#22c55e' : '#7c3aed',
          }}>{instrBadge}</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>{chart.date}</div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: '#22c55e' }}>▲ {chart.entry_count}</span>
        <span style={{ color: '#ef4444' }}>▼ {chart.exit_count}</span>
      </div>
      {rankBadges.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
          {rankBadges.map(rb => (
            <span key={rb.rank} style={{
              fontSize: 10, background: '#0d1117', borderRadius: 4, padding: '2px 6px',
              color: rb.color, border: `1px solid ${rb.color}40`,
            }}>{rb.label}</span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Cat: {chart.categories?.join(' · ') || '—'}
      </div>
      <div style={{ fontSize: 12, color: '#484f58', marginBottom: viewMode ? 0 : 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Strat: {chart.strategy_names.join(' · ') || '—'}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          style={btn('#1f6feb')}
          onClick={e => { e.stopPropagation(); onLoad(chart.chart_id) }}
        >Load</button>
        {canDelete && (confirming
          ? <button
              style={btn('#b62324')}
              onClick={e => { e.stopPropagation(); onDelete(chart.chart_id); setConfirming(false) }}
            >Sure?</button>
          : <button
              style={btn('#484f58')}
              onClick={e => { e.stopPropagation(); setConfirming(true) }}
            >Del</button>
        )}
      </div>
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SUPPORTED_SYMBOLS = ['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW']
const STRIKE_INTERVALS: Record<string, number> = { NIFTY: 50, BSESEN: 100, RELIND: 5, TATMOT: 5, TATPOW: 5 }
const DAYS_BACK = 2
const GALLERY_MAX_COLUMNS = 6
const GALLERY_CARD_MIN_WIDTH = 220

function galleryGridStyle(columns: number): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: 10,
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PatternLibrary() {
  const [mode, setMode] = useState<'create' | 'view'>('create')

  // Form
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState(() => {
    const d = new Date()
    if (d.getDay() === 0) d.setDate(d.getDate() - 2)
    if (d.getDay() === 6) d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>('equity')
  const [otmOffset, setOtmOffset] = useState(0)
  const [intervalMinutes] = useState(3)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Chart data — underlying + dynamic option panes
  const [equityCandles, setEquityCandles] = useState<OHLCCandle[]>([])
  const [optionPanes, setOptionPanes] = useState<OptionPane[]>([])
  const [resolvedExpiry, setResolvedExpiry] = useState<string | null>(null)
  const [resolvedAtm, setResolvedAtm] = useState<number | null>(null)
  const [chartLoaded, setChartLoaded] = useState(false)

  // Maximize — 'underlying' | pane numeric id | null
  const [maximizedPaneId, setMaximizedPaneId] = useState<'underlying' | number | null>(null)

  // Add-pane controls
  const [addPaneRight, setAddPaneRight] = useState<'CE' | 'PE'>('CE')
  const [addPaneStrike, setAddPaneStrike] = useState('')
  const [addingPane, setAddingPane] = useState(false)
  const [addPaneError, setAddPaneError] = useState<string | null>(null)
  const [addPaneSuccess, setAddPaneSuccess] = useState<string | null>(null)

  // Pane ID counter
  const paneIdRef = useRef(1)

  // Annotations
  const [annotations, setAnnotations] = useState<PatternAnnotation[]>([])
  const [activeToolKey, setActiveToolKey] = useState<string>('entry-CE')

  // Top Patterns
  const [topPatterns, setTopPatterns] = useState<TopPatterns>({})

  // Strategies / Categories
  const [strategies, setStrategies] = useState<string[]>([])
  const [activeStrategy, setActiveStrategy] = useState<string>('')
  const [newStrategyName, setNewStrategyName] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState<string>('')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [notes, setNotes] = useState('')

  // Persistence
  const [currentChartId, setCurrentChartId] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // Gallery
  const [galleryCharts, setGalleryCharts] = useState<PatternChartMeta[]>([])
  const [galleryStrategy, setGalleryStrategy] = useState<string>('')
  const [galleryCategory, setGalleryCategory] = useState<string>('')
  const [galleryTopOnly, setGalleryTopOnly] = useState(false)
  const [viewExpandedId, setViewExpandedId] = useState<string | null>(null)
  const [galleryColumns, setGalleryColumns] = useState(1)
  const galleryResizeObserverRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    api.patternListStrategies().then(r => setStrategies(r.strategies)).catch(() => {})
    api.patternListCategories().then(r => setCategories(r.categories)).catch(() => {})
  }, [])

  const refreshGallery = useCallback(async (strat?: string, cat?: string, topOnly?: boolean) => {
    try {
      const s = strat !== undefined ? strat : galleryStrategy
      const c = cat !== undefined ? cat : galleryCategory
      const t = topOnly !== undefined ? topOnly : galleryTopOnly
      const res = await api.patternListCharts(s || undefined, c || undefined, t)
      setGalleryCharts(res.charts)
    } catch { /* non-fatal */ }
  }, [galleryStrategy, galleryCategory, galleryTopOnly])

  useEffect(() => { refreshGallery() }, [galleryStrategy, galleryCategory, galleryTopOnly])

  const attachGalleryRef = useCallback((node: HTMLDivElement | null) => {
    galleryResizeObserverRef.current?.disconnect()
    galleryResizeObserverRef.current = null

    if (!node) return

    const updateColumns = () => {
      const width = node.clientWidth || 0
      const columns = width > 0
        ? Math.max(1, Math.min(GALLERY_MAX_COLUMNS, Math.floor((width + 10) / (GALLERY_CARD_MIN_WIDTH + 10))))
        : 1
      setGalleryColumns(columns)
    }

    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(node)
    galleryResizeObserverRef.current = observer
  }, [])

  useEffect(() => () => {
    galleryResizeObserverRef.current?.disconnect()
    galleryResizeObserverRef.current = null
  }, [])

  // ── Load chart ────────────────────────────────────────────────────────────

  const handleLoadChart = useCallback(async () => {
    setLoadError(null)
    setLoading(true)
    setChartLoaded(false)
    setAnnotations([])
    setCurrentChartId(null)
    setEquityCandles([])
    setOptionPanes([])
    setResolvedExpiry(null)
    setResolvedAtm(null)
    setMaximizedPaneId(null)
    setAddPaneError(null)
    paneIdRef.current = 1

    try {
      const eqPromise = api.patternOhlcEquity(symbol, date, intervalMinutes, DAYS_BACK)

      let newPanes: OptionPane[] = []
      let expiry: string | null = null
      let atm: number | null = null

      if (instrumentType === 'options') {
        const [priceRes, expiryRes] = await Promise.all([
          api.getPriceAt(symbol, date, '09:15'),
          api.getExpiry(symbol, date),
        ])
        expiry = expiryRes.expiry
        const interval = STRIKE_INTERVALS[symbol] ?? 50
        atm = Math.round(priceRes.price / interval) * interval
        const ceStrike = atm + otmOffset * interval
        const peStrike = atm - otmOffset * interval

        const [ceRes, peRes] = await Promise.all([
          api.patternOhlcOptions(symbol, date, ceStrike, expiry, 'CE', intervalMinutes, DAYS_BACK),
          api.patternOhlcOptions(symbol, date, peStrike, expiry, 'PE', intervalMinutes, DAYS_BACK),
        ])
        newPanes = [
          { id: paneIdRef.current++, right: 'CE', strike: ceStrike, expiry, candles: ceRes.candles },
          { id: paneIdRef.current++, right: 'PE', strike: peStrike, expiry, candles: peRes.candles },
        ]
        setAddPaneStrike(String(atm))
      }

      const eqRes = await eqPromise
      setEquityCandles(eqRes.candles)
      setOptionPanes(newPanes)
      setResolvedExpiry(expiry)
      setResolvedAtm(atm)

      const firstCe = newPanes.find(p => p.right === 'CE')
      const existing = await api.patternGetChartByDate(symbol, date, instrumentType, firstCe ? 'CE' : undefined)
      if (existing) {
        setAnnotations(existing.annotations)
        setCurrentChartId(existing.chart_id)
        setNotes(existing.notes ?? '')
        setTopPatterns(existing.top_patterns || {})
        if (existing.annotations.length > 0) {
          const firstAnn = existing.annotations[0]
          setActiveStrategy(firstAnn.strategy_name)
          setActiveCategory(firstAnn.category || '')
        }
      }
      setChartLoaded(true)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load chart')
    } finally {
      setLoading(false)
    }
  }, [symbol, date, instrumentType, otmOffset, intervalMinutes])

  // ── Add option pane ───────────────────────────────────────────────────────

  const handleAddPane = useCallback(async () => {
    if (!resolvedExpiry) return
    const strike = parseInt(addPaneStrike)
    if (isNaN(strike) || strike <= 0) { setAddPaneError('Enter a valid strike price'); return }
    setAddingPane(true)
    setAddPaneError(null)
    setAddPaneSuccess(null)
    try {
      const res = await api.patternOhlcOptions(symbol, date, strike, resolvedExpiry, addPaneRight, intervalMinutes, DAYS_BACK)
      const newPane: OptionPane = {
        id: paneIdRef.current++,
        right: addPaneRight,
        strike,
        expiry: resolvedExpiry,
        candles: res.candles,
      }
      setOptionPanes(prev => [...prev, newPane])
      setAddPaneSuccess(`✓ ${addPaneRight} ${strike} pane added`)
      setTimeout(() => setAddPaneSuccess(null), 2500)
    } catch (err) {
      setAddPaneError(err instanceof Error ? err.message : 'Failed to load options data')
    } finally {
      setAddingPane(false)
    }
  }, [resolvedExpiry, addPaneStrike, addPaneRight, symbol, date, intervalMinutes])

  // ── Remove option pane ────────────────────────────────────────────────────

  const handleRemovePane = useCallback((id: number) => {
    setOptionPanes(prev => prev.filter(p => p.id !== id))
    setMaximizedPaneId(prev => prev === id ? null : prev)
  }, [])

  // ── Maximize ──────────────────────────────────────────────────────────────

  const handleMaximize = useCallback((id: 'underlying' | number) => {
    setMaximizedPaneId(prev => prev === id ? null : id)
  }, [])

  // ── Bar click ─────────────────────────────────────────────────────────────

  const handleBarClick = useCallback((time: number, price: number) => {
    if (!chartLoaded) return
    const strategy = activeStrategy || newStrategyName.trim()
    const category = activeCategory || newCategoryName.trim()
    if (!category) { alert('Please select or type a category name before annotating.'); return }
    if (!strategy) { alert('Please select or type a strategy name before annotating.'); return }
    const tool = TOOL_OPTIONS.find(t => t.key === activeToolKey)
    if (!tool) return
    const id = crypto.randomUUID()
    const ann: PatternAnnotation = {
      id, time, price, type: tool.type, instrument: tool.instrument,
      strategy_name: strategy,
      category,
      text: `${category} — ${strategy} (${tool.type} ${tool.instrument})`,
    }
    setAnnotations(prev => {
      const dup = prev.find(a => a.time === time && a.instrument === tool.instrument && a.strategy_name === strategy && a.category === category && a.type === tool.type)
      if (dup) return prev.filter(a => a.id !== dup.id)
      return [...prev, ann]
    })
  }, [chartLoaded, activeStrategy, newStrategyName, activeCategory, newCategoryName, activeToolKey])

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    const strategy = activeStrategy || newStrategyName.trim()
    const category = activeCategory || newCategoryName.trim()
    if (!category) { alert('Please specify a category before saving.'); return }
    if (!strategy) { alert('Please specify a strategy name before saving.'); return }
    setSaveMsg(null)
    const firstCe = optionPanes.find(p => p.right === 'CE')
    try {
      let saved: PatternChart
      const cleanTopPatterns: TopPatterns = {}
      if (topPatterns.top_1) cleanTopPatterns.top_1 = topPatterns.top_1
      if (topPatterns.top_2) cleanTopPatterns.top_2 = topPatterns.top_2
      if (topPatterns.bottom_1) cleanTopPatterns.bottom_1 = topPatterns.bottom_1
      if (currentChartId) {
        saved = await api.patternUpdateChart(currentChartId, annotations, notes, Object.keys(cleanTopPatterns).length ? cleanTopPatterns : undefined)
      } else {
        saved = await api.patternCreateChart({
          symbol, date, instrument_type: instrumentType, annotations, notes,
          right: firstCe ? 'CE' : undefined,
          strike: firstCe?.strike,
          top_patterns: Object.keys(cleanTopPatterns).length ? cleanTopPatterns : undefined,
        })
        setCurrentChartId(saved.chart_id)
      }
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(null), 2000)
      const [strats, cats] = await Promise.all([
        api.patternListStrategies(),
        api.patternListCategories(),
      ])
      setStrategies(strats.strategies)
      setCategories(cats.categories)
      if (!activeStrategy && newStrategyName.trim()) {
        setActiveStrategy(newStrategyName.trim())
        setNewStrategyName('')
      }
      if (!activeCategory && newCategoryName.trim()) {
        setActiveCategory(newCategoryName.trim())
        setNewCategoryName('')
      }
      await refreshGallery()
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    }
  }, [currentChartId, annotations, notes, symbol, date, instrumentType, optionPanes, activeStrategy, newStrategyName, activeCategory, newCategoryName, topPatterns, refreshGallery])

  // ── Gallery load ──────────────────────────────────────────────────────────

  const handleGalleryLoad = useCallback(async (chartId: string) => {
    setLoadError(null)
    try {
      const chart = await api.patternGetChart(chartId)
      setSymbol(chart.symbol)
      setDate(chart.date)
      setInstrumentType(chart.instrument_type as 'equity' | 'options')
      setNotes(chart.notes ?? '')
      setCurrentChartId(chart.chart_id)
      setAnnotations(chart.annotations)
      setTopPatterns(chart.top_patterns || {})
      setOptionPanes([])
      setResolvedExpiry(null)
      setResolvedAtm(null)
      setMaximizedPaneId(null)
      paneIdRef.current = 1

      if (chart.annotations.length > 0) {
        if (mode === 'view') {
          setActiveStrategy('')
          setActiveCategory('')
        } else {
          const firstAnn = chart.annotations[0]
          setActiveStrategy(firstAnn.strategy_name)
          setActiveCategory(firstAnn.category || '')
        }
      }

      const eqRes = await api.patternOhlcEquity(chart.symbol, chart.date, intervalMinutes, DAYS_BACK)
      setEquityCandles(eqRes.candles)

      if (chart.instrument_type === 'options' && chart.strike) {
        try {
          const expiryRes = await api.getExpiry(chart.symbol, chart.date)
          const expiry = expiryRes.expiry
          const [ceRes, peRes] = await Promise.all([
            api.patternOhlcOptions(chart.symbol, chart.date, chart.strike, expiry, 'CE', intervalMinutes, DAYS_BACK).catch(() => null),
            api.patternOhlcOptions(chart.symbol, chart.date, chart.strike, expiry, 'PE', intervalMinutes, DAYS_BACK).catch(() => null),
          ])
          const annotatedRights = new Set(chart.annotations.map(a => a.instrument))
          const newPanes: OptionPane[] = []
          if (ceRes && annotatedRights.has('CE')) newPanes.push({ id: paneIdRef.current++, right: 'CE', strike: chart.strike, expiry, candles: ceRes.candles })
          if (peRes && annotatedRights.has('PE')) newPanes.push({ id: paneIdRef.current++, right: 'PE', strike: chart.strike, expiry, candles: peRes.candles })
          setOptionPanes(newPanes)
          setResolvedExpiry(expiry)
          setAddPaneStrike(String(chart.strike))
        } catch { /* non-fatal */ }
      }
      setChartLoaded(true)
      if (mode === 'view') setViewExpandedId(chartId)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load chart')
    }
  }, [intervalMinutes, mode])

  // ── Gallery delete ────────────────────────────────────────────────────────

  const handleGalleryDelete = useCallback(async (chartId: string) => {
    try {
      await api.patternDeleteChart(chartId)
      if (currentChartId === chartId) { setCurrentChartId(null); setAnnotations([]); setChartLoaded(false) }
      if (viewExpandedId === chartId) setViewExpandedId(null)
      await refreshGallery()
      const [strats, cats] = await Promise.all([
        api.patternListStrategies(),
        api.patternListCategories(),
      ])
      setStrategies(strats.strategies)
      setCategories(cats.categories)
    } catch { /* non-fatal */ }
  }, [currentChartId, viewExpandedId, refreshGallery])

  // ── Derived ───────────────────────────────────────────────────────────────

  const resolvedActiveStrategy = activeStrategy || null
  const resolvedActiveCategory = activeCategory || null
  const hasOptions = optionPanes.length > 0

  // ── Chart area renderer ───────────────────────────────────────────────────

  const renderCharts = (isReadonly: boolean) => {
    if (!chartLoaded) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58', fontSize: 13 }}>
          {loading ? 'Loading…' : 'Select symbol, date and click Load Chart to begin.'}
        </div>
      )
    }

    // Visibility rules based on maximized pane
    const showUnderlying = maximizedPaneId === null || maximizedPaneId === 'underlying'
    const showOptionsRow = maximizedPaneId === null || typeof maximizedPaneId === 'number'

    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: 8, overflow: 'hidden' }}>
        {/* Underlying pane */}
        <div style={{
          display: showUnderlying ? 'flex' : 'none',
          flex: hasOptions ? 2 : 1, minHeight: 0,
        }}>
          <ChartPane
            candles={equityCandles}
            annotations={annotations.filter(a => a.instrument === 'underlying')}
            activeStrategy={resolvedActiveStrategy}
            activeCategory={resolvedActiveCategory}
            label={`${symbol} — Underlying (${intervalMinutes}min)`}
            onBarClick={handleBarClick}
            readonly={isReadonly}
            onMaximize={() => handleMaximize('underlying')}
            isMaximized={maximizedPaneId === 'underlying'}
            topPatterns={topPatterns}
          />
        </div>

        {/* Options panes row */}
        {hasOptions && (
          <div style={{
            display: showOptionsRow ? 'flex' : 'none',
            flex: 3, minHeight: 0, gap: 4,
          }}>
            {optionPanes.map(pane => (
              <div key={pane.id} style={{
                display: (maximizedPaneId === null || maximizedPaneId === pane.id) ? 'flex' : 'none',
                flex: 1, minWidth: 0, minHeight: 0,
              }}>
                <ChartPane
                  candles={pane.candles}
                  annotations={annotations.filter(a => a.instrument === pane.right)}
                  activeStrategy={resolvedActiveStrategy}
                  activeCategory={resolvedActiveCategory}
                  label={`${symbol} ${pane.right} ${pane.strike} (${intervalMinutes}min)`}
                  onBarClick={handleBarClick}
                  readonly={isReadonly}
                  onMaximize={() => handleMaximize(pane.id)}
                  isMaximized={maximizedPaneId === pane.id}
                  onRemove={!isReadonly ? () => handleRemovePane(pane.id) : undefined}
                  topPatterns={topPatterns}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Add-pane strip (create mode only) ─────────────────────────────────────

  const renderAddPaneStrip = () => {
    if (!chartLoaded || instrumentType !== 'options' || !resolvedExpiry) return null
    const interval = STRIKE_INTERVALS[symbol] ?? 50
    const strikeNum = parseInt(addPaneStrike)
    const snapStrike = isNaN(strikeNum) ? null : Math.round(strikeNum / interval) * interval
    return (
      <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
        background: '#161b22', borderTop: '1px solid #30363d', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 11, color: '#8b949e' }}>Add pane:</span>
        {(['CE', 'PE'] as const).map(r => (
          <button key={r}
            style={{ ...btn(addPaneRight === r ? (r === 'CE' ? '#1a472a' : '#2d1b69') : '#21262d'), border: `1px solid ${r === 'CE' ? '#238636' : '#6e40c9'}`, fontSize: 11, padding: '3px 10px' }}
            onClick={() => setAddPaneRight(r)}>{r}</button>
        ))}
        <input
          type="number"
          value={addPaneStrike}
          onChange={e => setAddPaneStrike(e.target.value)}
          placeholder="Strike"
          style={{ ...inputStyle, width: 90 }}
          step={interval}
        />
        {snapStrike !== null && snapStrike !== strikeNum && (
          <span style={{ fontSize: 11, color: '#484f58' }}>→ {snapStrike}</span>
        )}
        {resolvedAtm !== null && (
          <span style={{ fontSize: 11, color: '#484f58' }}>ATM: {resolvedAtm}</span>
        )}
        <button
          style={btn('#1f6feb', addingPane || !addPaneStrike)}
          onClick={handleAddPane}
          disabled={addingPane || !addPaneStrike}
        >{addingPane ? 'Loading…' : '+ Add Pane'}</button>
      </div>
      {(addPaneError || addPaneSuccess) && (
        <div style={{ padding: '4px 12px', fontSize: 12, fontWeight: 600, color: addPaneError ? '#f85149' : '#3fb950', background: '#161b22', borderTop: '1px solid #21262d' }}>
          {addPaneError ?? addPaneSuccess}
        </div>
      )}
      </>
    )
  }

  // ── Gallery section ───────────────────────────────────────────────────────

  const renderGallery = (compact: boolean) => (
    <div
      ref={attachGalleryRef}
      style={{
      borderTop: compact ? '1px solid #30363d' : undefined,
      background: '#0d1117', padding: '12px 16px',
      flex: compact ? '0 0 auto' : 1,
      maxHeight: compact ? 220 : undefined,
      overflow: 'auto',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>Gallery</span>
        <select value={galleryCategory} onChange={e => setGalleryCategory(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={galleryStrategy} onChange={e => setGalleryStrategy(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
          <option value="">All strategies</option>
          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ fontSize: 11, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={galleryTopOnly} onChange={e => setGalleryTopOnly(e.target.checked)}
            style={{ accentColor: '#f0883e' }} />
          Top Patterns Only
        </label>
        <span style={{ fontSize: 11, color: '#484f58' }}>{galleryCharts.length} chart{galleryCharts.length !== 1 ? 's' : ''}</span>
      </div>
      {galleryCharts.length === 0 ? (
        <div style={{ fontSize: 12, color: '#484f58' }}>
          {galleryStrategy ? `No charts for "${galleryStrategy}".` : 'No saved charts yet.'}
        </div>
      ) : (
        <>
          <div style={galleryGridStyle(galleryColumns)}>
            {galleryCharts.map(chart => (
              <GalleryCard
                key={chart.chart_id}
                chart={chart}
                activeStrategy={galleryStrategy || null}
                onLoad={handleGalleryLoad}
                onDelete={handleGalleryDelete}
                viewMode={mode === 'view'}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={HEADER}>
        <span style={{ fontSize: 14, fontWeight: 700, marginRight: 4 }}>Pattern Library</span>

        {(['create', 'view'] as const).map(m => (
          <button key={m}
            style={{ ...btn(mode === m ? '#1f6feb' : '#21262d'), border: '1px solid #30363d' }}
            onClick={() => setMode(m)}>
            {m === 'create' ? '✏ Create' : '👁 View'}
          </button>
        ))}

        {mode === 'create' && (
          <>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} style={selectStyle} disabled={loading}>
              {SUPPORTED_SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input type="date" value={date} max={new Date().toISOString().slice(0, 10)}
              onChange={e => setDate(e.target.value)} style={inputStyle} disabled={loading} />
            <div style={{ display: 'flex', gap: 4 }}>
              {(['equity', 'options'] as const).map(t => (
                <button key={t}
                  style={{ ...btn(instrumentType === t ? '#1f6feb' : '#21262d'), border: '1px solid #30363d' }}
                  onClick={() => !loading && setInstrumentType(t)}>
                  {t === 'equity' ? 'Equity' : 'Options'}
                </button>
              ))}
            </div>
            {instrumentType === 'options' && (
              <label style={{ fontSize: 12, color: '#8b949e' }}>
                OTM&nbsp;
                <input type="number" value={otmOffset} min={-10} max={10}
                  onChange={e => setOtmOffset(parseInt(e.target.value) || 0)}
                  style={{ ...inputStyle, width: 55 }} disabled={loading} />
              </label>
            )}
            <button style={btn('#1f6feb', loading || !date)} onClick={handleLoadChart} disabled={loading || !date}>
              {loading ? 'Loading…' : 'Load Chart'}
            </button>
            {loadError && <span style={{ color: '#f85149', fontSize: 12 }}>{loadError}</span>}
          </>
        )}
        {mode === 'view' && loadError && (
          <span style={{ color: '#f85149', fontSize: 12 }}>{loadError}</span>
        )}
      </div>

      {/* Annotation toolbar — create mode only */}
      {mode === 'create' && (
        <div style={TOOLBAR}>
          <span style={{ fontSize: 11, color: '#8b949e', marginRight: 4 }}>Category:</span>
          <select value={activeCategory} onChange={e => { setActiveCategory(e.target.value); setNewCategoryName('') }}
            style={{ ...selectStyle, minWidth: 160 }}>
            <option value="">— select or type new —</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {!activeCategory && (
            <input placeholder="New category name…" value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              style={{ ...inputStyle, width: 180 }} />
          )}
          <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />
          <span style={{ fontSize: 11, color: '#8b949e', marginRight: 4 }}>Strategy:</span>
          <select value={activeStrategy} onChange={e => { setActiveStrategy(e.target.value); setNewStrategyName('') }}
            style={{ ...selectStyle, minWidth: 160 }}>
            <option value="">— select or type new —</option>
            {strategies.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {!activeStrategy && (
            <input placeholder="New strategy name…" value={newStrategyName}
              onChange={e => setNewStrategyName(e.target.value)}
              style={{ ...inputStyle, width: 180 }} />
          )}
          <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />
          {TOOL_OPTIONS.map(t => (
            <button key={t.key}
              style={{ ...toolBtn(activeToolKey === t.key), borderLeft: `3px solid ${colorDot(t.key)}` }}
              onClick={() => setActiveToolKey(t.key)}>
              {t.label}
            </button>
          ))}
          <button style={btn('#484f58', annotations.length === 0)} onClick={() => setAnnotations(prev => prev.slice(0, -1))} disabled={annotations.length === 0}>
            ↩ Undo Last
          </button>
          <button style={btn('#484f58', annotations.length === 0)} onClick={() => setAnnotations([])} disabled={annotations.length === 0}>
            ✕ Clear All
          </button>
          <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />
          <input placeholder="Notes…" value={notes} onChange={e => setNotes(e.target.value)}
            style={{ ...inputStyle, width: 180 }} />
          <button style={btn('#238636', !chartLoaded)} onClick={handleSave} disabled={!chartLoaded}>
            Save Annotations
          </button>
          {saveMsg && <span style={{ fontSize: 12, color: saveMsg === 'Saved!' ? '#3fb950' : '#f85149' }}>{saveMsg}</span>}
          {currentChartId && <span style={{ fontSize: 11, color: '#484f58' }}>chart saved</span>}
        </div>
      )}

      {/* Top Pattern ranking toolbar — create mode only */}
      {mode === 'create' && chartLoaded && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          background: '#0d1117', borderBottom: '1px solid #30363d', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, color: '#f0883e', fontWeight: 700, marginRight: 4 }}>🏆 Top Patterns</span>
          {getUniquePatterns(annotations).length === 0 && (
            <span style={{ fontSize: 11, color: '#484f58' }}>Add annotations to assign pattern rankings</span>
          )}
          {(['top_1', 'top_2', 'bottom_1'] as const).map(rank => {
            const selected = topPatterns[rank]
            const label = rank === 'top_1' ? '🥇 Top 1' : rank === 'top_2' ? '🥈 Top 2' : '❌ Bottom 1'
            const options = getUniquePatterns(annotations)
            return (
              <div key={rank} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: '#8b949e' }}>{label}:</span>
                <select
                  value={selected ? patternIdentity({ strategy_name: selected.strategy_name, category: selected.category, instrument: selected.instrument } as PatternAnnotation) : ''}
                  onChange={e => {
                    const val = e.target.value
                    setTopPatterns(prev => {
                      const next = { ...prev }
                      if (!val) {
                        delete next[rank]
                      } else {
                        const parts = val.split('::')
                        next[rank] = { strategy_name: parts[0], category: parts[1], instrument: parts[2] }
                      }
                      return next
                    })
                  }}
                  style={{ ...selectStyle, minWidth: 200 }}
                >
                  <option value="">— none —</option>
                  {options.map(opt => (
                    <option key={opt.identity} value={opt.identity}>
                      {opt.category}/{opt.strategy_name} ({opt.instrument})
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      )}

      {/* Body */}
      {mode === 'create' ? (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {renderCharts(false)}
        </div>
        {renderAddPaneStrip()}
      </div>
    ) : (
        /* View mode */
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {viewExpandedId && chartLoaded ? (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                background: '#161b22', borderBottom: '1px solid #30363d', flexShrink: 0,
              }}>
                <span style={{ fontSize: 12, color: '#8b949e' }}>
                  {symbol} · {date} · {instrumentType}
                  {optionPanes.length > 0 ? ` · ${optionPanes.map(p => `${p.right} ${p.strike}`).join(' / ')}` : ''}
                </span>
                <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />
                <span style={{ fontSize: 11, color: '#8b949e' }}>Filter:</span>
                <select value={activeCategory} onChange={e => setActiveCategory(e.target.value)}
                  style={{ ...selectStyle, minWidth: 140 }}>
                  <option value="">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={activeStrategy} onChange={e => setActiveStrategy(e.target.value)}
                  style={{ ...selectStyle, minWidth: 140 }}>
                  <option value="">All strategies</option>
                  {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                <button style={btn('#484f58')} onClick={() => { setViewExpandedId(null); setChartLoaded(false) }}>
                  ✕ Close
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {renderCharts(true)}
              </div>
              <div style={{ flexShrink: 0, maxHeight: 240, overflow: 'auto', borderTop: '1px solid #30363d' }}>
                {renderGallery(true)}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Gallery</span>
                <select value={galleryCategory} onChange={e => setGalleryCategory(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
                  <option value="">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={galleryStrategy} onChange={e => setGalleryStrategy(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
                  <option value="">All strategies</option>
                  {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <label style={{ fontSize: 11, color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={galleryTopOnly} onChange={e => setGalleryTopOnly(e.target.checked)}
                    style={{ accentColor: '#f0883e' }} />
                  Top Patterns Only
                </label>
                <span style={{ fontSize: 11, color: '#484f58' }}>{galleryCharts.length} chart{galleryCharts.length !== 1 ? 's' : ''}</span>
              </div>
              {galleryCharts.length === 0 ? (
                <div style={{ fontSize: 12, color: '#484f58' }}>No saved charts yet. Switch to Create mode to add charts.</div>
              ) : (
                <>
                  <div style={galleryGridStyle(galleryColumns)}>
                    {galleryCharts.map(chart => (
                      <GalleryCard
                        key={chart.chart_id}
                        chart={chart}
                        activeStrategy={galleryStrategy || null}
                        onLoad={handleGalleryLoad}
                        onDelete={handleGalleryDelete}
                        viewMode={true}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
