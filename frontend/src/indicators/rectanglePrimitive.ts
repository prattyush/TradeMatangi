import type {
  ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'
import {
  extrapolateTimeX, formatAxisTime, hexToRgba, normalizeRect, type RectPoint, type RectStyle,
} from './rectangleMath'
import { getRectStyle, subscribeRectStyle } from './rectangleStyle'

type RenderTarget = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0]

/**
 * Shaded rectangle between two clicked corners (replaces the old parallel channel).
 * Modelled on TradingView's rectangle-drawing-tool plugin example. Coordinates are
 * resolved while drawing so pan / zoom / autoscale never leave it stale. The fill
 * follows Settings -> Display live (subscribeRectStyle).
 */
export class RectanglePrimitive implements ISeriesPrimitive<Time>, ISeriesPrimitivePaneRenderer {
  private attachment: SeriesAttachedParameter<Time> | null = null
  private style: RectStyle = getRectStyle()
  private unsubscribe: (() => void) | null = null
  private readonly paneViewList: ISeriesPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this }]
  private readonly priceViews: ISeriesPrimitiveAxisView[]
  private readonly timeViews: ISeriesPrimitiveAxisView[]

  constructor(readonly p1: RectPoint, readonly p2: RectPoint) {
    this.priceViews = [this.priceView(() => p1.price), this.priceView(() => p2.price)]
    this.timeViews = [this.timeView(() => p1.time), this.timeView(() => p2.time)]
  }

  attached(attachment: SeriesAttachedParameter<Time>): void {
    this.attachment = attachment
    this.style = getRectStyle()
    this.unsubscribe = subscribeRectStyle(style => {
      this.style = style
      this.attachment?.requestUpdate()
    })
    attachment.requestUpdate()
  }

  detached(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.attachment = null
  }

  updateAllViews(): void { /* coordinates are resolved lazily at draw time */ }
  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.paneViewList }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.priceViews }
  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.timeViews }

  toJSON(): { p1: RectPoint; p2: RectPoint } { return { p1: this.p1, p2: this.p2 } }

  /** x coordinate for a time; null `timeToCoordinate` (time absent from the loaded
   *  data, e.g. a corner past the last candle) is resolved against the series bars. */
  private xFor(time: number): number | null {
    const attachment = this.attachment
    if (!attachment) return null
    const timeScale = attachment.chart.timeScale()
    const direct = timeScale.timeToCoordinate(time as Time)
    if (direct !== null) return direct
    const times = (attachment.series as ISeriesApi<SeriesType>).data()
      .flatMap(bar => typeof bar.time === 'number' ? [Number(bar.time)] : [])
    return extrapolateTimeX(time, times, timeScale.options().barSpacing, t => timeScale.timeToCoordinate(t as Time))
  }

  draw(target: RenderTarget): void {
    const attachment = this.attachment
    if (!attachment) return
    const rect = normalizeRect(this.p1, this.p2)
    const x1 = this.xFor(rect.timeMin)
    const x2 = this.xFor(rect.timeMax)
    const yTop = attachment.series.priceToCoordinate(rect.priceMax)
    const yBottom = attachment.series.priceToCoordinate(rect.priceMin)
    if (x1 === null || x2 === null || yTop === null || yBottom === null) return
    const { fillColor, opacity } = this.style
    target.useMediaCoordinateSpace(({ context }) => {
      const left = Math.min(x1, x2)
      const top = Math.min(yTop, yBottom)
      const width = Math.max(1, Math.abs(x2 - x1))
      const height = Math.max(1, Math.abs(yBottom - yTop))
      context.save()
      context.fillStyle = hexToRgba(fillColor, opacity)
      context.fillRect(left, top, width, height)
      context.strokeStyle = hexToRgba(fillColor, Math.min(1, opacity + 0.5))
      context.lineWidth = 1
      context.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
      context.restore()
    })
  }

  private labelColors() {
    return { back: hexToRgba(this.style.fillColor, 0.85), text: '#ffffff' }
  }

  private priceView(price: () => number): ISeriesPrimitiveAxisView {
    return {
      coordinate: () => this.attachment?.series.priceToCoordinate(price()) ?? -1,
      visible: () => this.attachment?.series.priceToCoordinate(price()) != null,
      text: () => this.attachment?.series.priceFormatter().format(price()) ?? '',
      textColor: () => this.labelColors().text,
      backColor: () => this.labelColors().back,
    }
  }

  private timeView(time: () => number): ISeriesPrimitiveAxisView {
    return {
      coordinate: () => this.xFor(time()) ?? -1,
      visible: () => this.xFor(time()) !== null,
      text: () => formatAxisTime(time()),
      textColor: () => this.labelColors().text,
      backColor: () => this.labelColors().back,
    }
  }
}

/** Create a rectangle and attach it to `series`; detach with `series.detachPrimitive(rect)`. */
export function attachRectangle(
  series: ISeriesApi<SeriesType>, p1: RectPoint, p2: RectPoint,
): RectanglePrimitive {
  const rectangle = new RectanglePrimitive(p1, p2)
  series.attachPrimitive(rectangle)
  return rectangle
}
