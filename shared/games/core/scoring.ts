/** Session score helpers shared by both pools (spec 6.3). Game-specific scoring lives with each game. */
import { CATEGORIES, catalogueEntry, type Category, type GameId } from './ids'

export const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value))
export const clamp01 = (value: number): number => clamp(value, 0, 1)

/** SessionScore is an integer 0..100. NaN counts as 0 so a bad game cannot poison progress. */
export const toSessionScore = (value: number): number => (Number.isFinite(value) ? Math.round(clamp(value, 0, 100)) : 0)

export const levelFactor = (level: number): number => 0.6 + 0.4 * (clamp(level, 1, 20) / 20)

/** Exponential moving score used for the per-game `emaScore`: 0.7 * previous + 0.3 * new (first session: the score). */
export const nextEma = (previous: number | undefined, score: number): number =>
  previous === undefined || !Number.isFinite(previous) ? score : Math.round((0.7 * previous + 0.3 * score) * 100) / 100

/** Rating contribution of a session: `SessionScore * levelFactor`. */
export const ratedScore = (score: number, level: number): number => score * levelFactor(level)

export interface GameRatingInput { id: GameId; emaScore?: number }

/**
 * Category rating, 0..100: the mean over the played games in the category of `emaScore`, which is stored per game
 * as the moving value `0.7 * prev + 0.3 * SessionScore * levelFactor` (`nextEma` of `ratedScore`). Unplayed categories are absent.
 */
export function categoryRatings(games: GameRatingInput[]): Partial<Record<Category, number>> {
  const sums: Partial<Record<Category, { total: number; count: number }>> = {}
  for (const game of games) {
    if (game.emaScore === undefined || !Number.isFinite(game.emaScore)) continue
    const category = catalogueEntry(game.id)?.category
    if (!category) continue
    const bucket = sums[category] ?? (sums[category] = { total: 0, count: 0 })
    bucket.total += game.emaScore
    bucket.count += 1
  }
  const out: Partial<Record<Category, number>> = {}
  for (const category of CATEGORIES) {
    const bucket = sums[category]
    if (bucket) out[category] = Math.round((bucket.total / bucket.count) * 10) / 10
  }
  return out
}
