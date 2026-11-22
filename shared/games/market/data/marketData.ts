/**
 * Market data for the games: `GET /availability` and `GET /window` (backend G1) through the injected transport, with the local window
 * cache in front. Only `core/paths.ts`-allowed routes are used; the server never downloads anything for these calls, so a miss is a
 * plain "not cached" and the picker moves on.
 *
 * Network discipline (spec 3.5, 8.3): one request in flight, at least `minGapMs` between two requests, and a window already in the
 * cache costs nothing.
 */
import { GamesHttpError, type GamesRequest } from '../../core/client'
import type { Availability } from '../engine/windows'
import type { WindowData } from '../engine/series'
import { windowKey, type WindowCache } from './windowCache'

export class NotCachedError extends Error {
  constructor(message = 'This window is not cached on the server') { super(message); this.name = 'NotCachedError' }
}

export interface WindowQuery {
  symbol: string
  date: string
  startSec: number
  durationSec: number
  /** 1 or 60 (the server serves nothing else; 5 s and 15 s bars are built here). */
  intervalSeconds?: 1 | 60
  contract?: { expiry: string; strike: number; right: 'CE' | 'PE' }
}

export interface MarketData {
  availability(signal?: AbortSignal): Promise<Availability>
  window(query: WindowQuery, signal?: AbortSignal): Promise<WindowData>
}

interface WireWindow { symbol: string; date: string; interval_seconds: number; start_sec: number; duration_sec: number; count: number; t: number[]; o: number[]; h: number[]; l: number[]; c: number[] }

export function windowPath(query: WindowQuery): string {
  const params = new URLSearchParams({
    symbol: query.symbol, date: query.date, start_sec: String(Math.round(query.startSec)), duration_sec: String(Math.round(query.durationSec)),
    interval_seconds: String(query.intervalSeconds ?? 1),
  })
  if (query.contract) { params.set('expiry', query.contract.expiry); params.set('strike', String(query.contract.strike)); params.set('right', query.contract.right) }
  return `window?${params.toString()}`
}

const isNotCached = (error: unknown): boolean => error instanceof GamesHttpError && error.status === 404

export function createMarketData(options: {
  request: GamesRequest
  cache: WindowCache
  minGapMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): MarketData {
  const { request, cache } = options
  const minGapMs = options.minGapMs ?? 250
  const now = options.now ?? (() => performance.now())
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let chain: Promise<unknown> = Promise.resolve()
  let lastSent = -Infinity
  let availability: Promise<Availability> | null = null
  const inflight = new Map<string, Promise<WindowData>>()

  /** Run `task` after every earlier one and after the minimum gap. A failed task does not block the next. */
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = lastSent + minGapMs - now()
      if (wait > 0) await sleep(wait)
      lastSent = now()
      return task()
    })
    chain = run.catch(() => undefined)
    return run
  }

  return {
    availability(signal) {
      // Kept for the life of this object (one Games launch). A failure is not kept, so the next call retries.
      if (!availability) availability = request<Availability>('availability', 'GET', undefined, signal).catch(error => { availability = null; throw error })
      return availability
    },
    async window(query, signal) {
      const key = windowKey({ ...query, intervalSeconds: query.intervalSeconds ?? 1 })
      const cached = await cache.get(key)
      if (cached) return cached
      const pending = inflight.get(key)
      if (pending) return pending
      const fetching = serial(async () => {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
        let wire: WireWindow
        try { wire = await request<WireWindow>(windowPath(query), 'GET', undefined, signal) } catch (error) {
          if (isNotCached(error)) throw new NotCachedError()
          throw error
        }
        const window: WindowData = {
          symbol: wire.symbol, date: wire.date, intervalSeconds: wire.interval_seconds, startSec: wire.start_sec, durationSec: wire.duration_sec,
          t: wire.t, o: wire.o, h: wire.h, l: wire.l, c: wire.c, contract: query.contract,
        }
        await cache.put(key, window).catch(() => undefined)
        return window
      }).finally(() => inflight.delete(key))
      inflight.set(key, fetching)
      return fetching
    },
  }
}
