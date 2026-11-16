/**
 * Sessions kept on this device only (spec 7.3, 17.8): the seed and level to replay a session, the per-trial review rows of the
 * newest ones, and the stats behind the trend panels. Nothing here is ever sent to the server.
 */
import type { LocalSession } from '../core/dashboard'
import { openGamesDb, promisify, STORES, transactionDone } from './idb'

/** Sessions that keep their per-trial review rows (spec 17.8: the last 20). */
export const KEEP_REVIEWS = 20
/** Longest trial log kept for one session. */
export const MAX_REVIEW_ROWS = 250
/** Sessions kept per game for the trend panels. */
export const KEEP_PER_GAME = 30

/** What to keep: at most `KEEP_PER_GAME` sessions of a game, review rows only on the newest `KEEP_REVIEWS`, each cut to `MAX_REVIEW_ROWS`. */
export function pruneSessions(all: LocalSession[]): { keep: LocalSession[]; dropIds: string[] } {
  const newestFirst = [...all].sort((a, b) => b.playedAt.localeCompare(a.playedAt) || b.id.localeCompare(a.id))
  const perGame = new Map<string, number>()
  const keep: LocalSession[] = []
  const dropIds: string[] = []
  let withReview = 0
  for (const entry of newestFirst) {
    const count = (perGame.get(entry.gameId) ?? 0) + 1
    perGame.set(entry.gameId, count)
    if (count > KEEP_PER_GAME) { dropIds.push(entry.id); continue }
    const wantsReview = entry.review !== undefined && withReview < KEEP_REVIEWS
    if (wantsReview) withReview += 1
    const next: LocalSession = { ...entry }
    if (wantsReview) next.review = entry.review!.slice(0, MAX_REVIEW_ROWS)
    else delete next.review
    keep.push(next)
  }
  return { keep, dropIds }
}

export interface SessionLog {
  add(entry: LocalSession): Promise<void>
  /** Oldest first. */
  list(): Promise<LocalSession[]>
}

const oldestFirst = (all: LocalSession[]) => [...all].sort((a, b) => a.playedAt.localeCompare(b.playedAt) || a.id.localeCompare(b.id))

export function createMemorySessionLog(): SessionLog {
  let entries: LocalSession[] = []
  return {
    async add(entry) { entries = pruneSessions([...entries.filter(e => e.id !== entry.id), entry]).keep },
    async list() { return oldestFirst(entries) },
  }
}

export function createIdbSessionLog(factory?: IDBFactory): SessionLog {
  let opened: Promise<IDBDatabase> | null = null
  const db = () => opened ?? (opened = openGamesDb(factory).catch(error => { opened = null; throw error }))
  return {
    async add(entry) {
      const tx = (await db()).transaction(STORES.sessions, 'readwrite')
      const store = tx.objectStore(STORES.sessions)
      store.put(entry)
      const all = await promisify(store.getAll() as IDBRequest<LocalSession[]>)
      const { keep, dropIds } = pruneSessions(all)
      for (const id of dropIds) store.delete(id)
      // Only the entries whose review rows were stripped need rewriting.
      const before = new Map(all.map(e => [e.id, e]))
      for (const next of keep) if (before.get(next.id)?.review !== undefined && next.review === undefined) store.put(next)
      await transactionDone(tx)
    },
    async list() {
      const tx = (await db()).transaction(STORES.sessions, 'readonly')
      return oldestFirst(await promisify(tx.objectStore(STORES.sessions).getAll() as IDBRequest<LocalSession[]>))
    },
  }
}

/** IndexedDB if it works, otherwise a memory log that lasts until the window closes. */
export async function openSessionLog(factory?: IDBFactory): Promise<SessionLog> {
  try {
    await openGamesDb(factory)
    return createIdbSessionLog(factory)
  } catch {
    return createMemorySessionLog()
  }
}
