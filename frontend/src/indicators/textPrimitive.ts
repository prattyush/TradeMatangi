import type {
  ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'

type RenderTarget = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0]

export interface TextDrawingData { time: number; price: number; text: string; color: string }
export const TEXT_DRAWING_COLOR = '#facc15'
const FONT = 'bold 13px sans-serif'

let measuring: CanvasRenderingContext2D | null = null
/** Width (px) of a text drawing's text, for picking it with a click. */
export function textWidth(text: string): number {
  if (!measuring) measuring = document.createElement('canvas').getContext('2d')
  if (!measuring) return text.length * 7.5
  measuring.font = FONT
  return measuring.measureText(text).width
}

/**
 * A text label placed at a clicked time and price (the Text drawing of the Lightweight Analysis, Patterns and Deep Dive charts).
 * The text starts just right of the point, in bold with a dark outline so it reads on any candle, and has no box behind it.
 * Coordinates are resolved while drawing, so panning, zooming and autoscale never leave it stale.
 */
export class TextPrimitive implements ISeriesPrimitive<Time>, ISeriesPrimitivePaneRenderer {
  private attachment: SeriesAttachedParameter<Time> | null = null
  private selected = false
  private readonly paneViewList: ISeriesPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => this }]

  constructor(readonly data: TextDrawingData) {}

  attached(attachment: SeriesAttachedParameter<Time>): void { this.attachment = attachment; attachment.requestUpdate() }
  detached(): void { this.attachment = null }
  updateAllViews(): void { /* coordinates are resolved lazily at draw time */ }
  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.paneViewList }
  toJSON(): TextDrawingData { return this.data }

  /** Outline the text while it is the selected drawing. */
  setSelected(on: boolean): void { this.selected = on; this.attachment?.requestUpdate() }

  draw(target: RenderTarget): void {
    const attachment = this.attachment
    if (!attachment) return
    const x = attachment.chart.timeScale().timeToCoordinate(this.data.time as Time)
    const y = attachment.series.priceToCoordinate(this.data.price)
    if (x === null || y === null) return
    target.useMediaCoordinateSpace(({ context }) => {
      context.save()
      context.font = FONT
      context.textAlign = 'left'
      context.textBaseline = 'middle'
      context.lineJoin = 'round'
      context.lineWidth = 3
      context.strokeStyle = 'rgba(13,17,23,0.9)'
      context.strokeText(this.data.text, x + 6, y)
      context.fillStyle = this.data.color
      context.fillText(this.data.text, x + 6, y)
      if (this.selected) {
        context.strokeStyle = '#f0883e'
        context.lineWidth = 1
        context.strokeRect(x + 3, y - 10, context.measureText(this.data.text).width + 6, 20)
      }
      context.restore()
    })
  }
}

/** Create a text drawing and attach it to `series`; detach with `series.detachPrimitive(text)`. */
export function attachText(series: ISeriesApi<SeriesType>, data: TextDrawingData): TextPrimitive {
  const text = new TextPrimitive(data)
  series.attachPrimitive(text)
  return text
}
