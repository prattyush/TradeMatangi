/**
 * How much of a day is labelled, for the little indicator on each date row of Analysis (no backend change: the round trips and
 * labels of every session are read through the normal Analysis API). Reads are shared (one per session until a label is
 * saved), spread out (at most three requests at a time, so a long search result does not flood the server) and cached.
 */
import type { RoundTrip, TradeLabel } from '../api'
import { isFullyLabeled, labelKey } from './model'

export interface DayProgress { done: number; total: number }
interface Source {
  getRoundTrips(sessionId: string): Promise<RoundTrip[]>
  getLabels(sessionId: string): Promise<TradeLabel[]>
}

export const MAX_PARALLEL_READS = 3
const cache = new Map<string, Promise<DayProgress>>()
const listeners = new Set<(sessionIds: string[]) => void>()
let running = 0
const waiting: Array<() => void> = []

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1
      task().then(resolve, reject).finally(() => { running -= 1; waiting.shift()?.() })
    }
    if (running < MAX_PARALLEL_READS) start()
    else waiting.push(start)
  })
}

export function sessionProgress(source: Source, sessionId: string): Promise<DayProgress> {
  const hit = cache.get(sessionId)
  if (hit) return hit
  const read = limited(async () => {
    const [trips, labels] = await Promise.all([source.getRoundTrips(sessionId), source.getLabels(sessionId)])
    const byKey = new Map(labels.map(label => [labelKey(label.session_id, label.round_trip_index), label]))
    return { total: trips.length, done: trips.filter(trip => isFullyLabeled(byKey.get(labelKey(sessionId, trip.index)))).length }
  })
  cache.set(sessionId, read)
  // A failed read is not remembered: the next look retries.
  read.catch(() => { if (cache.get(sessionId) === read) cache.delete(sessionId) })
  return read
}

/** All the sessions of one date row, added up. */
export async function dayProgress(source: Source, sessionIds: string[]): Promise<DayProgress> {
  const parts = await Promise.all(sessionIds.map(id => sessionProgress(source, id)))
  return parts.reduce((sum, part) => ({ done: sum.done + part.done, total: sum.total + part.total }), { done: 0, total: 0 })
}

/** Labels of these sessions changed: forget what was read and tell the date rows to look again. */
export function invalidateLabelProgress(sessionIds: string[]): void {
  for (const id of sessionIds) cache.delete(id)
  for (const listener of [...listeners]) listener(sessionIds)
}

export function subscribeLabelProgress(listener: (sessionIds: string[]) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test hook. */
export function resetLabelProgress(): void { cache.clear(); listeners.clear(); waiting.length = 0; running = 0 }
