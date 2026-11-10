import { expect, test, type Page } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS } from './fixtures'

const rows = (page: Page) => page.locator('.session-row')
const overlay = (page: Page) => page.getByRole('dialog', { name: 'Trade walkthrough' })

async function openWalkthrough(page: Page, row = 0) {
  await openSessions(page)
  await rows(page).nth(row).click() // 0: NIFTY options, Paper, two round trips; 1: TATPOW equity, Real, one losing trip
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Walkthrough')
  await expect(overlay(page).getByText(/Trade 1 of \d/)).toBeVisible()
}

test('opens full screen with the chart, the day P&L before and after, the entries and the exits', async ({ page }) => {
  await mockServer(page)
  await openWalkthrough(page)
  const box = await overlay(page).boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0 })
  await expect(overlay(page).locator('.phone-chart canvas').first()).toBeVisible()
  const story = overlay(page).getByLabel('Day P&L story')
  await expect(story.getByLabel('Day before')).toContainText('+₹0.00')
  await expect(story.getByLabel('This trade')).toContainText('+₹1,600.00')
  await expect(story.getByLabel('Day after')).toContainText('+₹1,600.00')
  await expect(overlay(page).getByRole('group', { name: 'Trade facts' })).toContainText('Peak capital 1.80%')
  const entries = overlay(page).getByLabel('Entries')
  await expect(entries).toContainText('B 75')
  await expect(entries).toContainText('1.80%') // capital
  await expect(entries).toContainText('0.30%') // risk
  await expect(entries.locator('.wt-chip')).toHaveText('MKT')
  const exits = overlay(page).getByLabel('Exits')
  await expect(exits).toContainText('S 75')
  await expect(exits.locator('.wt-chip')).toHaveText('TP') // take-profit strategy
})

test('Next moves to the second trade, which starts the day where the first one left it', async ({ page }) => {
  await mockServer(page)
  await openWalkthrough(page)
  await overlay(page).getByRole('button', { name: 'Next trade' }).click()
  await expect(overlay(page).getByText('Trade 2 of 2')).toBeVisible()
  const story = overlay(page).getByLabel('Day P&L story')
  await expect(story.getByLabel('Day before')).toContainText('+₹1,600.00')
  await expect(story.getByLabel('Day after')).toContainText('+₹3,200.00')
  await expect(overlay(page)).toContainText('CE 24600')
})

test('a stopped-out trade is a red SS chip and a loss, and More info explains the entry', async ({ page }) => {
  await mockServer(page)
  await openWalkthrough(page, 1)
  await expect(overlay(page).getByLabel('This trade')).toContainText('−₹1,250.00')
  await expect(overlay(page).getByLabel('Exits').locator('.wt-chip')).toHaveText('SS')
  await expect(overlay(page).getByLabel('Exits').locator('.wt-chip')).toHaveAttribute('title', 'Sell stoploss')
  await overlay(page).getByRole('button', { name: 'More info on entry 1' }).click()
  await expect(overlay(page).getByLabel('Entries')).toContainText('Initial stop')
  await overlay(page).getByRole('button', { name: 'More info on entry 1' }).click()
  await expect(overlay(page).getByLabel('Entries')).not.toContainText('Initial stop')
})

test('it only reads: nothing is written, and there is no save status', async ({ page }) => {
  const server = await mockServer(page)
  await openWalkthrough(page)
  await overlay(page).getByRole('button', { name: 'Next trade' }).click()
  await expect(overlay(page).getByText('Trade 2 of 2')).toBeVisible()
  expect(server.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET')).toHaveLength(0)
  await expect(overlay(page).locator('.tl-status')).toHaveCount(0)
})

test('the back key and the ← button return to the session', async ({ page }) => {
  await mockServer(page)
  await openWalkthrough(page)
  await page.keyboard.press('Escape') // Android back
  await expect(overlay(page)).toHaveCount(0)
  await chooseView(page, 'Walkthrough')
  await expect(overlay(page)).toBeVisible()
  await overlay(page).getByRole('button', { name: 'Close labeling' }).click()
  await expect(overlay(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^View:/ })).toBeVisible()
})

test('it is not offered for a swing portfolio', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).last().click() // the swing day
  await page.getByRole('button', { name: /^View:/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /^Walkthrough/ })).toHaveCount(0)
})

test('an older server without entry and exit details still lists the legs and says what is missing', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.cyclesOld = true
  await openSessions(page)
  await rows(page).first().click()
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Walkthrough')
  await expect(overlay(page).getByRole('note').filter({ hasText: 'did not send the entry and exit details' })).toBeVisible()
  await expect(overlay(page).getByLabel('Entries')).toContainText('B 75')
})

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('the panel fits: no sideways scroll, finger-sized controls, the P&L story within reach', async ({ page }) => {
      await mockServer(page)
      await openWalkthrough(page)
      const side = overlay(page).locator('.tl-side-col')
      expect(await side.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      for (const name of ['Previous trade', 'Next trade']) expect((await overlay(page).getByRole('button', { name }).first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect((await overlay(page).getByRole('button', { name: 'More info on entry 1' }).boundingBox())!.height).toBeGreaterThanOrEqual(40)
      // The three P&L figures are the first thing under the navigation: at least their top edge is on screen.
      const story = (await overlay(page).getByLabel('Day P&L story').boundingBox())!
      expect(story.y).toBeLessThan(viewport.height - 40)
      await page.screenshot({ path: `test-results/walkthrough-${viewport.name}.png` })
    })
  })
}
