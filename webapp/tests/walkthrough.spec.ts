import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace } from './workspaceFixture'

const app = 'http://127.0.0.1:5174/webapp/'
const end = 1791447300 + 120 * 180
const leg = (trade_id: string, side: 'BUY' | 'SELL', offset: number, extra: Record<string, unknown> = {}) => ({ trade_id, side, quantity: 65, price: 100 + offset, timestamp: end - (60 - offset) * 180, ...extra })
const ce = { right: 'CE', strike: 25000, expiry: '2026-10-15' }
const trips = [
  { index: 0, cycle_id: 'c0', right: null, pnl: 120.5, pnl_pct: 0.12, max_capital_pct: 6.5, entry_trades: [leg('t1', 'BUY', 1)], exit_trades: [leg('t2', 'SELL', 3)] },
  { index: 1, cycle_id: 'c1', right: 'CE', pnl: -45.25, pnl_pct: -0.05, max_capital_pct: 6.6, entry_trades: [leg('t3', 'BUY', 10, ce)], exit_trades: [leg('t4', 'SELL', 12, ce)] },
]
const trade = (row: ReturnType<typeof leg>, extra: Record<string, unknown> = {}) => ({ ...row, session_id: 's1', user_id: 'alice', symbol: 'NIFTY', instrument_type: extra.right ? 'options' : 'equity', right: null, strike: null, expiry: null, commission: 1, ...extra })
const trades = [trade(trips[0].entry_trades[0]), trade(trips[0].exit_trades[0]), trade(trips[1].entry_trades[0], ce), trade(trips[1].exit_trades[0], ce)]
const session = { session_id: 's1', user_id: 'alice', symbol: 'NIFTY', date: '2026-10-08', start_time: '09:15:00', instrument_type: 'options', session_type: 'paper', strike: null, expiry: null, session_capital: 100000, net_pnl: 75.25, pnl_pct: 0.07, total_commission: 4, trade_count: 4, round_trip_count: 2, buy_count: 2, sell_count: 2 }

const cycle = (id: string, trip: typeof trips[number], exitMethod: string, entryMethod: string, extra: Record<string, unknown> = {}) => ({
  user_id: 'alice', session_id: 's1', cycle_id: id, symbol: 'NIFTY', right: trip.right, strike: trip.right ? 25000 : null, expiry: trip.right ? '2026-10-15' : null,
  direction: 'LONG', state: 'closed', mode: 'paper', entry_time: trip.entry_trades[0].timestamp, exit_time: trip.exit_trades[0].timestamp, exit_sort_time: null,
  entry_count: 1, exit_count: 1, net_pnl: trip.pnl, pnl_pct: trip.pnl_pct, fees: 2, open_quantity: 0, capital: 100000, peak_capital_pct: trip.max_capital_pct, matches: [], executions: [],
  entries: [{ entry_id: `${id}-e`, entry_method: entryMethod, client: 'website', timestamp: trip.entry_trades[0].timestamp, quantity: 65, matched_quantity: 65, open_quantity: 0, average_price: trip.entry_trades[0].price,
    net_pnl: trip.pnl, pnl_pct: trip.pnl_pct, sizing_method: 'CAPITAL', requested_pct: 5, r_multiple: null, analytics: { effective_allocation_pct: 6.5, effective_risk_pct: 0.4, margin_rate: 1 } }],
  exits: [{ exit_id: `${id}-x`, exit_method: exitMethod, quantity: 65, price: trip.exit_trades[0].price, timestamp: trip.exit_trades[0].timestamp, analytics: {} }],
  ...extra,
})

async function mockAnalysis(page: Page, cycles: unknown[], writes: string[]) {
  await mockWorkspace(page)
  const bars = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4 }))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    if (method !== 'GET' && !path.endsWith('/users/settings')) writes.push(`${method} ${path}`)
    if (path.endsWith('/analysis/sessions')) return route.fulfill({ json: [session] })
    if (path.endsWith('/analysis/sessions/s1')) return route.fulfill({ json: { ...session, trades, orders: [], cycles } })
    if (path.endsWith('/analysis/round-trips')) return route.fulfill({ json: trips })
    if (path.endsWith('/analysis/labels')) return route.fulfill({ json: [] })
    if (path.endsWith('/analysis/entry-tags') || path.endsWith('/analysis/exit-tags')) return route.fulfill({ json: { tags: [] } })
    if (path.endsWith('/pattern/strategies')) return route.fulfill({ json: { strategies: [] } })
    if (path.endsWith('/pattern/categories')) return route.fulfill({ json: { categories: [] } })
    if (path.endsWith('/data/pre-session')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/data/options-historical')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/users/settings')) return route.fulfill({ json: {} })
    return route.fallback()
  })
}

