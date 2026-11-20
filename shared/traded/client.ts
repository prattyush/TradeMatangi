import type { TradedApi, TradedRequest, TradedStrategy } from './types'

const query = (values: Record<string, unknown>) => {
  const q = new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
  return q ? `?${q}` : ''
}

/**
 * The traded-patterns client over any transport: the website's fetch (`/api/pattern/traded...`) or the Windows app's patterns
 * transport. Both serve the same `pattern/traded...` paths, which `validPatternsPath` allows (tested).
 */
export function createTradedClient(request: TradedRequest): TradedApi {
  return {
    summary: async range => (await request<{ strategies: TradedStrategy[] }>('pattern/traded/summary' + query({ start_date: range?.start, end_date: range?.end }), 'GET')).strategies,
    list: (ref, options) => request('pattern/traded' + query({ category: ref.category, strategy: ref.strategy, start_date: options?.start, end_date: options?.end, limit: options?.limit }), 'GET'),
    save: (trade, ref) => request('pattern/traded/save', 'POST', { session_id: trade.session_id, round_trip_index: trade.round_trip_index, category: ref.category, strategy: ref.strategy }),
  }
}
