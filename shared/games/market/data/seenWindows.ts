/**
 * No-repeat memory (spec 4.3 rule 3): the windows a user played in a game in the last N days, kept in the browser's local storage.
 * Losing it is harmless: the player may see a window again. Storage failures (private window, quota) are swallowed.
 */
import { daysBetween } from '../../core/dates'
import { DEFAULT_NO_REPEAT_DAYS } from '../engine/windows'

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

const MAX_ENTRIES = 3000
const keyOf = (userId: string, gameId: string): string => `tm-games-seen:${userId}:${gameId}`

export interface SeenWindows {
  /** Ids seen within the no-repeat period. */
  recent(): Set<string>
  add(id: string): void
}

export function createSeenWindows(storage: StorageLike | null, userId: string, gameId: string, today: string, noRepeatDays = DEFAULT_NO_REPEAT_DAYS): SeenWindows {
  const key = keyOf(userId, gameId)
  const load = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(storage?.getItem(key) ?? '{}') as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
    } catch { return {} }
  }
  const fresh = (entries: Record<string, string>): Array<[string, string]> =>
    Object.entries(entries).filter(([, day]) => typeof day === 'string' && daysBetween(day, today) <= noRepeatDays && daysBetween(day, today) >= 0)
  let memory = Object.fromEntries(fresh(load()))
  return {
    recent: () => new Set(Object.keys(memory)),
    add(id) {
      memory[id] = today
      const keys = Object.keys(memory)
      if (keys.length > MAX_ENTRIES) {
        const oldest = keys.sort((x, y) => memory[x].localeCompare(memory[y])).slice(0, keys.length - MAX_ENTRIES)
        for (const key of oldest) delete memory[key]
      }
      try { storage?.setItem(key, JSON.stringify(memory)) } catch { /* the memory is only a convenience */ }
    },
  }
}

export function browserStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
