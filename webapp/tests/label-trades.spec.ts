import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace } from './workspaceFixture'

const app = 'http://127.0.0.1:5174/webapp/'
const end = 1791447300 + 120 * 180
const leg = (trade_id: string, side: 'BUY' | 'SELL', offset: number, extra: Record<string, unknown> = {}) => ({ trade_id, side, quantity: 65, price: 100 + offset, timestamp: end - (60 - offset) * 180, ...extra })
const ce = { right: 'CE', strike: 25000, expiry: '2026-10-15' }
const trips = [
  { index: 0, right: null, pnl: 120.5, entry_trades: [leg('t1', 'BUY', 1)], exit_trades: [leg('t2', 'SELL', 3)] },
  { index: 1, right: 'CE', pnl: -45.25, entry_trades: [leg('t3', 'BUY', 10, ce)], exit_trades: [leg('t4', 'SELL', 12, ce)] },
]
const trade = (row: ReturnType<typeof leg>, extra: Record<string, unknown> = {}) => ({ ...row, session_id: 's1', user_id: 'alice', symbol: 'NIFTY', instrument_type: extra.right ? 'options' : 'equity', right: null, strike: null, expiry: null, commission: 1, ...extra })
const trades = [trade(trips[0].entry_trades[0]), trade(trips[0].exit_trades[0]), trade(trips[1].entry_trades[0], ce), trade(trips[1].exit_trades[0], ce)]
const session = { session_id: 's1', user_id: 'alice', symbol: 'NIFTY', date: '2026-10-08', start_time: '09:15:00', instrument_type: 'options', session_type: 'paper', strike: null, expiry: null, session_capital: 100000, net_pnl: 75.25, pnl_pct: 0.07, total_commission: 4, trade_count: 4, round_trip_count: 2, buy_count: 2, sell_count: 2 }

async function mockAnalysis(page: Page, saves: unknown[][]) {
  await mockWorkspace(page)
  const bars = Array.from({ length: 200 }, (_, i) => ({ time: 1791447300 + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4 }))
  let labels: Record<string, unknown>[] = []
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    if (path.endsWith('/analysis/sessions')) return route.fulfill({ json: [session] })
    if (path.endsWith('/analysis/sessions/s1')) return route.fulfill({ json: { ...session, trades, orders: [], cycles: [] } })
    if (path.endsWith('/analysis/round-trips')) return route.fulfill({ json: trips })
    if (path.endsWith('/analysis/labels')) {
      if (method === 'POST') { const rows = route.request().postDataJSON().labels; saves.push(rows); labels = [...labels.filter(l => !rows.some((r: any) => r.round_trip_index === l.round_trip_index)), ...rows]; return route.fulfill({ json: rows }) }
      return route.fulfill({ json: labels })
    }
    if (path.endsWith('/analysis/entry-tags') || path.endsWith('/analysis/exit-tags')) return route.fulfill({ json: { tags: [] } })
    if (path.endsWith('/pattern/strategies')) return route.fulfill({ json: { strategies: ['Breakout'] } })
    if (path.endsWith('/pattern/categories')) return route.fulfill({ json: { categories: ['Momentum'] } })
    if (path.endsWith('/data/pre-session')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/data/options-historical')) return route.fulfill({ json: { candles: bars } })
    if (path.endsWith('/users/settings')) return route.fulfill({ json: { analysis_label_view: 'one_by_one' } })
    return route.fallback()
  })
}

