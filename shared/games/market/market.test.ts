import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { GamesHttpError, type GamesRequest } from '../core/client'
import { createRng } from '../core/rng'
import { createMarketData, NotCachedError, windowPath } from './data/marketData'
import { browserStorage, createSeenWindows, type StorageLike } from './data/seenWindows'
import { createIdbWindowCache, createMemoryWindowCache, createWindowCache, evictionPlan, packWindow, windowBytes, windowKey } from './data/windowCache'
import { costPoints, DEFAULT_COST, normalizeCost } from './engine/costModel'
import { createRoundSource, type RoundPlan } from './engine/roundSource'
import { aggregate, barsFromWindow, closeAtOrBefore, coverage, efficiencyRatio, rebase, sliceBars, type Bars, type WindowData } from './engine/series'
import { median, MIN_VOL_SHARE, volUnit } from './engine/volUnit'
import { decisionRange, GRID_SEC, listDays, pickWindow, SESSION_CLOSE_SEC, SESSION_OPEN_SEC, windowId, type Availability } from './engine/windows'

const bars = (rows: Array<[number, number, number, number, number]>): Bars => ({ t: rows.map(r => r[0]), o: rows.map(r => r[1]), h: rows.map(r => r[2]), l: rows.map(r => r[3]), c: rows.map(r => r[4]) })
const makeWindow = (count = 10, startSec = 34200, base = 2_500_000): WindowData => ({
  symbol: 'NIFTY', date: '2026-10-01', intervalSeconds: 1, startSec, durationSec: count,
  t: Array.from({ length: count }, (_, i) => startSec + i), o: Array.from({ length: count }, (_, i) => base + i), h: Array.from({ length: count }, (_, i) => base + i + 5),
  l: Array.from({ length: count }, (_, i) => base + i - 5), c: Array.from({ length: count }, (_, i) => base + i + 1),
})
const availability: Availability = { symbols: { NIFTY: { lot_size: 65, dates: ['2026-10-01', '2026-10-03'] }, BSESEN: { lot_size: 20, dates: ['2026-10-01'] }, EMPTY: { dates: [] } } }

describe('series helpers', () => {
  it('turns paise into points and skips broken rows', () => {
    const window = makeWindow(3)
    window.o = [100, Number.NaN, 300]
    const result = barsFromWindow(window)
    expect(result.t).toEqual([34200, 34202]); expect(result.o).toEqual([1, 3])
  })
  it('aggregates on epoch-aligned boundaries and leaves gaps empty', () => {
    const one = bars([[100, 1, 2, 0.5, 1.5], [101, 1.5, 3, 1, 2], [104, 2, 2.5, 1.8, 2.2], [106, 2.2, 2.4, 2.0, 2.1], [111, 2, 2, 2, 2]])
    const five = aggregate(one, 5)
    expect(five.t).toEqual([100, 105, 110])
    expect([five.o[0], five.h[0], five.l[0], five.c[0]]).toEqual([1, 3, 0.5, 2.2])
    expect(aggregate(one, 1)).toBe(one)
  })
  it('slices, rebases and finds the last close', () => {
    const one = bars([[100, 1, 2, 0, 1], [101, 1, 2, 0, 2], [105, 1, 2, 0, 3]])
    expect(sliceBars(one, 101, 105).t).toEqual([101])
    expect(rebase(one, 1).c).toEqual([0, 1, 2]); expect(one.c).toEqual([1, 2, 3])
    expect(closeAtOrBefore(one, 104)).toBe(2); expect(closeAtOrBefore(one, 99)).toBeUndefined(); expect(closeAtOrBefore(one, 500)).toBe(3)
  })
  it('efficiency ratio runs from noise to a straight line; coverage counts observed seconds', () => {
    expect(efficiencyRatio([1, 2, 3, 4])).toBe(1); expect(efficiencyRatio([1, 2, 1, 2, 1])).toBe(0); expect(efficiencyRatio([5, 5, 5])).toBe(0); expect(efficiencyRatio([1])).toBe(0)
    expect(coverage(bars([[100, 0, 0, 0, 0], [102, 0, 0, 0, 0]]), 100, 104)).toBe(0.5); expect(coverage(bars([]), 0, 0)).toBe(0)
  })
})

