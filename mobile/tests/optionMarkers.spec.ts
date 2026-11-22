import { expect, test, type Page } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS } from './fixtures'

/** Markers on the option chart carry no text on the phone (the colour says buy or sell; one trade at a time): Label Trades, Walkthrough, What If. */
async function openOptionChart(page: Page, view: string, dialog: string) {
  await openSessions(page)
  await page.locator('.session-row').first().click() // NIFTY options, Paper
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, view)
  const overlay = page.getByRole('dialog', { name: dialog })
  await expect(overlay.getByText(/Trade 1 of \d/)).toBeVisible()
  await overlay.getByRole('button', { name: 'Option', exact: true }).click()
  return overlay
}

for (const [view, dialog] of [['Label trades', 'Label trades'], ['Walkthrough', 'Trade walkthrough'], ['What If', 'What if']] as const) {
  test(`${view}: the option chart's markers have no text`, async ({ page }) => {
    await mockServer(page)
    const overlay = await openOptionChart(page, view, dialog)
    await expect(overlay.locator('.desktop-analysis-chart[data-contract-labels]')).toHaveAttribute('data-contract-labels', 'off')
  })
}

test.describe('every size', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: What If keeps Entries and Exits apart and nothing scrolls sideways`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await mockServer(page)
      const overlay = await openOptionChart(page, 'What If', 'What if')
      const exits = overlay.getByRole('region', { name: 'Exits' })
      await overlay.getByRole('region', { name: 'Entries' }).scrollIntoViewIfNeeded()
      await page.evaluate(() => document.querySelector('.tl-side-col')?.scrollBy(0, 150))
      await page.screenshot({ path: `test-results/whatif-blocks-${viewport.name}.png` })
      await exits.scrollIntoViewIfNeeded()
      await expect(exits.locator('h4')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      const box = (await overlay.locator('.tl-side-col').boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    })
  }
})
