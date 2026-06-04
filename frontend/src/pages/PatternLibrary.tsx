/**
 * Pattern Library — Trade Pattern Logger (Phase XII)
 *
 * Full-day historical chart viewer with click-to-annotate functionality.
 * Annotations are tagged per strategy; multiple strategies can co-exist on
 * one chart. Gallery shows all saved charts for the selected strategy.
 */
import { useState, useEffect, useRef, useCallback, CSSProperties } from 'react'
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time, SeriesMarker } from 'lightweight-charts'
import api, {
  PatternAnnotation,
  PatternChart,
  PatternChartMeta,
  OHLCCandle,
} from '../services/api'

// ── Colour scheme ─────────────────────────────────────────────────────────────

const MARKER_COLORS: Record<string, { color: string; shape: 'arrowUp' | 'arrowDown' }> = {
  'entry-underlying': { color: '#3b82f6', shape: 'arrowUp' },
  'exit-underlying':  { color: '#f97316', shape: 'arrowDown' },
  'entry-CE':         { color: '#22c55e', shape: 'arrowUp' },
  'exit-CE':          { color: '#ef4444', shape: 'arrowDown' },
  'entry-PE':         { color: '#14b8a6', shape: 'arrowUp' },
  'exit-PE':          { color: '#7c3aed', shape: 'arrowDown' },
}

function markerKey(type: string, instrument: string) {
  return `${type}-${instrument}`
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PAGE: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100vh',
  background: '#0d1117', color: '#e6edf3', fontFamily: 'monospace',
  overflow: 'hidden',
}

const HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
  background: '#161b22', borderBottom: '1px solid #30363d', flexWrap: 'wrap',
}

const TOOLBAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
  background: '#161b22', borderBottom: '1px solid #30363d', flexWrap: 'wrap',
}

const CHART_AREA: CSSProperties = {
  flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column',
  minHeight: 0,
}

const GALLERY: CSSProperties = {
  borderTop: '1px solid #30363d', background: '#0d1117',
  padding: '12px 16px', minHeight: 180,
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

function colorDot(key: string): string {
  return MARKER_COLORS[key]?.color ?? '#8b949e'
}

// ── Annotation toolbar options ─────────────────────────────────────────────────

const TOOL_OPTIONS: { key: string; label: string; type: 'entry' | 'exit'; instrument: 'underlying' | 'CE' | 'PE' }[] = [
  { key: 'entry-underlying', label: '▲ Entry UL', type: 'entry', instrument: 'underlying' },
  { key: 'exit-underlying',  label: '▼ Exit UL',  type: 'exit',  instrument: 'underlying' },
  { key: 'entry-CE',         label: '▲ Entry CE', type: 'entry', instrument: 'CE' },
  { key: 'exit-CE',          label: '▼ Exit CE',  type: 'exit',  instrument: 'CE' },
  { key: 'entry-PE',         label: '▲ Entry PE', type: 'entry', instrument: 'PE' },
  { key: 'exit-PE',          label: '▼ Exit PE',  type: 'exit',  instrument: 'PE' },
]

// ── LightweightCharts helpers ─────────────────────────────────────────────────

function buildMarkers(
  annotations: PatternAnnotation[],
  activeStrategy: string | null,
): SeriesMarker<Time>[] {
  return annotations
    .slice()
    .sort((a, b) => a.time - b.time)
    .map(ann => {
      const cfg = MARKER_COLORS[markerKey(ann.type, ann.instrument)] ?? { color: '#8b949e', shape: 'arrowUp' as const }
      const dimmed = activeStrategy !== null && ann.strategy_name !== activeStrategy
      return {
        time: ann.time as Time,
        position: ann.type === 'entry' ? 'belowBar' : 'aboveBar',
        color: dimmed ? '#3d4450' : cfg.color,
        shape: cfg.shape,
        text: dimmed ? '' : ann.strategy_name.slice(0, 10),
        size: dimmed ? 1 : 2,
      } as SeriesMarker<Time>
    })
}

// ── Single chart pane ─────────────────────────────────────────────────────────

interface ChartPaneProps {
  candles: OHLCCandle[]
  annotations: PatternAnnotation[]  // ALL annotations for this chart
  activeStrategy: string | null
  label: string
  onBarClick: (time: number, price: number) => void
  height?: number
}

function ChartPane({ candles, annotations, activeStrategy, label, onBarClick, height = 320 }: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: '#0d1117' }, textColor: '#e6edf3' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)

    // Click handler: find candle at clicked time
    chart.subscribeClick(param => {
      if (!param.time || !seriesRef.current) return
      const time = param.time as number
      const logicalIndex = chart.timeScale().coordinateToLogical(param.point?.x ?? 0) ?? 0
      const bar = seriesRef.current.dataByIndex(Math.round(logicalIndex)) as (CandlestickData & { time: number }) | null
      if (bar) onBarClick(time, bar.close)
    })

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update candles
  useEffect(() => {
    if (!seriesRef.current) return
    const data: CandlestickData[] = candles.map(c => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    seriesRef.current.setData(data)
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  // Update markers
  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setMarkers(buildMarkers(annotations, activeStrategy))
  }, [annotations, activeStrategy])

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#8b949e', padding: '4px 8px', background: '#161b22' }}>
        {label}
      </div>
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  )
}

