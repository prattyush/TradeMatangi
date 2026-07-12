/**
 * Chart Structures — Daily Chart Classification Browser (Phase XIII)
 *
 * Browse daily charts classified by Opening, Midday, and Closing structure types.
 * Three multi-select dropdowns filter the gallery. Click a card to view the full
 * OHLC chart with inline classification editing.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  createChart, IChartApi, ISeriesApi, LineData, Time,
} from 'lightweight-charts'
import api, { ChartStructureItem, OHLCCandle } from '../services/api'

// ── EMA helpers ───────────────────────────────────────────────────────────────

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

type TypeDef = { value: string; label: string }

const TYPE_COLORS: Record<string, string> = {
  within_yesterdays_range: '#60a5fa',
  within_day_before_yesterdays_range: '#93c5fd',
  gap_up: '#22c55e',
  gap_down: '#ef4444',
  big_gap_up: '#166534',
  big_gap_down: '#991b1b',
  trading_range: '#34d399',
  breakout: '#22c55e',
  trend: '#8b5cf6',
  reversal_breakout: '#ef4444',
  trend_reversal: '#ec4899',
  undefined: '#484f58',
}

function typeBadge(value: string, label: string) {
  const bg = TYPE_COLORS[value] || '#484f58'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, marginRight: 4,
      background: bg, color: '#fff',
    }}>{label}</span>
  )
}

// ── MultiSelect dropdown ──────────────────────────────────────────────────────

function MultiSelect({
  label, options, selected, onChange,
}: {
  label: string; options: TypeDef[]; selected: string[]; onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const toggle = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter(s => s !== value))
    else onChange([...selected, value])
  }

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1 }}>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>{label}</div>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '6px 10px', background: '#0d1117', border: '1px solid #30363d',
          borderRadius: 6, color: '#e6edf3', fontSize: 12, cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span>{selected.length ? `${selected.length} selected` : 'All'}</span>
        <span style={{ fontSize: 10 }}>▼</span>
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: '#161b22', border: '1px solid #30363d', borderRadius: 6,
          marginTop: 4, maxHeight: 220, overflowY: 'auto', padding: 4,
        }}>
          {options.map(opt => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
              fontSize: 12, color: '#e6edf3', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
              />
              {typeBadge(opt.value, opt.label)}
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Mini OHLC Sparkline ───────────────────────────────────────────────────────

function Sparkline({ candles }: { candles: OHLCCandle[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || candles.length < 2) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth, h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)

    const prices = candles.flatMap(c => [c.high, c.low])
    const lo = Math.min(...prices), hi = Math.max(...prices)
    const range = hi - lo || 1
    const step = w / (candles.length - 1)

    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    candles.forEach((c, i) => {
      const x = i * step
      const y = h - ((c.close - lo) / range) * (h - 2) - 1
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }, [candles])

  return <canvas ref={canvasRef} style={{ width: '100%', height: 40 }} />
}

// ── Full Chart Modal ──────────────────────────────────────────────────────────

function ChartModal({
  item, onClose,
}: {
  item: ChartStructureItem; onClose: () => void
}) {
  const chartRef = useRef<HTMLDivElement>(null)
  const chartApi = useRef<IChartApi | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const [candles, setCandles] = useState<OHLCCandle[]>([])
  const [showEma, setShowEma] = useState(true)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState<string>('')
  const [editMid, setEditMid] = useState<string>('')
  const [editClose, setEditClose] = useState<string>('')
  const [structure, setStructure] = useState<ChartStructureItem>(item)

  // Fetch types once for dropdowns
  const [types, setTypes] = useState<{ opening: TypeDef[]; midday: TypeDef[]; closing: TypeDef[] }>({
    opening: [], midday: [], closing: [],
  })

  useEffect(() => {
    api.chartStructureGetTypes().then(t => {
      setTypes({ opening: t.opening_types, midday: t.midday_types, closing: t.closing_types })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const symbol = item.symbol === 'BSESEN' ? 'BSESEN' : item.symbol
    api.chartStructureGetOHLC(symbol, item.date).then(data => {
      setCandles(data.candles)
      if (data.structure) setStructure(data.structure)
      setEditOpen(data.structure?.opening_type || 'undefined')
      setEditMid(data.structure?.midday_type || 'undefined')
      setEditClose(data.structure?.closing_type || 'undefined')
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [item])

  useEffect(() => {
    if (!chartRef.current || candles.length === 0) return

    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth,
      height: Math.max(300, window.innerHeight * 0.5),
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: false },
    })
    chartApi.current = chart
    const series = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e',
      borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })
    const e9 = chart.addLineSeries({ color: '#f0883e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const e21 = chart.addLineSeries({ color: '#79c0ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    ema9Ref.current = e9
    ema21Ref.current = e21
    series.setData(candles.map(c => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    })))
    chart.timeScale().fitContent()

    const onResize = () => { chart.resize(chartRef.current!.clientWidth, chartRef.current!.clientHeight) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      ema9Ref.current = null
      ema21Ref.current = null
    }
  }, [candles])

  // EMA compute + visibility
  useEffect(() => {
    ema9Ref.current?.applyOptions({ visible: showEma })
    ema21Ref.current?.applyOptions({ visible: showEma })
  }, [showEma])

  useEffect(() => {
    if (!ema9Ref.current || !ema21Ref.current || candles.length === 0) return
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

  const save = async () => {
    try {
      if (structure.is_predefined || !structure.can_delete) {
        // Create a new user-owned structure
        const created = await api.chartStructureCreate({
          symbol: item.symbol, date: item.date,
          opening_type: editOpen, midday_type: editMid, closing_type: editClose,
        })
        setStructure(created)
      } else {
        const updated = await api.chartStructureUpdate(structure.chart_structure_id, {
          opening_type: editOpen, midday_type: editMid, closing_type: editClose,
        })
        setStructure(updated)
      }
    } catch { /* ignore */ }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.85)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 20,
      overflowY: 'auto',
    }}>
      <div style={{ width: '100%', maxWidth: 1000 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ color: '#e6edf3', fontSize: 16, fontWeight: 600 }}>
            {item.symbol} — {item.date}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid #30363d', borderRadius: 6,
            color: '#8b949e', fontSize: 14, cursor: 'pointer', padding: '4px 12px',
          }}>✕ Close</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {typeBadge(editOpen, types.opening.find(t => t.value === editOpen)?.label || editOpen)}
          {typeBadge(editMid, types.midday.find(t => t.value === editMid)?.label || editMid)}
          {typeBadge(editClose, types.closing.find(t => t.value === editClose)?.label || editClose)}
          {structure.is_predefined && (
            <span style={{ fontSize: 11, color: '#d4a017', marginLeft: 8 }}>System</span>
          )}
          {!structure.is_predefined && !structure.can_delete && (
            <span style={{ fontSize: 11, color: '#8b949e', marginLeft: 8 }}>Shared</span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <button onClick={() => setShowEma(v => !v)} style={{
            padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            border: `1px solid ${showEma ? '#f0883e' : '#30363d'}`,
            borderRadius: 6, background: showEma ? '#1f3a5f' : '#161b22',
            color: showEma ? '#f0883e' : '#484f58',
          }}>EMA 9/21</button>
        </div>

        {loading ? (
          <div style={{ color: '#484f58', textAlign: 'center', padding: 60 }}>Loading chart…</div>
        ) : (
          <div ref={chartRef} style={{ width: '100%', height: Math.max(300, window.innerHeight * 0.5) }} />
        )}

        {/* Edit section */}
        <div style={{
          marginTop: 16, padding: 12, background: '#161b22',
          border: '1px solid #21262d', borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, color: '#f0883e', fontWeight: 600, marginBottom: 10 }}>
            {structure.can_delete ? 'Edit Classification' : 'Classification (System)'}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <SelectField label="Opening" options={types.opening} value={editOpen} onChange={setEditOpen} disabled={!structure.can_delete} />
            <SelectField label="Midday" options={types.midday} value={editMid} onChange={setEditMid} disabled={!structure.can_delete} />
            <SelectField label="Closing" options={types.closing} value={editClose} onChange={setEditClose} disabled={!structure.can_delete} />
          </div>
          {structure.can_delete && (
            <button onClick={save} style={{
              marginTop: 10, padding: '6px 16px', background: '#1f6feb',
              border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12,
            }}>
              {structure.is_predefined ? 'Save Custom' : 'Update'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SelectField({
  label, options, value, onChange, disabled,
}: {
  label: string; options: TypeDef[]; value: string; onChange: (v: string) => void; disabled: boolean
}) {
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>{label}</div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: '100%', padding: '6px 8px', background: disabled ? '#0d1117' : '#0d1117',
          border: '1px solid #30363d', borderRadius: 6, color: disabled ? '#484f58' : '#e6edf3',
          fontSize: 12, cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ChartStructures({ onClose }: { onClose: () => void }) {
  const [types, setTypes] = useState<{ opening: TypeDef[]; midday: TypeDef[]; closing: TypeDef[] }>({
    opening: [], midday: [], closing: [],
  })
  const [selOpen, setSelOpen] = useState<string[]>([])
  const [selMid, setSelMid] = useState<string[]>([])
  const [selClose, setSelClose] = useState<string[]>([])
  const [structures, setStructures] = useState<ChartStructureItem[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<ChartStructureItem | null>(null)

  useEffect(() => {
    api.chartStructureGetTypes().then(t => setTypes({
      opening: t.opening_types, midday: t.midday_types, closing: t.closing_types,
    })).catch(() => {})
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.chartStructureList({
        opening_types: selOpen.length ? selOpen.join(',') : undefined,
        midday_types: selMid.length ? selMid.join(',') : undefined,
        closing_types: selClose.length ? selClose.join(',') : undefined,
      })
      setStructures(res.structures)
    } catch { /* ignore */ }
    setLoading(false)
  }, [selOpen, selMid, selClose])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99, background: '#0d1117',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 20px', borderBottom: '1px solid #21262d',
      }}>
        <div>
          <div style={{ fontSize: 18, color: '#e6edf3', fontWeight: 600 }}>📊 Chart Structures</div>
          <div style={{ fontSize: 12, color: '#484f58', marginTop: 4 }}>
            View daily charts by market structure classification
          </div>
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: '1px solid #30363d', borderRadius: 6,
          color: '#8b949e', fontSize: 13, cursor: 'pointer', padding: '6px 16px',
        }}>✕ Close</button>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, padding: '12px 20px',
        borderBottom: '1px solid #21262d', flexWrap: 'wrap',
      }}>
        <MultiSelect label="Opening" options={types.opening} selected={selOpen} onChange={setSelOpen} />
        <MultiSelect label="Midday" options={types.midday} selected={selMid} onChange={setSelMid} />
        <MultiSelect label="Closing" options={types.closing} selected={selClose} onChange={setSelClose} />
      </div>

      {/* Gallery */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
        {loading ? (
          <div style={{ color: '#484f58', textAlign: 'center', padding: 40 }}>Loading…</div>
        ) : structures.length === 0 ? (
          <div style={{ color: '#484f58', textAlign: 'center', padding: 40 }}>
            No structures found. Try running the classification script first.
          </div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 12,
          }}>
            {structures.map(s => (
              <StructureCard key={s.chart_structure_id} item={s} onClick={() => setModal(s)} />
            ))}
          </div>
        )}
      </div>

      <div style={{
        padding: '8px 20px', borderTop: '1px solid #21262d',
        fontSize: 11, color: '#484f58',
      }}>
        {structures.length} chart{structures.length !== 1 ? 's' : ''} • Run <code>scripts/classify_chart_structures.py</code> to classify more dates
      </div>

      {modal && <ChartModal item={modal} onClose={() => setModal(null)} />}
    </div>
  )
}