describe('volUnit', () => {
  it('is the median 5 s range of the previous 5 minutes, floored', () => {
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBe(0)
    const rows: Array<[number, number, number, number, number]> = []
    for (let t = 1000; t < 1300; t++) rows.push([t, 100, 100 + (Math.floor(t / 5) % 2 ? 4 : 2), 100, 100])
    expect(volUnit(bars(rows), 1300, 100)).toBe(3)
    expect(volUnit(bars(rows), 1300, 100, 0)).toBe(3)
  })
  it('only looks backwards and never returns less than the floor', () => {
    const quiet = bars([[100, 100, 100, 100, 100]])
    expect(volUnit(quiet, 200, 25_000)).toBeCloseTo(25_000 * MIN_VOL_SHARE, 6)
    expect(volUnit(bars([]), 200, 25_000)).toBeCloseTo(25_000 * MIN_VOL_SHARE, 6)
    const future = bars([[300, 100, 500, 0, 100]])
    expect(volUnit(future, 200, 100)).toBeLessThan(1) // a bar after the decision point is invisible
    expect(Number.isFinite(volUnit(quiet, 200, Number.NaN))).toBe(true)
  })
})

describe('cost model', () => {
  it('is 2 x slippage x multiplier plus rupees per lot over the lot size', () => {
    expect(costPoints({ slippagePtsPerSide: 0.5, roundTripCostPerLotRs: 65, defaultLots: 1 }, 65, 1)).toBeCloseTo(2, 9)
    expect(costPoints({ slippagePtsPerSide: 0.5, roundTripCostPerLotRs: 65, defaultLots: 1 }, 65, 0)).toBeCloseTo(1, 9)
    expect(costPoints({ slippagePtsPerSide: 1, roundTripCostPerLotRs: 40, defaultLots: 1 }, 20, 1.5)).toBeCloseTo(3 + 2, 9)
    expect(costPoints(DEFAULT_COST, undefined, 1)).toBe(1)
    expect(costPoints(DEFAULT_COST, 0, 1)).toBe(1); expect(costPoints(DEFAULT_COST, 65, -3)).toBeCloseTo(40 / 65, 9)
  })
  it('normalises settings into their limits', () => {
    expect(normalizeCost(undefined)).toEqual(DEFAULT_COST)
    expect(normalizeCost({ slippagePtsPerSide: -4, roundTripCostPerLotRs: 99999, defaultLots: 2.6 })).toEqual({ slippagePtsPerSide: 0, roundTripCostPerLotRs: 5000, defaultLots: 3 })
    expect(normalizeCost({ slippagePtsPerSide: 'x', defaultLots: Number.NaN })).toEqual(DEFAULT_COST)
  })
})

describe('window picking', () => {
  const rules = { preSec: 300, postSec: 60 }
  it('keeps decision points inside the session, away from the open and the close, on the grid', () => {
    const range = decisionRange(rules)!
    expect(range.first).toBeGreaterThanOrEqual(SESSION_OPEN_SEC + 600 + 300); expect(range.last).toBeLessThanOrEqual(SESSION_CLOSE_SEC - 300 - 60)
    expect(range.first % GRID_SEC).toBe(0); expect(range.last % GRID_SEC).toBe(0)
    expect(decisionRange({ preSec: 40_000, postSec: 0 })).toBeNull()
    const rng = createRng(3)
    for (let i = 0; i < 200; i++) { const pick = pickWindow(rng, availability, rules, new Set())!; expect(pick.decisionSec).toBeGreaterThanOrEqual(range.first); expect(pick.decisionSec).toBeLessThanOrEqual(range.last); expect(pick.decisionSec % GRID_SEC).toBe(0) }
  })
  it('is deterministic for a seed and lists only the days the server lists', () => {
    const a = pickWindow(createRng(9), availability, rules, new Set()), b = pickWindow(createRng(9), availability, rules, new Set())
    expect(a).toEqual(b)
    expect(listDays(availability).length).toBe(3); expect(listDays(availability, ['BSESEN'])).toEqual([{ symbol: 'BSESEN', date: '2026-10-01' }])
    expect(a!.id).toBe(windowId(a!.symbol, a!.date, a!.decisionSec))
  })
  it('never returns a seen or excluded window and gives up when nothing is left', () => {
    const tiny: Availability = { symbols: { NIFTY: { dates: ['2026-10-01'] } } }
    const range = decisionRange(rules)!
    const all = new Set<string>()
    for (let s = range.first; s <= range.last; s += GRID_SEC) all.add(windowId('NIFTY', '2026-10-01', s))
    expect(pickWindow(createRng(1), tiny, rules, all)).toBeNull()
    const almost = new Set(all); const keep = windowId('NIFTY', '2026-10-01', range.first); almost.delete(keep)
    expect(pickWindow(createRng(1), tiny, rules, almost, new Set(), { attempts: 5000 })!.id).toBe(keep)
    expect(pickWindow(createRng(1), tiny, rules, new Set(), new Set([keep]), { attempts: 5000 })!.id).not.toBe(keep)
    expect(pickWindow(createRng(1), { symbols: {} }, rules, new Set())).toBeNull()
  })
})

