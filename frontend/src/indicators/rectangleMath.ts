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
