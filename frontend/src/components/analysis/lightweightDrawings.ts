import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  LineSeriesPartialOptions,
  MouseEventParams,
  PriceLineOptions,
  SeriesMarker,
  Time,
} from 'lightweight-charts'

/**
 * Drawing tools for the Lightweight Analysis/Patterns charts: the same seven
 * tools as the Lightweight trading chart (`Chart.tsx`), reproduced here so the
 * real-trading chart stays untouched. Drawings are kept in localStorage only
 * (KLine drawings are the ones saved to the backend).
 */
export type LwDrawMode = 'none' | 'hline' | 'trendline' | 'fibretracement' | 'channel' | 'buymarker' | 'sellmarker' | 'rrindicator'

export const LW_DRAW_ITEMS: { mode: Exclude<LwDrawMode, 'none'>; label: string }[] = [
  { mode: 'hline', label: '─ Horizontal Line' },
  { mode: 'trendline', label: '↗ Trend Line' },
  { mode: 'fibretracement', label: '◫ Fib Retracement' },
  { mode: 'channel', label: '⊟ Parallel Channel' },
  { mode: 'buymarker', label: '▲ Buy Marker' },
  { mode: 'sellmarker', label: '▼ Sell Marker' },
  { mode: 'rrindicator', label: '⚡ Risk:Reward' },
]
export const LW_DRAW_LABEL: Partial<Record<LwDrawMode, string>> = {
  hline: 'H-Line', trendline: 'Trend', fibretracement: 'Fib', channel: 'Channel',
  buymarker: 'Buy Mark', sellmarker: 'Sell Mark', rrindicator: 'R:R',
}
const FIB_LEVELS = [
  { ratio: 0, color: '#e6edf3' },
  { ratio: 0.25, color: '#34d399' },
  { ratio: 0.5, color: '#60a5fa' },
  { ratio: 0.75, color: '#fbbf24' },
  { ratio: 1.0, color: '#e6edf3' },
]
const LINE = { priceLineVisible: false, lastValueVisible: false } as const

type Drawing =
  | { type: 'hline'; ref: IPriceLine }
  | { type: 'trendline' | 'fibretracement' | 'channel' | 'rrindicator'; refs: ISeriesApi<'Line'>[] }
  | { type: 'buymarker' | 'sellmarker'; ref: ISeriesApi<'Line'> }
type SavedLine = { data: LineData<Time>[]; options?: LineSeriesPartialOptions; markers?: SeriesMarker<Time>[] }
// Same persisted shape as Chart.tsx so the two stay interchangeable.
export type SavedDrawing =
  | { type: 'hline'; price: number; options?: Partial<PriceLineOptions> }
  | { type: Exclude<LwDrawMode, 'none' | 'hline'>; lines: LineData<Time>[][]; series?: SavedLine[] }

const saveLine = (ref: ISeriesApi<'Line'>): SavedLine => {
  const o = ref.options()
  return {
    data: ref.data() as LineData<Time>[],
    markers: ref.markers(),
    options: {
      color: o.color, lineWidth: o.lineWidth, lineStyle: o.lineStyle,
      lineVisible: o.lineVisible, crosshairMarkerVisible: o.crosshairMarkerVisible,
      priceLineVisible: o.priceLineVisible, lastValueVisible: o.lastValueVisible,
    },
  }
}

export interface LwDrawingSnapshot { mode: LwDrawMode; step: number; count: number }
export const emptyLwSnapshot: LwDrawingSnapshot = { mode: 'none', step: 0, count: 0 }

export function lightweightDrawingKey(account: string, symbol: string, right?: string, strike?: number, expiry?: string) {
  return `analysis-lw-drawings:${account}:${symbol}:${right ?? ''}:${strike ?? ''}:${expiry ?? ''}`
}

export class LightweightDrawingController {
  private drawings: Drawing[] = []
  private points: { time: number; price: number }[] = []
  private mode: LwDrawMode = 'none'
  private modeChangedAt = 0
  private listeners = new Set<() => void>()
  private disposed = false
  private readonly onClick = (param: MouseEventParams) => this.handleClick(param)

