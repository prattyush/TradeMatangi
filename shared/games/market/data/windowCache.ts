/**
 * Local cache of fetched windows (spec 8.3): IndexedDB, least recently used out first, capped in bytes. A window fetched once is never
 * fetched again unless it was evicted. Prices are stored as typed arrays (4 bytes a value, no JSON), which is the compact form the
 * server's integer paise were designed for. When IndexedDB is unavailable a memory cache with the same rules is used.
 */
import { openGamesDb, promisify, STORES, transactionDone } from '../../data/idb'
import type { WindowData } from '../engine/series'

export const DEFAULT_CACHE_BYTES = 300 * 1024 * 1024
export const LOW_MEMORY_CACHE_BYTES = 150 * 1024 * 1024

export interface WindowCache {
  get(key: string): Promise<WindowData | undefined>
  put(key: string, window: WindowData): Promise<void>
  clear(): Promise<void>
  stats(): Promise<{ count: number; bytes: number }>
}

interface Meta { key: string; bytes: number; lastUsed: number }

/** Bytes a window takes in the cache: five arrays of 4-byte values plus a small header. */
export const windowBytes = (window: WindowData): number => window.t.length * 5 * 4 + 200

/** Copy the server's number arrays into typed arrays. The time array is unsigned, prices are signed integers (paise). */
export function packWindow(window: WindowData): WindowData {
  return { ...window, t: Uint32Array.from(window.t), o: Int32Array.from(window.o), h: Int32Array.from(window.h), l: Int32Array.from(window.l), c: Int32Array.from(window.c) }
}

/** Stable key: `symbol|date|start|duration|interval|contract` (spec 8.3). */
export function windowKey(query: { symbol: string; date: string; startSec: number; durationSec: number; intervalSeconds?: number; contract?: { expiry: string; strike: number; right: string } }): string {
  const contract = query.contract ? `${query.contract.expiry}:${query.contract.strike}:${query.contract.right}` : '-'
  return `${query.symbol}|${query.date}|${query.startSec}|${query.durationSec}|${query.intervalSeconds ?? 1}|${contract}`
}

/** Eviction order is a pure function so both caches (and the tests) share it: oldest `lastUsed` first until `total <= limit`. */
export function evictionPlan(entries: Meta[], limit: number): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const victims: string[] = []
  for (const entry of [...entries].sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key))) {
    if (total <= limit) break
    victims.push(entry.key)
    total -= entry.bytes
  }
  return victims
}

export function createMemoryWindowCache(maxBytes = DEFAULT_CACHE_BYTES, now: () => number = () => Date.now()): WindowCache {
  const entries = new Map<string, { window: WindowData; meta: Meta }>()
  return {
    async get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entry.meta.lastUsed = now()
      return entry.window
    },
    async put(key, window) {
      const packed = packWindow(window)
      entries.set(key, { window: packed, meta: { key, bytes: windowBytes(packed), lastUsed: now() } })
      for (const victim of evictionPlan([...entries.values()].map(entry => entry.meta), maxBytes)) if (victim !== key) entries.delete(victim)
    },
    async clear() { entries.clear() },
    async stats() { return { count: entries.size, bytes: [...entries.values()].reduce((sum, entry) => sum + entry.meta.bytes, 0) } },
  }
}

export function createIdbWindowCache(maxBytes = DEFAULT_CACHE_BYTES, factory?: IDBFactory, now: () => number = () => Date.now()): WindowCache {
  let opened: Promise<{ db: IDBDatabase; meta: Map<string, Meta> }> | null = null
  const open = () => opened ?? (opened = (async () => {
    const db = await openGamesDb(factory)
    const rows = await promisify(db.transaction(STORES.windowMeta, 'readonly').objectStore(STORES.windowMeta).getAll() as IDBRequest<Meta[]>)
    return { db, meta: new Map(rows.map(row => [row.key, row])) }
  })().catch(error => { opened = null; throw error }))
  return {
    async get(key) {
      const { db, meta } = await open()
      const tx = db.transaction([STORES.windows, STORES.windowMeta], 'readwrite')
      const window = (await promisify(tx.objectStore(STORES.windows).get(key))) as WindowData | undefined
      const entry = meta.get(key)
      if (window && entry) { entry.lastUsed = now(); tx.objectStore(STORES.windowMeta).put(entry) }
      await transactionDone(tx)
      return window
    },
    async put(key, window) {
      const { db, meta } = await open()
      const packed = packWindow(window)
      meta.set(key, { key, bytes: windowBytes(packed), lastUsed: now() })
      const victims = evictionPlan([...meta.values()], maxBytes).filter(victim => victim !== key)
      const tx = db.transaction([STORES.windows, STORES.windowMeta], 'readwrite')
      tx.objectStore(STORES.windows).put(packed, key)
      tx.objectStore(STORES.windowMeta).put(meta.get(key)!)
      for (const victim of victims) { tx.objectStore(STORES.windows).delete(victim); tx.objectStore(STORES.windowMeta).delete(victim); meta.delete(victim) }
      await transactionDone(tx)
    },
    async clear() {
      const { db, meta } = await open()
      const tx = db.transaction([STORES.windows, STORES.windowMeta], 'readwrite')
      tx.objectStore(STORES.windows).clear(); tx.objectStore(STORES.windowMeta).clear()
      meta.clear()
      await transactionDone(tx)
    },
    async stats() {
      const { meta } = await open()
      return { count: meta.size, bytes: [...meta.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
    },
  }
}

/** The IndexedDB cache, falling back to memory (and staying there) when the database cannot be opened or a call fails. */
export function createWindowCache(maxBytes = DEFAULT_CACHE_BYTES, factory?: IDBFactory): WindowCache {
  const memory = createMemoryWindowCache(maxBytes)
  const idb = createIdbWindowCache(maxBytes, factory)
  let broken = false
  const guarded = async <T,>(call: (cache: WindowCache) => Promise<T>): Promise<T> => {
    if (broken) return call(memory)
    try { return await call(idb) } catch { broken = true; return call(memory) }
  }
  return {
    get: key => guarded(cache => cache.get(key)),
    put: (key, window) => guarded(cache => cache.put(key, window)),
    clear: () => guarded(cache => cache.clear()),
    stats: () => guarded(cache => cache.stats()),
  }
}
