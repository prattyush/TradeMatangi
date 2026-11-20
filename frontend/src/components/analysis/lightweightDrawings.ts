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
import { attachRectangle, type RectanglePrimitive } from '../../indicators/rectanglePrimitive'
import { attachText, TEXT_DRAWING_COLOR, textWidth, type TextDrawingData, type TextPrimitive } from '../../indicators/textPrimitive'
import { hitBox, hitHorizontal, hitRect, hitSegments, markerBox, nearest, textBox, type Px } from './lightweightHit'

/**
 * Drawing tools for the Lightweight Analysis/Patterns charts: the same seven
 * tools as the Lightweight trading chart (`Chart.tsx`), reproduced here so the
 * real-trading chart stays untouched. Drawings are kept in localStorage only
 * (KLine drawings are the ones saved to the backend).
 */
export type LwDrawMode = 'none' | 'hline' | 'trendline' | 'fibretracement' | 'rect' | 'text' | 'buymarker' | 'sellmarker' | 'rrindicator'

export const LW_DRAW_ITEMS: { mode: Exclude<LwDrawMode, 'none'>; label: string }[] = [
  { mode: 'hline', label: '─ Horizontal Line' },
  { mode: 'trendline', label: '↗ Trend Line' },
  { mode: 'fibretracement', label: '◫ Fib Retracement' },
  { mode: 'rect', label: '▭ Rectangle' },
  { mode: 'text', label: 'T Text' },
  { mode: 'buymarker', label: '▲ Buy Marker' },
  { mode: 'sellmarker', label: '▼ Sell Marker' },
  { mode: 'rrindicator', label: '⚡ Risk:Reward' },
]
export const LW_DRAW_LABEL: Partial<Record<LwDrawMode, string>> = {
  hline: 'H-Line', trendline: 'Trend', fibretracement: 'Fib', rect: 'Rectangle', text: 'Text',
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
  | { type: 'trendline' | 'fibretracement' | 'rrindicator'; refs: ISeriesApi<'Line'>[] }
  | { type: 'rect'; ref: RectanglePrimitive }
  | { type: 'text'; ref: TextPrimitive }
  | { type: 'buymarker' | 'sellmarker'; ref: ISeriesApi<'Line'> }
type SavedLine = { data: LineData<Time>[]; options?: LineSeriesPartialOptions; markers?: SeriesMarker<Time>[] }
// Same persisted shape as Chart.tsx so the two stay interchangeable.
export type SavedDrawing =
  | { type: 'hline'; price: number; options?: Partial<PriceLineOptions> }
  | { type: 'rect'; p1: { time: number; price: number }; p2: { time: number; price: number } }
  | ({ type: 'text' } & TextDrawingData)
  | { type: Exclude<LwDrawMode, 'none' | 'hline' | 'rect' | 'text'>; lines: LineData<Time>[][]; series?: SavedLine[] }

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

/** A Text drawing waiting for its text: the clicked point, and where (viewport pixels) to put the prompt. */
export interface LwPendingText { time: number; price: number; x: number; y: number; /** Set when the text of an existing drawing is being changed. */ editIndex?: number; initial?: string }
/** The drawing a click picked: its name, whether it has text to edit, and where (viewport pixels) to show its actions. */
export interface LwSelection { label: string; canEditText: boolean; x: number; y: number }
export interface LwDrawingSnapshot { mode: LwDrawMode; step: number; count: number; pendingText: LwPendingText | null; selection: LwSelection | null }
export const emptyLwSnapshot: LwDrawingSnapshot = { mode: 'none', step: 0, count: 0, pendingText: null, selection: null }
const DRAWING_NAME: Record<Drawing['type'], string> = {
  hline: 'Horizontal line', trendline: 'Trend line', fibretracement: 'Fib retracement', rect: 'Rectangle', text: 'Text',
  buymarker: 'Buy marker', sellmarker: 'Sell marker', rrindicator: 'Risk:Reward',
}


export function lightweightDrawingKey(account: string, symbol: string, right?: string, strike?: number, expiry?: string) {
  return `analysis-lw-drawings:${account}:${symbol}:${right ?? ''}:${strike ?? ''}:${expiry ?? ''}`
}

export class LightweightDrawingController {
  private drawings: Drawing[] = []
  private points: { time: number; price: number }[] = []
  private mode: LwDrawMode = 'none'
  private pendingText: LwPendingText | null = null
  private selected: number | null = null
  private selection: LwSelection | null = null
  private unhighlight: (() => void) | null = null
  private modeChangedAt = 0
  private listeners = new Set<() => void>()
  private disposed = false
  private readonly onClick = (param: MouseEventParams) => this.handleClick(param)

  constructor(private chart: IChartApi, private series: ISeriesApi<'Candlestick'>, private storageKey: string | null) {
    chart.subscribeClick(this.onClick)
    chart.chartElement().addEventListener('dblclick', this.onDoubleClick)
    this.restore()
  }

  snapshot(): LwDrawingSnapshot {
    return { mode: this.mode, step: this.points.length, count: this.drawings.length, pendingText: this.pendingText, selection: this.selection }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify() { this.listeners.forEach(listener => listener()) }

  /** Selecting the active tool again turns it off. */
  setMode(next: LwDrawMode) {
    this.clearSelection()
    this.mode = next === this.mode ? 'none' : next
    this.points = []
    this.pendingText = null
    this.modeChangedAt = Date.now()
    this.notify()
  }

  clearLast() {
    this.clearSelection()
    const drawing = this.drawings.pop()
    if (drawing) this.remove(drawing)
    this.mode = 'none'
    this.points = []
    this.pendingText = null
    this.persist()
    this.notify()
  }

  /** Switch to another instrument's drawings (the chart instance is reused across contracts). */
  setStorageKey(key: string | null) {
    if (key === this.storageKey) return
    this.clearSelection()
    this.removeAll()
    this.storageKey = key
    this.mode = 'none'
    this.points = []
    this.pendingText = null
    this.restore()
    this.notify()
  }

  dispose() {
    this.disposed = true
    this.clearSelection(false)
    this.listeners.clear()
    try { this.chart.unsubscribeClick(this.onClick); this.chart.chartElement().removeEventListener('dblclick', this.onDoubleClick) } catch { /* chart already removed */ }
  }

  private remove(drawing: Drawing) {
    try {
      if (drawing.type === 'hline') this.series.removePriceLine(drawing.ref)
      else if (drawing.type === 'rect' || drawing.type === 'text') this.series.detachPrimitive(drawing.ref)
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
      if (d.type === 'rect') return { type: 'rect', ...d.ref.toJSON() }
      if (d.type === 'text') return { type: 'text', ...d.ref.toJSON() }
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
        if (d.type === 'rect') {
          if (d.p1 && d.p2) this.drawings.push({ type: 'rect', ref: attachRectangle(this.series, d.p1, d.p2) })
          continue
        }
        if (d.type === 'text') {
          if (typeof d.text === 'string' && d.text) this.drawings.push({ type: 'text', ref: attachText(this.series, { time: d.time, price: d.price, text: d.text, color: d.color ?? TEXT_DRAWING_COLOR }) })
          continue
        }
        // The parallel channel was replaced by the rectangle tool; drop legacy entries.
        if ((d.type as string) === 'channel') continue
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
        else this.drawings.push({ type: d.type as 'trendline' | 'fibretracement' | 'rrindicator', refs })
      }
    } catch { /* Ignore invalid old local drawings. */ }
  }

  /** The text typed for a pending Text drawing (an empty text drops a new one and leaves a changed one as it was). */
  submitText(text: string) {
    const pending = this.pendingText
    this.pendingText = null
    const clean = text.trim().slice(0, 80)
    if (pending && clean && !this.disposed) {
      try {
        const ref = attachText(this.series, { time: pending.time, price: pending.price, text: clean, color: TEXT_DRAWING_COLOR })
        if (pending.editIndex !== undefined && this.drawings[pending.editIndex]?.type === 'text') {
          const old = this.drawings[pending.editIndex]
          this.drawings[pending.editIndex] = { type: 'text', ref }
          this.remove(old)
          this.persist()
          this.notify()
        } else this.finish({ type: 'text', ref })
        return
      } catch { /* chart disposed */ }
    }
    this.notify()
  }
  cancelText() { this.pendingText = null; this.notify() }

  // ── Picking a drawing: select it with a click, then delete it (or change a Text's text) ──

  private px(time: number, price: number): Px | null {
    const x = this.chart.timeScale().timeToCoordinate(time as Time)
    const y = this.series.priceToCoordinate(price)
    return x === null || y === null ? null : { x, y }
  }
  private linePoints(ref: ISeriesApi<'Line'>): Px[] {
    return (ref.data() as LineData<Time>[]).flatMap(d => {
      const at = d.value === undefined ? null : this.px(d.time as number, d.value)
      return at ? [at] : []
    })
  }
  /** How near (px) a click is to a drawing, null when it is not on it. */
  private distance(drawing: Drawing, click: Px): number | null {
    if (drawing.type === 'hline') {
      const y = this.series.priceToCoordinate(drawing.ref.options().price)
      return y === null ? null : hitHorizontal(click, y)
    }
    if (drawing.type === 'rect') {
      const a = this.px(drawing.ref.p1.time, drawing.ref.p1.price)
      const b = this.px(drawing.ref.p2.time, drawing.ref.p2.price)
      return a && b ? hitRect(click, a, b) : null
    }
    if (drawing.type === 'text') {
      const at = this.px(drawing.ref.data.time, drawing.ref.data.price)
      return at ? hitBox(click, textBox(at, textWidth(drawing.ref.data.text))) : null
    }
    if (drawing.type === 'buymarker' || drawing.type === 'sellmarker') {
      const [at] = this.linePoints(drawing.ref)
      return at ? hitBox(click, markerBox(at, drawing.type === 'buymarker'), 0) : null
    }
    if (!('refs' in drawing)) return null
    const segments = drawing.refs.flatMap(ref => {
      const points = this.linePoints(ref)
      return points.slice(1).map((point, i) => [points[i], point] as const)
    })
    return hitSegments(click, segments)
  }
  /** Make the drawing look picked: thicker lines, an outline on a rectangle or text. Returns how to undo it. */
  private highlight(drawing: Drawing): () => void {
    const thicker = (width: number) => Math.min(4, width + 2) as 1 | 2 | 3 | 4
    if (drawing.type === 'hline') {
      const width = drawing.ref.options().lineWidth
      drawing.ref.applyOptions({ lineWidth: thicker(width) })
      return () => drawing.ref.applyOptions({ lineWidth: width })
    }
    if (drawing.type === 'rect' || drawing.type === 'text') {
      drawing.ref.setSelected(true)
      return () => drawing.ref.setSelected(false)
    }
    if ('refs' in drawing) {
      const widths = drawing.refs.map(ref => ref.options().lineWidth)
      drawing.refs.forEach((ref, i) => ref.applyOptions({ lineWidth: thicker(widths[i]) }))
      return () => drawing.refs.forEach((ref, i) => ref.applyOptions({ lineWidth: widths[i] }))
    }
    return () => undefined
  }
  private readonly onKey = (event: KeyboardEvent) => {
    if (this.selected === null || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true]'))) return
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.deleteSelected() }
    else if (event.key === 'Escape') { this.clearSelection() }
  }
  /** Undo the picked look (always before the drawings are saved, so a thick line is never what is stored). */
  private clearSelection(notify = true) {
    if (this.selected === null) return
    try { this.unhighlight?.() } catch { /* chart removed */ }
    this.unhighlight = null
    this.selected = null
    this.selection = null
    document.removeEventListener('keydown', this.onKey)
    if (notify) this.notify()
  }
  private select(index: number, click: Px) {
    this.clearSelection(false)
    const drawing = this.drawings[index]
    const rect = this.chart.chartElement().getBoundingClientRect()
    this.selected = index
    this.unhighlight = this.highlight(drawing)
    this.selection = { label: DRAWING_NAME[drawing.type], canEditText: drawing.type === 'text', x: rect.left + click.x, y: rect.top + click.y }
    document.addEventListener('keydown', this.onKey)
    this.notify()
  }
  /** A click with no drawing tool on: pick the drawing under it (or none). */
  private pick(param: MouseEventParams) {
    if (!param.point || this.pendingText) return
    const click = { x: param.point.x, y: param.point.y }
    const index = nearest(this.drawings.map((drawing, i) => ({ index: i, distance: this.distance(drawing, click) })))
    if (index === null) { this.clearSelection(); return }
    this.select(index, click)
  }
  /**
   * A double click on a Text changes its text. Lightweight swallows the second click of a double click (and has no double click event),
   * so this listens to the browser's own `dblclick` on the chart.
   */
  private readonly onDoubleClick = (event: MouseEvent) => {
    if (this.disposed || this.mode !== 'none' || this.pendingText) return
    const rect = this.chart.chartElement().getBoundingClientRect()
    const click = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const index = nearest(this.drawings.map((drawing, i) => ({ index: i, distance: this.distance(drawing, click) })))
    if (index === null || this.drawings[index].type !== 'text') return
    if (this.selected !== index) this.select(index, click)
    this.editSelectedText()
  }

  /** True when a click at this chart pixel is on a drawing (so a screen that also marks candles can leave that click to the drawing). */
  hitsDrawing(point: { x: number; y: number }): boolean {
    return nearest(this.drawings.map((drawing, i) => ({ index: i, distance: this.distance(drawing, point) }))) !== null
  }

  /** Delete the picked drawing. */
  deleteSelected() {
    const index = this.selected
    if (index === null) return
    const drawing = this.drawings[index]
    this.clearSelection(false)
    if (drawing) {
      this.drawings.splice(index, 1)
      this.remove(drawing)
    }
    this.persist()
    this.notify()
  }
  /** Ask for a new text for the picked Text drawing. */
  editSelectedText() {
    const index = this.selected
    const drawing = index === null ? undefined : this.drawings[index]
    const at = this.selection
    if (index === null || !drawing || drawing.type !== 'text' || !at) return
    const { time, price, text } = drawing.ref.data
    this.clearSelection(false)
    this.pendingText = { time, price, x: at.x, y: at.y, editIndex: index, initial: text }
    this.notify()
  }

  private finish(drawing: Drawing) {
    this.drawings.push(drawing)
    this.points = []
    this.mode = 'none'
    this.persist()
    this.notify()
  }

  private handleClick(param: MouseEventParams) {
    if (this.disposed) return
    if (this.mode === 'none') { this.pick(param); return }
    if (!param.point || !param.time) return
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
      } else if (mode === 'text') {
        // The text is asked for beside the clicked point; the drawing is made once it has one.
        const rect = this.chart.chartElement().getBoundingClientRect()
        this.pendingText = { time, price, x: rect.left + param.point.x, y: rect.top + param.point.y }
        this.mode = 'none'
        this.points = []
        this.notify()
      } else if (mode === 'buymarker' || mode === 'sellmarker') {
        const buy = mode === 'buymarker'
        const ref = this.chart.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, ...LINE })
        ref.setData([{ time: time as Time, value: price }])
        ref.setMarkers([{ time: time as Time, position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#3b82f6' : '#f97316', shape: buy ? 'arrowUp' : 'arrowDown', text: buy ? 'Buy UL' : 'Sell UL', size: 2 }])
        this.finish({ type: mode, ref })
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
      } else if (mode === 'rect') {
        this.finish({ type: 'rect', ref: attachRectangle(this.series, first, { time, price }) })
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
