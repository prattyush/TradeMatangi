/**
 * Geometry of the games' canvas chart (spec 9). Pure: series and a pixel size in, pixel coordinates out, so layout is tested without
 * a canvas. Prices are whatever the game passes (usually rebased points); times are seconds, relative or of the day.
 */
export interface Candle { t: number; o: number; h: number; l: number; c: number }
export interface LinePoint { t: number; v: number }
export interface Level { y: number; label?: string; colour?: string; dash?: boolean }
export interface Zone { y1: number; y2: number; colour?: string; label?: string }
export type MarkerKind = 'entry' | 'exit' | 'stop' | 'target' | 'long' | 'short'
export interface Marker { t: number; y: number; kind: MarkerKind; label?: string }

export interface ChartData {
  candles?: Candle[]
  line?: LinePoint[]
  levels?: Level[]
  zones?: Zone[]
  markers?: Marker[]
  /** A vertical line at this time (the replay clock). */
  clock?: number
  /** Fixed time range; otherwise the data's. */
  xRange?: [number, number]
  /** Fixed price range; otherwise the data's, padded. */
  yRange?: [number, number]
}

export interface Size { width: number; height: number }
export interface Padding { left: number; right: number; top: number; bottom: number }
export const DEFAULT_PADDING: Padding = { left: 8, right: 56, top: 10, bottom: 18 }

/** The spec's ceiling for one chart (spec 9): the oldest points are dropped beyond it. */
export const MAX_POINTS = 20_000

export interface ChartView {
  x: (t: number) => number
  y: (price: number) => number
  xRange: [number, number]
  yRange: [number, number]
  plot: { left: number; top: number; width: number; height: number }
  /** Pixel width of one candle body (0 when there are no candles). */
  bodyWidth: number
  /** Seconds one candle spans (the median spacing of the candles). */
  step: number
  /** The inverse of `x`: the time at a pixel column (for clicks on the chart). */
  timeAt: (px: number) => number
}

export function limitPoints<T>(items: T[] | undefined): T[] | undefined {
  return items && items.length > MAX_POINTS ? items.slice(items.length - MAX_POINTS) : items
}

const finite = (values: number[]) => values.filter(Number.isFinite)

export function dataRanges(data: ChartData): { x: [number, number]; y: [number, number] } {
  const times: number[] = [], prices: number[] = []
  for (const c of data.candles ?? []) { times.push(c.t); prices.push(c.h, c.l) }
  for (const p of data.line ?? []) { times.push(p.t); prices.push(p.v) }
  for (const m of data.markers ?? []) { times.push(m.t); prices.push(m.y) }
  for (const l of data.levels ?? []) prices.push(l.y)
  for (const z of data.zones ?? []) prices.push(z.y1, z.y2)
  if (data.clock !== undefined) times.push(data.clock)
  const t = finite(times), p = finite(prices)
  const x: [number, number] = t.length ? [Math.min(...t), Math.max(...t)] : [0, 1]
  const y: [number, number] = p.length ? [Math.min(...p), Math.max(...p)] : [-1, 1]
  return { x, y }
}

/** Candle spacing used to give the last candle room on the right (the median gap between candle starts, else 1). */
export function candleStep(candles: Candle[] | undefined): number {
  if (!candles || candles.length < 2) return 1
  const gaps: number[] = []
  for (let i = 1; i < candles.length; i++) if (candles[i].t > candles[i - 1].t) gaps.push(candles[i].t - candles[i - 1].t)
  gaps.sort((a, b) => a - b)
  return gaps.length ? gaps[gaps.length >> 1] : 1
}

export function computeView(data: ChartData, size: Size, padding: Padding = DEFAULT_PADDING): ChartView {
  const ranges = dataRanges(data)
  const step = candleStep(data.candles)
  let [x0, x1] = data.xRange ?? [ranges.x[0], ranges.x[1] + (data.candles?.length ? step : 0)]
  if (!(x1 > x0)) x1 = x0 + 1
  let [y0, y1] = data.yRange ?? ranges.y
  if (!data.yRange) {
    const pad = (y1 - y0) * 0.08 || Math.max(Math.abs(y0) * 0.001, 0.5)
    y0 -= pad; y1 += pad
  }
  if (!(y1 > y0)) y1 = y0 + 1
  const plot = { left: padding.left, top: padding.top, width: Math.max(1, size.width - padding.left - padding.right), height: Math.max(1, size.height - padding.top - padding.bottom) }
  const x = (t: number) => plot.left + ((t - x0) / (x1 - x0)) * plot.width
  const y = (price: number) => plot.top + (1 - (price - y0) / (y1 - y0)) * plot.height
  const count = data.candles?.length ?? 0
  const bodyWidth = count ? Math.max(1, Math.min(14, (plot.width / Math.max(1, (x1 - x0) / step)) * 0.7)) : 0
  const timeAt = (px: number) => x0 + ((px - plot.left) / plot.width) * (x1 - x0)
  return { x, y, xRange: [x0, x1], yRange: [y0, y1], plot, bodyWidth, step, timeAt }
}

/** Round tick values for the price axis (about `count` of them). */
export function priceTicks(range: [number, number], count = 5): number[] {
  const span = range[1] - range[0]
  if (!(span > 0)) return [range[0]]
  const raw = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const unit = [1, 2, 5, 10].map(m => m * magnitude).find(step => step >= raw) ?? raw
  const ticks: number[] = []
  for (let v = Math.ceil(range[0] / unit) * unit; v <= range[1] + unit * 1e-9; v += unit) ticks.push(Math.round(v / unit) * unit)
  return ticks
}

export interface CandleGeometry { x: number; wickTop: number; wickBottom: number; bodyTop: number; bodyBottom: number; up: boolean }

/** A candle is centred in its time slot (`t` to `t + step`). A flat body is drawn at least one pixel high by the painter. */
export function candleGeometry(candle: Candle, view: ChartView): CandleGeometry {
  const open = view.y(candle.o), close = view.y(candle.c)
  return {
    x: view.x(candle.t + view.step / 2),
    wickTop: view.y(candle.h), wickBottom: view.y(candle.l),
    bodyTop: Math.min(open, close), bodyBottom: Math.max(open, close), up: candle.c >= candle.o,
  }
}
