/** Durable queue of finished sessions that the server has not confirmed yet (spec 3.3, 8.5 "write discipline"). */
import type { SessionResult } from '../core/progress'
import { openGamesDb, promisify, STORES, transactionDone } from './idb'

export interface OutboxEntry { id: string; session: SessionResult; queuedAt: string; attempts: number }

export interface Outbox {
  add(session: SessionResult): Promise<void>
  /** Oldest first. */
  list(): Promise<OutboxEntry[]>
  remove(id: string): Promise<void>
  bumpAttempts(id: string): Promise<void>
}

/** Used when IndexedDB is unavailable (private window, blocked storage): progress still syncs, but is lost on reload. */
export function createMemoryOutbox(): Outbox {
  const entries = new Map<string, OutboxEntry>()
  return {
    async add(session) { if (!entries.has(session.id)) entries.set(session.id, { id: session.id, session, queuedAt: new Date().toISOString(), attempts: 0 }) },
    async list() { return [...entries.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id)) },
    async remove(id) { entries.delete(id) },
    async bumpAttempts(id) { const entry = entries.get(id); if (entry) entry.attempts += 1 },
  }
}

export function createIdbOutbox(factory?: IDBFactory): Outbox {
  let opened: Promise<IDBDatabase> | null = null
  const db = () => opened ?? (opened = openGamesDb(factory).catch(error => { opened = null; throw error }))
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORES.outbox, mode)
  return {
    async add(session) {
      const t = await tx('readwrite')
      const store = t.objectStore(STORES.outbox)
      if (!(await promisify(store.get(session.id)))) store.put({ id: session.id, session, queuedAt: new Date().toISOString(), attempts: 0 } satisfies OutboxEntry)
      await transactionDone(t)
    },
    async list() {
      const t = await tx('readonly')
      const all = await promisify(t.objectStore(STORES.outbox).getAll() as IDBRequest<OutboxEntry[]>)
      return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id))
    },
    async remove(id) {
      const t = await tx('readwrite')
      t.objectStore(STORES.outbox).delete(id)
      await transactionDone(t)
    },
    async bumpAttempts(id) {
      const t = await tx('readwrite')
      const store = t.objectStore(STORES.outbox)
      const entry = (await promisify(store.get(id))) as OutboxEntry | undefined
      if (entry) store.put({ ...entry, attempts: entry.attempts + 1 })
      await transactionDone(t)
    },
  }
}

/** IndexedDB if it works, otherwise memory. */
export async function openOutbox(factory?: IDBFactory): Promise<Outbox> {
  try {
    await openGamesDb(factory)
    return createIdbOutbox(factory)
  } catch {
    return createMemoryOutbox()
  }
}
