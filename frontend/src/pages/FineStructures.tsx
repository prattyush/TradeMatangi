import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, IChartApi, ISeriesApi, Time, LineStyle } from 'lightweight-charts'
import api, { FineDefinition, FlowStep, FineSearchResult, OHLCCandle } from '../services/api'
import { loadMaxPriceMode, loadMaxPriceThresholdCE, loadMaxPriceThresholdPE } from '../components/SettingsModal'

const STEP_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff',
  '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787',
]

const THRESHOLD_VALUES_NIFTY = [25, 50, 75, 100, 125, 150]
const THRESHOLD_VALUES_SENSEX = [50, 100, 150, 200, 250]

function thresholdValuesFor(symbol: string) {
  return symbol === 'BSESEN' ? THRESHOLD_VALUES_SENSEX : THRESHOLD_VALUES_NIFTY
}

function nextEMA(prev: number, close: number, k: number): number {
  return close * k + prev * (1 - k)
}

function computeEMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return []
  const result: (number | null)[] = []
  const k = 2 / (period + 1)
  let ema: number | null = null
  let warmup = 0, sum = 0
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

type DrawMode = 'none' | 'hline' | 'trendline' | 'fibretracement' | 'channel' | 'rrindicator'

type Drawing =
  | { type: 'hline'; ref: import('lightweight-charts').IPriceLine }
  | { type: 'trendline' | 'fibretracement' | 'channel' | 'rrindicator'; refs: ISeriesApi<'Line'>[] }

const FIB_LEVELS = [
  { ratio: 0, color: '#e6edf3' },
  { ratio: 0.25, color: '#34d399' },
  { ratio: 0.5, color: '#60a5fa' },
  { ratio: 0.75, color: '#fbbf24' },
  { ratio: 1.0, color: '#e6edf3' },
]

const DRAW_LABEL: Partial<Record<DrawMode, string>> = {
  hline: 'H-Line', trendline: 'Trend', fibretracement: 'Fib', channel: 'Channel', rrindicator: 'R:R',
}

const DRAW_ITEMS: { mode: DrawMode; label: string }[] = [
  { mode: 'hline', label: '─ Horizontal Line' },
  { mode: 'trendline', label: '↗ Trend Line' },
  { mode: 'fibretracement', label: '◫ Fib Retracement' },
  { mode: 'channel', label: '⊟ Parallel Channel' },
  { mode: 'rrindicator', label: '⚡ Risk:Reward' },
]

const btnStyle = (active = false): React.CSSProperties => ({
  padding: '4px 12px', fontSize: 12, borderRadius: 4,
  border: `1px solid ${active ? '#f0883e' : '#30363d'}`,
  background: active ? '#2a1a0a' : '#161b22',
  color: active ? '#f0883e' : '#8b949e', cursor: 'pointer',
})

const inputStyle: React.CSSProperties = {
  background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 4, padding: '4px 8px', fontSize: 12,
}

const selectStyle: React.CSSProperties = {
  ...inputStyle, maxWidth: 180,
}

// ── Definitions Sub-tab ──────────────────────────────────────────────────────

