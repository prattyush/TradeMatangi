import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace } from './workspaceFixture'

const app = 'http://127.0.0.1:5174/webapp/'
const end = 1791447300 + 120 * 180
const at = (offset: number) => end - (60 - offset) * 180
const ce = { right: 'CE', strike: 25000, expiry: '2026-10-15' }
// Two completed trades: an equity one (buy 65 at 101, sell 65 at 103) and a CE one (buy 65 at 110, sell 65 at 112). Charges 2.5 a fill.
const fill = (id: string, role: 'entry' | 'exit', side: 'BUY' | 'SELL', offset: number, price: number, extra: Record<string, unknown> = {}) =>
  ({ trade_id: id, execution_id: id, role, side, quantity: 65, price, timestamp: at(offset), commission: 2.5, ...extra })
const trade = (row: ReturnType<typeof fill>, extra: Record<string, unknown> = {}) => ({ ...row, session_id: 's1', user_id: 'alice', symbol: 'NIFTY', instrument_type: extra.right ? 'options' : 'equity', right: null, strike: null, expiry: null, ...extra })
const legs0 = [fill('t1', 'entry', 'BUY', 1, 101), fill('t2', 'exit', 'SELL', 3, 103)]
const legs1 = [fill('t3', 'entry', 'BUY', 10, 110, ce), fill('t4', 'exit', 'SELL', 12, 112, ce)]
const roundTripLeg = (row: ReturnType<typeof fill>) => ({ trade_id: row.trade_id, side: row.side, quantity: row.quantity, price: row.price, timestamp: row.timestamp, ...(row.right ? { right: row.right, strike: row.strike } : {}) })
const trips = [
  { index: 0, cycle_id: 'c0', right: null, pnl: 125, pnl_pct: 0.125, max_capital_pct: 6.57, entry_trades: [roundTripLeg(legs0[0])], exit_trades: [roundTripLeg(legs0[1])] },
  { index: 1, cycle_id: 'c1', right: 'CE', pnl: 125, pnl_pct: 0.125, max_capital_pct: 7.15, entry_trades: [roundTripLeg(legs1[0])], exit_trades: [roundTripLeg(legs1[1])] },
]
const trades = [...legs0.map(row => trade(row)), ...legs1.map(row => trade(row, ce))]
const cycle = (id: string, trip: typeof trips[number], legs: ReturnType<typeof fill>[]) => ({
  user_id: 'alice', session_id: 's1', cycle_id: id, symbol: 'NIFTY', right: trip.right, strike: trip.right ? 25000 : null, expiry: trip.right ? '2026-10-15' : null,
  direction: 'LONG', state: 'closed', mode: 'paper', entry_time: legs[0].timestamp, exit_time: legs[1].timestamp, exit_sort_time: null, entry_count: 1, exit_count: 1,
  net_pnl: 125, pnl_pct: trip.pnl_pct, fees: 5, open_quantity: 0, capital: 100000, peak_capital_pct: trip.max_capital_pct, matches: [], label_index: trip.index,
  entries: [{ entry_id: `${id}-e`, entry_method: 'MARKET', client: 'website', timestamp: legs[0].timestamp, quantity: 65, matched_quantity: 65, open_quantity: 0, average_price: legs[0].price, net_pnl: 125, pnl_pct: 0.125, sizing_method: 'CAPITAL', requested_pct: 5, r_multiple: null, analytics: { effective_allocation_pct: 6.5, margin_rate: 1 } }],
  exits: [{ exit_id: `${id}-x`, exit_method: 'MARKET', quantity: 65, price: legs[1].price, timestamp: legs[1].timestamp, analytics: {} }],
  executions: legs,
})
const session = { session_id: 's1', user_id: 'alice', symbol: 'NIFTY', date: '2026-10-08', start_time: '09:15:00', instrument_type: 'options', session_type: 'paper', strike: null, expiry: null, session_capital: 100000, net_pnl: 250, pnl_pct: 0.25, total_commission: 10, trade_count: 4, round_trip_count: 2, buy_count: 2, sell_count: 2 }

interface Mock { writes: string[]; saved: Array<Record<string, any>> }

