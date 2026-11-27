import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  MouseEventParams,
  Time,
} from 'lightweight-charts'
import { attachRectangle, type RectanglePrimitive } from '../../indicators/rectanglePrimitive'
import { attachText, TEXT_DRAWING_COLOR, textWidth, type TextPrimitive } from '../../indicators/textPrimitive'
import { announceDrawingChange, watchDrawingChanges } from '../../../../shared/charts/drawingEvents'
import { canonicalDrawingKey, drawingIdentity } from '../../../../shared/charts/drawingIdentity'
import type { DrawingRecord, DrawingRequest } from '../../../../shared/charts/klineDrawingModel'
import { loadScopedRecords, scopedIdentity, seedScopedDrawings } from '../../../../shared/charts/scopedDrawings'
import { hitBox, hitHorizontal, hitRect, hitSegments, markerBox, nearest, textBox, type Px } from './lightweightHit'
import {
  LW_MARKER_TEXT, LW_TEXT_MAX, fromPersisted, isLegacyKeyOf, legacyToSpecs, specSignature, toPersisted,
  type LwKind, type LwPoint, type LwSpec,
} from './lightweightPersist'

/**
 * Drawing tools for the Lightweight Analysis/Patterns/Deep Dive charts: the same seven tools as the Lightweight trading chart
 * (`Chart.tsx`), reproduced here so the real-trading chart stays untouched, plus Text. Drawings are saved to the database as the same
 * records KLine drawings are (`lightweightPersist.ts`), so the two chart types show, change and delete the same drawings. Drawings
 * kept in the browser before that (localStorage) are copied up once.
 */
export type LwDrawMode = 'none' | LwKind

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
const RR_COLORS = ['rgb(248,81,73)', 'rgb(230,237,243)', 'rgb(63,185,80)', 'rgb(88,166,255)', 'rgb(188,140,255)']

type Shape =
  | { type: 'hline'; ref: IPriceLine }
  | { type: 'trendline' | 'fibretracement' | 'rrindicator'; refs: ISeriesApi<'Line'>[] }
  | { type: 'rect'; ref: RectanglePrimitive }
  | { type: 'text'; ref: TextPrimitive }
  | { type: 'buymarker' | 'sellmarker'; ref: ISeriesApi<'Line'> }
/** A drawing on the chart: its objects, what it is (`spec`, which is what is saved) and its saved record once it has one. */
type Drawing = Shape & {
  spec: LwSpec
  rec?: { id: string; revision: number }
  /** The save in flight (create or change); a delete or a change waits for it. */
  busy?: Promise<unknown>
  /** Saved locked in KLine: drawn, but not picked or deleted here. */
  locked?: boolean
}

/** A Text drawing waiting for its text: the clicked point, and where (viewport pixels) to put the prompt. */
export interface LwPendingText { time: number; price: number; x: number; y: number; /** Set when the text of an existing drawing is being changed. */ editIndex?: number; initial?: string }
/** The drawing a click picked: its name, whether it has text to edit, and where (viewport pixels) to show its actions. */
export interface LwSelection { label: string; canEditText: boolean; x: number; y: number }
export interface LwDrawingSnapshot { mode: LwDrawMode; step: number; count: number; pendingText: LwPendingText | null; selection: LwSelection | null; notice: string }
export const emptyLwSnapshot: LwDrawingSnapshot = { mode: 'none', step: 0, count: 0, pendingText: null, selection: null, notice: '' }
const DRAWING_NAME: Record<Drawing['type'], string> = {
  hline: 'Horizontal line', trendline: 'Trend line', fibretracement: 'Fib retracement', rect: 'Rectangle', text: 'Text',
  buymarker: 'Buy marker', sellmarker: 'Sell marker', rrindicator: 'Risk:Reward',
}


