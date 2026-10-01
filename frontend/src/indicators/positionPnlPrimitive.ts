import type {
  ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView,
  SeriesAttachedParameter, Time,
} from 'lightweight-charts'
import type { PositionPnlLevel } from './positionPnlLevels'

type RenderTarget = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0]

/** Short P&L segments rendered with the candle series' current chart transform. */
export class PositionPnlPrimitive implements ISeriesPrimitive, ISeriesPrimitivePaneRenderer {
  private attachment: SeriesAttachedParameter | null = null
  private levels: PositionPnlLevel[] = []
  private anchorTime: number | null = null
  private fallbackTime: number | null = null
  private fallbackKey = ''
  private fallbackCandidate: number | null = null
  private readonly views: ISeriesPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => this }]

  attached(attachment: SeriesAttachedParameter): void {
    this.attachment = attachment
    attachment.requestUpdate()
  }

  detached(): void {
    this.attachment = null
    this.fallbackTime = null
  }

  setLevels(levels: PositionPnlLevel[], anchorTime: number | null, fallbackCandidate: number | null): void {
    const key = levels.map(level => `${level.key}:${level.price}`).join('|')
    if (key !== this.fallbackKey) this.fallbackTime = null
    this.fallbackKey = key
    this.levels = levels
    this.anchorTime = anchorTime
    this.fallbackCandidate = fallbackCandidate
    this.attachment?.requestUpdate()
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.views }

  draw(target: RenderTarget): void {
    const attachment = this.attachment
    if (!attachment || !this.levels.length) return
    const { chart, series } = attachment
    const timeScale = chart.timeScale()
    let anchor = this.anchorTime ?? this.fallbackTime ?? this.fallbackCandidate
    let center = anchor === null ? null : timeScale.timeToCoordinate(anchor as Time)
    if (center === null) {
      // Fills can precede the first tick or sit in a gap in reloaded history.
      // Lightweight Charts returns null for a time absent from its time scale.
      const times = series.data().flatMap(bar => typeof bar.time === 'number' ? [Number(bar.time)] : [])
      if (!times.length) return
      const desired = anchor ?? times[times.length - 1]
      const nearest = times.reduce((best, time) => Math.abs(time - desired) < Math.abs(best - desired) ? time : best)
      center = timeScale.timeToCoordinate(nearest as Time)
      anchor = desired
    }
    if (center === null) return
    if (this.anchorTime === null && this.fallbackTime === null) this.fallbackTime = anchor

    // Compute price coordinates during canvas drawing, after autoscaling. React
    // effects can run before that repaint and miss a data/price-scale update.
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const width = Math.min(mediaSize.width, Math.max(1, timeScale.options().barSpacing) * 5)
      const x = Math.max(0, Math.min(mediaSize.width - width, center! - width / 2))
      context.save()
      context.font = '10px Arial, sans-serif'
      context.textBaseline = 'bottom'
      context.lineWidth = 1
      for (const level of this.levels) {
        const y = series.priceToCoordinate(level.price)
        if (y === null || y < 0 || y > mediaSize.height) continue
        context.strokeStyle = level.color
        context.beginPath()
        context.moveTo(x, y)
        context.lineTo(x + width, y)
        context.stroke()
        const labelWidth = context.measureText(level.label).width + 4
        const labelX = Math.max(0, Math.min(mediaSize.width - labelWidth, x))
        const labelBottom = Math.max(12, y - 2)
        context.fillStyle = '#0d1117'
        context.fillRect(labelX, labelBottom - 12, labelWidth, 12)
        context.fillStyle = level.color
        context.fillText(level.label, labelX + 2, labelBottom)
      }
      context.restore()
    })
  }
}