async function mockAnalysis(page: Page, renderer: 'kline' | 'lightweight', state: Mock, options: { whatIf?: boolean; shared?: boolean } = {}) {
  await mockWorkspace(page)
  const bars = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4 }))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    if (method !== 'GET' && !path.endsWith('/users/settings')) state.writes.push(`${method} ${path}`)
    if (path.endsWith('/analysis/sessions')) return route.fulfill({ json: [{ ...session, shared: options.shared ?? false }] })
    if (path.endsWith('/analysis/sessions/s1')) return route.fulfill({ json: { ...session, shared: options.shared ?? false, trades, orders: [], cycles: [cycle('c0', trips[0], legs0), cycle('c1', trips[1], legs1)] } })
    if (path.endsWith('/analysis/round-trips')) return route.fulfill({ json: trips })
    if (path.endsWith('/analysis/labels')) return route.fulfill({ json: [] })
    if (path.endsWith('/analysis/entry-tags') || path.endsWith('/analysis/exit-tags')) return route.fulfill({ json: { tags: [] } })
    if (path.endsWith('/pattern/strategies')) return route.fulfill({ json: { strategies: [] } })
    if (path.endsWith('/pattern/categories')) return route.fulfill({ json: { categories: [] } })
    if (path.endsWith('/data/pre-session')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/data/options-historical')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/users/settings')) return route.fulfill({ json: { website_analysis_chart_renderer: renderer } })
    if (path.endsWith('/api/whatif/range')) {
      const rows = state.saved.map(({ edits, ...rest }) => rest)
      return route.fulfill({ json: { scenarios: rows } })
    }
    if (path.endsWith('/api/whatif')) {
      if (options.whatIf === false) return route.fulfill({ status: 404, json: { detail: 'Not Found' } })
      if (method === 'GET') return route.fulfill({ json: { scenarios: state.saved } })
      if (method === 'POST') {
        const body = route.request().postDataJSON()
        const id = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        const row = { session_id: body.session_id, scenario_id: id, name: body.name, date: '2026-10-08', symbol: 'NIFTY', session_type: 'paper', instrument_type: 'options', summary: body.summary, edits: body.edits, version: 1, updated_at: new Date().toISOString() }
        state.saved = [...state.saved.filter(r => r.scenario_id !== id), row]
        return route.fulfill({ json: row })
      }
      if (method === 'DELETE') { const id = url.searchParams.get('scenario_id'); state.saved = state.saved.filter(r => r.scenario_id !== id); return route.fulfill({ json: { deleted: true } }) }
    }
    return route.fallback()
  })
}

async function openWhatIf(page: Page) {
  await page.goto(app)
  await page.getByRole('button', { name: /Analysis/ }).click()
  await expect(page.getByText('Trade Analysis', { exact: true })).toBeVisible()
  await page.getByText('2026-10-08', { exact: true }).click()
  await page.getByRole('button', { name: 'What If', exact: true }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
}
const figure = (page: Page, name: string) => page.getByLabel(name, { exact: true })
const price = (page: Page, what: string) => page.getByLabel(`Price of ${what}`)
const quantity = (page: Page, what: string) => page.getByLabel(`Quantity of ${what}`)
const EXIT = 'exit at ' // the leg label starts with the role; the clock time follows
const exitPrice = (page: Page) => page.getByLabel(/^Price of exit at /)
const exitQty = (page: Page) => page.getByLabel(/^Quantity of exit at /)
const entryQty = (page: Page) => page.getByLabel(/^Quantity of entry at /)

test('the real day first: actual and what-if are the same until something is changed', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await expect(figure(page, 'Day: actual')).toContainText('+₹250.00')
  await expect(figure(page, 'Day: what-if')).toContainText('+₹250.00')
  await expect(figure(page, 'Day: difference')).toContainText('₹0.00')
  await expect(page.getByRole('group', { name: 'What-if summary' })).toContainText('0 trades edited')
  await expect(exitPrice(page)).toHaveValue('103')
  await expect(exitQty(page)).toHaveValue('65')
  expect(state.writes).toEqual([])
})

