import { expect, test } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS } from './fixtures'

const rows = (page: import('@playwright/test').Page) => page.locator('.session-row')
async function openSnapshots(page: import('@playwright/test').Page, day = 'Paper') {
  await openSessions(page)
  await rows(page).filter({ hasText: day }).first().click()
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Snapshots')
}
const strip = (page: import('@playwright/test').Page) => page.locator('.snapshot-strip')

test('the Snapshots view shows the first event and its chart', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page)
  await expect(page.getByRole('button', { name: 'View: Snapshots' })).toBeVisible()
  await expect(strip(page)).toContainText('1/3')
  await expect(strip(page)).toContainText('10:04:40')
  await expect(strip(page)).toContainText('BUY LIMIT placed @ 120')
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
})

test('◀ and ▶ step through the events and stop at the ends', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page)
  await expect(page.getByRole('button', { name: 'Previous event' })).toBeDisabled()
  await page.getByRole('button', { name: 'Next event' }).click()
  await expect(strip(page)).toContainText('2/3')
  await expect(strip(page)).toContainText('BUY order filled @ 120')
  await page.getByRole('button', { name: 'Next event' }).click()
  await expect(strip(page)).toContainText('Stoploss edited to 110')
  await expect(page.getByRole('button', { name: 'Next event' })).toBeDisabled()
  await page.getByRole('button', { name: 'Previous event' }).click()
  await expect(strip(page)).toContainText('2/3')
})

test('the event list is searchable and jumps to the chosen event', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page)
  await strip(page).locator('.event-button').click()
  const sheet = page.getByRole('dialog', { name: 'Events' })
  await expect(sheet.locator('.event-row')).toHaveCount(3)
  await expect(sheet.locator('.event-row').first()).toHaveAttribute('aria-current', 'true')
  await sheet.getByLabel(/^Search/).fill('stop*')
  await expect(sheet.locator('.event-row')).toHaveCount(1)
  await sheet.locator('.event-row').click()
  await expect(sheet).toHaveCount(0)
  await expect(strip(page)).toContainText('3/3')
  await expect(strip(page)).toContainText('Stoploss edited to 110')
})

test('Details shows the money, the open orders and the positions at that moment', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page)
  await page.getByRole('button', { name: 'Next event' }).click()
  await page.getByRole('button', { name: 'Next event' }).click() // stoploss edited: one open order, a long CE
  await page.getByRole('button', { name: 'Details' }).click()
  const sheet = page.getByRole('dialog', { name: 'Snapshot details' })
  await expect(sheet).toContainText('Stoploss edited to 110')
  await expect(sheet.getByRole('group', { name: 'Money' })).toContainText('₹4,91,000')
  await expect(sheet.getByRole('group', { name: 'Money' })).toContainText('+₹130.00')
  await expect(sheet.getByRole('group', { name: 'Open orders' })).toContainText('SELL STOP · SL')
  await expect(sheet.getByRole('group', { name: 'Open orders' })).toContainText('@ 110 × 75')
  await expect(sheet.getByRole('group', { name: 'Positions' })).toContainText('LONG 75 @ 120.00')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

test('an options day offers Underlying, CE and PE; each loads its own chart', async ({ page }) => {
  const server = await mockServer(page)
  await openSnapshots(page)
  const group = page.getByRole('group', { name: 'Snapshot chart' })
  await expect(group.getByRole('button')).toHaveCount(3) // Underlying, CE 24500, PE 24500
  await group.getByRole('button', { name: 'CE 24500' }).click()
  await expect(group.getByRole('button', { name: 'CE 24500' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => server.requests.some(r => r.path.endsWith('data/options-historical') && r.query.get('right') === 'CE' && r.query.get('strike') === '24500')).toBe(true)
  await group.getByRole('button', { name: 'PE 24500' }).click()
  await expect.poll(() => server.requests.some(r => r.path.endsWith('data/options-historical') && r.query.get('right') === 'PE')).toBe(true)
})

test('a contract the snapshot does not have is not offered', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page, 'Stepwise')
  const group = page.getByRole('group', { name: 'Snapshot chart' })
  await expect(group.getByRole('button', { name: /^CE / })).toHaveCount(1)
  await expect(group.getByRole('button', { name: /^PE / })).toHaveCount(0)
})

test('the chart is asked for the captured event candle of the chosen event', async ({ page }) => {
  const server = await mockServer(page)
  await openSnapshots(page)
  await page.getByRole('button', { name: 'Next event' }).click()
  await expect.poll(() => server.requests.some(r => /snapshots\/s-0911-a-e2\/candle$/.test(r.path))).toBe(true)
})

test('a day without snapshots says so, and the view menu still works', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page, 'Real') // TATPOW, an equity day with no captured events
  await expect(page.getByText('No snapshots for this day')).toBeVisible()
  await chooseView(page, 'Trades')
  await expect(page.locator('.trades-table')).toBeVisible()
})

test('a server without the snapshots route says it is not available', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.snapshotsOld = true
  await openSnapshots(page)
  await expect(page.getByText('Snapshots is not available on this server')).toBeVisible()
})

test('the back key closes the events list before anything else', async ({ page }) => {
  await mockServer(page)
  await openSnapshots(page)
  await strip(page).locator('.event-button').click()
  await expect(page.getByRole('dialog', { name: 'Events' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Events' })).toHaveCount(0)
  await expect(strip(page)).toBeVisible()
})

for (const viewport of VIEWPORTS) {
  test.describe(`landscape ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('snapshots fit: a 44 px strip, one control row, and a tall chart', async ({ page }) => {
      await mockServer(page)
      await openSnapshots(page)
      const stripBox = await strip(page).boundingBox()
      expect(stripBox!.height).toBeLessThanOrEqual(46)
      const chart = await page.locator('.phone-chart .analysis-kline').first().boundingBox()
      expect(chart!.height).toBeGreaterThanOrEqual(viewport.height - 44 - 44 - 60)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true)
      await page.screenshot({ path: `test-results/snapshots-${viewport.name}.png` })
      await strip(page).locator('.event-button').click()
      await page.screenshot({ path: `test-results/snapshots-events-${viewport.name}.png` })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Details' }).click()
      await page.screenshot({ path: `test-results/snapshots-details-${viewport.name}.png` })
    })
  })
}
