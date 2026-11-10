import { expect, test, type Page } from '@playwright/test'
import { mockServer, signIn, VIEWPORTS, type MockServer } from './fixtures'

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main' })

async function openBrowse(page: Page, setup?: (state: MockServer) => void) {
  const state = await mockServer(page)
  setup?.(state)
  await signIn(page)
  await rail(page).getByRole('button', { name: 'Browse' }).click()
  return state
}
const dataRequests = (state: MockServer) => state.requests.filter(r => r.path.startsWith('/api/desktop/v1/analysis/data/'))
const chart = (page: Page) => page.locator('.desktop-analysis-chart')

test('opens on the last completed trading day with the NIFTY chart', async ({ page }) => {
  const state = await openBrowse(page)
  await expect(chart(page)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Symbol: NIFTY/ })).toBeVisible()
  const historical = dataRequests(state).find(r => r.path.endsWith('data/historical'))!
  expect(historical.authorization).toBe('Bearer access-token-1')
  expect(historical.query.get('symbol')).toBe('NIFTY')
  const day = new Date(historical.query.get('trading_date') + 'T00:00:00Z').getUTCDay()
  expect(day).not.toBe(0)
  expect(day).not.toBe(6)
  expect(historical.query.get('trading_date')! < new Date().toISOString().slice(0, 10)).toBe(true) // never today
  await expect(page.getByRole('button', { name: 'Next day' })).toBeDisabled() // already on the latest day
})

test('previous and next day load that day and skip weekends', async ({ page }) => {
  const state = await openBrowse(page)
  await expect(chart(page)).toBeVisible()
  const first = dataRequests(state).find(r => r.path.endsWith('data/historical'))!.query.get('trading_date')!
  const firstLabel = await page.getByRole('button', { name: /^Day:/ }).getAttribute('aria-label')
  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/historical')).at(-1)!.query.get('trading_date')).not.toBe(first)
  const second = dataRequests(state).filter(r => r.path.endsWith('data/historical')).at(-1)!.query.get('trading_date')!
  expect([0, 6]).not.toContain(new Date(second + 'T00:00:00Z').getUTCDay())
  expect(second < first).toBe(true)
  await page.getByRole('button', { name: 'Next day' }).click()
  // Already loaded days come from the cache, so the proof is the day shown, and that Next is off again on the latest day.
  await expect(page.getByRole('button', { name: /^Day:/ })).toHaveAttribute('aria-label', firstLabel!)
  await expect(page.getByRole('button', { name: 'Next day' })).toBeDisabled()
})