describe('seen windows memory', () => {
  const memoryStorage = (): StorageLike & { data: Record<string, string> } => { const data: Record<string, string> = {}; return { data, getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v } } }
  it('remembers per user and game, and forgets after the no-repeat period', () => {
    const storage = memoryStorage()
    createSeenWindows(storage, 'u1', 'tick_reader', '2026-10-01').add('a')
    expect(createSeenWindows(storage, 'u1', 'tick_reader', '2026-10-20').recent().has('a')).toBe(true)
    expect(createSeenWindows(storage, 'u1', 'tick_reader', '2026-11-05').recent().has('a')).toBe(false)
    expect(createSeenWindows(storage, 'u2', 'tick_reader', '2026-10-02').recent().size).toBe(0)
    expect(createSeenWindows(storage, 'u1', 'entry_sniper', '2026-10-02').recent().size).toBe(0)
  })
  it('survives broken storage and garbage', () => {
    const broken: StorageLike = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('full') } }
    const seen = createSeenWindows(broken, 'u', 'g', '2026-10-01'); seen.add('x'); expect(seen.recent().has('x')).toBe(true)
    const garbage = memoryStorage(); garbage.setItem('tm-games-seen:u:g', '[1,2'); expect(createSeenWindows(garbage, 'u', 'g', '2026-10-01').recent().size).toBe(0)
    expect(createSeenWindows(null, 'u', 'g', '2026-10-01').recent().size).toBe(0); expect(() => browserStorage()).not.toThrow()
  })
  it('keeps the list bounded', () => {
    const storage = memoryStorage(); const seen = createSeenWindows(storage, 'u', 'g', '2026-10-01')
    for (let i = 0; i < 3100; i++) seen.add(`w${i}`)
    expect(seen.recent().size).toBeLessThanOrEqual(3000)
  })
})

describe('window cache', () => {
  it('packs into typed arrays and counts bytes', () => {
    const packed = packWindow(makeWindow(4))
    expect(packed.t).toBeInstanceOf(Uint32Array); expect(packed.c).toBeInstanceOf(Int32Array); expect(windowBytes(packed)).toBe(4 * 5 * 4 + 200)
    expect(windowKey({ symbol: 'NIFTY', date: '2026-10-01', startSec: 100, durationSec: 360 })).toBe('NIFTY|2026-10-01|100|360|1|-')
    expect(windowKey({ symbol: 'NIFTY', date: 'd', startSec: 1, durationSec: 2, intervalSeconds: 60, contract: { expiry: 'e', strike: 24800, right: 'CE' } })).toBe('NIFTY|d|1|2|60|e:24800:CE')
  })
  it('plans eviction oldest first until the cap is met', () => {
    const meta = [{ key: 'a', bytes: 100, lastUsed: 3 }, { key: 'b', bytes: 100, lastUsed: 1 }, { key: 'c', bytes: 100, lastUsed: 2 }]
    expect(evictionPlan(meta, 300)).toEqual([]); expect(evictionPlan(meta, 200)).toEqual(['b']); expect(evictionPlan(meta, 100)).toEqual(['b', 'c']); expect(evictionPlan(meta, 0)).toEqual(['b', 'c', 'a'])
  })
  const lru = async (cache: ReturnType<typeof createMemoryWindowCache>, clock: { now: number }) => {
    const size = windowBytes(makeWindow(10))
    await cache.put('a', makeWindow(10)); clock.now = 2; await cache.put('b', makeWindow(10)); clock.now = 3
    expect(await cache.get('a')).toBeDefined() // touching `a` makes `b` the oldest
    clock.now = 4; await cache.put('c', makeWindow(10))
    expect(await cache.get('b')).toBeUndefined(); expect(await cache.get('a')).toBeDefined(); expect(await cache.get('c')).toBeDefined()
    expect((await cache.stats()).bytes).toBe(2 * size)
    await cache.clear(); expect((await cache.stats()).count).toBe(0)
  }
  it('the memory cache is least recently used and capped in bytes', async () => {
    const clock = { now: 1 }; await lru(createMemoryWindowCache(2 * windowBytes(makeWindow(10)), () => clock.now), clock)
  })
  it('the IndexedDB cache does the same and keeps data across a reopen', async () => {
    const factory = new IDBFactory(); const clock = { now: 1 }
    await lru(createIdbWindowCache(2 * windowBytes(makeWindow(10)), factory, () => clock.now), clock)
    const first = createIdbWindowCache(10_000_000, factory); await first.put('k', makeWindow(5))
    const reopened = createIdbWindowCache(10_000_000, factory)
    const back = await reopened.get('k'); expect(Array.from(back!.c)).toEqual(Array.from(makeWindow(5).c)); expect((await reopened.stats()).count).toBe(1)
  })
  it('upgrades a version 2 database (outbox and sessions only) without losing it', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('tradematangi-games', 2)
      open.onupgradeneeded = () => { open.result.createObjectStore('outbox', { keyPath: 'id' }).put({ id: 'keep' }); open.result.createObjectStore('sessions', { keyPath: 'id' }) }
      open.onsuccess = () => { open.result.close(); resolve() }; open.onerror = () => reject(open.error)
    })
    const cache = createIdbWindowCache(10_000_000, factory); await cache.put('k', makeWindow(3))
    expect((await cache.get('k'))?.t.length).toBe(3)
    const { createIdbOutbox } = await import('../data/outbox')
    expect((await createIdbOutbox(factory).list()).map(entry => entry.id)).toEqual(['keep'])
  })
  it('falls back to memory when IndexedDB cannot open', async () => {
    const cache = createWindowCache(10_000_000, { open() { throw new Error('blocked') } } as unknown as IDBFactory)
    await cache.put('k', makeWindow(3)); expect((await cache.get('k'))?.t.length).toBe(3); expect((await cache.stats()).count).toBe(1)
  })
})

