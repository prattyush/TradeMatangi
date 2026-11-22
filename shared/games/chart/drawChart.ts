/**
 * Paints one frame of the games' chart on a 2D context (spec 9). The colours come in as a theme so the same code serves the dark and
 * the light desktop theme and both game palettes. Candles use colour and fill (hollow = up) so direction never rests on colour alone.
 */
import { candleGeometry, computeView, limitPoints, priceTicks, type ChartData, type ChartView, type Size } from './chartModel'

export interface ChartTheme {
  background: string
  grid: string
  text: string
  up: string
  down: string
  line: string
  level: string
  zone: string
  clock: string
  marker: string
  font: string
}

export const DARK_THEME: ChartTheme = {
  background: '#0d1117', grid: '#21262d', text: '#8b949e', up: '#009E73', down: '#D55E00', line: '#56B4E9', level: '#F0E442', zone: 'rgba(86,180,233,0.15)',
  clock: '#c9d1d9', marker: '#e6edf3', font: '11px system-ui, sans-serif',
}
export const LIGHT_THEME: ChartTheme = {
  background: '#ffffff', grid: '#d0d7de', text: '#57606a', up: '#007a5a', down: '#b34700', line: '#0072B2', level: '#8a6d00', zone: 'rgba(0,114,178,0.12)',
  clock: '#24292f', marker: '#1f2328', font: '11px system-ui, sans-serif',
}

/** The subset of CanvasRenderingContext2D that is used, so tests can pass a recorder. */
export interface Painter {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fill(): void
  closePath(): void
  fillText(text: string, x: number, y: number): void
  setLineDash(segments: number[]): void
  clearRect(x: number, y: number, w: number, h: number): void
}

const MARKER_SIZE = 5

function drawMarker(g: Painter, kind: string, x: number, y: number, theme: ChartTheme): void {
  g.fillStyle = theme.marker; g.strokeStyle = theme.marker
  g.beginPath()
  if (kind === 'long' || kind === 'entry') { g.moveTo(x, y - MARKER_SIZE); g.lineTo(x - MARKER_SIZE, y + MARKER_SIZE); g.lineTo(x + MARKER_SIZE, y + MARKER_SIZE) }
  else if (kind === 'short') { g.moveTo(x, y + MARKER_SIZE); g.lineTo(x - MARKER_SIZE, y - MARKER_SIZE); g.lineTo(x + MARKER_SIZE, y - MARKER_SIZE) }
  else { g.moveTo(x - MARKER_SIZE, y); g.lineTo(x, y - MARKER_SIZE); g.lineTo(x + MARKER_SIZE, y); g.lineTo(x, y + MARKER_SIZE) }
  g.closePath(); g.fill()
}

/** Returns the view used, so callers (tests, hover) can map coordinates. */
export function drawChart(g: Painter, rawData: ChartData, size: Size, theme: ChartTheme = DARK_THEME): ChartView {
  const data: ChartData = { ...rawData, candles: limitPoints(rawData.candles), line: limitPoints(rawData.line) }
  const view = computeView(data, size)
  const { plot } = view
  g.clearRect(0, 0, size.width, size.height)
  g.fillStyle = theme.background; g.fillRect(0, 0, size.width, size.height)
  g.font = theme.font; g.textAlign = 'left'; g.textBaseline = 'middle'
  g.setLineDash([])

  g.lineWidth = 1; g.strokeStyle = theme.grid; g.fillStyle = theme.text
  for (const tick of priceTicks(view.yRange)) {
    const y = Math.round(view.y(tick)) + 0.5
    if (y < plot.top || y > plot.top + plot.height) continue
    g.beginPath(); g.moveTo(plot.left, y); g.lineTo(plot.left + plot.width, y); g.stroke()
    g.fillText(Number.isInteger(tick) ? String(tick) : tick.toFixed(2), plot.left + plot.width + 4, y)
  }
  for (const zone of data.zones ?? []) {
    const top = view.y(Math.max(zone.y1, zone.y2)), bottom = view.y(Math.min(zone.y1, zone.y2))
    g.fillStyle = zone.colour ?? theme.zone; g.fillRect(plot.left, top, plot.width, Math.max(1, bottom - top))
  }
  for (const candle of data.candles ?? []) {
    const geo = candleGeometry(candle, view)
    const colour = geo.up ? theme.up : theme.down
    g.strokeStyle = colour; g.fillStyle = colour; g.lineWidth = 1
    g.beginPath(); g.moveTo(Math.round(geo.x) + 0.5, geo.wickTop); g.lineTo(Math.round(geo.x) + 0.5, geo.wickBottom); g.stroke()
    const left = geo.x - view.bodyWidth / 2, height = Math.max(1, geo.bodyBottom - geo.bodyTop)
    if (geo.up) { g.fillStyle = theme.background; g.fillRect(left, geo.bodyTop, view.bodyWidth, height); g.strokeRect(left, geo.bodyTop, view.bodyWidth, height) }
    else g.fillRect(left, geo.bodyTop, view.bodyWidth, height)
  }
  if (data.line?.length) {
    g.strokeStyle = theme.line; g.lineWidth = 1.5
    g.beginPath()
    data.line.forEach((point, i) => { const x = view.x(point.t), y = view.y(point.v); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y) })
    g.stroke()
  }
  for (const level of data.levels ?? []) {
    const y = Math.round(view.y(level.y)) + 0.5
    g.strokeStyle = level.colour ?? theme.level; g.fillStyle = level.colour ?? theme.level; g.lineWidth = 1
    g.setLineDash(level.dash === false ? [] : [4, 3])
    g.beginPath(); g.moveTo(plot.left, y); g.lineTo(plot.left + plot.width, y); g.stroke()
    g.setLineDash([])
    if (level.label) g.fillText(level.label, plot.left + 4, y - 6)
  }
  if (data.clock !== undefined && Number.isFinite(data.clock)) {
    const x = Math.round(view.x(data.clock)) + 0.5
    g.strokeStyle = theme.clock; g.lineWidth = 1; g.setLineDash([2, 3])
    g.beginPath(); g.moveTo(x, plot.top); g.lineTo(x, plot.top + plot.height); g.stroke()
    g.setLineDash([])
  }
  for (const marker of data.markers ?? []) {
    drawMarker(g, marker.kind, view.x(marker.t), view.y(marker.y), theme)
    if (marker.label) { g.fillStyle = theme.marker; g.fillText(marker.label, view.x(marker.t) + 8, view.y(marker.y)) }
  }
  return view
}