// ── Gallery card ───────────────────────────────────────────────────────────────

interface GalleryCardProps {
  chart: PatternChartMeta
  activeStrategy: string | null
  onLoad: (chartId: string) => void
  onDelete: (chartId: string) => void
}

function GalleryCard({ chart, activeStrategy, onLoad, onDelete }: GalleryCardProps) {
  const [confirming, setConfirming] = useState(false)
  const entryCount = activeStrategy
    ? chart.entry_count   // already filtered server-side
    : chart.entry_count
  const exitCount = activeStrategy ? chart.exit_count : chart.exit_count
  const instrBadge = chart.instrument_type === 'options'
    ? (chart.right ?? 'OPT')
    : 'EQ'

  return (
    <div style={{
      background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
      padding: 12, minWidth: 190, maxWidth: 220,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{chart.symbol}</span>
        <span style={{
          fontSize: 10, background: '#21262d', borderRadius: 4, padding: '2px 6px',
          color: instrBadge === 'EQ' ? '#3b82f6' : instrBadge === 'CE' ? '#22c55e' : '#7c3aed',
        }}>{instrBadge}</span>
      </div>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>{chart.date}</div>
      <div style={{ display: 'flex', gap: 8, fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: '#22c55e' }}>▲ {entryCount}</span>
        <span style={{ color: '#ef4444' }}>▼ {exitCount}</span>
      </div>
      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {chart.strategy_names.join(' · ') || '—'}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btn('#1f6feb')} onClick={() => onLoad(chart.chart_id)}>Load</button>
        {confirming
          ? <button style={btn('#b62324')} onClick={() => { onDelete(chart.chart_id); setConfirming(false) }}>Sure?</button>
          : <button style={btn('#484f58')} onClick={() => setConfirming(true)}>Del</button>
        }
      </div>
    </div>
  )
}

// ── Main PatternLibrary page ────────────────────────────────────────────────────

const SUPPORTED_SYMBOLS = ['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW']
const STRIKE_INTERVALS: Record<string, number> = { NIFTY: 50, BSESEN: 100, RELIND: 5, TATMOT: 5, TATPOW: 5 }

export default function PatternLibrary() {
  // ── Form state ──────────────────────────────────────────────────────────────
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

  // ── Loaded chart data ───────────────────────────────────────────────────────
  const [equityCandles, setEquityCandles] = useState<OHLCCandle[]>([])
  const [optionsCandles, setOptionsCandles] = useState<OHLCCandle[]>([])
  const [optionsMeta, setOptionsMeta] = useState<{ strike: number; expiry: string; right: string } | null>(null)
  const [chartLoaded, setChartLoaded] = useState(false)

  // ── Annotation state ────────────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<PatternAnnotation[]>([])
  const [activeToolKey, setActiveToolKey] = useState<string>('entry-CE')

  // ── Strategy state ──────────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState<string[]>([])
  const [activeStrategy, setActiveStrategy] = useState<string>('')
  const [newStrategyName, setNewStrategyName] = useState('')
  const [notes, setNotes] = useState('')

  // ── Persistence ─────────────────────────────────────────────────────────────
  const [currentChartId, setCurrentChartId] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // ── Gallery ──────────────────────────────────────────────────────────────────
  const [galleryCharts, setGalleryCharts] = useState<PatternChartMeta[]>([])
  const [galleryStrategy, setGalleryStrategy] = useState<string>('')
  const [galleryPage, setGalleryPage] = useState(0)
  const GALLERY_PAGE_SIZE = 6

  // ── Load strategies on mount ─────────────────────────────────────────────────
  useEffect(() => {
    api.patternListStrategies()
      .then(r => setStrategies(r.strategies))
      .catch(() => {})
  }, [])

  // ── Reload gallery when gallery strategy changes ──────────────────────────────
  const refreshGallery = useCallback(async (strat?: string) => {
    try {
      const s = strat ?? galleryStrategy
      const res = await api.patternListCharts(s || undefined)
      setGalleryCharts(res.charts)
      setGalleryPage(0)
    } catch { /* non-fatal */ }
  }, [galleryStrategy])

  useEffect(() => { refreshGallery() }, [galleryStrategy]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load chart (OHLC + existing annotations) ─────────────────────────────────
  const handleLoadChart = useCallback(async () => {
    setLoadError(null)
    setLoading(true)
    setChartLoaded(false)
    setAnnotations([])
    setCurrentChartId(null)
    setEquityCandles([])
    setOptionsCandles([])
    setOptionsMeta(null)

    try {
      // Always load equity candles
      const eqRes = await api.patternOhlcEquity(symbol, date, intervalMinutes)
      setEquityCandles(eqRes.candles)

      let resolvedRight: string | undefined

      if (instrumentType === 'options') {
        // Resolve strike from price at market open
        const priceRes = await api.getPriceAt(symbol, date, '09:15')
        const interval = STRIKE_INTERVALS[symbol] ?? 50
        const atm = Math.round(priceRes.price / interval) * interval
        const strike = atm + otmOffset * interval
        const expiryRes = await api.getExpiry(symbol, date)
        // Show CE side when OTM ≥ 0, PE when OTM < 0 (default CE for 0)
        const right = otmOffset < 0 ? 'PE' : 'CE'
        const optRes = await api.patternOhlcOptions(symbol, date, strike, expiryRes.expiry, right, intervalMinutes)
        setOptionsCandles(optRes.candles)
        setOptionsMeta({ strike, expiry: expiryRes.expiry, right })
        resolvedRight = right
      }

      // Check if an existing chart record exists for this date/symbol
      const existing = await api.patternGetChartByDate(symbol, date, instrumentType, resolvedRight)
      if (existing) {
        setAnnotations(existing.annotations)
        setCurrentChartId(existing.chart_id)
        setNotes(existing.notes ?? '')
      }

      setChartLoaded(true)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load chart')
    } finally {
      setLoading(false)
    }
  }, [symbol, date, instrumentType, otmOffset, intervalMinutes])

  // ── Annotation: click on chart ────────────────────────────────────────────────
  const handleBarClick = useCallback((time: number, price: number) => {
    if (!chartLoaded) return
    const strategy = activeStrategy || newStrategyName.trim()
    if (!strategy) {
      alert('Please select or type a strategy name before annotating.')
      return
    }
    const tool = TOOL_OPTIONS.find(t => t.key === activeToolKey)
    if (!tool) return

    const id = crypto.randomUUID()
    const ann: PatternAnnotation = {
      id,
      time,
      price,
      type: tool.type,
      instrument: tool.instrument,
      strategy_name: strategy,
      text: `${tool.type.charAt(0).toUpperCase() + tool.type.slice(1)} ${tool.instrument} — ${strategy}`,
    }

    // Double-click (within 300ms of identical timestamp) removes instead
    setAnnotations(prev => {
      const existing = prev.find(a => a.time === time && a.instrument === tool.instrument && a.strategy_name === strategy && a.type === tool.type)
      if (existing) return prev.filter(a => a.id !== existing.id)
      return [...prev, ann]
    })
  }, [chartLoaded, activeStrategy, newStrategyName, activeToolKey])

  // ── Save annotations ──────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const strategy = activeStrategy || newStrategyName.trim()
    if (!strategy) {
      alert('Please specify a strategy name before saving.')
      return
    }
    setSaveMsg(null)
    try {
      let saved: PatternChart
      if (currentChartId) {
        saved = await api.patternUpdateChart(currentChartId, annotations, notes)
      } else {
        saved = await api.patternCreateChart({
          symbol, date,
          instrument_type: instrumentType,
          annotations,
          notes,
          right: optionsMeta?.right,
          strike: optionsMeta?.strike,
        })
        setCurrentChartId(saved.chart_id)
      }
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(null), 2000)

      // Refresh strategy list and gallery
      const strats = await api.patternListStrategies()
      setStrategies(strats.strategies)
      if (!activeStrategy && newStrategyName.trim()) {
        setActiveStrategy(newStrategyName.trim())
        setNewStrategyName('')
      }
      await refreshGallery()
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    }
  }, [currentChartId, annotations, notes, symbol, date, instrumentType, optionsMeta, activeStrategy, newStrategyName, refreshGallery])

  // ── Load chart from gallery ───────────────────────────────────────────────────
  const handleGalleryLoad = useCallback(async (chartId: string) => {
    try {
      const chart = await api.patternGetChart(chartId)
      setSymbol(chart.symbol)
      setDate(chart.date)
      setInstrumentType(chart.instrument_type as 'equity' | 'options')
      setNotes(chart.notes ?? '')
      setCurrentChartId(chart.chart_id)
      setAnnotations(chart.annotations)
      // Load the OHLC for this chart
      const eqRes = await api.patternOhlcEquity(chart.symbol, chart.date, intervalMinutes)
      setEquityCandles(eqRes.candles)
      if (chart.instrument_type === 'options' && chart.strike && chart.right) {
        try {
          const expiryRes = await api.getExpiry(chart.symbol, chart.date)
          const optRes = await api.patternOhlcOptions(chart.symbol, chart.date, chart.strike, expiryRes.expiry, chart.right, intervalMinutes)
          setOptionsCandles(optRes.candles)
          setOptionsMeta({ strike: chart.strike, expiry: expiryRes.expiry, right: chart.right })
        } catch { setOptionsCandles([]) }
      } else {
        setOptionsCandles([])
        setOptionsMeta(null)
      }
      setChartLoaded(true)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load chart from gallery')
    }
  }, [intervalMinutes])

  // ── Delete from gallery ───────────────────────────────────────────────────────
  const handleGalleryDelete = useCallback(async (chartId: string) => {
    try {
      await api.patternDeleteChart(chartId)
      if (currentChartId === chartId) {
        setCurrentChartId(null)
        setAnnotations([])
        setChartLoaded(false)
      }
      await refreshGallery()
      const strats = await api.patternListStrategies()
      setStrategies(strats.strategies)
    } catch { /* non-fatal */ }
  }, [currentChartId, refreshGallery])

  // ── Resolved active strategy (dropdown or new text) ───────────────────────────
  const resolvedActiveStrategy = activeStrategy || null

  // ── Gallery pagination ────────────────────────────────────────────────────────
  const galleryTotal = Math.ceil(galleryCharts.length / GALLERY_PAGE_SIZE)
  const galleryPage_ = Math.min(galleryPage, Math.max(0, galleryTotal - 1))
  const gallerySlice = galleryCharts.slice(galleryPage_ * GALLERY_PAGE_SIZE, (galleryPage_ + 1) * GALLERY_PAGE_SIZE)

  const hasOptions = instrumentType === 'options' && optionsCandles.length > 0

  return (
    <div style={PAGE}>
      {/* ── Header: load controls ── */}
      <div style={HEADER}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', marginRight: 8 }}>Pattern Library</span>

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
              {t.charAt(0).toUpperCase() + t.slice(1)}
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
      </div>

      {/* ── Annotation toolbar ── */}
      <div style={TOOLBAR}>
        {/* Strategy selector */}
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

        {/* Tool buttons */}
        {TOOL_OPTIONS.map(t => (
          <button key={t.key}
            style={{ ...toolBtn(activeToolKey === t.key), borderLeft: `3px solid ${colorDot(t.key)}` }}
            onClick={() => setActiveToolKey(t.key)}>
            {t.label}
          </button>
        ))}

        <button style={btn('#484f58', annotations.length === 0)} onClick={() => setAnnotations([])}
          disabled={annotations.length === 0} title="Clear all annotations">
          ✕ Clear All
        </button>

        <div style={{ width: 1, height: 16, background: '#30363d', margin: '0 4px' }} />

        <input placeholder="Notes…" value={notes} onChange={e => setNotes(e.target.value)}
          style={{ ...inputStyle, width: 180 }} />

        <button style={btn('#238636', !chartLoaded)} onClick={handleSave} disabled={!chartLoaded}>
          Save Annotations
        </button>

        {saveMsg && <span style={{ fontSize: 12, color: saveMsg === 'Saved!' ? '#3fb950' : '#f85149' }}>{saveMsg}</span>}

        {currentChartId && (
          <span style={{ fontSize: 11, color: '#484f58' }}>chart saved</span>
        )}
      </div>

      {/* ── Chart area ── */}
      <div style={CHART_AREA}>
        {!chartLoaded && !loading && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58', fontSize: 13 }}>
            Select symbol, date and click Load Chart to begin annotating.
          </div>
        )}
        {chartLoaded && (
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            <ChartPane
              candles={equityCandles}
              annotations={annotations.filter(a => a.instrument === 'underlying')}
              activeStrategy={resolvedActiveStrategy}
              label={`${symbol} — Underlying (3min)`}
              onBarClick={handleBarClick}
              height={hasOptions ? 240 : 380}
            />
            {hasOptions && optionsMeta && (
              <ChartPane
                candles={optionsCandles}
                annotations={annotations.filter(a => a.instrument === optionsMeta.right)}
                activeStrategy={resolvedActiveStrategy}
                label={`${symbol} ${optionsMeta.right} ${optionsMeta.strike} — Options (3min)`}
                onBarClick={handleBarClick}
                height={240}
              />
            )}
          </div>
        )}

        {/* ── Gallery ── */}
        <div style={GALLERY}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Gallery</span>
            <select value={galleryStrategy} onChange={e => setGalleryStrategy(e.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
              <option value="">All strategies</option>
              {strategies.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span style={{ fontSize: 11, color: '#484f58' }}>{galleryCharts.length} chart{galleryCharts.length !== 1 ? 's' : ''}</span>
          </div>

          {galleryCharts.length === 0 ? (
            <div style={{ fontSize: 12, color: '#484f58' }}>
              {galleryStrategy
                ? `No charts annotated with "${galleryStrategy}" yet.`
                : 'No saved charts yet. Load a chart and save annotations to begin.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {gallerySlice.map(chart => (
                  <GalleryCard
                    key={chart.chart_id}
                    chart={chart}
                    activeStrategy={galleryStrategy || null}
                    onLoad={handleGalleryLoad}
                    onDelete={handleGalleryDelete}
                  />
                ))}
              </div>
              {galleryTotal > 1 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <button style={btn('#21262d', galleryPage_ === 0)} onClick={() => setGalleryPage(p => Math.max(0, p - 1))} disabled={galleryPage_ === 0}>←</button>
                  <span style={{ fontSize: 12, color: '#8b949e' }}>Page {galleryPage_ + 1} of {galleryTotal}</span>
                  <button style={btn('#21262d', galleryPage_ >= galleryTotal - 1)} onClick={() => setGalleryPage(p => Math.min(galleryTotal - 1, p + 1))} disabled={galleryPage_ >= galleryTotal - 1}>→</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
