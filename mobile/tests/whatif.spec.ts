import { expect, test, type Page } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS, type MockServer } from './fixtures'

const rows = (page: Page) => page.locator('.session-row')
const overlay = (page: Page) => page.getByRole('dialog', { name: 'What if' })
const figure = (page: Page, name: string) => overlay(page).getByLabel(name, { exact: true })
const exitPrice = (page: Page) => overlay(page).getByLabel(/^Price of exit at /)
const exitQty = (page: Page) => overlay(page).getByLabel(/^Quantity of exit at /)

async function openWhatIf(page: Page, row = 0) {
  await openSessions(page)
  await rows(page).nth(row).click() // 0: NIFTY options, Paper, two round trips (buy 75 at 120, sell 75 at 141.33)
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'What If')
  await expect(overlay(page).getByText(/Trade 1 of \d/)).toBeVisible()
}
const saveAs = async (page: Page, name: string) => {
  await overlay(page).getByRole('button', { name: /^What-if:/ }).click()
  await overlay(page).getByLabel('What-if name').fill(name)
  await overlay(page).getByRole('button', { name: 'Save', exact: true }).click()
}

test('opens full screen with the chart, the day and the trade as actual against what-if, and the fills to edit', async ({ page }) => {
  await mockServer(page)
  await openWhatIf(page)
  expect(await overlay(page).boundingBox()).toMatchObject({ x: 0, y: 0 })
  await expect(overlay(page).locator('.phone-chart canvas').first()).toBeVisible()
  await expect(figure(page, 'Day: actual')).toContainText('+₹3,200.00')
  await expect(figure(page, 'Day: what-if')).toContainText('+₹3,200.00')
  await expect(figure(page, 'Day: difference')).toContainText('₹0.00')
  await expect(figure(page, 'This trade: actual')).toContainText('+₹1,600.00')
  await expect(exitPrice(page)).toHaveValue(/^141\.33/)
  await expect(exitQty(page)).toHaveValue('75')
  await expect(overlay(page).locator('.wi-summary')).toBeHidden() // nothing edited yet: the count line stays out of the way on a phone
})

test('changing the exit price moves the trade and the day; the other trade is unchanged', async ({ page }) => {
  await mockServer(page)
  await openWhatIf(page)
  await exitPrice(page).fill('130')
  // 75 units sold 11.33 lower: about 850 less, and the charges on a smaller sell are a little lower.
  const delta = await figure(page, 'This trade: difference').locator('strong').innerText()
  expect(delta.startsWith('−')).toBe(true)
  expect(Number(delta.replace(/[^0-9.]/g, ''))).toBeGreaterThan(700)
  expect(Number(delta.replace(/[^0-9.]/g, ''))).toBeLessThan(870)
  await expect(figure(page, 'Day: difference').locator('strong')).toHaveText(delta)
  await expect(overlay(page).getByRole('group', { name: 'What-if summary' })).toContainText('1 trade edited')
  await overlay(page).getByRole('button', { name: 'Next trade' }).click()
  await expect(figure(page, 'This trade: difference').locator('strong')).toContainText('₹0.00')
  await overlay(page).getByRole('button', { name: 'Previous trade' }).click()
  await expect(exitPrice(page)).toHaveValue('130')
  await overlay(page).getByRole('button', { name: /^Reset exit at / }).click()
  await expect(exitPrice(page)).toHaveValue(/^141\.33/)
})

test('a quantity that does not match warns; capital % shows the change', async ({ page }) => {
  await mockServer(page)
  await openWhatIf(page)
  await exitQty(page).fill('50')
  await expect(overlay(page).getByRole('alert').filter({ hasText: 'uneven' })).toContainText('75')
  await expect(overlay(page).getByRole('group', { name: 'What-if summary' })).toContainText('1 with a warning')
  await expect(overlay(page).locator('.wi-leg.changed').first()).toContainText('−') // capital change
})

test('tapping Pick, then the chart, sets the price from where it was tapped', async ({ page }) => {
  await mockServer(page)
  await openWhatIf(page)
  const before = Number(await exitPrice(page).inputValue())
  await overlay(page).getByRole('button', { name: /^Pick the price of exit at / }).click()
  await expect(overlay(page).getByText('Click the chart to set the exit price')).toBeVisible()
  const chart = overlay(page).locator('.analysis-kline').first()
  const box = (await chart.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35)
  await expect(overlay(page).getByText('Click the chart to set the exit price')).toHaveCount(0)
  const picked = Number(await exitPrice(page).inputValue())
  expect(picked).not.toBe(before)
  expect(picked).toBeGreaterThan(50) // inside the option series the mock draws (a tap near the top of the chart)
  expect(picked).toBeLessThan(400)
  await expect(overlay(page).locator('.wi-leg.changed')).toHaveCount(1)
})

