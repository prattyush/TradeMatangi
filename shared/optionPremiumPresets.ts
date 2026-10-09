/** UI suggestions, not hard limits on custom/saved premium caps. */
export const NIFTY_PREMIUM_PRESETS = [30, 50, 75, 100, 125, 150]
export const SENSEX_PREMIUM_PRESETS = [50, 100, 150, 200, 250]
const OTHER_PREMIUM_PRESETS = [25, 50, 75, 100, 125, 150]

export function premiumPresetsFor(symbol: string): number[] {
  return symbol === 'NIFTY' ? NIFTY_PREMIUM_PRESETS : symbol === 'BSESEN' ? SENSEX_PREMIUM_PRESETS : OTHER_PREMIUM_PRESETS
}

/** Keep legacy/custom saved values visible without restoring a removed preset. */
export function withSavedPremium(values: number[], saved: number): number[] {
  return Number.isFinite(saved) && saved > 0 && !values.includes(saved) ? [...values, saved] : values
}