function DefinitionsView({ definitions, onRefresh }: {
  definitions: FineDefinition[]
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState<FineDefinition | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [subTypes, setSubTypes] = useState('')

  const startCreate = () => {
    setName('')
    setSubTypes('')
    setEditing(null)
    setCreating(true)
  }

  const startEdit = (d: FineDefinition) => {
    setName(d.name)
    setSubTypes(d.sub_types.join(', '))
    setCreating(false)
    setEditing(d)
  }

  const handleSave = async () => {
    const types = subTypes.split(',').map(s => s.trim()).filter(Boolean)
    if (!name.trim()) return
    try {
      if (editing) {
        await api.fineStructureUpdateDefinition(editing.definition_id, { name: name.trim(), sub_types: types })
      } else {
        await api.fineStructureCreateDefinition({ name: name.trim(), sub_types: types })
      }
      setCreating(false)
      setEditing(null)
      onRefresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const handleDelete = async (d: FineDefinition) => {
    if (!confirm(`Delete "${d.name}"?`)) return
    try {
      await api.fineStructureDeleteDefinition(d.definition_id)
      onRefresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, flex: 1, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>Structure Definitions</span>
        <button onClick={startCreate} style={btnStyle()}>+ Add Definition</button>
      </div>

      {(creating || editing) && (
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Structure name"
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              value={subTypes}
              onChange={e => setSubTypes(e.target.value)}
              placeholder="Sub-types (comma separated)"
              style={{ ...inputStyle, flex: 2 }}
            />
            <button onClick={handleSave} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>Save</button>
            <button onClick={() => { setCreating(false); setEditing(null) }} style={btnStyle()}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {definitions.map(d => (
          <div key={d.definition_id} style={{
            background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
            padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
            opacity: d.is_predefined ? 0.8 : 1,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', minWidth: 140 }}>
              {d.name}
            </span>
            <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
              {d.sub_types.map(st => (
                <span key={st} style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 10,
                  background: '#21262d', color: '#8b949e',
                }}>{st}</span>
              ))}
              {d.sub_types.length === 0 && (
                <span style={{ fontSize: 10, color: '#484f58' }}>no sub-types</span>
              )}
            </div>
            {d.is_predefined && (
              <span style={{ fontSize: 10, color: '#484f58' }}>system</span>
            )}
            {d.can_delete && (
              <>
                <button onClick={() => startEdit(d)} style={{ ...btnStyle(), padding: '2px 8px', fontSize: 11 }}>Edit</button>
                <button onClick={() => handleDelete(d)} style={{ ...btnStyle(), padding: '2px 8px', fontSize: 11, color: '#f85149', borderColor: '#f85149' }}>Delete</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Builder Sub-tab ──────────────────────────────────────────────────────────

function BuilderView({ definitions }: { definitions: FineDefinition[] }) {
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState('')
  const [candles, setCandles] = useState<OHLCCandle[]>([])
  const [steps, setSteps] = useState<(FlowStep & { color: string })[]>([])
  const [flowId, setFlowId] = useState<string | null>(null)
  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null)
  const activeStepIdxRef = useRef<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // Add step form
  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')

  const addDef = definitions.find(d => d.definition_id === addDefId)

  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const markerSeriesRefs = useRef<ISeriesApi<'Line'>[]>([])
  const [showEma, setShowEma] = useState(true)

  const drawModeRef = useRef<DrawMode>('none')
  const drawPtsRef = useRef<{ time: number; price: number }[]>([])
  const drawingsRef = useRef<Drawing[]>([])
  const ignoreNextClickRef = useRef(false)
  const drawDropdownRef = useRef<HTMLDivElement>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [drawStep, setDrawStep] = useState(0)
  const [drawingCount, setDrawingCount] = useState(0)
  const [drawDropdownOpen, setDrawDropdownOpen] = useState(false)

  useEffect(() => { drawModeRef.current = drawMode }, [drawMode])
  useEffect(() => { activeStepIdxRef.current = activeStepIdx }, [activeStepIdx])

  useEffect(() => {
    if (!drawDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (drawDropdownRef.current && !drawDropdownRef.current.contains(e.target as Node)) {
        setDrawDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [drawDropdownOpen])

  const loadChart = useCallback(async () => {
    if (!symbol || !date) return
    setLoading(true)
    try {
      const res = await api.fineStructureGetOHLC(symbol, date)
      setCandles(res.candles)
      if (res.flow) {
        setFlowId(res.flow.flow_id)
        setSteps(res.flow.steps.map((s, i) => ({ ...s, color: STEP_COLORS[i % STEP_COLORS.length] })))
      } else {
        setFlowId(null)
        setSteps([])
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load OHLC')
    } finally {
      setLoading(false)
    }
  }, [symbol, date])

  useEffect(() => {
    if (!chartContainerRef.current || candles.length === 0) return

    // Clean up old chart
    if (chartRef.current) {
      markerSeriesRefs.current = []
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 400,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    })

    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderUpColor: '#26a641', borderDownColor: '#f85149',
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    series.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))

    const closes = candles.map(c => c.close)
    const ema9Data = computeEMA(closes, 9)
    const ema21Data = computeEMA(closes, 21)

    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    e9.setData(candles.map((c, i) => ({ time: c.time as Time, value: ema9Data[i] })).filter((d): d is { time: Time; value: number } => d.value !== null))
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    e21.setData(candles.map((c, i) => ({ time: c.time as Time, value: ema21Data[i] })).filter((d): d is { time: Time; value: number } => d.value !== null))

    chartRef.current = chart
    seriesRef.current = series
    ema9Ref.current = e9
    ema21Ref.current = e21

    // Click handler for draw modes and transition bars
    chart.subscribeClick(param => {
      if (!param.point || !seriesRef.current) return
      if (ignoreNextClickRef.current) { ignoreNextClickRef.current = false; return }
      const price = seriesRef.current.coordinateToPrice(param.point.y)
      if (price === null || !param.time) return
      const time = param.time as number
      const mode = drawModeRef.current

      if (mode === 'hline') {
        const line = seriesRef.current.createPriceLine({
          price, color: '#e6edf3', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: price.toFixed(0),
        })
        drawingsRef.current.push({ type: 'hline', ref: line })
        setDrawingCount(c => c + 1)
        setDrawMode('none')
      } else if (mode === 'trendline') {
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
      } else if (mode === 'fibretracement') {
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
      } else if (mode === 'channel') {
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
      } else if (mode === 'rrindicator') {
        const pts = drawPtsRef.current
        if (pts.length === 0) {
          drawPtsRef.current = [{ time, price }]; setDrawStep(1)
        } else {
          const riskPrice = pts[0].price
          const entryPrice = price
          const isBuy = riskPrice < entryPrice
          const diff = Math.abs(entryPrice - riskPrice)
          const tStart = Math.min(pts[0].time, time) as Time
          const tEnd = Math.max(pts[0].time, time) as Time
          const levels: { price: number; color: number[] }[] = [
            { price: riskPrice, color: [248, 81, 73] },
            { price: entryPrice, color: [230, 237, 243] },
            { price: isBuy ? entryPrice + diff : entryPrice - diff, color: [63, 185, 80] },
            { price: isBuy ? entryPrice + diff * 1.5 : entryPrice - diff * 1.5, color: [88, 166, 255] },
            { price: isBuy ? entryPrice + diff * 2 : entryPrice - diff * 2, color: [188, 140, 255] },
          ]
          const rrRefs: ISeriesApi<'Line'>[] = []
          for (const lvl of levels) {
            const ls = chartRef.current!.addLineSeries({ color: `rgb(${lvl.color.join(',')})`, lineWidth: 3, priceLineVisible: false, lastValueVisible: false })
            ls.setData([{ time: tStart, value: lvl.price }, { time: tEnd, value: lvl.price }])
            rrRefs.push(ls)
          }
          drawingsRef.current.push({ type: 'rrindicator', refs: rrRefs })
          setDrawingCount(c => c + 1)
          drawPtsRef.current = []; setDrawStep(0); setDrawMode('none')
        }
      } else if (activeStepIdxRef.current !== null) {
        const idx = activeStepIdxRef.current
        setSteps(prev => {
          const next = [...prev]
          if (idx < next.length) {
            next[idx] = { ...next[idx], transition_bar_time: time }
          }
          return next
        })
      }
    })

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    ro.observe(chartContainerRef.current)

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [candles]) // eslint-disable-line react-hooks/exhaustive-deps

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
    switch (drawing.type) {
      case 'hline':
        try { seriesRef.current?.removePriceLine(drawing.ref) } catch { /* disposed */ }
        break
      default:
        for (const s of drawing.refs) try { chartRef.current?.removeSeries(s) } catch { /* disposed */ }
    }
    setDrawingCount(c => c - 1)
    setDrawMode('none')
    drawPtsRef.current = []
    setDrawStep(0)
  }, [])

  // EMA visibility toggle
  useEffect(() => {
    if (ema9Ref.current) ema9Ref.current.applyOptions({ visible: showEma })
    if (ema21Ref.current) ema21Ref.current.applyOptions({ visible: showEma })
  }, [showEma])

  // Update markers when steps change
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return
    for (const s of markerSeriesRefs.current) {
      try { chartRef.current.removeSeries(s) } catch { /* disposed */ }
    }
    markerSeriesRefs.current = []

    const markers: { time: Time; position: 'belowBar' | 'aboveBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string; size: number }[] = []
    for (const step of steps) {
      if (!step.transition_bar_time) continue
      const isBear = step.direction === 'Bear'
      markers.push({
        time: step.transition_bar_time as Time,
        position: isBear ? 'aboveBar' : 'belowBar',
        color: isBear ? '#f97316' : '#3b82f6',
        shape: isBear ? 'arrowDown' : 'arrowUp',
        text: step.name + (step.type ? `(${step.type})` : ''),
        size: 2,
      })
    }
    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as number) - (b.time as number))
      seriesRef.current.setMarkers(markers)
    } else {
      seriesRef.current.setMarkers([])
    }
  }, [steps])

  const addStep = () => {
    if (!addDefId || !addDef) return
    const step: FlowStep & { color: string } = {
      definition_id: addDefId,
      name: addDef.name,
      type: addType || undefined,
      direction: addDirection || undefined,
      color: STEP_COLORS[steps.length % STEP_COLORS.length],
    }
    setSteps(prev => [...prev, step])
    setAddDefId('')
    setAddType('')
    setAddDirection('')
  }

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx))
    if (activeStepIdx === idx) setActiveStepIdx(null)
    else if (activeStepIdx !== null && activeStepIdx > idx) setActiveStepIdx(activeStepIdx - 1)
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= steps.length) return
    setSteps(prev => {
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
    if (activeStepIdx === idx) setActiveStepIdx(target)
    else if (activeStepIdx === target) setActiveStepIdx(idx)
  }

  const handleSave = async () => {
    if (!symbol || !date || steps.length === 0) return
    const flowSteps: FlowStep[] = steps.map(({ color, ...s }) => s)
    try {
      if (flowId) {
        await api.fineStructureUpdateFlow(flowId, flowSteps)
      } else {
        const f = await api.fineStructureCreateFlow({ symbol, date, steps: flowSteps })
        setFlowId(f.flow_id)
      }
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(null), 2000)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center', flexShrink: 0, borderBottom: '1px solid #21262d' }}>
        <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" style={{ ...inputStyle, width: 100 }} />
        <input value={date} onChange={e => setDate(e.target.value)} type="date" style={{ ...inputStyle, width: 140 }} />
        <button onClick={loadChart} disabled={loading} style={btnStyle()}>{loading ? 'Loading...' : 'Load'}</button>
        <div style={{ flex: 1 }} />
        {saveMsg && <span style={{ fontSize: 12, color: '#3fb950' }}>{saveMsg}</span>}
        <button onClick={handleSave} disabled={steps.length === 0} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>
          {flowId ? 'Update Flow' : 'Save Flow'}
        </button>
      </div>

      {/* Main area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chart - left 60% */}
        <div style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#161b22', borderBottom: '1px solid #21262d', flexShrink: 0, flexWrap: 'wrap' }}>
            <button onClick={() => setShowEma(v => !v)} style={btnStyle(showEma)}>EMA 9/21</button>
            <div style={{ position: 'relative' }} ref={drawDropdownRef}>
              <button
                onClick={() => setDrawDropdownOpen(v => !v)}
                style={btnStyle(drawMode !== 'none')}
              >{DRAW_LABEL[drawMode] ?? 'Draw'} ▾</button>
              {drawDropdownOpen && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, zIndex: 200,
                  background: '#161b22', border: '1px solid #30363d',
                  borderRadius: 4, minWidth: 160, marginTop: 2,
                }}>
                  {DRAW_ITEMS.map(({ mode: m, label }) => (
                    <div
                      key={m}
                      onMouseDown={() => { if (m !== drawModeRef.current) ignoreNextClickRef.current = true }}
                      onClick={() => enterDrawMode(m)}
                      style={{
                        padding: '5px 10px', cursor: 'pointer', fontSize: 11,
                        color: drawMode === m ? '#f0883e' : '#e6edf3',
                        background: drawMode === m ? '#2a1a0a' : 'transparent',
                      }}
                    >{label}</div>
                  ))}
                </div>
              )}
            </div>
            {drawingCount > 0 && (
              <button onClick={clearLastDrawing} style={btnStyle(false)}>Clear</button>
            )}
            {drawMode !== 'none' && (
              <span style={{ fontSize: 11, color: '#f0883e' }}>
                {drawMode === 'hline' && 'Click to place'}
                {drawMode === 'trendline' && (drawStep === 0 ? 'Click pt 1' : 'Click pt 2')}
                {drawMode === 'fibretracement' && (drawStep === 0 ? 'Click start' : 'Click end')}
                {drawMode === 'channel' && (drawStep === 0 ? 'Click start' : drawStep === 1 ? 'Click end' : 'Click offset')}
                {drawMode === 'rrindicator' && (drawStep === 0 ? 'Click risk price' : 'Click entry price')}
              </span>
            )}
            {activeStepIdx !== null && drawMode === 'none' && (
              <span style={{ fontSize: 11, color: '#3fb950' }}>
                ⊕ Click chart to set transition bar for: {steps[activeStepIdx]?.name}
              </span>
            )}
          </div>
          <div ref={chartContainerRef} style={{ flex: 1, minHeight: 0, cursor: (drawMode !== 'none' || activeStepIdx !== null) ? 'crosshair' : 'default' }} />
        </div>

        {/* Steps panel - right 40% */}
        <div style={{ flex: 2, minWidth: 0, borderLeft: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>Flow Steps</span>
          </div>

          {/* Steps list */}
          <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
            {steps.map((step, idx) => (
              <div
                key={idx}
                onClick={() => setActiveStepIdx(activeStepIdx === idx ? null : idx)}
                style={{
                  background: activeStepIdx === idx ? '#2a1a0a' : '#0d1117',
                  border: `1px solid ${activeStepIdx === idx ? '#f0883e' : '#21262d'}`,
                  borderRadius: 6, padding: '6px 10px', marginBottom: 6,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span style={{ fontSize: 10, color: '#484f58', width: 16 }}>{idx + 1}</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: step.color,
                  padding: '1px 6px', borderRadius: 8, background: step.color + '20',
                }}>{step.name}</span>
                {step.type && (
                  <span style={{ fontSize: 10, color: '#8b949e', padding: '1px 5px', borderRadius: 8, background: '#21262d' }}>{step.type}</span>
                )}
                {step.direction && (
                  <span style={{ fontSize: 10, color: step.direction === 'Bull' ? '#3fb950' : '#f85149' }}>{step.direction}</span>
                )}
                {step.transition_bar_time && (
                  <span style={{ fontSize: 10, color: '#58a6ff' }}>
                    {new Date(step.transition_bar_time * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={e => { e.stopPropagation(); moveStep(idx, -1) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10 }}>↑</button>
                <button onClick={e => { e.stopPropagation(); moveStep(idx, 1) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10 }}>↓</button>
                <button onClick={e => { e.stopPropagation(); removeStep(idx) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10, color: '#f85149' }}>✕</button>
              </div>
            ))}
            {steps.length === 0 && (
              <div style={{ fontSize: 12, color: '#484f58', padding: 16, textAlign: 'center' }}>
                Add structures below to build the flow
              </div>
            )}
          </div>

          {/* Add step form */}
          <div style={{ padding: 8, borderTop: '1px solid #21262d', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} style={{ ...selectStyle, flex: 1 }}>
                <option value="">— Structure —</option>
                {definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}
              </select>
              {addDef && addDef.sub_types.length > 0 && (
                <select value={addType} onChange={e => setAddType(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">— Type (optional) —</option>
                  {addDef.sub_types.map(st => <option key={st} value={st}>{st}</option>)}
                </select>
              )}
              <select value={addDirection} onChange={e => setAddDirection(e.target.value)} style={{ ...selectStyle, width: 80 }}>
                <option value="">Dir</option>
                <option value="Bull">Bull</option>
                <option value="Bear">Bear</option>
              </select>
            </div>
            <button onClick={addStep} disabled={!addDefId} style={btnStyle()}>+ Add Step</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Options Builder Sub-tab ──────────────────────────────────────────────────

function OptionsBuilderView({ definitions }: { definitions: FineDefinition[] }) {
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState('')
  const [otmOffset, setOtmOffset] = useState(2)
  const [loading, setLoading] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const [underlyingCandles, setUnderlyingCandles] = useState<OHLCCandle[]>([])
  const [ceCandles, setCeCandles] = useState<OHLCCandle[]>([])
  const [peCandles, setPeCandles] = useState<OHLCCandle[]>([])
  const [ceStrike, setCeStrike] = useState<number | null>(null)
  const [peStrike, setPeStrike] = useState<number | null>(null)

  const [underlyingSteps, setUnderlyingSteps] = useState<(FlowStep & { color: string })[]>([])
  const [ceSteps, setCeSteps] = useState<(FlowStep & { color: string })[]>([])
  const [peSteps, setPeSteps] = useState<(FlowStep & { color: string })[]>([])
  const [underlyingFlowId, setUnderlyingFlowId] = useState<string | null>(null)
  const [ceFlowId, setCeFlowId] = useState<string | null>(null)
  const [peFlowId, setPeFlowId] = useState<string | null>(null)

  const [activeChart, setActiveChart] = useState<'underlying' | 'CE' | 'PE'>('underlying')
  const [maximizedChart, setMaximizedChart] = useState<'underlying' | 'CE' | 'PE' | null>(null)
  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null)

  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')
  const addDef = definitions.find(d => d.definition_id === addDefId)

  const strikeMode = loadMaxPriceMode()
  const isIndex = symbol === 'NIFTY' || symbol === 'BSESEN'
  const useMaxPrice = isIndex && strikeMode === 'threshold'
  const [maxPriceCE, setMaxPriceCE] = useState(loadMaxPriceThresholdCE())
  const [maxPricePE, setMaxPricePE] = useState(loadMaxPriceThresholdPE())

  const activeSteps = activeChart === 'underlying' ? underlyingSteps : activeChart === 'CE' ? ceSteps : peSteps
  const setActiveSteps = activeChart === 'underlying' ? setUnderlyingSteps : activeChart === 'CE' ? setCeSteps : setPeSteps
  const activeFlowId = activeChart === 'underlying' ? underlyingFlowId : activeChart === 'CE' ? ceFlowId : peFlowId

  const loadChart = useCallback(async () => {
    if (!symbol || !date) return
    setLoading(true)
    try {
      const undRes = await api.fineStructureGetOHLC(symbol, date)
      setUnderlyingCandles(undRes.candles)
      if (undRes.flow && undRes.flow.instrument_type === 'options') {
        setUnderlyingFlowId(undRes.flow.flow_id)
        setUnderlyingSteps(undRes.flow.steps.map((s, i) => ({ ...s, color: STEP_COLORS[i % STEP_COLORS.length] })))
      } else {
        setUnderlyingFlowId(null)
        setUnderlyingSteps([])
      }

      // Calculate ATM strike from first candle
      if (undRes.candles.length > 0) {
        const firstPrice = undRes.candles[0].open
        const interval = symbol === 'SENSEX' ? 100 : 50
        const atm = Math.round(firstPrice / interval) * interval

        let ceS: number, peS: number

        if (useMaxPrice) {
          // Max price mode: find strikes by premium threshold
          const expiryRes = await api.getExpiry(symbol, date)
          const refTime = '09:30:00'
          const [ceRes, peRes] = await Promise.all([
            api.findStrikeByPrice(symbol, date, expiryRes.expiry, 'CE', maxPriceCE, refTime),
            api.findStrikeByPrice(symbol, date, expiryRes.expiry, 'PE', maxPricePE, refTime),
          ])
          ceS = ceRes.strike
          peS = peRes.strike
        } else {
          // OTM offset mode
          ceS = atm + otmOffset * interval
          peS = atm - otmOffset * interval
        }

        setCeStrike(ceS)
        setPeStrike(peS)

        try {
          const ceRes = await api.fineStructureGetOptionsOHLC(symbol, date, ceS, undefined, 'CE')
          setCeCandles(ceRes.candles)
          if (ceRes.flow) {
            setCeFlowId(ceRes.flow.flow_id)
            setCeSteps(ceRes.flow.steps.map((s, i) => ({ ...s, color: STEP_COLORS[i % STEP_COLORS.length] })))
          } else {
            setCeFlowId(null)
            setCeSteps([])
          }
        } catch { setCeCandles([]); setCeSteps([]) }

        try {
          const peRes = await api.fineStructureGetOptionsOHLC(symbol, date, peS, undefined, 'PE')
          setPeCandles(peRes.candles)
          if (peRes.flow) {
            setPeFlowId(peRes.flow.flow_id)
            setPeSteps(peRes.flow.steps.map((s, i) => ({ ...s, color: STEP_COLORS[i % STEP_COLORS.length] })))
          } else {
            setPeFlowId(null)
            setPeSteps([])
          }
        } catch { setPeCandles([]); setPeSteps([]) }
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load OHLC')
    } finally {
      setLoading(false)
    }
  }, [symbol, date, otmOffset, useMaxPrice, maxPriceCE, maxPricePE])

  useEffect(() => { setActiveStepIdx(null) }, [activeChart])

  const addStep = () => {
    if (!addDefId || !addDef) return
    const step: FlowStep & { color: string } = {
      definition_id: addDefId,
      name: addDef.name,
      type: addType || undefined,
      direction: addDirection || undefined,
      color: STEP_COLORS[activeSteps.length % STEP_COLORS.length],
    }
    setActiveSteps(prev => [...prev, step])
    setAddDefId('')
    setAddType('')
    setAddDirection('')
  }

  const removeStep = (idx: number) => {
    setActiveSteps(prev => prev.filter((_, i) => i !== idx))
    if (activeStepIdx === idx) setActiveStepIdx(null)
    else if (activeStepIdx !== null && activeStepIdx > idx) setActiveStepIdx(activeStepIdx - 1)
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= activeSteps.length) return
    setActiveSteps(prev => {
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
    if (activeStepIdx === idx) setActiveStepIdx(target)
    else if (activeStepIdx === target) setActiveStepIdx(idx)
  }

  const handleSaveActive = async () => {
    if (!symbol || !date || activeSteps.length === 0) return
    setSaveMsg(null)
    try {
      const right = activeChart === 'CE' ? 'CE' : activeChart === 'PE' ? 'PE' : null
      const flowId = activeFlowId
      const flowSteps: FlowStep[] = activeSteps.map(({ color, ...s }) => s)
      if (flowId) {
        await api.fineStructureUpdateFlow(flowId, flowSteps)
      } else {
        const f = await api.fineStructureCreateFlow({ symbol, date, steps: flowSteps, instrument_type: 'options', right })
        if (right === 'CE') setCeFlowId(f.flow_id)
        else if (right === 'PE') setPeFlowId(f.flow_id)
        else setUnderlyingFlowId(f.flow_id)
      }
      setSaveMsg(`${activeChart} saved!`)
      setTimeout(() => setSaveMsg(null), 2000)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const chartTabs: { key: 'underlying' | 'CE' | 'PE'; label: string }[] = [
    { key: 'underlying', label: 'Underlying' },
  ]
  if (ceCandles.length > 0) chartTabs.push({ key: 'CE', label: `CE ${ceStrike}` })
  if (peCandles.length > 0) chartTabs.push({ key: 'PE', label: `PE ${peStrike}` })

  const renderChart = (key: 'underlying' | 'CE' | 'PE', candles: OHLCCandle[], steps: FlowStep[], compact = false) => {
    const isMax = maximizedChart === key
    const isActive = activeChart === key
    return (
      <div
        onClick={() => setActiveChart(key)}
        style={{
          flex: isMax ? 1 : undefined,
          minHeight: compact && !isMax ? 150 : undefined,
          display: 'flex', flexDirection: 'column',
          border: isActive ? '2px solid #f0883e' : '1px solid #21262d',
          borderRadius: 4, overflow: 'hidden', cursor: 'pointer',
          height: '100%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', background: '#161b22', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: isActive ? '#f0883e' : '#8b949e' }}>{key}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={e => { e.stopPropagation(); setMaximizedChart(isMax ? null : key) }}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 11, padding: '0 4px' }}
          >{isMax ? '⤡' : '⤢'}</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ResultChart candles={candles} steps={steps} />
        </div>
      </div>
    )
  }

  if (maximizedChart) {
    const candles = maximizedChart === 'underlying' ? underlyingCandles : maximizedChart === 'CE' ? ceCandles : peCandles
    const steps = maximizedChart === 'underlying' ? underlyingSteps : maximizedChart === 'CE' ? ceSteps : peSteps
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center', flexShrink: 0, borderBottom: '1px solid #21262d' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>{symbol} — {maximizedChart}</span>
          <button onClick={() => setMaximizedChart(null)} style={btnStyle()}>⤡ Restore</button>
          <div style={{ flex: 1 }} />
          {saveMsg && <span style={{ fontSize: 12, color: '#3fb950' }}>{saveMsg}</span>}
          <button onClick={handleSaveActive} disabled={activeSteps.length === 0} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>
            Save {activeChart}
          </button>
        </div>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ flex: 3, minWidth: 0 }}>{renderChart(maximizedChart, candles, steps)}</div>
          <div style={{ flex: 2, minWidth: 0, borderLeft: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>Flow Steps ({maximizedChart})</span>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
              {steps.map((step, idx) => (
                <div key={idx} style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 4, padding: '4px 8px', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                  <span style={{ color: '#484f58', width: 14 }}>{idx + 1}</span>
                  <span style={{ color: '#e6edf3', fontWeight: 600 }}>{step.name}</span>
                  {step.type && <span style={{ color: '#8b949e' }}>({step.type})</span>}
                </div>
              ))}
              {steps.length === 0 && <div style={{ fontSize: 10, color: '#484f58', padding: 8, textAlign: 'center' }}>No steps</div>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center', flexShrink: 0, borderBottom: '1px solid #21262d', flexWrap: 'wrap' }}>
        <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" style={{ ...inputStyle, width: 100 }} />
        <input value={date} onChange={e => setDate(e.target.value)} type="date" style={{ ...inputStyle, width: 140 }} />
        {useMaxPrice ? (
          <>
            <span style={{ fontSize: 11, color: '#8b949e' }}>CE:</span>
            <select value={maxPriceCE} onChange={e => setMaxPriceCE(Number(e.target.value))} style={{ ...selectStyle, width: 70, fontSize: 11 }}>
              {thresholdValuesFor(symbol).map(v => <option key={v} value={v}>₹{v}</option>)}
            </select>
            <span style={{ fontSize: 11, color: '#8b949e' }}>PE:</span>
            <select value={maxPricePE} onChange={e => setMaxPricePE(Number(e.target.value))} style={{ ...selectStyle, width: 70, fontSize: 11 }}>
              {thresholdValuesFor(symbol).map(v => <option key={v} value={v}>₹{v}</option>)}
            </select>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11, color: '#8b949e' }}>OTM:</span>
            <input value={otmOffset} onChange={e => setOtmOffset(parseInt(e.target.value) || 2)} type="number" min={1} style={{ ...inputStyle, width: 50 }} />
          </>
        )}
        <button onClick={loadChart} disabled={loading} style={btnStyle()}>{loading ? 'Loading...' : 'Load'}</button>
        <div style={{ flex: 1 }} />
        {saveMsg && <span style={{ fontSize: 12, color: '#3fb950' }}>{saveMsg}</span>}
        <button onClick={handleSaveActive} disabled={activeSteps.length === 0} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>
          Save {activeChart}
        </button>
      </div>

      {/* Main area: left charts, right flow steps */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left panel: charts */}
        <div style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 4 }}>
          {/* Underlying — 50% height */}
          <div style={{ flex: 1, minHeight: 0, marginBottom: 2 }}>
            {renderChart('underlying', underlyingCandles, underlyingSteps)}
          </div>
          {/* CE + PE — 50% height */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 2, marginTop: 2 }}>
            <div style={{ flex: 1, minWidth: 0 }}>{renderChart('CE', ceCandles, ceSteps, true)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>{renderChart('PE', peCandles, peSteps, true)}</div>
          </div>
        </div>

        {/* Right panel: flow steps */}
        <div style={{ flex: 2, minWidth: 0, borderLeft: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
            {chartTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveChart(tab.key)}
                style={{
                  padding: '3px 10px', fontSize: 11, fontWeight: 600,
                  background: 'transparent', border: 'none',
                  borderBottom: activeChart === tab.key ? '2px solid #f0883e' : '2px solid transparent',
                  color: activeChart === tab.key ? '#f0883e' : '#8b949e',
                  cursor: 'pointer',
                }}
              >{tab.label}</button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: '#484f58' }}>{activeSteps.length} steps</span>
          </div>
          {/* Steps list */}
          <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
            {activeSteps.map((step, idx) => (
              <div
                key={idx}
                onClick={() => setActiveStepIdx(activeStepIdx === idx ? null : idx)}
                style={{
                  background: activeStepIdx === idx ? '#2a1a0a' : '#0d1117',
                  border: `1px solid ${activeStepIdx === idx ? '#f0883e' : '#21262d'}`,
                  borderRadius: 4, padding: '4px 8px', marginBottom: 3,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10,
                }}
              >
                <span style={{ color: '#484f58', width: 14 }}>{idx + 1}</span>
                <span style={{ color: step.color, fontWeight: 600 }}>{step.name}</span>
                {step.type && <span style={{ color: '#8b949e' }}>({step.type})</span>}
                {step.direction && <span style={{ color: step.direction === 'Bull' ? '#3fb950' : '#f85149' }}>{step.direction}</span>}
                <div style={{ flex: 1 }} />
                <button onClick={e => { e.stopPropagation(); moveStep(idx, -1) }} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 10 }}>↑</button>
                <button onClick={e => { e.stopPropagation(); moveStep(idx, 1) }} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 10 }}>↓</button>
                <button onClick={e => { e.stopPropagation(); removeStep(idx) }} style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 10 }}>✕</button>
              </div>
            ))}
            {activeSteps.length === 0 && <div style={{ fontSize: 10, color: '#484f58', padding: 8, textAlign: 'center' }}>Add steps below</div>}
          </div>
          {/* Add step form */}
          <div style={{ padding: 6, borderTop: '1px solid #21262d', display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap' }}>
            <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} style={{ ...selectStyle, fontSize: 11, padding: '2px 4px', flex: 1, minWidth: 0 }}>
              <option value="">— Structure —</option>
              {definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}
            </select>
            {addDef && addDef.sub_types.length > 0 && (
              <select value={addType} onChange={e => setAddType(e.target.value)} style={{ ...selectStyle, fontSize: 11, padding: '2px 4px', flex: 1, minWidth: 0 }}>
                <option value="">— Type —</option>
                {addDef.sub_types.map(st => <option key={st} value={st}>{st}</option>)}
              </select>
            )}
            <select value={addDirection} onChange={e => setAddDirection(e.target.value)} style={{ ...selectStyle, fontSize: 11, padding: '2px 4px', width: 60 }}>
              <option value="">Dir</option>
              <option value="Bull">Bull</option>
              <option value="Bear">Bear</option>
            </select>
            <button onClick={addStep} disabled={!addDefId} style={{ ...btnStyle(), fontSize: 11 }}>+ Add</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Search Result Chart ──────────────────────────────────────────────────────

function ResultChart({ candles, steps }: { candles: OHLCCandle[]; steps: FlowStep[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 300,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    })

    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderUpColor: '#26a641', borderDownColor: '#f85149',
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    series.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))

    const closes = candles.map(c => c.close)
    const ema9Data = computeEMA(closes, 9)
    const ema21Data = computeEMA(closes, 21)
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    e9.setData(candles.map((c, i) => ({ time: c.time as Time, value: ema9Data[i] })).filter((d): d is { time: Time; value: number } => d.value !== null))
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    e21.setData(candles.map((c, i) => ({ time: c.time as Time, value: ema21Data[i] })).filter((d): d is { time: Time; value: number } => d.value !== null))

    const markers: { time: Time; position: 'belowBar' | 'aboveBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string; size: number }[] = []
    for (const step of steps) {
      if (!step.transition_bar_time) continue
      const isBear = step.direction === 'Bear'
      markers.push({
        time: step.transition_bar_time as Time,
        position: isBear ? 'aboveBar' : 'belowBar',
        color: isBear ? '#f97316' : '#3b82f6',
        shape: isBear ? 'arrowDown' : 'arrowUp',
        text: step.name + (step.type ? `(${step.type})` : ''),
        size: 2,
      })
    }
    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as number) - (b.time as number))
      series.setMarkers(markers)
    }

    chart.timeScale().fitContent()
    chartRef.current = chart

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    ro.observe(containerRef.current)

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [candles, steps])

  return <div ref={containerRef} style={{ height: '100%', minHeight: 0 }} />
}

// ── Search Sub-tab ───────────────────────────────────────────────────────────

function SearchView({ definitions }: {
  definitions: FineDefinition[]
}) {
  const [querySteps, setQuerySteps] = useState<{ name: string; type?: string; direction?: string }[]>([])
  const [results, setResults] = useState<FineSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [resultCandles, setResultCandles] = useState<OHLCCandle[]>([])
  const [loadingChart, setLoadingChart] = useState(false)

  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')

  const addDef = definitions.find(d => d.definition_id === addDefId)

  const selected = selectedIdx !== null && selectedIdx < results.length ? results[selectedIdx] : null

  const addQueryStep = () => {
    if (!addDefId) return
    if (addDefId === '*') {
      setQuerySteps(prev => [...prev, { name: '*' }])
    } else {
      if (!addDef) return
      setQuerySteps(prev => [...prev, {
        name: addDef.name,
        type: addType || undefined,
        direction: addDirection || undefined,
      }])
    }
    setAddDefId('')
    setAddType('')
    setAddDirection('')
  }

  const removeQueryStep = (idx: number) => {
    setQuerySteps(prev => prev.filter((_, i) => i !== idx))
  }

  const handleSearch = async () => {
    if (querySteps.length === 0) return
    setSearching(true)
    setSelectedIdx(null)
    setResultCandles([])
    try {
      const res = await api.fineStructureSearch({ query_steps: querySteps })
      setResults(res)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  const selectResult = useCallback(async (idx: number) => {
    setSelectedIdx(idx)
    const r = results[idx]
    if (!r) return
    setLoadingChart(true)
    try {
      const res = await api.fineStructureGetOHLC(r.flow.symbol, r.flow.date)
      setResultCandles(res.candles)
    } catch {
      setResultCandles([])
    } finally {
      setLoadingChart(false)
    }
  }, [results])

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Left panel: query + results */}
      <div style={{ width: 510, flexShrink: 0, borderRight: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Query builder */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', marginBottom: 6 }}>Search by Sequence</div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 6 }}>
            {querySteps.map((qs, idx) => (
              <span key={idx} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 10, padding: '2px 6px', borderRadius: 10,
                background: '#21262d', color: '#e6edf3',
              }}>
                {idx > 0 && <span style={{ color: '#484f58', marginRight: 1 }}>→</span>}
                {qs.name === '*' ? '✱ Any' : qs.name}
                {qs.type && <span style={{ color: '#8b949e' }}>({qs.type})</span>}
                {qs.direction && <span style={{ color: qs.direction === 'Bull' ? '#3fb950' : '#f85149' }}>{qs.direction}</span>}
                <button onClick={() => removeQueryStep(idx)} style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 10, padding: 0 }}>✕</button>
              </span>
            ))}
            {querySteps.length === 0 && <span style={{ fontSize: 10, color: '#484f58' }}>Add structures to search</span>}
          </div>
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} style={{ ...selectStyle, maxWidth: 120, fontSize: 11, padding: '2px 4px' }}>
              <option value="">— Structure —</option>
              <option value="*">✱ Any (Wildcard)</option>
              {definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}
            </select>
            {addDefId !== '*' && addDef && addDef.sub_types.length > 0 && (
              <select value={addType} onChange={e => setAddType(e.target.value)} style={{ ...selectStyle, maxWidth: 100, fontSize: 11, padding: '2px 4px' }}>
                <option value="">— Type —</option>
                {addDef.sub_types.map(st => <option key={st} value={st}>{st}</option>)}
              </select>
            )}
            {addDefId !== '*' && (
              <select value={addDirection} onChange={e => setAddDirection(e.target.value)} style={{ ...selectStyle, width: 60, fontSize: 11, padding: '2px 4px' }}>
                <option value="">Dir</option>
                <option value="Bull">Bull</option>
                <option value="Bear">Bear</option>
              </select>
            )}
            <button onClick={addQueryStep} disabled={!addDefId} style={{ ...btnStyle(), padding: '2px 8px', fontSize: 11 }}>Add</button>
          </div>
          <button onClick={handleSearch} disabled={querySteps.length === 0 || searching} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none', width: '100%', marginTop: 6, fontSize: 11 }}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>

        {/* Results tiles */}
        <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
          {results.length === 0 && !searching && (
            <div style={{ fontSize: 11, color: '#484f58', textAlign: 'center', padding: 24 }}>
              {querySteps.length === 0 ? 'Build a query above' : 'No results found'}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {results.map((r, idx) => (
              <div
                key={idx}
                onClick={() => selectResult(idx)}
                style={{
                  background: selectedIdx === idx ? '#2a1a0a' : '#161b22',
                  border: `1px solid ${selectedIdx === idx ? '#f0883e' : '#21262d'}`,
                  borderRadius: 6, padding: 8, cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3' }}>{r.flow.symbol}</span>
                  <span style={{ fontSize: 10, color: '#8b949e' }}>{r.flow.date}</span>
                </div>
                <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {r.flow.steps.map((s, si) => (
                    <span key={si} style={{
                      fontSize: 9, padding: '1px 4px', borderRadius: 6,
                      background: si >= r.match_start_index && si < r.match_start_index + querySteps.length
                        ? '#2a1a0a' : '#21262d',
                      color: si >= r.match_start_index && si < r.match_start_index + querySteps.length
                        ? '#f0883e' : '#8b949e',
                      fontWeight: si >= r.match_start_index && si < r.match_start_index + querySteps.length ? 600 : 400,
                    }}>
                      {si > 0 && '→'}{s.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel: chart + flow steps */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, color: '#484f58' }}>Select a result to view chart</span>
          </div>
        ) : (
          <>
            {/* Chart */}
            <div style={{ flex: 3, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '4px 12px', borderBottom: '1px solid #21262d', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>{selected.flow.symbol}</span>
                <span style={{ fontSize: 12, color: '#8b949e' }}>{selected.flow.date}</span>
              </div>
              {loadingChart ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 12, color: '#484f58' }}>Loading chart...</span>
                </div>
              ) : (
                <ResultChart candles={resultCandles} steps={selected.flow.steps} />
              )}
            </div>

            {/* Flow steps */}
            <div style={{ flex: 2, minHeight: 0, borderTop: '1px solid #21262d', overflow: 'auto', padding: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', marginBottom: 6 }}>Flow Steps</div>
              {selected.flow.steps.map((step, idx) => {
                const isMatch = idx >= selected.match_start_index && idx < selected.match_start_index + querySteps.length
                const isBear = step.direction === 'Bear'
                return (
                  <div key={idx} style={{
                    background: isMatch ? '#2a1a0a' : '#0d1117',
                    border: `1px solid ${isMatch ? '#f0883e' : '#21262d'}`,
                    borderRadius: 6, padding: '5px 10px', marginBottom: 4,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span style={{ fontSize: 10, color: '#484f58', width: 16 }}>{idx + 1}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: isMatch ? '#f0883e' : '#e6edf3',
                    }}>{step.name}</span>
                    {step.type && (
                      <span style={{ fontSize: 10, color: '#8b949e', padding: '1px 5px', borderRadius: 8, background: '#21262d' }}>{step.type}</span>
                    )}
                    {step.direction && (
                      <span style={{ fontSize: 10, color: isBear ? '#f85149' : '#3fb950' }}>{step.direction}</span>
                    )}
                    {step.transition_bar_time && (
                      <span style={{ fontSize: 10, color: '#58a6ff' }}>
                        {new Date(step.transition_bar_time * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main FineStructures Component ────────────────────────────────────────────

export default function FineStructures() {
  const [activeSubTab, setActiveSubTab] = useState<'definitions' | 'builder' | 'search'>('builder')
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>('equity')
  const [definitions, setDefinitions] = useState<FineDefinition[]>([])

  const loadDefinitions = useCallback(async () => {
    try {
      const defs = await api.fineStructureListDefinitions()
      setDefinitions(defs)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadDefinitions() }, [loadDefinitions])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 0, padding: '0 16px', borderBottom: '1px solid #21262d', flexShrink: 0, alignItems: 'center' }}>
        {(['definitions', 'builder', 'search'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveSubTab(tab)}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 600,
              background: 'transparent', border: 'none',
              borderBottom: activeSubTab === tab ? '2px solid #f0883e' : '2px solid transparent',
              color: activeSubTab === tab ? '#f0883e' : '#8b949e',
              cursor: 'pointer',
            }}
          >
            {tab === 'definitions' ? 'Definitions' : tab === 'builder' ? 'Builder' : 'Search'}
          </button>
        ))}
        {activeSubTab === 'builder' && (
          <div style={{ marginLeft: 16, display: 'flex', gap: 0 }}>
            {(['equity', 'options'] as const).map(t => (
              <button
                key={t}
                onClick={() => setInstrumentType(t)}
                style={{
                  padding: '4px 10px', fontSize: 11, fontWeight: 600,
                  background: instrumentType === t ? '#2a1a0a' : 'transparent',
                  border: `1px solid ${instrumentType === t ? '#f0883e' : '#30363d'}`,
                  borderRadius: 3,
                  color: instrumentType === t ? '#f0883e' : '#8b949e',
                  cursor: 'pointer',
                }}
              >
                {t === 'equity' ? 'Equity' : 'Options'}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeSubTab === 'definitions' && <DefinitionsView definitions={definitions} onRefresh={loadDefinitions} />}
      {activeSubTab === 'builder' && instrumentType === 'equity' && <BuilderView definitions={definitions} />}
      {activeSubTab === 'builder' && instrumentType === 'options' && <OptionsBuilderView definitions={definitions} />}
      {activeSubTab === 'search' && <SearchView definitions={definitions} />}
    </div>
  )
}
