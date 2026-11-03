import { BACKEND_URL } from '../config'
import { _authHeaders } from '../services/api'
import { DEFAULT_RECT_STYLE, normalizeRectStyle, type RectStyle } from './rectangleMath'

/** Same event name `dev`'s chart-appearance settings dispatch after saving. */
export const CHART_APPEARANCE_EVENT = 'website-chart-appearance'

/** Read (no argument) or write the per-user chart-settings record shared with the desktop app. */
export async function requestChartSettings(settings?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${BACKEND_URL}/api/desktop/v1/chart-settings`, {
    method: settings ? 'PUT' : 'GET',
    headers: { ..._authHeaders(), 'Content-Type': 'application/json' },
    ...(settings ? { body: JSON.stringify({ settings }) } : {}),
  })
  if (!response.ok) throw new Error(`Chart settings failed (${response.status})`)
  return ((await response.json()).settings ?? {}) as Record<string, unknown>
}

let current: RectStyle = { ...DEFAULT_RECT_STYLE }
let loadStarted = false
const listeners = new Set<(style: RectStyle) => void>()

function publish(settings: Record<string, unknown> | null | undefined): void {
  current = normalizeRectStyle(settings)
  listeners.forEach(listener => listener(current))
}

function ensureLoaded(): void {
  if (loadStarted || typeof window === 'undefined') return
  loadStarted = true
  window.addEventListener(CHART_APPEARANCE_EVENT, event => {
    const settings = (event as CustomEvent<{ settings?: Record<string, unknown> }>).detail?.settings
    if (settings) publish(settings)
  })
  requestChartSettings().then(publish).catch(() => { loadStarted = false })
}

export function getRectStyle(): RectStyle { return current }

/** Subscribe to rectangle style changes (Settings -> Display). Returns an unsubscribe fn. */
export function subscribeRectStyle(listener: (style: RectStyle) => void): () => void {
  ensureLoaded()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
