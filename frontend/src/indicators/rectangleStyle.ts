import { BACKEND_URL } from '../config'
import { _authHeaders } from '../services/api'
import { rendererAccountKey } from '../services/websiteChartPreferences'
import { DEFAULT_RECT_STYLE, normalizeRectStyle, type RectStyle } from './rectangleMath'

/** Same event name the KLine chart-appearance settings dispatch after saving. */
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

// The style belongs to the signed-in account; never show one user's fill to another
// after an account switch without a page reload.
let current: RectStyle = { ...DEFAULT_RECT_STYLE }
let owner: string | null = null
let listening = false
const listeners = new Set<(style: RectStyle) => void>()

function publish(settings: Record<string, unknown> | null | undefined): void {
  current = normalizeRectStyle(settings)
  listeners.forEach(listener => listener(current))
}

function ensureLoaded(): void {
  if (typeof window === 'undefined') return
  if (!listening) {
    listening = true
    window.addEventListener(CHART_APPEARANCE_EVENT, event => {
      const detail = (event as CustomEvent<{ owner?: string; settings?: Record<string, unknown> }>).detail
      if (!detail?.settings || (detail.owner !== undefined && detail.owner !== rendererAccountKey())) return
      owner = rendererAccountKey()
      publish(detail.settings)
    })
  }
  const account = rendererAccountKey()
  if (owner === account) return
  owner = account
  current = { ...DEFAULT_RECT_STYLE }
  requestChartSettings()
    .then(settings => { if (account === rendererAccountKey()) publish(settings) })
    .catch(() => { if (owner === account) owner = null })   // retry on the next subscribe
}

export function getRectStyle(): RectStyle {
  ensureLoaded()
  return current
}

/** Subscribe to rectangle style changes (Settings -> Display). Returns an unsubscribe fn. */
export function subscribeRectStyle(listener: (style: RectStyle) => void): () => void {
  ensureLoaded()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
