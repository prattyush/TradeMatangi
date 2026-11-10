import type { Page, Route } from '@playwright/test'
import { analysisResponse, newAnalysisState, type AnalysisMockState } from './analysisMock'

/** The four landscape sizes every screen must work at (CSS px). */
export const VIEWPORTS = [
  { name: 'pixel-915x412', width: 915, height: 412 },
  { name: 'galaxy-851x393', width: 851, height: 393 },
  { name: 'small-740x360', width: 740, height: 360 },
  { name: 'large-960x432', width: 960, height: 432 },
]

export interface RecordedRequest { method: string; path: string; host: string; authorization?: string; headers: Record<string, string>; body?: unknown }

export interface MockServer {
  requests: RecordedRequest[]
  /** Make /api/auth/desktop/token fail with 401. */
  rejectLogin: boolean
  /** Make the capabilities endpoint answer 404 like an older server. */
  oldServer: boolean
  /** The analysis endpoints' behaviour and what they were asked. */
  analysis: AnalysisMockState
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
}

const bundle = { access_token: 'access-token-1', refresh_token: 'refresh-token-1', token_type: 'Bearer', expires_in: 3600 }

/** Stand in for the TradeMatangi server on the given hosts (the app talks to an absolute https URL). */
export async function mockServer(page: Page, hosts: string[] = ['tradematangi.co.in']): Promise<MockServer> {
  const state: MockServer = { requests: [], rejectLogin: false, oldServer: false, analysis: newAnalysisState() }
  const answer = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  for (const host of hosts) {
    await page.route(`https://${host}/**`, async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      let body: unknown
      try { body = request.postDataJSON() } catch { body = undefined }
      state.requests.push({ method: request.method(), path: url.pathname, host: url.host, authorization: request.headers().authorization, headers: request.headers(), body })
      if (url.pathname === '/api/auth/desktop/token') return state.rejectLogin ? answer(route, 401, { detail: 'Invalid email or password' }) : answer(route, 200, bundle)
      if (url.pathname === '/api/auth/desktop/refresh') return answer(route, 200, bundle)
      if (url.pathname === '/api/auth/desktop/logout') return route.fulfill({ status: 204, headers: CORS })
      if (url.pathname === '/api/desktop/v1/capabilities') {
        if (state.oldServer) return answer(route, 404, { detail: 'Not Found' })
        return answer(route, 200, { api_version: 'v1', features: ['catalogue', 'historical-candles'], trading_capabilities: ['trade-labels', 'behavior-labels'] })
      }
      const analysisPrefix = '/api/desktop/v1/analysis/'
      if (url.pathname.startsWith(analysisPrefix)) {
        const result = analysisResponse(url.pathname.slice(analysisPrefix.length), url.searchParams, state.analysis)
        return answer(route, result.status, result.body)
      }
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