test('Label Trades on a phone: one trade at a time, stacked panes become tabs, bottom Prev/Next bar, auto-save', async ({ page }) => {
  const saves: unknown[][] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await mockAnalysis(page, saves)
  await page.goto(app)
  await page.getByRole('button', { name: /Analysis/ }).click()
  await expect(page.getByText('Trade Analysis', { exact: true })).toBeVisible()
  await page.getByText('2026-10-08', { exact: true }).click()
  await page.getByRole('button', { name: 'Label Trades', exact: true }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
  const bar = page.locator('.tl-bottom-nav')
  await expect(bar).toBeVisible()
  // Fixed to the bottom of the screen, above the page content.
  await expect.poll(async () => { const box = (await bar.boundingBox())!; return Math.round(box.y + box.height) }).toBe(844)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Previous trade' })).toBeDisabled()
  // Edit trade 1; Next saves only that trade before moving.
  await page.locator('input[list^="et-"]').first().fill('FIRST')
  await page.getByRole('button', { name: 'Next trade' }).click()
  await expect(page.getByText('Trade 2 of 2', { exact: true })).toBeVisible()
  expect(saves.map(rows => (rows as any[]).map(row => [row.round_trip_index, row.entry_tag]))).toEqual([[[0, 'FIRST']]])
  // The CE trade has a strike chart: phones show one pane at a time behind tabs.
  const tabs = page.getByRole('navigation', { name: 'Chart pane' })
  await expect(tabs).toBeVisible()
  await expect(page.getByLabel('Strike chart pane')).toHaveCount(0)
  await tabs.getByRole('button', { name: 'CE 25000' }).click()
  await expect(page.getByLabel('Strike chart pane')).toBeVisible()
  await expect(page.getByLabel('Underlying chart pane')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/label-trades-phone.png' })
  await page.getByRole('button', { name: 'Previous trade' }).click()
  await expect(page.getByText('Trade 1 of 2', { exact: true })).toBeVisible()
  expect(saves).toHaveLength(1) // untouched trade 2 is never written
  expect(errors).toEqual([])
})

test('Settings → Analytics manages behavior questions: add, edit, archive and unarchive', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1200, height: 900 })
  await mockWorkspace(page)
  let questions: Record<string, unknown>[] = [{ question_id: 'q1', kind: 'entry', text: 'Chased the move', status: 'active', sort_order: 0, created_at: '2026-10-01', archived_at: null }]
  const found = (id: string) => questions.find(question => question.question_id === id)!
  await page.route('**/api/behavior/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method()
    const [, , , , id, action] = url.pathname.split('/')
    if (method === 'GET') return route.fulfill({ json: { questions } })
    if (!id || id === 'questions') {
      const body = route.request().postDataJSON()
      const created = { question_id: `q${questions.length + 1}`, kind: body.kind, text: body.text, status: 'active', sort_order: questions.length, created_at: '2026-10-05', archived_at: null }
      questions.push(created); return route.fulfill({ json: created })
    }
    const question = found(id)
    if (action === 'update') question.text = route.request().postDataJSON().text
    if (action === 'archive') { question.status = 'archived'; question.archived_at = '2026-10-21T08:00:00Z' }
    if (action === 'restore') { question.status = 'active'; question.archived_at = null }
    return route.fulfill({ json: question })
  })
  await page.goto(app)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'analytics', exact: true }).click()
  const manager = settings.getByRole('region', { name: 'Behavior questions' })
  await expect(manager.getByText('Chased the move', { exact: true })).toBeVisible()
  await manager.getByLabel('New question text').fill('Exited after one bar in profit')
  await manager.getByRole('radio', { name: 'Exit' }).click()
  await manager.getByRole('button', { name: 'Add question' }).click()
  await expect(manager.getByText('Exited after one bar in profit', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Edit question: Chased the move' }).click()
  await manager.getByLabel('Question text', { exact: true }).fill('Chased price')
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(manager.getByText('Chased price', { exact: true })).toBeVisible()
  await manager.getByRole('button', { name: 'Archive question: Chased price' }).click()
  await manager.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(manager.getByText('Chased price', { exact: true })).toHaveCount(0)
  await manager.getByRole('button', { name: /Archived \(1\)/ }).click()
  await manager.getByRole('button', { name: 'Unarchive question: Chased price' }).click()
  await expect(manager.getByRole('button', { name: 'Archive question: Chased price' })).toBeVisible()
  expect(errors).toEqual([])
})