  constructor(private chart: IChartApi, private series: ISeriesApi<'Candlestick'>, private storageKey: string | null) {
    chart.subscribeClick(this.onClick)
    this.restore()
  }

  snapshot(): LwDrawingSnapshot {
    return { mode: this.mode, step: this.points.length, count: this.drawings.length }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify() { this.listeners.forEach(listener => listener()) }

  /** Selecting the active tool again turns it off. */
  setMode(next: LwDrawMode) {
    this.mode = next === this.mode ? 'none' : next
    this.points = []
    this.modeChangedAt = Date.now()
    this.notify()
  }

  clearLast() {
    const drawing = this.drawings.pop()
    if (drawing) this.remove(drawing)
    this.mode = 'none'
    this.points = []
    this.persist()
    this.notify()
  }

  /** Switch to another instrument's drawings (the chart instance is reused across contracts). */
  setStorageKey(key: string | null) {
    if (key === this.storageKey) return
    this.removeAll()
    this.storageKey = key
    this.mode = 'none'
    this.points = []
    this.restore()
    this.notify()
  }

  dispose() {
    this.disposed = true
    this.listeners.clear()
    try { this.chart.unsubscribeClick(this.onClick) } catch { /* chart already removed */ }
  }

  private remove(drawing: Drawing) {
    try {
      if (drawing.type === 'hline') this.series.removePriceLine(drawing.ref)
      else if ('refs' in drawing) drawing.refs.forEach(ref => this.chart.removeSeries(ref))
      else this.chart.removeSeries(drawing.ref)
    } catch { /* already removed */ }
  }
  private removeAll() {
    this.drawings.forEach(drawing => this.remove(drawing))
    this.drawings = []
  }

  private persist() {
    if (!this.storageKey) return
    const saved: SavedDrawing[] = this.drawings.map(d => {
      if (d.type === 'hline') return { type: d.type, price: d.ref.options().price, options: d.ref.options() }
      const series = ('refs' in d ? d.refs : [d.ref]).map(saveLine)
      return { type: d.type, lines: series.map(s => s.data), series }
    })
    try { localStorage.setItem(this.storageKey, JSON.stringify(saved)) } catch { /* Storage can be disabled. */ }
  }

  private restore() {
    if (!this.storageKey) return
    try {
      const saved: SavedDrawing[] = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]')
      for (const d of saved) {
        if (d.type === 'hline') {
          const ref = this.series.createPriceLine({ color: '#e6edf3', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '', ...d.options, price: d.price })
          this.drawings.push({ type: 'hline', ref })
          continue
        }
        const marker = d.type === 'buymarker' || d.type === 'sellmarker'
        const refs = (d.series ?? d.lines.map(data => ({ data } as SavedLine))).map((line, index) => {
          const ref = this.chart.addLineSeries({
            color: d.type === 'fibretracement' ? FIB_LEVELS[index]?.color ?? '#ffa657' : '#ffa657',
            lineWidth: 1, ...LINE, lineVisible: !marker, ...line.options,
          })
          ref.setData(line.data)
          const buy = d.type === 'buymarker'
          const inferred: SeriesMarker<Time>[] = marker && line.data[0]
            ? [{ time: line.data[0].time, position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#3b82f6' : '#f97316', shape: buy ? 'arrowUp' : 'arrowDown', text: buy ? 'Buy UL' : 'Sell UL', size: 2 }]
            : []
          ref.setMarkers(line.markers ?? inferred)
          return ref
        })
        if (marker) { if (refs[0]) this.drawings.push({ type: d.type as 'buymarker' | 'sellmarker', ref: refs[0] }) }
        else this.drawings.push({ type: d.type as 'trendline' | 'fibretracement' | 'channel' | 'rrindicator', refs })
      }
    } catch { /* Ignore invalid old local drawings. */ }
  }

  private finish(drawing: Drawing) {
    this.drawings.push(drawing)
    this.points = []
    this.mode = 'none'
    this.persist()
    this.notify()
  }

  private handleClick(param: MouseEventParams) {
    if (this.disposed || this.mode === 'none' || !param.point || !param.time) return
    // Ignore the click that selected the tool (dropdown items can overlap the chart).
    if (Date.now() - this.modeChangedAt < 150) return
    const price = this.series.coordinateToPrice(param.point.y)
    if (price === null) return
    const time = param.time as number
    const mode = this.mode
    const first = this.points[0]
    const line = (color: string, width: 1 | 2 | 3 = 1) => this.chart.addLineSeries({ color, lineWidth: width, ...LINE })
    try {
      if (mode === 'hline') {
        const ref = this.series.createPriceLine({ price, color: '#e6edf3', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: price.toFixed(0) })
        this.finish({ type: 'hline', ref })
      } else if (mode === 'buymarker' || mode === 'sellmarker') {
        const buy = mode === 'buymarker'
        const ref = this.chart.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, ...LINE })
        ref.setData([{ time: time as Time, value: price }])
        ref.setMarkers([{ time: time as Time, position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#3b82f6' : '#f97316', shape: buy ? 'arrowUp' : 'arrowDown', text: buy ? 'Buy UL' : 'Sell UL', size: 2 }])
        this.finish({ type: mode, ref })
      } else if (mode === 'channel' && this.points.length < 2) {
        this.points = [...this.points, { time, price }]
        this.notify()
      } else if (!first) {
        this.points = [{ time, price }]
        this.notify()
      } else if (mode === 'trendline') {
        const ref = line('#ffa657')
        ref.setData([
          { time: Math.min(first.time, time) as Time, value: first.time <= time ? first.price : price },
          { time: Math.max(first.time, time) as Time, value: first.time <= time ? price : first.price },
        ])
        this.finish({ type: 'trendline', refs: [ref] })
      } else if (mode === 'fibretracement') {
        const start = Math.min(first.time, time) as Time
        const end = Math.max(first.time, time) as Time
        const low = Math.min(first.price, price)
        const range = Math.max(first.price, price) - low
        const refs = FIB_LEVELS.map(level => {
          const ref = line(level.color)
          ref.setData([{ time: start, value: low + range * level.ratio }, { time: end, value: low + range * level.ratio }])
          return ref
        })
        this.finish({ type: 'fibretracement', refs })
      } else if (mode === 'channel') {
        const [p1, p2] = this.points
        const start = Math.min(p1.time, p2.time)
        const end = Math.max(p1.time, p2.time)
        const startPrice = p1.time <= p2.time ? p1.price : p2.price
        const endPrice = p1.time <= p2.time ? p2.price : p1.price
        const slope = end !== start ? (endPrice - startPrice) / (end - start) : 0
        const offset = price - (startPrice + slope * (time - start))
        const baseline = line('#ffa657')
        baseline.setData([{ time: start as Time, value: startPrice }, { time: end as Time, value: endPrice }])
        const parallel = line('#79c0ff')
        parallel.setData([{ time: start as Time, value: startPrice + offset }, { time: end as Time, value: endPrice + offset }])
        this.finish({ type: 'channel', refs: [baseline, parallel] })
      } else if (mode === 'rrindicator') {
        const risk = first.price
        const isBuy = risk < price
        const diff = Math.abs(price - risk)
        const start = Math.min(first.time, time) as Time
        const end = Math.max(first.time, time) as Time
        const levels = [
          { price: risk, color: 'rgb(248,81,73)' },
          { price, color: 'rgb(230,237,243)' },
          { price: isBuy ? price + diff : price - diff, color: 'rgb(63,185,80)' },
          { price: isBuy ? price + diff * 1.5 : price - diff * 1.5, color: 'rgb(88,166,255)' },
          { price: isBuy ? price + diff * 2 : price - diff * 2, color: 'rgb(188,140,255)' },
        ]
        const refs = levels.map(level => {
          const ref = line(level.color, 3)
          ref.setData([{ time: start, value: level.price }, { time: end, value: level.price }])
          return ref
        })
        this.finish({ type: 'rrindicator', refs })
      }
    } catch { /* chart disposed */ }
  }
}
