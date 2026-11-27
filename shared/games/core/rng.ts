/** Seeded randomness. A session is regenerated from `userId + date + gameId + sessionNo` (Review mode, tests). */

export interface Rng {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number
  pick<T>(items: readonly T[]): T
  shuffle<T>(items: readonly T[]): T[]
  chance(probability: number): boolean
}

/** xmur3: string -> 32-bit seed. */
export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** mulberry32. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  return {
    next,
    int,
    pick: items => items[int(0, items.length - 1)],
    shuffle: items => {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) { const j = int(0, i); [out[i], out[j]] = [out[j], out[i]] }
      return out
    },
    chance: probability => next() < probability,
  }
}

/** The documented seed: the same inputs always give the same session. */
export function sessionSeed(userId: string, date: string, gameId: string, sessionNo: number): number {
  return hashSeed(`${userId}|${date}|${gameId}|${sessionNo}`)
}

export const sessionRng = (userId: string, date: string, gameId: string, sessionNo: number): Rng =>
  createRng(sessionSeed(userId, date, gameId, sessionNo))
