import type { OHLCCandle } from './api'

const CHART_DATA_CACHE_MAX = 80

const chartDataCache = new Map<string, { promise: Promise<OHLCCandle[]>; expiresAt: number; pending: boolean }>()

export function rememberChartData(key: string, loader: () => Promise<OHLCCandle[]>, forceRefresh = false): Promise<OHLCCandle[]> {
  const now = Date.now()
  for (const [cachedKey, entry] of chartDataCache) {
    if (!entry.pending && entry.expiresAt <= now) chartDataCache.delete(cachedKey)
  }
  const cached = chartDataCache.get(key)
  if (cached && (cached.pending || (!forceRefresh && cached.expiresAt > now))) {
    return cached.promise.then(candles => candles.map(c => ({ ...c })))
  }

  const promise = loader()
    .then(candles => candles.map(c => ({ ...c })))
    .catch(err => {
      if (chartDataCache.get(key)?.promise === promise) chartDataCache.delete(key)
      throw err
    })

  const entry = { promise, expiresAt: now + 10_000, pending: true }
  chartDataCache.set(key, entry)
  void promise.then(() => { entry.pending = false; entry.expiresAt = Date.now() + 10_000 }, () => { entry.pending = false })
  if (chartDataCache.size > CHART_DATA_CACHE_MAX) {
    const oldest = chartDataCache.keys().next().value
    if (oldest) chartDataCache.delete(oldest)
  }
  return promise.then(candles => candles.map(c => ({ ...c })))
}


export function clearChartDataCache(): void {
  chartDataCache.clear()
}
