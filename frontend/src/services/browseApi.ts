import { BACKEND_URL } from '../config'
import api, { _authHeaders, type HistoricalDataResponse, type OHLCCandle } from './api'
import { desktopDrawingRequest } from './desktopDrawingRequest'
import { maxPriceRequest, readMaxPrice, type OptionMetadata, type OptionRight, type PreparedPane } from '../../../shared/browse/browseModel'

/**
 * Data for the website's Browse. Candles are read-only and only drawn, so every call asks for minute-level data
 * (`granularity=minute`), not the second-level data replay needs, and the underlying scrolls back through the paged route.
 */

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.json().catch(() => ({}))
  return new Error(typeof body?.detail === 'string' ? body.detail : `${what} failed: ${response.status}`)
}

const history = (symbol: string, tradingDate?: string, intervalMinutes?: number, historicalDays?: number) => {
  const params = new URLSearchParams({ symbol, granularity: 'minute' })
  if (tradingDate) params.set('trading_date', tradingDate)
  if (intervalMinutes) params.set('interval_minutes', String(intervalMinutes))
  if (historicalDays) params.set('historical_days', String(historicalDays))
  return params
}

/** The history calls the shared analysis chart makes, answered from minute data. Everything else is the website's api. */
export const browseApi = {
  ...api,
  async getHistorical(symbol = 'NIFTY', tradingDate?: string, intervalMinutes?: number, historicalDays?: number): Promise<HistoricalDataResponse> {
    const res = await fetch(`${BACKEND_URL}/api/data/historical?${history(symbol, tradingDate, intervalMinutes, historicalDays)}`, { headers: _authHeaders() })
    if (!res.ok) throw await failure(res, 'Historical data fetch')
    return res.json()
  },
  async getPreSession(symbol: string, tradingDate: string, startTime: string, intervalMinutes?: number): Promise<OHLCCandle[]> {
    const params = new URLSearchParams({ symbol, trading_date: tradingDate, start_time: startTime, granularity: 'minute' })
    if (intervalMinutes) params.set('interval_minutes', String(intervalMinutes))
    const res = await fetch(`${BACKEND_URL}/api/data/pre-session?${params}`, { headers: _authHeaders() })
    if (!res.ok) return []
    return (await res.json()).candles ?? []
  },
  async getOptionsHistorical(symbol: string, date: string, strike: number, expiry: string, right: string, intervalMinutes?: number, historicalDays?: number): Promise<HistoricalDataResponse> {
    const params = new URLSearchParams({ symbol, date, strike: String(strike), expiry, right, granularity: 'minute' })
    if (intervalMinutes) params.set('interval_minutes', String(intervalMinutes))
    if (historicalDays) params.set('historical_days', String(historicalDays))
    const res = await fetch(`${BACKEND_URL}/api/data/options-historical?${params}`, { headers: _authHeaders() })
    if (!res.ok) throw await failure(res, 'Options historical data fetch')
    return res.json()
  },
}

export interface BrowsePage { candles: OHLCCandle[]; more: boolean }

/** Candles older than `before` (epoch seconds of the oldest candle held) for an index or equity, a page of whole days. */
export async function loadOlderPage(symbol: string, intervalMinutes: number, date: string, before: number): Promise<BrowsePage> {
  const params = new URLSearchParams({ symbol, interval: String(intervalMinutes), date, before: String(before) })
  const page = await desktopDrawingRequest(`browse/history?${params}`, 'GET') as BrowsePage
  return { candles: page.candles, more: page.more }
}

/** The expiry to use on a day and the gap between strikes, from the desktop route (the website's header is accepted). */
export async function optionMetadata(symbol: string, date: string): Promise<OptionMetadata> {
  return await desktopDrawingRequest(`option-metadata?${new URLSearchParams({ symbol, as_of_date: date })}`, 'GET') as OptionMetadata
}

/** The strike whose premium is at or below `cap`, found by the server's Max price search on minute data. */
export async function findMaxPriceStrike(symbol: string, date: string, expiry: string, right: OptionRight, cap: number): Promise<{ strike: number; premium: number | null }> {
  const body = maxPriceRequest(symbol, date, expiry, right, cap)
  return readMaxPrice(await desktopDrawingRequest('trading/prepare-session', 'POST', body) as { panes?: PreparedPane[] })
}