async function openWalkthrough(page: Page) {
  await page.goto(app)
  await page.getByRole('button', { name: /Analysis/ }).click()
  await expect(page.getByText('Trade Analysis', { exact: true })).toBeVisible()
  await page.getByText('2026-10-08', { exact: true }).click()
  await page.getByRole('button', { name: 'Walkthrough', exact: true }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
}

test('Walkthrough shows each trade\'s entries, exits, how it exited, peak capital and the day P&L before and after', async ({ page }) => {
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockAnalysis(page, [cycle('c0', trips[0], 'STOPLOSS', 'MARKET'), cycle('c1', trips[1], 'TargetProfit', 'LIMIT')], writes)
  await openWalkthrough(page)

  // Trade 1: the day starts at zero, the trade is +120.50, the day ends at +120.50.
  const story = page.getByLabel('Day P&L story')
  await expect(story.getByLabel('Day before')).toContainText('+₹0.00')
  await expect(story.getByLabel('This trade')).toContainText('+₹120.50')
  await expect(story.getByLabel('Day after')).toContainText('+₹120.50')
  await expect(story.getByLabel('Day after')).toContainText('+0.12%')
  await expect(page.getByRole('group', { name: 'Trade facts' })).toContainText('Peak capital 6.50%')

  const entries = page.getByLabel('Entries')
  await expect(entries).toContainText('B 65')
  await expect(entries).toContainText('101') // price
  await expect(entries).toContainText('6.50%') // capital
  await expect(entries).toContainText('0.40%') // risk
  await expect(entries.locator('.wt-chip')).toHaveText('MKT')
  const exits = page.getByLabel('Exits')
  await expect(exits).toContainText('S 65')
  await expect(exits.locator('.wt-chip')).toHaveText('SS') // sell stoploss
  await expect(exits.locator('.wt-chip')).toHaveAttribute('title', 'Sell stoploss')

  await page.screenshot({ path: 'test-results/walkthrough-website.png' })
  // More info opens the rest of what is known.
  await entries.getByRole('button', { name: 'More info on entry 1' }).click()
  await expect(entries).toContainText('capital 5%')

  // Trade 2 starts the day where trade 1 left it; its exit was the take-profit strategy.
  await page.getByRole('button', { name: 'Next trade' }).click()
  await expect(page.getByText('Trade 2 of 2', { exact: true })).toBeVisible()
  await expect(story.getByLabel('Day before')).toContainText('+₹120.50')
  await expect(story.getByLabel('This trade')).toContainText('−₹45.25')
  await expect(story.getByLabel('Day after')).toContainText('+₹75.25')
  await expect(page.getByLabel('Exits').locator('.wt-chip')).toHaveText('TP')
  await expect(page.getByLabel('Entries').locator('.wt-chip')).toHaveText('BL')

  // Read-only: nothing was written, and there is no save status line.
  expect(writes).toEqual([])
  await expect(page.locator('.tl-status')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Walkthrough on a server without cycle details still lists the legs and says what is missing', async ({ page }) => {
  const errors: string[] = [], writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockAnalysis(page, [], writes)
  await openWalkthrough(page)
  await expect(page.getByRole('note').filter({ hasText: 'did not send the entry and exit details' })).toBeVisible()
  await expect(page.getByLabel('Entries')).toContainText('B 65')
  await expect(page.getByLabel('Exits')).toContainText('S 65')
  await expect(page.getByLabel('Day P&L story').getByLabel('Day before')).toContainText('—')
  expect(errors).toEqual([])
})

test('the other tabs are still there and Label Trades opens as before', async ({ page }) => {
  const writes: string[] = []
  await mockAnalysis(page, [cycle('c0', trips[0], 'STOPLOSS', 'MARKET')], writes)
  await openWalkthrough(page)
  await page.getByRole('button', { name: 'Label Trades', exact: true }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
  await expect(page.locator('.tl-status')).toContainText('Changes save automatically')
  await page.getByRole('button', { name: 'Trades', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Walkthrough', exact: true })).toBeVisible()
})