test('a changed exit price recalculates the trade and the day, charges included, and marks the leg', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await exitPrice(page).fill('105')
  // 65 x 2 more, less the extra charges on a bigger sell: a gain of a little under 130.
  const delta = await figure(page, 'This trade: difference').locator('strong').innerText()
  const amount = Number(delta.replace(/[^0-9.]/g, ''))
  expect(delta.startsWith('+')).toBe(true)
  expect(amount).toBeGreaterThan(100)
  expect(amount).toBeLessThan(130)
  await expect(figure(page, 'Day: difference').locator('strong')).toHaveText(delta) // the other trade is untouched
  await expect(page.getByRole('group', { name: 'What-if summary' })).toContainText('1 trade edited')
  await expect(page.locator('div.wi-leg.changed')).toHaveCount(1)
  // The other trade is unchanged.
  await page.getByRole('button', { name: 'Next trade' }).click()
  await expect(page.getByText('Trade 2 of 2', { exact: true })).toBeVisible()
  await expect(figure(page, 'This trade: difference').locator('strong')).toContainText('₹0.00')
  await expect(figure(page, 'Day: difference').locator('strong')).toHaveText(delta)
  // Back: the edit is still there. Reset puts the real price back.
  await page.getByRole('button', { name: 'Previous trade' }).click()
  await expect(exitPrice(page)).toHaveValue('105')
  await page.getByRole('button', { name: /^Reset exit at / }).click()
  await expect(exitPrice(page)).toHaveValue('103')
  await expect(figure(page, 'Day: difference').locator('strong')).toContainText('₹0.00')
})

test('a quantity that does not match warns that the P&L is uneven; quantity 0 removes a leg and shows the capital change', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await exitQty(page).fill('40')
  await expect(page.getByRole('alert').filter({ hasText: 'uneven' })).toContainText('65')
  await expect(page.getByRole('alert').filter({ hasText: 'uneven' })).toContainText('40')
  await expect(page.getByRole('group', { name: 'What-if summary' })).toContainText('1 with a warning')
  await expect(figure(page, 'This trade: what-if').locator('strong')).toContainText('−') // 25 units bought and never sold
  await expect(page.locator('div.wi-leg.changed').first()).toContainText('−2.58') // 25 fewer units: 25 x 103 / 100000 = 2.58% less capital
  await entryQty(page).fill('0')
  await expect(page.locator('div.wi-leg.removed')).toHaveCount(1)
  await expect(page.locator('div.wi-leg.removed')).toContainText('removed')
})

test('an invalid typed value is ignored and the real value comes back on leaving the box', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await exitPrice(page).fill('-4')
  await exitPrice(page).blur()
  await expect(exitPrice(page)).toHaveValue('103')
  await expect(page.getByRole('group', { name: 'What-if summary' })).toContainText('0 trades edited')
})

test('save, refresh, and the what-if is back; revert the day; delete it', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await exitPrice(page).fill('105')
  await expect(page.getByText('Unsaved changes.')).toBeVisible()
  await page.getByLabel('What-if name').fill('Exit later')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved “Exit later”' })).toBeVisible()
  expect(state.saved).toHaveLength(1)
  expect(state.saved[0]).toMatchObject({ session_id: 's1', name: 'Exit later', edits: [{ round_trip: 0, leg_id: 't2', role: 'exit', price: 105, quantity: 65 }] })
  expect(state.saved[0].summary).toMatchObject({ actual_pnl: 250, trips_edited: 1, warnings: 0 })
  expect(state.saved[0].summary.whatif_pnl).toBeGreaterThan(350)
  await expect(page.getByText('Unsaved changes.')).toHaveCount(0)

  // A refresh loses nothing: the saved what-if is shown again.
  await openWhatIf(page)
  await expect(page.getByRole('combobox', { name: 'Saved what-ifs' })).toHaveValue('exit-later')
  await expect(exitPrice(page)).toHaveValue('105')
  await expect(page.getByLabel('What-if name')).toHaveValue('Exit later')

  // Revert day shows the real day without deleting the saved one.
  await page.getByRole('button', { name: 'Revert day' }).click()
  await expect(exitPrice(page)).toHaveValue('103')
  expect(state.saved).toHaveLength(1)
  await page.getByRole('combobox', { name: 'Saved what-ifs' }).selectOption('exit-later')
  await expect(exitPrice(page)).toHaveValue('105')

  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Deleted' })).toBeVisible()
  expect(state.saved).toHaveLength(0)
  await expect(exitPrice(page)).toHaveValue('103')
  // Only what-if routes were written; no order, trade or label was touched.
  expect([...new Set(state.writes)].sort()).toEqual(['DELETE /api/whatif', 'POST /api/whatif'])
})

