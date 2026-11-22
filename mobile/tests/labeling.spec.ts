import { expect, test, type Page } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS } from './fixtures'

const rows = (page: Page) => page.locator('.session-row')
const overlay = (page: Page) => page.getByRole('dialog', { name: 'Label trades' })

async function openLabeling(page: Page) {
  await openSessions(page)
  await rows(page).first().click() // NIFTY options, Paper: two round trips
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Label trades')
  await expect(overlay(page).getByText('Trade 1 of 2')).toBeVisible()
}

test('Label trades opens full screen with the trade, its chart and the form', async ({ page }) => {
  await mockServer(page)
  await openLabeling(page)
  const box = await overlay(page).boundingBox()
  expect(box).toMatchObject({ x: 0, y: 0 })
  expect(box!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1)
  await expect(overlay(page)).toContainText('RT#0 — CE 24500')
  await expect(overlay(page)).toContainText('B 75@120.00')
  await expect(overlay(page).getByLabel('Entry Tag')).toBeVisible()
  await expect(overlay(page).getByLabel('Exit Tag')).toBeVisible()
  await expect(overlay(page).locator('.phone-chart canvas').first()).toBeVisible()
  await expect(overlay(page).getByRole('button', { name: 'Close labeling' })).toBeVisible()
})

test('typing a tag saves it by itself, and the status says so', async ({ page }) => {
  const server = await mockServer(page)
  await openLabeling(page)
  await overlay(page).getByLabel('Entry Tag').fill('BREAKOUT')
  await expect.poll(() => server.analysis.labelPosts.length).toBeGreaterThan(0)
  const posted = server.analysis.labelPosts.at(-1)!.labels[0]
  expect(posted).toMatchObject({ session_id: 's-0911-a', round_trip_index: 0, entry_tag: 'BREAKOUT' })
  await expect(overlay(page).getByText('Saved ✓')).toBeVisible()
})

test('choosing a pattern category and strategy is saved', async ({ page }) => {
  const server = await mockServer(page)
  await openLabeling(page)
  const expected = overlay(page).locator('.tl-field').filter({ hasText: 'Expected Pattern' })
  await expected.locator('select').nth(0).selectOption('Breakout')
  await expected.locator('select').nth(1).selectOption('Opening Range')
  await expect.poll(() => server.analysis.labelPosts.at(-1)?.labels[0]).toMatchObject({ expected_category: 'Breakout', expected_strategy: 'Opening Range' })
})

test('Next and Prev move between trades and save first; the chips jump', async ({ page }) => {
  const server = await mockServer(page)
  await openLabeling(page)
  await expect(overlay(page).getByRole('button', { name: 'Previous trade' })).toBeDisabled()
  await overlay(page).getByLabel('Entry Tag').fill('FIRST')
  await overlay(page).getByRole('button', { name: 'Next trade' }).click()
  await expect(overlay(page).getByText('Trade 2 of 2')).toBeVisible()
  expect(server.analysis.labelPosts.some(post => post.labels.some(label => label.entry_tag === 'FIRST'))).toBe(true) // saved before moving
  await expect(overlay(page)).toContainText('RT#1')
  await expect(overlay(page).getByRole('button', { name: 'Next trade' })).toBeDisabled()
  await overlay(page).getByRole('group', { name: 'Round trips' }).getByRole('button', { name: '1', exact: true }).click()
  await expect(overlay(page).getByText('Trade 1 of 2')).toBeVisible()
  await expect(overlay(page).getByLabel('Entry Tag')).toHaveValue('FIRST')
})

test('behavior questions are yes/no switches that save on their own', async ({ page }) => {
  const server = await mockServer(page)
  await openLabeling(page)
  const chased = overlay(page).getByRole('switch', { name: /Chased the entry/ })
  await expect(chased).toHaveAttribute('aria-checked', 'false')
  await chased.click()
  await expect(chased).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => server.analysis.markPosts.at(-1)).toMatchObject({ session_id: 's-0911-a', round_trip_index: 0, answers: { 'q-entry-1': true } })
  await overlay(page).getByRole('switch', { name: /Exited too early/ }).click()
  await expect.poll(() => server.analysis.markPosts.at(-1)?.answers).toEqual({ 'q-exit-1': true })
})

