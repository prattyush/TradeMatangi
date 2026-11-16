import { DEFAULT_COST, normalizeCost } from '../market/engine/costModel'

/** Games settings, saved in the profile record (spec 7.4, 17.8). Unknown or out-of-range values fall back to defaults. */
export type WarmupPool = 'both' | 'market' | 'brain'
/** `safe` = the Okabe-Ito set (default), `contrast` = the same hues, lighter and with thicker outlines. */
export type PaletteName = 'safe' | 'contrast'

export interface GamesSettings {
  sound: boolean
  reduceMotion: boolean
  /** Font scale, percent, 80..150. */
  zoom: number
  warmupPool: WarmupPool
  palette: PaletteName
  /** Halves the window cache of the market games. */
  lowMemory: boolean
  /** Market-game costs (spec 4.4). Placeholders until the player enters their broker's numbers. */
  slippagePtsPerSide: number
  roundTripCostPerLotRs: number
  defaultLots: number
}

export const DEFAULT_SETTINGS: GamesSettings = { sound: false, reduceMotion: false, zoom: 100, warmupPool: 'both', palette: 'safe', lowMemory: false, ...DEFAULT_COST }

export function normalizeSettings(raw: unknown): GamesSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const zoom = typeof input.zoom === 'number' && Number.isFinite(input.zoom) ? Math.min(150, Math.max(80, Math.round(input.zoom))) : DEFAULT_SETTINGS.zoom
  const pool = input.warmupPool === 'market' || input.warmupPool === 'brain' || input.warmupPool === 'both' ? input.warmupPool : DEFAULT_SETTINGS.warmupPool
  return {
    sound: input.sound === true,
    reduceMotion: input.reduceMotion === true,
    zoom,
    warmupPool: pool,
    palette: input.palette === 'contrast' ? 'contrast' : 'safe',
    lowMemory: input.lowMemory === true,
    ...normalizeCost(input),
  }
}

/** Keep unknown keys other sprints may have stored; replace the ones this version knows. */
export const mergeSettings = (existing: Record<string, unknown> | undefined, next: GamesSettings): Record<string, unknown> => ({ ...(existing ?? {}), ...next })