describe('market data', () => {
  const wire = (query: string) => { const p = new URLSearchParams(query.split('?')[1]); const w = makeWindow(Number(p.get('duration_sec')), Number(p.get('start_sec'))); return { symbol: w.symbol, date: p.get('date'), interval_seconds: 1, start_sec: w.startSec, duration_sec: w.durationSec, count: w.durationSec, t: w.t, o: w.o, h: w.h, l: w.l, c: w.c } }
  const setup = (handler?: (path: string) => unknown) => {
    const calls: Array<{ path: string; at: number }> = []
    let clock = 0
    const request = (async (path: string) => { calls.push({ path, at: clock }); if (handler) return handler(path); return path.startsWith('availability') ? availability : wire(path) }) as GamesRequest
    const data = createMarketData({ request, cache: createMemoryWindowCache(), minGapMs: 250, now: () => clock, sleep: async ms => { clock += ms } })
    return { data, calls, tick: (ms: number) => { clock += ms } }
  }
  const query = { symbol: 'NIFTY', date: '2026-10-01', startSec: 34_000, durationSec: 360 }

  it('builds the window path with only allowed parameters', () => {
    expect(windowPath(query)).toBe('window?symbol=NIFTY&date=2026-10-01&start_sec=34000&duration_sec=360&interval_seconds=1')
    expect(windowPath({ ...query, intervalSeconds: 60, contract: { expiry: '2026-10-06', strike: 24800, right: 'CE' } })).toContain('expiry=2026-10-06&strike=24800&right=CE')
  })
  it('fetches availability once and retries after a failure', async () => {
    let fail = true
    const { data, calls } = setup(path => { if (path === 'availability' && fail) throw new Error('offline'); return availability })
    await expect(data.availability()).rejects.toThrow('offline'); fail = false
    await data.availability(); await data.availability()
    expect(calls.filter(c => c.path === 'availability').length).toBe(2)
  })
  it('serves a second request for a window from the cache and shares one in-flight fetch', async () => {
    const { data, calls } = setup()
    const [a, b] = await Promise.all([data.window(query), data.window(query)])
    expect(a).toBe(b); expect(calls.length).toBe(1)
    const again = await data.window(query); expect(calls.length).toBe(1); expect(again.t.length).toBe(360)
  })
  it('keeps at least 250 ms between two requests, one at a time', async () => {
    const { data, calls } = setup()
    await Promise.all([data.window(query), data.window({ ...query, startSec: 35_000 }), data.window({ ...query, startSec: 36_000 })])
    expect(calls.length).toBe(3)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(250); expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(250)
  })
  it('turns a 404 into NotCachedError and lets other failures through, without poisoning the queue', async () => {
    let n = 0
    const { data } = setup(path => { n += 1; if (n === 1) throw new GamesHttpError(404, 'nope', { reason: 'not_cached' }); if (n === 2) throw new GamesHttpError(500, 'boom'); return wire(path) })
    await expect(data.window(query)).rejects.toBeInstanceOf(NotCachedError)
    await expect(data.window({ ...query, startSec: 1 })).rejects.toMatchObject({ status: 500 })
    expect((await data.window({ ...query, startSec: 2 })).t.length).toBe(360)
  })
  it('does not send a request that was cancelled before its turn', async () => {
    const { data, calls } = setup(); const controller = new AbortController(); controller.abort()
    await expect(data.window(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(calls.length).toBe(0)
  })
})

describe('round source', () => {
  interface R { id: string; edge: boolean; er: number }
  const plan = (build: RoundPlan<R>['build'], want = false): RoundPlan<R> => ({ rules: { preSec: 300, postSec: 60 }, fetchBefore: 300, fetchAfter: 60, build, wantNoEdge: () => want, misfit: (r, noEdge) => (r.edge === !noEdge ? 0 : 1) + r.er })
  const fetcher = (log: string[] = []) => ({ async window(q: { symbol: string; date: string; startSec: number; durationSec: number }) { log.push(`${q.symbol}|${q.date}|${q.startSec}|${q.durationSec}`); return makeWindow(5) } })

  it('fetches before and after the decision point and marks the window used', async () => {
    const log: string[] = []; const used: string[] = []
    const source = createRoundSource<R>({ rng: createRng(1), availability, fetcher: fetcher(log), plan: plan((_, pick) => ({ id: pick.id, edge: true, er: 0 })), seen: new Set(), onUsed: id => used.push(id) })
    const next = await source.next()
    expect(next.ok).toBe(true); expect(log.length).toBe(1); expect(used.length).toBe(1)
    const decision = Number(used[0].split('|')[2]); expect(log[0].endsWith(`|${decision - 300}|360`)).toBe(true)
  })
  it('tries at most three candidates and keeps the best fit', async () => {
    const fits = [{ edge: false, er: 0.5 }, { edge: true, er: 0.3 }, { edge: true, er: 0.4 }, { edge: true, er: 0 }]
    let i = 0; const log: string[] = []
    const source = createRoundSource<R>({ rng: createRng(2), availability, fetcher: fetcher(log), plan: plan((_, pick) => ({ id: pick.id, ...fits[i++] }), true), seen: new Set(), goodEnough: 0.05 })
    const next = await source.next()
    expect(log.length).toBe(3); expect(next.ok && next.round.edge === false).toBe(true) // wanted a no-edge round: the first candidate was the only one
  })
  it('stops early on a good enough round', async () => {
    const log: string[] = []
    const source = createRoundSource<R>({ rng: createRng(2), availability, fetcher: fetcher(log), plan: plan((_, pick) => ({ id: pick.id, edge: true, er: 0.01 })), seen: new Set() })
    await source.next(); expect(log.length).toBe(1)
  })
  it('replaces windows that are thin or fail and reports no_data after three failures in a row', async () => {
    const thin = createRoundSource<R>({ rng: createRng(3), availability, fetcher: fetcher(), plan: plan(() => null), seen: new Set() })
    expect(await thin.next()).toEqual({ ok: false, reason: 'no_data' })
    let calls = 0
    const flaky = createRoundSource<R>({ rng: createRng(3), availability, fetcher: { async window() { calls += 1; if (calls <= 2) throw new NotCachedError(); return makeWindow(5) } }, plan: plan((_, pick) => ({ id: pick.id, edge: true, er: 0 })), seen: new Set() })
    expect((await flaky.next()).ok).toBe(true); expect(calls).toBe(3)
    const dead = createRoundSource<R>({ rng: createRng(3), availability, fetcher: { async window() { throw new NotCachedError() } }, plan: plan(() => null), seen: new Set() })
    expect(await dead.next()).toEqual({ ok: false, reason: 'no_data' })
  })
  it('never hands out the same window twice and honours the seen set', async () => {
    const tiny: Availability = { symbols: { NIFTY: { dates: ['2026-10-01'] } } }
    const ids: string[] = []
    const source = createRoundSource<R>({ rng: createRng(4), availability: tiny, fetcher: fetcher(), plan: plan((_, pick) => ({ id: pick.id, edge: true, er: 0 })), seen: new Set(), onUsed: id => ids.push(id) })
    for (let i = 0; i < 30; i++) await source.next()
    expect(new Set(ids).size).toBe(30)
  })
  it('reports cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    const source = createRoundSource<R>({ rng: createRng(1), availability, fetcher: fetcher(), plan: plan((_, pick) => ({ id: pick.id, edge: true, er: 0 })), seen: new Set() })
    expect(await source.next(controller.signal)).toEqual({ ok: false, reason: 'cancelled' })
  })
})