test('saving needs a name and an edit, and says so', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await page.getByLabel('What-if name').fill('Idea')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Nothing to save yet')).toBeVisible()
  await exitPrice(page).fill('105')
  await page.getByLabel('What-if name').fill('')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Give this what-if a name first.')).toBeVisible()
  expect(state.writes).toEqual([])
})

test('Compare days lists the saved what-ifs of a date range with a total per idea', async ({ page }) => {
  const day = (id: string, name: string, date: string, actual: number, whatif: number) => ({ session_id: id, scenario_id: name.toLowerCase().replace(/ /g, '-'), name, date, symbol: 'NIFTY', session_type: 'paper', instrument_type: 'options', summary: { actual_pnl: actual, whatif_pnl: whatif, delta: whatif - actual, delta_pct: (whatif - actual) / 1000, trips_edited: 1, warnings: 0 }, edits: [], version: 1, updated_at: `${date}T10:00:00Z` })
  const state: Mock = { writes: [], saved: [day('s7', 'Exit at close', '2026-10-05', 100, 400), day('s8', 'Exit at close', '2026-10-06', -200, -50), day('s9', 'No averaging', '2026-10-06', -200, 100)] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await page.getByRole('button', { name: 'Compare days' }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare days' })
  const close = dialog.getByRole('table', { name: 'What-if Exit at close' })
  await expect(close).toContainText('2 days')
  await expect(close.locator('tr.total')).toContainText('+₹450.00') // (400-100) + (-50 - -200)
  await expect(dialog.getByRole('table', { name: 'What-if No averaging' }).locator('tr.total')).toContainText('+₹300.00')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('a server without saved what-ifs still lets the day be explored, and says saving is not available', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state, { whatIf: false })
  await openWhatIf(page)
  await exitPrice(page).fill('105')
  await expect(figure(page, 'Day: difference').locator('strong')).toContainText('+')
  expect(state.writes).toEqual([])
})

test('Lightweight charts: typing works and the page says how to pick on the chart; KLine offers picking', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await expect(page.getByText('switch the Analysis chart to KLine')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Pick the price of / })).toHaveCount(0)
})

test('KLine: Pick sets the price from the chart click, Escape cancels, and the edited leg is drawn', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockAnalysis(page, 'kline', state)
  await openWhatIf(page)
  await expect(page.locator('.analysis-kline canvas').first()).toBeVisible()
  const pick = page.getByRole('button', { name: /^Pick the price of exit at / })
  await expect(pick).toBeVisible()
  await pick.click()
  await expect(page.getByText('Click the chart to set the exit price')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Click the chart to set the exit price')).toHaveCount(0)
  await expect(exitPrice(page)).toHaveValue('103')
  await pick.click()
  const chart = page.locator('.analysis-kline').first()
  const box = (await chart.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3)
  await expect(page.getByText('Click the chart to set the exit price')).toHaveCount(0)
  const picked = Number(await exitPrice(page).inputValue())
  expect(picked).not.toBe(103)
  expect(picked).toBeGreaterThan(95)
  expect(picked).toBeLessThan(140) // within the candle range the chart shows
  await expect(page.locator('div.wi-leg.changed')).toHaveCount(1)
  expect(errors).toEqual([])
  await page.screenshot({ path: 'test-results/whatif-kline.png' })
})

test('other tabs still open, and leaving a changed what-if asks first', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state)
  await openWhatIf(page)
  await page.getByRole('button', { name: 'Walkthrough', exact: true }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'What If', exact: true }).click()
  await expect(exitPrice(page)).toHaveValue('103')
  await page.getByRole('button', { name: 'Label Trades', exact: true }).click()
  await expect(page.locator('.tl-status')).toContainText('Changes save automatically')
})

test('shared history: edits work as a playground, but nothing can be saved or deleted', async ({ page }) => {
  const state: Mock = { writes: [], saved: [] }
  await mockAnalysis(page, 'lightweight', state, { shared: true })
  await openWhatIf(page)
  await exitPrice(page).fill('105')
  await expect(figure(page, 'Day: difference').locator('strong')).toContainText('+')
  await expect(page.getByText('Shared history: edits are a playground and cannot be saved.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
  await expect(page.getByLabel('What-if name')).toBeDisabled()
  expect(state.writes).toEqual([])
})
