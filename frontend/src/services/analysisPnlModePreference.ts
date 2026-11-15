export type AnalysisPnlMode = 'currency' | 'percent'
export const analysisPnlModeEvent = 'analysis-pnl-mode'
/** The Settings toggle mirrors the user's choice into this browser key, so the first paint already uses it. */
const BROWSER_KEY = 'pnlPctMode'
let cached: AnalysisPnlMode | undefined
export const isAnalysisPnlMode = (value: unknown): value is AnalysisPnlMode => value === 'currency' || value === 'percent'
export function cachedAnalysisPnlMode(): AnalysisPnlMode {
  if (cached) return cached
  try { return localStorage.getItem(BROWSER_KEY) === 'true' ? 'percent' : 'currency' } catch { return 'currency' }
}
/** Remembers the server value (`desktop_pnl_display_mode`) and tells every mounted Label Trades view. */
export function publishAnalysisPnlMode(raw: unknown) {
  // Milestones is a trading-screen mode only; Label Trades and the other Analysis views stay in rupees.
  const value = raw === 'milestones' ? 'currency' : raw
  if (!isAnalysisPnlMode(value)) return
  cached = value
  window.dispatchEvent(new CustomEvent(analysisPnlModeEvent, { detail: value }))
}