/** Where a chart's drawings are saved: the drawings service and the instrument they belong to (the same identity KLine uses). */
export interface LwStore {
  request: DrawingRequest
  instrument: Record<string, unknown>
  /** localStorage key of this instrument's browser-only drawings from before they were saved to the database (copied up once). */
  legacyBase: string
  /** A Swing chart's old private scope: its earlier records are still read (as the KLine chart does). */
  legacyScope?: string
  /**
   * A private namespace for the drawings (the day's Notes chart, `notesScope(date)`): the other charts' drawings of the contract are
   * copied into it once, and what is drawn, changed or deleted stays in it. Without it nothing changes.
   */
  scope?: string
  /** Show the saved drawings only (the Summary): no tools, no picking, nothing is copied or saved. */
  readOnly?: boolean
}
/** The browser-only drawings of an instrument (its key, and the Deep Dive per-day keys) that have not been copied up yet. */
export const legacyKeys = (base: string) => {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && isLegacyKeyOf(base, key) && localStorage.getItem(`analysis-lw-migrated:${key}`) === null) keys.push(key)
    }
  } catch { /* storage can be disabled */ }
  return keys
}

export function lightweightDrawingKey(account: string, symbol: string, right?: string, strike?: number, expiry?: string) {
  return `analysis-lw-drawings:${account}:${symbol}:${right ?? ''}:${strike ?? ''}:${expiry ?? ''}`
}
export const lightweightStoreKey = (store: LwStore | null) => (store ? `${canonicalDrawingKey(store.instrument)}${store.scope ? `|${store.scope}` : ''}${store.readOnly ? '|view' : ''}` : '')

export class LightweightDrawingController {
  private drawings: Drawing[] = []
  private points: LwPoint[] = []
  private mode: LwDrawMode = 'none'
  private pendingText: LwPendingText | null = null
  private selected: number | null = null
  private selection: LwSelection | null = null
  private unhighlight: (() => void) | null = null
  private modeChangedAt = 0
  private listeners = new Set<() => void>()
  private disposed = false
  private readonly onClick = (param: MouseEventParams) => this.handleClick(param)
  // Saving to the database
  private store: LwStore | null = null
  private identity: ReturnType<typeof drawingIdentity> | null = null
  /** Set for a scoped (Notes) chart: its own namespace and the plain one it starts from. */
  private scoped: ReturnType<typeof scopedIdentity> | null = null
  private readonly owner = crypto.randomUUID()
  private generation = 0
  private busyCount = 0
  private notice = ''
  private stopWatching: (() => void) | null = null
  private retry: number | undefined
  private known = new Set<string>()

  constructor(private chart: IChartApi, private series: ISeriesApi<'Candlestick'>, store: LwStore | null) {
    chart.subscribeClick(this.onClick)
    chart.chartElement().addEventListener('dblclick', this.onDoubleClick)
    this.setStore(store)
  }

