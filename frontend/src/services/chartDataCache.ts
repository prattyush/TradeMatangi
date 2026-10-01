import type { OHLCCandle } from './api'

const CHART_DATA_CACHE_MAX = 80

const chartDataCache = new Map<string, { promise: Promise<OHLCCandle[]>; expiresAt: number }>()

export function rememberChartData(key: string, loader: () => Promise<OHLCCandle[]>, forceRefresh = false): Promise<OHLCCandle[]> {
  if (!forceRefresh) {
    const cached = chartDataCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.promise.then(candles => candles.map(c => ({ ...c })))
  }

  const promise = loader()
    .then(candles => candles.map(c => ({ ...c })))
    .catch(err => {
      chartDataCache.delete(key)
      throw err
    })

  chartDataCache.set(key, { promise, expiresAt: Date.now() + 10_000 })
  if (chartDataCache.size > CHART_DATA_CACHE_MAX) {
    const oldest = chartDataCache.keys().next().value
    if (oldest) chartDataCache.delete(oldest)
  }
  return promise.then(candles => candles.map(c => ({ ...c })))
}


export function clearChartDataCache(): void {
  chartDataCache.clear()
}