test('Back cancels a pick first, then asks before dropping changes, then closes', async ({ page }) => {
  await mockServer(page)
  await openWhatIf(page)
  await overlay(page).getByRole('button', { name: /^Pick the price of exit at / }).click()
  await expect(overlay(page).getByText('Click the chart to set the exit price')).toBeVisible()
  await page.keyboard.press('Escape') // Android back: cancels the pick, the screen stays
  await expect(overlay(page).getByText('Click the chart to set the exit price')).toHaveCount(0)
  await expect(overlay(page)).toBeVisible()
  await exitPrice(page).fill('130')
  let asked = ''
  page.once('dialog', dialog => { asked = dialog.message(); void dialog.dismiss() })
  await overlay(page).getByRole('button', { name: 'Close labeling' }).click() // the ← button
  await expect.poll(() => asked).toContain('unsaved')
  await expect(overlay(page)).toBeVisible()
  page.once('dialog', dialog => void dialog.accept())
  await overlay(page).getByRole('button', { name: 'Close labeling' }).click()
  await expect(overlay(page)).toHaveCount(0)
})

test('save under a name, reopen: it is back; revert the day; delete it', async ({ page }) => {
  const server: MockServer = await mockServer(page)
  await openWhatIf(page)
  await exitPrice(page).fill('130')
  await expect(overlay(page).getByRole('button', { name: /^What-if: not saved · unsaved/ })).toBeVisible()
  await saveAs(page, 'Exit earlier')
  await expect(overlay(page).getByRole('status').filter({ hasText: 'Saved “Exit earlier”' })).toBeVisible()
  await expect.poll(() => server.analysis.whatIfSaved.length).toBe(1)
  expect(server.analysis.whatIfSaved[0]).toMatchObject({ session_id: 's-0911-a', name: 'Exit earlier', edits: [{ round_trip: 0, role: 'exit', price: 130, quantity: 75 }] })
  expect(server.analysis.whatIfSaved[0].summary).toMatchObject({ actual_pnl: 3200, trips_edited: 1 })

  // Close and open again: the saved what-if is shown by itself.
  await overlay(page).getByRole('button', { name: 'Close labeling' }).click()
  await expect(overlay(page)).toHaveCount(0)
  await chooseView(page, 'What If')
  await expect(overlay(page).getByText(/Trade 1 of \d/)).toBeVisible()
  await expect(exitPrice(page)).toHaveValue('130')
  await expect(overlay(page).getByRole('button', { name: /^What-if: Exit earlier/ })).toBeVisible()

  await overlay(page).getByRole('button', { name: /^What-if:/ }).click()
  await overlay(page).getByRole('button', { name: 'Revert day' }).click()
  await expect(exitPrice(page)).toHaveValue(/^141\.33/)
  expect(server.analysis.whatIfSaved).toHaveLength(1)
  await overlay(page).getByRole('combobox', { name: 'Saved what-ifs' }).selectOption('exit-earlier')
  await expect(exitPrice(page)).toHaveValue('130')
  page.once('dialog', dialog => void dialog.accept())
  await overlay(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(overlay(page).getByRole('status').filter({ hasText: 'Deleted' })).toBeVisible()
  expect(server.analysis.whatIfSaved).toHaveLength(0)
  expect(server.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET' && !r.path.endsWith('/whatif') && !r.path.startsWith('/api/desktop/v1/analysis/labels') && !r.path.startsWith('/api/auth/'))).toHaveLength(0)
})

test('Compare days lists saved what-ifs over a range with the total', async ({ page }) => {
  const server = await mockServer(page)
  const day = (id: string, date: string, actual: number, whatif: number) => ({ session_id: id, scenario_id: 'exit-at-close', name: 'Exit at close', date, symbol: 'NIFTY', session_type: 'paper', instrument_type: 'options', summary: { actual_pnl: actual, whatif_pnl: whatif, delta: whatif - actual, delta_pct: 0.1, trips_edited: 1, warnings: 0 }, edits: [], version: 1, updated_at: `${date}T10:00:00Z` })
  server.analysis.whatIfSaved = [day('x1', '2026-11-03', 100, 400), day('x2', '2026-11-04', -200, -50)]
  await openWhatIf(page, 1)
  await overlay(page).getByRole('button', { name: /^What-if:/ }).click()
  await overlay(page).getByRole('button', { name: 'Compare days' }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare days' })
  const table = dialog.getByRole('table', { name: 'What-if Exit at close' })
  await expect(table).toContainText('2 days')
  await expect(table.locator('tr.total')).toContainText('+₹450.00')
  await dialog.getByRole('button', { name: 'Close compare days' }).click()
  await expect(dialog).toHaveCount(0)
})

test('against a server without saved what-ifs the day can still be explored, and it says saving is not available', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.whatIfOld = true
  await openWhatIf(page)
  await exitPrice(page).fill('130')
  await expect(figure(page, 'Day: difference').locator('strong')).toContainText('−')
  await overlay(page).getByRole('button', { name: /^What-if:/ }).click()
  await expect(overlay(page).getByRole('status').filter({ hasText: 'Not Found' }).or(overlay(page).getByText('Unsaved changes.'))).toBeVisible()
})

const SESSION_TYPES: Array<[number, string]> = [[0, 'paper'], [1, 'real'], [2, 'replay'], [3, 'stepwise']]
for (const [row, type] of SESSION_TYPES) {
  test(`works on a ${type} day: an edited exit moves the trade and the day, and nothing is sent to a broker`, async ({ page }) => {
    const server = await mockServer(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openWhatIf(page, row)
    const actual = await figure(page, 'Day: actual').locator('strong').innerText()
    await expect(figure(page, 'Day: difference').locator('strong')).toContainText('₹0.00')
    const price = Number(await exitPrice(page).inputValue())
    await exitPrice(page).fill(String(Math.round(price * 0.9 * 100) / 100))
    const delta = await figure(page, 'This trade: difference').locator('strong').innerText()
    expect(delta).not.toContain('₹0.00')
    await expect(figure(page, 'Day: actual').locator('strong')).toHaveText(actual) // the actual figure does not move
    await expect(overlay(page).locator('.wi-leg.changed')).toHaveCount(1)
    await overlay(page).getByRole('button', { name: 'Reset this trade' }).click()
    await expect(figure(page, 'Day: difference').locator('strong')).toContainText('₹0.00')
    expect(server.requests.filter(r => r.method !== 'GET' && r.path.startsWith('/api/desktop/') && !r.path.includes('/auth/'))).toHaveLength(0)
    expect(errors).toEqual([])
  })
}

test('a day with two sessions saves each session\'s own edits and summary', async ({ page }) => {
  const server = await mockServer(page)
  await openWhatIf(page, 2) // NIFTY 7 Nov: two replay sessions, one round trip each
  await expect(overlay(page).getByText('Trade 1 of 2')).toBeVisible()
  await exitPrice(page).fill('130')
  await saveAs(page, 'Both sessions')
  await expect.poll(() => server.analysis.whatIfSaved.length).toBe(1) // only the session with an edit is written
  expect(server.analysis.whatIfSaved[0].session_id).toBe('s-0911-c1')
  await overlay(page).getByRole('button', { name: 'Next trade' }).click()
  await exitPrice(page).fill('130')
  await overlay(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => server.analysis.whatIfSaved.length).toBe(2)
  const [first, second] = server.analysis.whatIfSaved
  expect([first.session_id, second.session_id].sort()).toEqual(['s-0911-c1', 's-0911-c2'])
  for (const row of server.analysis.whatIfSaved) expect(row.summary.trips_edited).toBe(1) // each session counts only its own trade
  expect(first.summary.actual_pnl).not.toBe(second.summary.actual_pnl)
})

test('a trade the server sent no fills for cannot be edited and says so', async ({ page }) => {
  const server = await mockServer(page)
  server.analysis.cyclesOld = true
  await openWhatIf(page)
  await expect(overlay(page).getByRole('note').filter({ hasText: 'did not send the fills' })).toBeVisible()
  await expect(overlay(page).getByLabel(/^Price of /)).toHaveCount(0)
})

test('it is not offered for a swing portfolio', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).last().click()
  await page.getByRole('button', { name: /^View:/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /^What If/ })).toHaveCount(0)
})

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })
    test('the fill rows fit: price and quantity boxes are finger-sized and nothing scrolls sideways', async ({ page }) => {
      await mockServer(page)
      await openWhatIf(page)
      const side = overlay(page).locator('.tl-side-col')
      expect(await side.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      for (const input of [exitPrice(page), exitQty(page)]) {
        const box = (await input.boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(34)
        expect(box.width).toBeGreaterThanOrEqual(60)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      }
      const pick = (await overlay(page).getByRole('button', { name: /^Pick the price of exit at / }).boundingBox())!
      expect(pick.height).toBeGreaterThanOrEqual(40)
      const dayFigures = (await figure(page, 'Day').boundingBox())!
      expect(dayFigures.y).toBeLessThan(viewport.height - 40) // the day's actual and what-if are within reach
      await page.screenshot({ path: `test-results/whatif-${viewport.name}.png` })
    })
  })
}