// ── Gallery Card ──────────────────────────────────────────────────────────────

function StructureCard({ item, onClick }: { item: ChartStructureItem; onClick: () => void }) {
  const [spark, setSpark] = useState<OHLCCandle[]>([])

  useEffect(() => {
    api.chartStructureGetOHLC(item.symbol, item.date, 15).then(d => setSpark(d.candles)).catch(() => {})
  }, [item])

  const findLabel = (value: string) => {
    const map: Record<string, string> = {
      within_yesterdays_range: "Y'day Range",
      within_day_before_yesterdays_range: 'DBY Range',
      gap_up: 'Gap Up',
      gap_down: 'Gap Dn',
      big_gap_up: 'Big Up',
      big_gap_down: 'Big Dn',
      trading_range: 'Range',
      breakout: 'BrkOut',
      trend: 'Trend',
      reversal_breakout: 'Rev Brk',
      trend_reversal: 'Rev Trend',
      undefined: '—',
    }
    return map[value] || value
  }

  return (
    <div onClick={onClick} style={{
      background: '#161b22', border: '1px solid #21262d', borderRadius: 8,
      padding: 10, cursor: 'pointer', transition: 'border-color 0.15s',
    }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = '#30363d')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = '#21262d')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ color: '#e6edf3', fontSize: 13, fontWeight: 600 }}>{item.symbol}</div>
        <div style={{ color: '#8b949e', fontSize: 11 }}>{item.date}</div>
      </div>
      <div style={{ marginBottom: 8 }}>
        {typeBadge(item.opening_type, findLabel(item.opening_type))}
        {typeBadge(item.midday_type, findLabel(item.midday_type))}
        {typeBadge(item.closing_type, findLabel(item.closing_type))}
      </div>
      <Sparkline candles={spark} />
      {!item.can_delete && !item.is_predefined && (
        <div style={{ fontSize: 10, color: '#8b949e', marginTop: 4 }}>Shared</div>
      )}
    </div>
  )
}