test('closing returns to the session and the menu shows how many trades are labeled', async ({ page }) => {
  await mockServer(page)
  await openLabeling(page)
  const expected = overlay(page).locator('.tl-field').filter({ hasText: 'Expected Pattern' })
  await expected.locator('select').nth(0).selectOption('Breakout')
  await expect(overlay(page).getByText('Saved ✓')).toBeVisible()
  await overlay(page).getByRole('button', { name: 'Close labeling' }).click()
  await expect(overlay(page)).toHaveCount(0)
  await page.getByRole('button', { name: /^View:/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Label trades/ })).toContainText('1/2')
})

test('Back while a label is still saving waits for the save, then closes', async ({ page }) => {
  const server = await mockServer(page)
  await openLabeling(page)
  await overlay(page).getByLabel('Entry Tag').fill('LAST_SECOND')
  await page.keyboard.press('Escape') // Android back, right after typing
  await expect(overlay(page)).toHaveCount(0)
  expect(server.analysis.labelPosts.some(post => post.labels.some(label => label.entry_tag === 'LAST_SECOND'))).toBe(true)
})

test('a failed save shows the error and Retry saves it', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.labelSave = 'fail-once'
  await openLabeling(page)
  await overlay(page).getByLabel('Entry Tag').fill('RETRY_ME')
  await expect(overlay(page).getByRole('alert')).toBeVisible()
  await overlay(page).getByRole('button', { name: 'Retry save' }).click()
  await expect(overlay(page).getByText('Saved ✓')).toBeVisible()
  expect(server.analysis.labelPosts.some(post => post.labels.some(label => label.entry_tag === 'RETRY_ME'))).toBe(true)
})

test('labels that cannot be loaded offer Retry', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.labelsLoad = 'fail'
  await openSessions(page)
  await rows(page).first().click()
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Label trades')
  await expect(overlay(page).getByRole('alert')).toBeVisible()
  server.analysis.labelsLoad = undefined
  await overlay(page).getByRole('button', { name: 'Retry labels' }).click()
  await expect(overlay(page).getByText('Trade 1 of 2')).toBeVisible()
})

test('a swing day has no Label trades item', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).filter({ hasText: 'Swing' }).click()
  await page.getByRole('button', { name: /^View:/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Label trades/ })).toHaveCount(0)
})

for (const viewport of VIEWPORTS) {
  test.describe(`landscape ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('chart on the left, form on the right, nothing scrolls the page, controls are finger-sized', async ({ page }) => {
      await mockServer(page)
      await openLabeling(page)
      await expect(overlay(page).locator('.phone-chart canvas').first()).toBeVisible()
      const chart = await overlay(page).locator('.tl-chart-col').boundingBox()
      const form = await overlay(page).locator('.tl-side-col').boundingBox()
      expect(chart!.x).toBeLessThan(form!.x)
      expect(chart!.width).toBeGreaterThanOrEqual(viewport.width * 0.5)
      expect(form!.width).toBeGreaterThanOrEqual(300)
      expect(chart!.height).toBeGreaterThanOrEqual(viewport.height - 2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true)
      for (const name of ['Previous trade', 'Next trade']) expect((await overlay(page).getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect((await overlay(page).getByRole('switch').first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
      // Save status is always in view, even though the form scrolls.
      const status = await overlay(page).locator('.tl-status').boundingBox()
      expect(status!.y + status!.height).toBeLessThanOrEqual(viewport.height + 1)
      await page.screenshot({ path: `test-results/labeling-${viewport.name}.png` })
      await overlay(page).locator('.tl-side-col').evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.screenshot({ path: `test-results/labeling-scrolled-${viewport.name}.png` })
    })
  })
}

test('with the keyboard up (a very short screen) the form gets all of the height', async ({ page }) => {
  await mockServer(page)
  await openLabeling(page)
  await page.setViewportSize({ width: 851, height: 190 }) // what the viewport becomes when the keyboard opens
  await expect(overlay(page).locator('.tl-chart-col')).toBeHidden()
  const entry = overlay(page).getByLabel('Entry Tag')
  await entry.scrollIntoViewIfNeeded()
  await entry.fill('TYPING')
  const box = await entry.boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(190)
  await expect(overlay(page).getByRole('button', { name: 'Next trade' })).toBeVisible()
  await page.setViewportSize({ width: 851, height: 393 }) // keyboard closed again
  await expect(overlay(page).locator('.tl-chart-col')).toBeVisible()
  await expect(overlay(page).getByLabel('Entry Tag')).toHaveValue('TYPING')
})
