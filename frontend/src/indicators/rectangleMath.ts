/** Pure helpers for the rectangle drawing tool (no chart / DOM imports, unit-testable). */

export interface RectStyle {
  fillColor: string
  opacity: number
}

/** Same defaults as the desktop app / KLine chart (`drawingFillColor` / `drawingFillOpacity`). */
export const DEFAULT_RECT_STYLE: RectStyle = { fillColor: '#60a5fa', opacity: 0.16 }

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim())
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = isHexColor(hex) ? hex.trim().slice(1) : DEFAULT_RECT_STYLE.fillColor.slice(1)
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean
  const n = parseInt(full, 16)
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : DEFAULT_RECT_STYLE.opacity))
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** Read a style out of the per-user chart-settings record, falling back to defaults. */
export function normalizeRectStyle(settings: Record<string, unknown> | null | undefined): RectStyle {
  const color = settings?.drawingFillColor
  const opacity = Number(settings?.drawingFillOpacity)
  return {
    fillColor: isHexColor(color) ? color.trim() : DEFAULT_RECT_STYLE.fillColor,
    opacity: settings?.drawingFillOpacity != null && Number.isFinite(opacity)
      ? Math.min(1, Math.max(0.02, opacity))
      : DEFAULT_RECT_STYLE.opacity,
  }
}

export interface RectPoint { time: number; price: number }

/** Order the two clicked corners so left<=right in time and bottom<=top in price. */
export function normalizeRect(p1: RectPoint, p2: RectPoint) {
  return {
    timeMin: Math.min(p1.time, p2.time),
    timeMax: Math.max(p1.time, p2.time),
    priceMin: Math.min(p1.price, p2.price),
    priceMax: Math.max(p1.price, p2.price),
  }
}

/** Time-axis label. Timestamps are IST-as-UTC, so UTC accessors give IST wall-clock. */
export function formatAxisTime(seconds: number): string {
  const d = new Date(seconds * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * The chart-settings record to save: everything already stored is kept (the record is shared with the desktop
 * app), only the two rectangle keys change, and the values are sanitised exactly like they are on read.
 */
export function mergeRectSettings(latest: Record<string, unknown> | null | undefined, style: RectStyle): Record<string, unknown> {
  const clean = normalizeRectStyle({ drawingFillColor: style.fillColor, drawingFillOpacity: style.opacity })
  return { ...(latest ?? {}), drawingFillColor: clean.fillColor, drawingFillOpacity: clean.opacity }
}

/**
 * x coordinate for a corner time the chart cannot place directly (`timeToCoordinate` is null because the time is
 * not one of the loaded candles). `times` are the loaded candle times, oldest first; `coordinateOf` is the chart's
 * own time -> x lookup. A time past either end is extrapolated from the average bar spacing, a time inside a gap
 * snaps to the nearest candle, and fewer than two candles (nothing to measure against) gives null.
 */
export function extrapolateTimeX(
  time: number, times: number[], barSpacing: number, coordinateOf: (time: number) => number | null,
): number | null {
  if (times.length < 2) return null
  const first = times[0]
  const last = times[times.length - 1]
  const step = (last - first) / (times.length - 1)
  if (!(step > 0)) return null
  if (time > last) {
    const edge = coordinateOf(last)
    return edge === null ? null : edge + ((time - last) / step) * barSpacing
  }
  if (time < first) {
    const edge = coordinateOf(first)
    return edge === null ? null : edge - ((first - time) / step) * barSpacing
  }
  const nearest = times.reduce((best, t) => Math.abs(t - time) < Math.abs(best - time) ? t : best)
  return coordinateOf(nearest)
}