test('the date sheet picks a day, refuses a weekend and can return to the latest day', async ({ page }) => {
  const state = await openBrowse(page)
  await page.getByRole('button', { name: /^Day:/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Day' })
  await sheet.getByLabel('Date').fill('2026-11-07') // Saturday
  await expect(sheet.getByRole('alert')).toContainText('weekend')
  await expect(sheet.getByRole('button', { name: 'Show' })).toBeDisabled()
  await sheet.getByLabel('Date').fill('2026-11-05')
  await sheet.getByRole('button', { name: 'Show' }).click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/historical')).at(-1)!.query.get('trading_date')).toBe('2026-11-05')
  await expect(page.getByRole('button', { name: 'Day: Thu 5 Nov' })).toBeVisible()
})

test('the symbol sheet searches the catalogue and loads that symbol', async ({ page }) => {
  const state = await openBrowse(page)
  await page.getByRole('button', { name: /^Symbol:/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Symbol' })
  await expect(sheet.getByRole('button', { name: /NIFTY 50/ })).toBeVisible()
  await sheet.getByLabel('Search symbols').fill('reli')
  await expect(sheet.getByRole('button', { name: /Tata Motors/ })).toHaveCount(0)
  await sheet.getByRole('button', { name: /Reliance Industries/ }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Symbol: RELIND' })).toBeVisible()
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/historical')).at(-1)!.query.get('symbol')).toBe('RELIND')
  // The pick is remembered as a recent symbol.
  await page.getByRole('button', { name: /^Symbol:/ }).click()
  await expect(page.getByRole('dialog', { name: 'Symbol' }).getByRole('group', { name: 'Recent' })).toContainText('Reliance Industries')
})

test('CE and PE are offered only for symbols with options', async ({ page }) => {
  await openBrowse(page)
  await expect(page.getByRole('button', { name: 'CE', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: /^Symbol:/ }).click()
  await page.getByRole('dialog', { name: 'Symbol' }).getByRole('button', { name: /Tata Motors/ }).click()
  await expect(page.getByRole('button', { name: 'CE', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'PE', exact: true })).toBeDisabled()
})

test('CE shows the option chart for the day\'s expiry at the strike nearest the money, and the strike menu changes it', async ({ page }) => {
  const state = await openBrowse(page)
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Strike:/ })).toBeVisible()
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/options-historical')).length).toBeGreaterThan(0)
  const first = dataRequests(state).filter(r => r.path.endsWith('data/options-historical')).at(-1)!
  expect(first.query.get('right')).toBe('CE')
  expect(first.query.get('expiry')).toBe('2026-11-13')
  expect(Number(first.query.get('strike')) % 50).toBe(0)
  expect(first.authorization).toBe('Bearer access-token-1')
  await page.getByRole('button', { name: /^Strike:/ }).click()
  const menu = page.getByRole('menu', { name: 'Strike' })
  expect(await menu.getByRole('menuitemradio').count()).toBe(43)
  // Opens with the current strike in view, not at the top of the 43.
  await expect(menu.getByRole('menuitemradio', { name: first.query.get('strike')!, exact: true })).toBeInViewport()
  const target = String(Number(first.query.get('strike')) + 100)
  await menu.getByRole('menuitemradio', { name: target, exact: true }).click()
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/options-historical')).at(-1)!.query.get('strike')).toBe(target)
  await page.getByRole('button', { name: 'PE', exact: true }).click()
  await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/options-historical')).at(-1)!.query.get('right')).toBe('PE')
  // The strike is kept when switching side.
  expect(dataRequests(state).filter(r => r.path.endsWith('data/options-historical')).at(-1)!.query.get('strike')).toBe(target)
})

test('a day without listed options says why instead of showing a chart', async ({ page }) => {
  await openBrowse(page, state => { state.optionsUnavailable = 'The selected date is not a trading day' })
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'not a trading day' })).toBeVisible()
  await expect(chart(page)).toHaveCount(0)
  // The controls stay so another day or Spot can be chosen.
  await page.getByRole('button', { name: 'Spot', exact: true }).click()
  await expect(chart(page)).toBeVisible()
})

test('an older server without the catalogue still browses NIFTY', async ({ page }) => {
  await openBrowse(page, state => { state.catalogueOld = true })
  await expect(chart(page)).toBeVisible()
  await page.getByRole('button', { name: /^Symbol:/ }).click()
  await expect(page.getByRole('dialog', { name: 'Symbol' }).getByRole('button', { name: /NIFTY 50/ })).toBeVisible()
})

test('leaving the tab and coming back finds the same chart', async ({ page }) => {
  await openBrowse(page)
  await page.getByRole('button', { name: /^Symbol:/ }).click()
  await page.getByRole('dialog', { name: 'Symbol' }).getByRole('button', { name: /Reliance Industries/ }).click()
  await rail(page).getByRole('button', { name: 'Stats' }).click()
  await rail(page).getByRole('button', { name: 'Browse' }).click()
  await expect(page.getByRole('button', { name: 'Symbol: RELIND' })).toBeVisible()
})

test('Browse only reads: no write request and no order or drawing controls', async ({ page }) => {
  const state = await openBrowse(page)
  await expect(chart(page)).toBeVisible()
  await expect(page.getByRole('button', { name: /Buy|Sell/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /drawing tools/i })).toHaveCount(0)
  expect(state.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET')).toHaveLength(0)
})

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('the one control row fits, the chart gets the height and the page does not scroll sideways', async ({ page }) => {
      await openBrowse(page)
      await page.getByRole('button', { name: 'CE', exact: true }).click()
      await expect(page.getByRole('button', { name: /^Strike:/ })).toBeVisible()
      await expect(chart(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      const header = (await page.locator('.desktop-analysis-chart header').boundingBox())!
      expect(header.height).toBeLessThanOrEqual(48) // one row, not wrapped
      const plot = (await page.locator('.analysis-kline').boundingBox())!
      expect(plot.height).toBeGreaterThanOrEqual(viewport.height - 60)
      for (const name of [/^Symbol:/, 'Previous day', /^Day:/, 'Spot', 'CE', 'PE', /^Strike:/]) {
        const box = (await page.getByRole('button', { name }).first().boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(36)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      }
    })
  })
}
