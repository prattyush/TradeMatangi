import type { Page, Route } from '@playwright/test'
import { analysisResponse, dayCandles, epoch, newAnalysisState, type AnalysisMockState } from './analysisMock'

/** The four landscape sizes every screen must work at (CSS px). */
export const VIEWPORTS = [
  { name: 'pixel-915x412', width: 915, height: 412 },
  { name: 'galaxy-851x393', width: 851, height: 393 },
  { name: 'small-740x360', width: 740, height: 360 },
  { name: 'large-960x432', width: 960, height: 432 },
]

export interface RecordedRequest { method: string; path: string; host: string; authorization?: string; headers: Record<string, string>; query: URLSearchParams; body?: unknown }

export interface MockServer {
  requests: RecordedRequest[]
  /** Make /api/auth/desktop/token fail with 401. */
  rejectLogin: boolean
  /** Make the capabilities endpoint answer 404 like an older server. */
  oldServer: boolean
  /** The analysis endpoints' behaviour and what they were asked. */
  analysis: AnalysisMockState
  /** Browse: make the catalogue answer 404 (older server), or report options unavailable on the day. */
  catalogueOld?: boolean
  optionsUnavailable?: string
  /** Browse Max Price (`prepare-session`): fail with this reason, or answer 404 like an older server. */
  maxPriceFail?: string
  maxPriceOld?: boolean
  /** Browse Live: what the live routes were asked, and how they behave. */
  live: LiveMock
}

export interface LiveMock {
  starts: Array<{ tiles: Array<{ tile_id: string; instrument: Record<string, unknown>; interval_minutes: number }> }>
  puts: Array<{ tile: { tile_id: string; instrument: Record<string, unknown>; interval_minutes: number } }>
  stops: string[]
  eventRequests: URLSearchParams[]
  /** Answer the start route with this status (for example 404 like an older server). */
  startStatus?: number
  /** Which stream id the next start returns. */
  nextId: number
}

/** The trading day the live mock plays: baseline candles up to 11:00 and three one-second ticks just after. */
export const LIVE_DAY = '2026-11-10'
const liveBaseline = (interval: number) => dayCandles(LIVE_DAY, interval).filter(c => c.time < epoch(LIVE_DAY, 11, 0)).map(c => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
const liveTile = (tile: { tile_id: string; instrument: Record<string, unknown>; interval_minutes: number }, availability: string) =>
  ({ tile_id: tile.tile_id, availability, instrument: tile.instrument, interval_minutes: tile.interval_minutes, candles: liveBaseline(tile.interval_minutes), latest_tick: null })
const liveSnapshot = (id: string, tile: { tile_id: string; instrument: Record<string, unknown>; interval_minutes: number }, availability: string, eventId = 1) =>
  ({ stream_id: id, event_id: eventId, feed: null, tiles: [liveTile(tile, availability)] })
const sse = (id: number, streamId: string, tileId: string, second: number, price: number) =>
  `id: ${id}\nevent: candle\ndata: ${JSON.stringify({ version: 1, stream_id: streamId, event_id: id, timestamp: epoch(LIVE_DAY, 11, 0, second), type: 'candle', tile_id: tileId, payload: { timestamp: epoch(LIVE_DAY, 11, 0, second), open: price, high: price + 1, low: price - 1, close: price, volume: 10 } })}\n\n`

export const INSTRUMENTS = [
  { symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] },
  { symbol: 'BSESEN', display_name: 'S&P BSE SENSEX', exchange: 'BSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] },
  { symbol: 'RELIND', display_name: 'Reliance Industries', exchange: 'NSE', chart_type: 'equity', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] },
  { symbol: 'TATMOT', display_name: 'Tata Motors', exchange: 'NSE', chart_type: 'equity', option_eligible: false, supported_intervals: [1, 3, 5, 15, 30, 60] },
]

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
}

const bundle = { access_token: 'access-token-1', refresh_token: 'refresh-token-1', token_type: 'Bearer', expires_in: 3600 }