  snapshot(): LwDrawingSnapshot {
    return { mode: this.mode, step: this.points.length, count: this.drawings.length, pendingText: this.pendingText, selection: this.selection, notice: this.notice }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify() { this.listeners.forEach(listener => listener()) }
  private fail(action: string, error: unknown) {
    this.notice = `Could not ${action} the drawing: ${error instanceof Error ? error.message : String(error)}`
    this.notify()
  }

  /** Selecting the active tool again turns it off. */
  setMode(next: LwDrawMode) {
    this.clearSelection()
    this.mode = next === this.mode ? 'none' : next
    this.points = []
    this.pendingText = null
    this.modeChangedAt = Date.now()
    this.notify()
  }

  /** Remove the last drawing (from the chart and the database). */
  clearLast() {
    this.clearSelection()
    const drawing = this.drawings.pop()
    if (drawing) { this.remove(drawing); void this.removeRemote(drawing) }
    this.mode = 'none'
    this.points = []
    this.pendingText = null
    this.notify()
  }

  /** Switch to another instrument's drawings (the chart instance is reused across contracts). A new request alone changes nothing. */
  setStore(store: LwStore | null) {
    if (this.store && store && lightweightStoreKey(store) === lightweightStoreKey(this.store)) { this.store = store; return }
    this.clearSelection()
    this.stopWatching?.()
    this.stopWatching = null
    window.clearTimeout(this.retry)
    this.generation += 1
    this.removeAll()
    this.store = store
    this.scoped = store?.scope ? scopedIdentity(store.instrument, store.scope) : null
    this.identity = this.scoped ?? (store ? drawingIdentity(store.instrument, undefined, store.legacyScope, true) : null)
    this.mode = 'none'
    this.points = []
    this.pendingText = null
    this.notice = ''
    this.known = new Set()
    if (store && this.identity) {
      this.stopWatching = watchDrawingChanges(this.owner, this.identity.readKeys, () => { void this.refresh() })
      if (this.scoped) {
        // The first time this day's Notes chart is opened, start from the drawings of the other charts (never when only viewing).
        const scoped = this.scoped
        const ready = store.readOnly ? Promise.resolve() : seedScopedDrawings(store.request, scoped).then(() => undefined, error => this.fail('load', error))
        void ready.then(() => this.refresh())
      } else void this.refresh().then(() => this.migrate())
    }
    this.notify()
  }

  dispose() {
    this.disposed = true
    this.clearSelection(false)
    this.stopWatching?.()
    window.clearTimeout(this.retry)
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

  // ── The database ──────────────────────────────────────────────────────────

  private announce() {
    if (this.identity) announceDrawingChange({ owner: this.owner, keys: this.identity.readKeys })
  }
  private async call<T>(work: () => Promise<T>): Promise<T> {
    this.busyCount += 1
    try { return await work() } finally { this.busyCount -= 1 }
  }

  /** Replace what is on the chart with what the database has (after a change elsewhere, or on opening). */
  async refresh(): Promise<void> {
    const store = this.store
    const identity = this.identity
    if (!store || !identity || this.disposed) return
    const version = ++this.generation
    // Not while a save is in flight or a drawing is being placed: try again shortly.
    if (this.busyCount > 0 || this.mode !== 'none' || this.points.length || this.pendingText) {
      window.clearTimeout(this.retry)
      this.retry = window.setTimeout(() => { void this.refresh() }, 250)
      return
    }
    try {
      const results = this.scoped
        ? [{ drawings: await loadScopedRecords(store.request, this.scoped, Boolean(store.readOnly)) }]
        : await Promise.all(identity.readKeys.map(key => store.request(`drawings?instrument=${encodeURIComponent(key)}`, 'GET')))
      if (this.disposed || version !== this.generation || this.store !== store) return
      if (this.busyCount > 0) { void this.refresh(); return }
      const records = [...new Map(results
        .flatMap(value => (value as { drawings?: DrawingRecord[] }).drawings ?? [])
        .map(record => [record.drawing_id, record])).values()]
        .sort((x, y) => String((x as { updated_at?: string }).updated_at ?? '').localeCompare(String((y as { updated_at?: string }).updated_at ?? '')))
      this.clearSelection(false)
      this.removeAll()
      this.known = new Set()
      for (const record of records) {
        const read = fromPersisted(record.drawing)
        if (!read) continue
        const drawing = this.build(read.spec)
        if (!drawing) continue
        drawing.rec = { id: record.drawing_id, revision: record.revision }
        drawing.locked = read.locked
        this.drawings.push(drawing)
        this.known.add(specSignature(read.spec))
      }
      this.notice = ''
      this.notify()
    } catch (error) {
      if (version === this.generation) this.fail('load', error)
    }
  }

  private async post(drawing: Drawing): Promise<void> {
    const store = this.store
    const identity = this.identity
    if (!store || !identity) return
    try {
      const record = await this.call(() => store.request('drawings', 'POST', {
        instrument: identity.writeInstrument, drawing: toPersisted(drawing.spec), mutation_id: crypto.randomUUID(),
      })) as DrawingRecord
      drawing.rec = { id: record.drawing_id, revision: record.revision }
      this.announce()
    } catch (error) {
      this.fail('save', error)
    }
  }
  /** Save a drawing that was just made. */
  private save(drawing: Drawing) {
    drawing.busy = this.post(drawing)
  }
  /** Delete a drawing from the database (a soft delete, so it stays gone in both chart types). */
  private async removeRemote(drawing: Drawing): Promise<void> {
    const store = this.store
    const identity = this.identity
    await drawing.busy
    if (!store || !identity || !drawing.rec) return
    try {
      await this.call(() => store.request(`drawings/${drawing.rec!.id}`, 'DELETE', {
        instrument: identity.writeInstrument, drawing: toPersisted(drawing.spec), revision: drawing.rec!.revision, mutation_id: crypto.randomUUID(),
      }))
      this.announce()
    } catch (error) {
      this.fail('delete', error)
      void this.refresh() // the database still has it: show it again
    }
  }
  /** Save a changed drawing (the text of a Text). */
  private async putRemote(drawing: Drawing): Promise<void> {
    const store = this.store
    const identity = this.identity
    await drawing.busy
    if (!store || !identity || !drawing.rec) return
    try {
      const record = await this.call(() => store.request(`drawings/${drawing.rec!.id}`, 'PUT', {
        instrument: identity.writeInstrument, drawing: toPersisted(drawing.spec), revision: drawing.rec!.revision, mutation_id: crypto.randomUUID(),
      })) as DrawingRecord
      drawing.rec = { id: record.drawing_id, revision: record.revision }
      this.announce()
    } catch (error) {
      this.fail('save', error)
      void this.refresh()
    }
  }

  /** Copy the browser-only drawings of this instrument to the database, once per browser key (the local copy is left in place). */
  private async migrate(): Promise<void> {
    const store = this.store
    if (!store || this.disposed) return
    const keys = legacyKeys(store.legacyBase)
    if (!keys.length) return
    const bars = this.series.data() as unknown as { time: number }[]
    const last = bars.length ? bars[bars.length - 1].time : undefined
    const fallbackTime = typeof last === 'number' ? last : Math.floor(Date.now() / 1000)
    for (const key of keys) {
      let specs: LwSpec[] = []
      try { specs = legacyToSpecs(JSON.parse(localStorage.getItem(key) ?? '[]'), fallbackTime) } catch { /* unreadable: nothing to copy */ }
      let ok = true
      for (const spec of specs) {
        if (this.disposed || this.store !== store) return
        if (this.known.has(specSignature(spec))) continue // already in the database (copied from another browser)
        const drawing = this.build(spec)
        if (!drawing) continue
        this.drawings.push(drawing)
        this.known.add(specSignature(spec))
        this.save(drawing)
        await drawing.busy
        if (!drawing.rec) ok = false
      }
      this.notify()
      if (ok) { try { localStorage.setItem(`analysis-lw-migrated:${key}`, '1') } catch { /* try again next time */ } }
    }
  }

  /** The text typed for a pending Text drawing (an empty text drops a new one and leaves a changed one as it was). */
  submitText(text: string) {
    const pending = this.pendingText
    this.pendingText = null
    const clean = text.trim().slice(0, LW_TEXT_MAX)
    if (pending && clean && !this.disposed) {
      try {
        const old = pending.editIndex !== undefined ? this.drawings[pending.editIndex] : undefined
        const spec: LwSpec = { kind: 'text', pts: [{ time: pending.time, price: pending.price }], text: clean, color: TEXT_DRAWING_COLOR }
        const drawing = this.build(spec)
        if (drawing && old?.type === 'text') {
          // Change the text of an existing drawing: same place in the list and the same saved record.
          drawing.rec = old.rec
          drawing.busy = old.busy
          this.drawings[pending.editIndex!] = drawing
          this.remove(old)
          void this.putRemote(drawing)
          this.notify()
        } else if (drawing) this.finish(drawing)
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
    if (drawing.locked) return null // locked in KLine: drawn here, but not picked
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
    if (this.disposed || this.store?.readOnly || this.mode !== 'none' || this.pendingText) return
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
      void this.removeRemote(drawing)
    }
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

  /** A drawing just made: on the chart, and saved. */
  private finish(drawing: Drawing) {
    this.drawings.push(drawing)
    this.known.add(specSignature(drawing.spec))
    this.points = []
    this.mode = 'none'
    this.save(drawing)
    this.notify()
  }

  /** Draw a drawing from its spec (new, restored from the database or copied up from the browser). */
  private build(spec: LwSpec): Drawing | null {
    const [first, second] = spec.pts
    const line = (color: string, width: 1 | 2 | 3 = 1) => this.chart.addLineSeries({ color, lineWidth: width, ...LINE })
    const levelLine = (color: string, width: 1 | 2 | 3, start: number, end: number, price: number) => {
      const ref = line(color, width)
      ref.setData([{ time: start as Time, value: price }, { time: end as Time, value: price }])
      return ref
    }
    try {
      switch (spec.kind) {
        case 'hline': {
          const ref = this.series.createPriceLine({ price: first.price, color: '#e6edf3', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: first.price.toFixed(0) })
          return { type: 'hline', ref, spec }
        }
        case 'text':
          return { type: 'text', ref: attachText(this.series, { time: first.time, price: first.price, text: spec.text ?? '', color: spec.color ?? TEXT_DRAWING_COLOR }), spec }
        case 'buymarker':
        case 'sellmarker': {
          const buy = spec.kind === 'buymarker'
          const ref = this.chart.addLineSeries({ lineVisible: false, crosshairMarkerVisible: false, ...LINE })
          ref.setData([{ time: first.time as Time, value: first.price }])
          ref.setMarkers([{ time: first.time as Time, position: buy ? 'belowBar' : 'aboveBar', color: buy ? '#3b82f6' : '#f97316', shape: buy ? 'arrowUp' : 'arrowDown', text: spec.text ?? LW_MARKER_TEXT[spec.kind], size: 2 }])
          return { type: spec.kind, ref, spec }
        }
        case 'trendline': {
          const ref = line('#ffa657')
          ref.setData([
            { time: Math.min(first.time, second.time) as Time, value: first.time <= second.time ? first.price : second.price },
            { time: Math.max(first.time, second.time) as Time, value: first.time <= second.time ? second.price : first.price },
          ])
          return { type: 'trendline', refs: [ref], spec }
        }
        case 'fibretracement': {
          const start = Math.min(first.time, second.time)
          const end = Math.max(first.time, second.time)
          const low = Math.min(first.price, second.price)
          const range = Math.max(first.price, second.price) - low
          return { type: 'fibretracement', refs: FIB_LEVELS.map(level => levelLine(level.color, 1, start, end, low + range * level.ratio)), spec }
        }
        case 'rect':
          return { type: 'rect', ref: attachRectangle(this.series, first, second), spec }
        case 'rrindicator': {
          // The stop first, then the entry: a buy when the stop is below the entry.
          const risk = first.price
          const entry = second.price
          const isBuy = risk < entry
          const diff = Math.abs(entry - risk)
          const start = Math.min(first.time, second.time)
          const end = Math.max(first.time, second.time)
          const sign = isBuy ? 1 : -1
          const prices = [risk, entry, entry + sign * diff, entry + sign * diff * 1.5, entry + sign * diff * 2]
          return { type: 'rrindicator', refs: prices.map((price, i) => levelLine(RR_COLORS[i], 3, start, end, price)), spec }
        }
      }
    } catch { /* chart disposed */ }
    return null
  }

  private handleClick(param: MouseEventParams) {
    if (this.disposed || this.store?.readOnly) return
    if (this.mode === 'none') { this.pick(param); return }
    if (!param.point || !param.time) return
    // Ignore the click that selected the tool (dropdown items can overlap the chart).
    if (Date.now() - this.modeChangedAt < 150) return
    const price = this.series.coordinateToPrice(param.point.y)
    if (price === null) return
    const time = param.time as number
    const mode = this.mode
    const here = { time, price }
    try {
      if (mode === 'text') {
        // The text is asked for beside the clicked point; the drawing is made once it has one.
        const rect = this.chart.chartElement().getBoundingClientRect()
        this.pendingText = { time, price, x: rect.left + param.point.x, y: rect.top + param.point.y }
        this.mode = 'none'
        this.points = []
        this.notify()
      } else if (mode === 'hline' || mode === 'buymarker' || mode === 'sellmarker') {
        const drawing = this.build({ kind: mode, pts: [here], ...(mode === 'hline' ? {} : { text: LW_MARKER_TEXT[mode] }) })
        if (drawing) this.finish(drawing)
      } else if (!this.points[0]) {
        this.points = [here]
        this.notify()
      } else {
        const drawing = this.build({ kind: mode, pts: [this.points[0], here] })
        if (drawing) this.finish(drawing)
      }
    } catch { /* chart disposed */ }
  }
}
