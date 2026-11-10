import { expect, test } from '@playwright/test'
import { mockServer, openSessions, VIEWPORTS } from './fixtures'

const rows = (page: import('@playwright/test').Page) => page.locator('.session-row')

test('lists trading days grouped by date and instrument, newest first, with P&L and mode', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await expect(rows(page)).toHaveCount(5) // two sessions on 07 Nov are one group; the swing day is its own row
  const first = rows(page).nth(0)
  await expect(first).toContainText('09')
  await expect(first).toContainText('Nov')
  await expect(first).toContainText('NIFTY')
  await expect(first).toContainText('Paper')
  await expect(first).toContainText('+₹3,200')
  await expect(first.locator('.pos')).toHaveCount(1)
  await expect(rows(page).nth(1)).toContainText('TATPOW')
  await expect(rows(page).nth(1)).toContainText('Real')
  await expect(rows(page).nth(1).locator('.neg')).toHaveText('-₹1,250')
  const merged = rows(page).filter({ hasText: '2 sessions' })
  await expect(merged).toHaveCount(1)
  await expect(merged).toContainText('+₹600') // 900 - 300
  await expect(rows(page).filter({ hasText: 'Swing' })).toHaveCount(1)
})

test('asks the server only for a bounded period (the endpoint has no pagination)', async ({ page }) => {
  const server = await mockServer(page)
  await openSessions(page)
  await expect(rows(page).first()).toBeVisible()
  const query = server.analysis.sessionsRequests.at(-1)!
  expect(query.get('start_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(query.get('end_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const days = (Date.parse(query.get('end_date')!) - Date.parse(query.get('start_date')!)) / 86_400_000
  expect(days).toBe(30)
  const call = server.requests.find(r => r.path === '/api/desktop/v1/analysis/sessions')!
  expect(call.authorization).toBe('Bearer access-token-1')
})

test('selecting a day shows its chart; Trades, Orders and Videos tabs work', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await expect(page.getByText('Pick a session')).toBeVisible()
  await rows(page).first().click()
  await expect(page.getByRole('tab', { name: 'Chart' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Trades' }).click()
  const table = page.locator('.trades-table')
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await expect(table.locator('tbody tr').first()).toContainText('10:05:00')
  await expect(table.locator('tbody tr').first()).toContainText('BUY')
  await expect(table.locator('tbody tr').first()).toContainText('24500 CE')
  await page.getByRole('tab', { name: 'Orders' }).click()
  await expect(page.getByText('No stored orders for this session.')).toBeVisible()
  await page.getByRole('tab', { name: 'Videos' }).click()
  await expect(page.getByRole('tab', { name: 'Videos' })).toHaveAttribute('aria-selected', 'true')
})

test('a day with two sessions splits its trades by session', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).filter({ hasText: '2 sessions' }).click()
  await page.getByRole('tab', { name: 'Trades' }).click()
  await expect(page.getByText(/^Session 1/)).toBeVisible()
  await expect(page.getByText(/^Session 2/)).toBeVisible()
})

test('a swing day offers Trades and Videos only', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).filter({ hasText: 'Swing' }).click()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: 'Trades' })).toHaveAttribute('aria-selected', 'true')
})

test('filters: pick Paper and 90 days, apply, and only matching days stay', async ({ page }) => {
  const server = await mockServer(page)
  await openSessions(page)
  await expect(rows(page)).toHaveCount(5)
  await page.getByRole('button', { name: /^Filters/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Filters' })
  await sheet.getByRole('button', { name: '90 days' }).click()
  await sheet.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Paper' }).click()
  await sheet.getByRole('button', { name: 'Apply' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(rows(page)).toHaveCount(2) // NIFTY paper + the swing HDFCBANK paper day
  const query = server.analysis.sessionsRequests.at(-1)!
  expect(query.get('session_type')).toBe('paper')
  expect((Date.parse(query.get('end_date')!) - Date.parse(query.get('start_date')!)) / 86_400_000).toBe(90)
  await expect(page.getByRole('button', { name: /^Filters/ }).locator('.count')).toHaveText('2')
  await expect(page.getByText('Last 90 days')).toBeVisible()
})

test('a custom period is validated before it is applied', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Filters' })
  await sheet.getByRole('button', { name: 'Custom' }).click()
  await expect(sheet.getByRole('alert')).toContainText('Pick a start date')
  await expect(sheet.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await sheet.getByLabel('From').fill('2026-11-01')
  await expect(sheet.getByRole('button', { name: 'Apply' })).toBeEnabled()
})

test('the back key closes the filter sheet first', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Filters' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Sessions', level: 2 })).toBeVisible()
})

test('an empty period offers a wider one', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.sessions = 'empty'
  await openSessions(page)
  await expect(page.getByText('No sessions in this period')).toBeVisible()
  await page.getByRole('button', { name: 'Show 1 year' }).click()
  await expect(page.getByText('Last 1 year')).toBeVisible()
})

test('a server error can be retried', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.sessions = 'fail-once'
  await openSessions(page)
  await expect(page.getByRole('alert')).toContainText('Internal error')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(rows(page)).toHaveCount(5)
})

test('an older server without the analysis routes says so instead of failing', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.sessions = 'old'
  await openSessions(page)
  await expect(page.getByText('Sessions is not available on this server')).toBeVisible()
})

for (const viewport of VIEWPORTS) {
  test.describe(`landscape ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('list and detail fit the screen, rows and tabs are tappable, the chart has room', async ({ page }) => {
      await mockServer(page)
      await openSessions(page)
      await expect(rows(page).first()).toBeVisible()
      for (const row of await rows(page).all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48)
      await page.screenshot({ path: `test-results/sessions-list-${viewport.name}.png` })
      await rows(page).first().click()
      await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
      for (const tab of await page.getByRole('tab').all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(40)
      const chart = await page.locator('.phone-chart .analysis-kline').first().boundingBox()
      expect(chart!.height).toBeGreaterThanOrEqual(180) // the candles themselves, below the toggle and the chart header
      expect(chart!.width).toBeGreaterThanOrEqual(380)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true)
      await page.screenshot({ path: `test-results/sessions-chart-${viewport.name}.png` })
      await page.getByRole('tab', { name: 'Trades' }).click()
      await page.screenshot({ path: `test-results/sessions-trades-${viewport.name}.png` })
      await page.getByRole('button', { name: /^Filters/ }).click()
      await page.screenshot({ path: `test-results/sessions-filters-${viewport.name}.png` })
    })
  })
}