/** Stand in for the TradeMatangi server on the given hosts (the app talks to an absolute https URL). */
export async function mockServer(page: Page, hosts: string[] = ['tradematangi.co.in']): Promise<MockServer> {
  const state: MockServer = { requests: [], rejectLogin: false, oldServer: false, analysis: newAnalysisState(), live: { starts: [], puts: [], stops: [], eventRequests: [], nextId: 1 } }
  const answer = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  for (const host of hosts) {
    await page.route(`https://${host}/**`, async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      let body: unknown
      try { body = request.postDataJSON() } catch { body = undefined }
      state.requests.push({ method: request.method(), path: url.pathname, host: url.host, authorization: request.headers().authorization, headers: request.headers(), query: url.searchParams, body })
      if (url.pathname === '/api/auth/desktop/token') return state.rejectLogin ? answer(route, 401, { detail: 'Invalid email or password' }) : answer(route, 200, bundle)
      if (url.pathname === '/api/auth/desktop/refresh') return answer(route, 200, bundle)
      if (url.pathname === '/api/auth/desktop/logout') return route.fulfill({ status: 204, headers: CORS })
      if (url.pathname === '/api/desktop/v1/capabilities') {
        if (state.oldServer) return answer(route, 404, { detail: 'Not Found' })
        return answer(route, 200, { api_version: 'v1', features: ['catalogue', 'historical-candles'], trading_capabilities: ['trade-labels', 'behavior-labels'] })
      }
      if (url.pathname === '/api/desktop/v1/catalogue') return state.catalogueOld ? answer(route, 404, { detail: 'Not Found' }) : answer(route, 200, { version: 1, instruments: INSTRUMENTS })
      if (url.pathname === '/api/desktop/v1/option-metadata') {
        const available = !state.optionsUnavailable
        return answer(route, 200, { version: 1, symbol: url.searchParams.get('symbol'), as_of_date: url.searchParams.get('as_of_date'), expiries: available ? ['2026-11-13'] : [], strike_interval: 50, available, unavailable_reason: state.optionsUnavailable ?? null })
      }
      if (url.pathname === '/api/desktop/v1/trading/prepare-session' && request.method() === 'POST') {
        if (state.maxPriceOld) return answer(route, 404, { detail: 'Not Found' })
        const pane = (body as { panes: Array<Record<string, unknown>> }).panes[0]
        const cap = Number(pane.max_price)
        if (state.maxPriceFail) return answer(route, 200, { version: 1, panes: [{ pane, availability: 'error', reason: state.maxPriceFail, premium: null }] })
        // CE and PE land on different strikes for the same cap, and a day with a different date a different one again.
        const strike = (pane.right === 'CE' ? 24600 : 24200) + (String(pane.tradingDate).endsWith('09') ? 0 : 50)
        return answer(route, 200, { version: 1, date: pane.tradingDate, reference_time: '09:30:00', panes: [{ pane: { ...pane, strike: String(strike) }, availability: 'available', reason: null, premium: cap - 5 }] })
      }
      if (url.pathname === '/api/desktop/v1/live/start' && request.method() === 'POST') {
        const posted = body as LiveMock['starts'][number]
        if (state.live.startStatus) return answer(route, state.live.startStatus, { detail: 'Not Found' })
        state.live.starts.push(posted)
        return answer(route, 201, liveSnapshot(`live-${state.live.nextId++}`, posted.tiles[0], 'pending_subscription'))
      }
      const liveRoute = url.pathname.match(/^\/api\/desktop\/v1\/live\/([\w-]+)\/(events|snapshot|stop|refresh|tiles\/browse)$/)
      if (liveRoute) {
        const [, id, what] = liveRoute
        const tile = state.live.puts.at(-1)?.tile ?? state.live.starts.at(-1)!.tiles[0]
        if (what === 'events') {
          state.live.eventRequests.push(url.searchParams)
          // A stream's first read (cursor 1, from its start snapshot) delivers three seconds of ticks; reconnects only the heartbeat.
          const first = Number(url.searchParams.get('last_event_id') ?? 0) < 2
          const text = first ? [sse(2, id, tile.tile_id, 5, 24510), sse(3, id, tile.tile_id, 6, 24512), sse(4, id, tile.tile_id, 7, 24515)].join('') : ': heartbeat\n\n'
          return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: text })
        }
        if (what === 'stop') { state.live.stops.push(id); return answer(route, 200, { version: 1, stream_id: id, stopped: true }) }
        if (what.startsWith('tiles')) { state.live.puts.push(body as LiveMock['puts'][number]); return answer(route, 200, liveSnapshot(id, (body as LiveMock['puts'][number]).tile, 'available', 5)) }
        return answer(route, 200, liveSnapshot(id, tile, 'available', 5))
      }
      const analysisPrefix = '/api/desktop/v1/analysis/'
      if (url.pathname.startsWith(analysisPrefix)) {
        const result = analysisResponse(url.pathname.slice(analysisPrefix.length), url.searchParams, state.analysis, request.method(), body)
        return answer(route, result.status, result.body)
      }
      if (url.pathname === '/api/desktop/v1/trading/settings/current') return answer(route, 200, { desktop_pnl_display_mode: 'currency', analysis_label_view: 'one_by_one' })
      return answer(route, 404, { detail: 'Not Found' })
    })
  }
  return state
}

export async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill('me@example.com')
  await page.getByLabel('Password').fill('secret')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('navigation', { name: 'Main' }).waitFor()
}

export async function openSessions(page: Page) {
  await signIn(page)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sessions' }).click()
}

/** Choose a view (Chart, Trades, Orders, Videos) from the view menu in the control row. */
export async function chooseView(page: Page, name: string) {
  await page.getByRole('button', { name: /^View:/ }).click()
  // Anchored at the start so "Trades" does not also match "Label trades".
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
}
