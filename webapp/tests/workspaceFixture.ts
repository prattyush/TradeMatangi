import type { Page } from '@playwright/test'

/** Full application with a cached account and broker-free read responses. */
export async function mockWorkspace(page: Page) {
  await page.addInitScript(() => localStorage.setItem('auth_user', JSON.stringify({ userId: 'alice', email: 'alice@example.com', accountName: 'Alice', isAdmin: true })))
  const candles = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4, volume: 100 }))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { user_id: 'alice', email: 'alice@example.com', account_name: 'Alice', is_admin: true } })
    if (path.endsWith('/groups/active')) return route.fulfill({ status: 204 })
    if (path.endsWith('/data/symbols')) return route.fulfill({ json: { symbols: [
      { symbol: 'NIFTY', name: 'NIFTY', display_name: 'NIFTY 50', chart_type: 'index', option_eligible: true, strike_interval: 50 },
      { symbol: 'BSESEN', name: 'SENSEX', display_name: 'S&P BSE SENSEX', chart_type: 'index', option_eligible: true, strike_interval: 100 },
      { symbol: 'TATPOW', name: 'Tata Power', display_name: 'Tata Power', chart_type: 'equity', option_eligible: true, strike_interval: 5 },
      { symbol: 'RELIND', name: 'Reliance', display_name: 'Reliance Industries', chart_type: 'equity', option_eligible: true, strike_interval: 10 },
      { symbol: 'TATMOT', name: 'Tata Motors', display_name: 'Tata Motors', chart_type: 'equity', option_eligible: false, strike_interval: 5 },
    ] } })
    if (path.endsWith('/data/available-dates')) return route.fulfill({ json: { dates: ['2026-10-08'] } })
    if (path.endsWith('/data/historical')) return route.fulfill({ json: { candles, symbol: 'TATPOW' } })
    if (path.endsWith('/wallet')) return route.fulfill({ json: { user_id: 'alice', balance: 150000, ledger_kind: 'paper', reset_allowed: true } })
    if (path.endsWith('/check-access')) return route.fulfill({ json: { has_access: false } })
    if (path.endsWith('/open-option-contracts') || path.endsWith('/analysis/sessions')) return route.fulfill({ json: [] })
    if (path.endsWith('/chart-structures/types')) return route.fulfill({ json: { opening_types: [], midday_types: [], closing_types: [] } })
    if (path.endsWith('/chart-structures/structures')) return route.fulfill({ json: { structures: [] } })
    if (path.endsWith('/swing/portfolios')) return route.fulfill({ json: { portfolios: [], portfolio: null, positions: [], orders: [], trades: [] } })
    return route.fulfill({ json: { settings: {}, candles: [], charts: [], categories: [], strategies: [], emails: [], shared_from: [], items: [] } })
  })
}
