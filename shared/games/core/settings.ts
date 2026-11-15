/** Games settings, saved in the profile record (spec 7.4, 17.8). Unknown or out-of-range values fall back to defaults. */
export type WarmupPool = 'both' | 'market' | 'brain'

export interface GamesSettings {
  sound: boolean
  reduceMotion: boolean
  /** Font scale, percent, 80..150. */
  zoom: number
  warmupPool: WarmupPool
  /** Halves resident data in market games (G3b onward). */
  lowMemory: boolean
}

export const DEFAULT_SETTINGS: GamesSettings = { sound: false, reduceMotion: false, zoom: 100, warmupPool: 'both', lowMemory: false }

export function normalizeSettings(raw: unknown): GamesSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const zoom = typeof input.zoom === 'number' && Number.isFinite(input.zoom) ? Math.min(150, Math.max(80, Math.round(input.zoom))) : DEFAULT_SETTINGS.zoom
  const pool = input.warmupPool === 'market' || input.warmupPool === 'brain' || input.warmupPool === 'both' ? input.warmupPool : DEFAULT_SETTINGS.warmupPool
  return {
    sound: input.sound === true,
    reduceMotion: input.reduceMotion === true,
    zoom,
    warmupPool: pool,
    lowMemory: input.lowMemory === true,
  }
}

/** Keep unknown keys other sprints may have stored; replace the ones this version knows. */
export const mergeSettings = (existing: Record<string, unknown> | undefined, next: GamesSettings): Record<string, unknown> => ({ ...(existing ?? {}), ...next })
