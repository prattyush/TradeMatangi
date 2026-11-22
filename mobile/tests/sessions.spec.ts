import { expect, test, type Page } from '@playwright/test'
import { chooseView, mockServer, openSessions, VIEWPORTS } from './fixtures'

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

test('selecting a day shows its chart; Trades, Orders and Videos open from the view menu', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await expect(page.getByText('Pick a session')).toBeVisible()
  await rows(page).first().click()
  await expect(page.getByRole('button', { name: 'View: Chart' })).toBeVisible()
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
  await chooseView(page, 'Trades')
  const table = page.locator('.trades-table')
  await expect(table).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(4)
  await expect(table.locator('tbody tr').first()).toContainText('10:05:00')
  await expect(table.locator('tbody tr').first()).toContainText('BUY')
  await expect(table.locator('tbody tr').first()).toContainText('24500 CE')
  await expect(page.getByRole('button', { name: 'View: Trades' })).toBeVisible()
  await chooseView(page, 'Orders')
  await expect(page.getByText('No stored orders for this session.')).toBeVisible()
  await chooseView(page, 'Videos')
  await expect(page.getByRole('button', { name: 'View: Videos' })).toBeVisible()
  await chooseView(page, 'Chart')
  await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
})

test('a day with two sessions splits its trades by session', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).filter({ hasText: '2 sessions' }).click()
  await chooseView(page, 'Trades')
  await expect(page.getByText(/^Session 1/)).toBeVisible()
  await expect(page.getByText(/^Session 2/)).toBeVisible()
})

test('a swing day offers Trades and Videos only', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  await rows(page).filter({ hasText: 'Swing' }).click()
  await expect(page.getByRole('button', { name: 'View: Trades' })).toBeVisible()
  await page.getByRole('button', { name: /^View:/ }).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(2)
  await expect(page.getByRole('menuitemradio', { name: 'Videos' })).toBeVisible()
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
      // The controls share one 44 px row that is part of the chart header; they are 36 px tall (rows and the rail stay 44+).
      for (const control of await page.locator('.phone-chart header button, .phone-chart header select').all()) {
        if (await control.isVisible()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(36)
      }
      const chart = await page.locator('.phone-chart .analysis-kline').first().boundingBox()
      expect(chart!.height).toBeGreaterThanOrEqual(viewport.height - 44 - 60) // everything below the one control row is candles
      expect(chart!.width).toBeGreaterThanOrEqual(viewport.width - 56 - 70)
      const header = await page.locator('.phone-chart header').boundingBox()
      expect(header!.height).toBeLessThanOrEqual(46)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true)
      await page.screenshot({ path: `test-results/sessions-chart-${viewport.name}.png` })
      await page.getByRole('button', { name: 'Option' }).click()
      await page.screenshot({ path: `test-results/sessions-option-${viewport.name}.png` })
      await chooseView(page, 'Trades')
      await page.screenshot({ path: `test-results/sessions-trades-${viewport.name}.png` })
      await page.getByRole('button', { name: 'Show days' }).click()
      await page.getByRole('button', { name: /^Filters/ }).click()
      await page.screenshot({ path: `test-results/sessions-filters-${viewport.name}.png` })
    })
  })
}


test.describe('days list', () => {
  test('choosing a day hides the list; Days brings it back; choosing another hides it again', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await expect(page.locator('.session-pane')).toBeHidden()
    const detail = await page.locator('.detail-pane').boundingBox()
    expect(detail!.width).toBeGreaterThan(600) // the chart gets the width the list used to take
    await page.getByRole('button', { name: 'Show days' }).click()
    await expect(page.locator('.session-pane')).toBeVisible()
    await expect(rows(page).first()).toHaveAttribute('aria-current', 'true')
    await rows(page).nth(1).click()
    await expect(page.locator('.session-pane')).toBeHidden()
    await expect(page.getByRole('region', { name: 'TATPOW 2026-11-09' })).toBeVisible()
  })

  test('tapping Sessions again toggles the list', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await expect(page.locator('.session-pane')).toBeHidden()
    const rail = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sessions' })
    await rail.click()
    await expect(page.locator('.session-pane')).toBeVisible()
    await rail.click()
    await expect(page.locator('.session-pane')).toBeHidden()
  })

  test('with no day chosen the list stays; tapping Sessions does nothing', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sessions' }).click()
    await expect(page.locator('.session-pane')).toBeVisible()
  })

  test('the back key shows the list before it leaves Sessions', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await expect(page.locator('.session-pane')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-pane')).toBeVisible()
  })

  test('coming back from another tab finds the same day, with the list still hidden', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).nth(1).click()
    await expect(page.getByRole('region', { name: 'TATPOW 2026-11-09' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Browse' }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sessions' }).click()
    await expect(page.getByRole('region', { name: 'TATPOW 2026-11-09' })).toBeVisible()
    await expect(page.locator('.session-pane')).toBeHidden()
  })
})

test.describe('maximized chart', () => {
  test.use({ viewport: { width: 851, height: 393 } })

  test('shows one chart that fills the screen, and the back key restores it', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
    await page.getByRole('button', { name: 'Maximize chart' }).click()
    const maximized = page.locator('.phone-chart.maximized')
    await expect(maximized).toBeVisible()
    await expect(maximized.locator('.desktop-analysis-chart')).toHaveCount(1)
    await expect(maximized.getByRole('button', { name: 'Restore chart' })).toHaveCount(1)
    // Days and the view menu are not offered over a maximized chart; Underlying / Option stay.
    await expect(maximized.getByRole('button', { name: /^View:/ })).toHaveCount(0)
    await expect(maximized.getByRole('button', { name: 'Option' })).toBeVisible()
    const box = await maximized.boundingBox()
    expect(box).toMatchObject({ x: 0, y: 0, width: 851, height: 393 })
    await expect.poll(async () => (await maximized.locator('.analysis-kline').boundingBox())!.height, { timeout: 5000 }).toBeGreaterThanOrEqual(393 - 44 - 50)
    await page.screenshot({ path: 'test-results/sessions-maximized.png' })
    await page.keyboard.press('Escape') // Android back
    await expect(page.locator('.phone-chart.maximized')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Maximize chart' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^View:/ })).toBeVisible()
  })

  test('the Restore button also works, and Option stays selected while maximized', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await page.getByRole('button', { name: 'Option' }).click()
    await page.getByRole('button', { name: 'Maximize chart' }).click()
    await expect(page.locator('.phone-chart.maximized .contract-pill, .phone-chart.maximized .menu-button')).toBeVisible()
    await page.getByRole('button', { name: 'Restore chart' }).click()
    await expect(page.locator('.phone-chart.maximized')).toHaveCount(0)
  })
})

test.describe('chart controls', () => {
  test('Underlying, Option, the view menu and the chart controls share one row', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
    const tops = async () => Promise.all([
      page.getByRole('button', { name: /^View:/ }),
      page.getByRole('button', { name: 'Underlying' }),
      page.getByRole('button', { name: 'Option', exact: true }),
      page.getByRole('button', { name: 'Fit chart' }),
    ].map(async locator => (await locator.boundingBox())!.y))
    const ys = await tops()
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(8)
  })

  test('choosing Option shows the strikes in a menu over the chart, without taking a row', async ({ page }) => {
    const server = await mockServer(page)
    await openSessions(page)
    await rows(page).first().click() // this day has two option contracts: 24500 CE and 24600 CE
    await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /^Option contract/ })).toHaveCount(0)
    const before = await page.locator('.phone-chart .analysis-kline').boundingBox()
    await page.getByRole('button', { name: 'Option', exact: true }).click()
    const strike = page.getByRole('button', { name: 'Option contract: CE 24500' })
    await expect(strike).toBeVisible()
    await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
    const after = await page.locator('.phone-chart .analysis-kline').boundingBox()
    expect(after!.height).toBe(before!.height) // the strike control lives in the same row
    await strike.click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(2)
    await page.getByRole('menuitemradio', { name: /CE 24600/ }).click()
    await expect(page.getByRole('button', { name: 'Option contract: CE 24600' })).toBeVisible()
    await expect.poll(() => server.requests.some(r => r.path.endsWith('data/options-historical') && r.query.get('strike') === '24600')).toBe(true)
    await page.getByRole('button', { name: 'Underlying', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Option contract/ })).toHaveCount(0)
  })

  test('a day with a single contract shows it as a label, not a menu', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).filter({ hasText: 'Stepwise' }).click()
    await page.getByRole('button', { name: 'Option', exact: true }).click()
    await expect(page.locator('.contract-pill')).toHaveText('CE 24300')
  })

  test('an equity day has no Underlying / Option toggle', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).filter({ hasText: 'TATPOW' }).click()
    await expect(page.locator('.phone-chart canvas').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Option', exact: true })).toHaveCount(0)
  })

  test('the back key closes an open strike menu before anything else', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await page.getByRole('button', { name: 'Option', exact: true }).click()
    await page.getByRole('button', { name: /^Option contract/ }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.locator('.session-pane')).toBeHidden() // still on the same day
  })
})

test('chart details can be chosen in More and are remembered', async ({ page }) => {
  await mockServer(page)
  await openSessions(page)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('button', { name: 'More' }).click()
  const group = page.getByRole('group', { name: 'Chart details' })
  await expect(group.getByRole('button', { name: 'While touching' })).toHaveAttribute('aria-pressed', 'true') // the default
  await group.getByRole('button', { name: 'Never' }).click()
  await expect(group.getByRole('button', { name: 'Never' })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => localStorage.getItem('tm.chart_info'))).toBe('none')
  await nav.getByRole('button', { name: 'Sessions' }).click()
  await nav.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('group', { name: 'Chart details' }).getByRole('button', { name: 'Never' })).toHaveAttribute('aria-pressed', 'true')
})

test.describe('execution details and day journey', () => {
  test('tapping a trade opens its execution details; Back closes them', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await chooseView(page, 'Trades')
    await page.getByRole('button', { name: 'Inspect BUY 75 at 120.00' }).first().click()
    const inspector = page.getByRole('dialog', { name: 'Execution inspector' })
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText('BUY 75 @ 120')
    await expect(inspector).toContainText('CE 24500')
    const box = await inspector.boundingBox()
    expect(box!.y).toBeLessThanOrEqual(page.viewportSize()!.height) // inside the pane
    await page.screenshot({ path: 'test-results/sessions-inspector.png' })
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)
    await expect(page.locator('.trades-table')).toBeVisible()
  })

  test('Open cycle in the execution details opens that trade in Stats', async ({ page }) => {
    const state = await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await chooseView(page, 'Trades')
    await page.getByRole('button', { name: 'Inspect BUY 75 at 120.00' }).first().click()
    await page.getByRole('dialog', { name: 'Execution inspector' }).getByRole('button', { name: 'Open cycle' }).first().click()
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-current', 'page')
    const drawer = page.getByRole('dialog', { name: 'Trade cycle details' })
    await expect(drawer).toBeVisible()
    expect(state.requests.some(r => r.path.startsWith('/api/desktop/v1/analysis/performance/cycles/'))).toBe(true)
    // Shown once: leaving Stats and coming back does not reopen it.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sessions' }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Stats' }).click()
    await expect(page.getByRole('dialog', { name: 'Trade cycle details' })).toHaveCount(0)
  })

  test('the Day journey view draws the cumulative P&L of the day', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await chooseView(page, 'Day journey')
    const chart = page.getByRole('region', { name: 'Day P&L journey' })
    await expect(chart).toBeVisible()
    await expect(chart.locator('svg circle')).toHaveCount(2) // the two closed round trips of this day
    await expect(chart).toContainText('2 completed trades')
    await page.screenshot({ path: 'test-results/sessions-journey.png' })
  })

  test('a swing day has no Day journey', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).filter({ hasText: 'Swing' }).click()
    await page.getByRole('button', { name: /^View:/ }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Day journey' })).toHaveCount(0)
  })
})

test.describe('Compare', () => {
  const compare = (page: Page) => page.getByRole('dialog', { name: 'Pattern comparison' })

  test('opens from the view menu: trades on one side, the saved pattern annotations on the other', async ({ page }) => {
    const state = await mockServer(page)
    state.analysis.patterns = true
    await openSessions(page)
    await rows(page).first().click()
    await page.getByRole('button', { name: /^View:/ }).click()
    await page.getByRole('menuitemradio', { name: /^Compare/ }).click()
    const dialog = compare(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Pattern vs Trade')
    await expect(dialog.locator('.comparison-trades-pane .desktop-analysis-chart')).toBeVisible()
    await expect(dialog.locator('.comparison-pattern-pane .desktop-analysis-chart')).toBeVisible()
    expect(state.analysis.patternRequests.length).toBeGreaterThan(0)
    const box = (await dialog.boundingBox())!
    expect(box.y).toBe(0)
    expect(box.height).toBe(page.viewportSize()!.height)
    await page.screenshot({ path: 'test-results/sessions-compare.png' })
    await page.keyboard.press('Escape') // Android back
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^View:/ })).toBeVisible()
  })

  test('Close returns to the session; a day without saved patterns still opens', async ({ page }) => {
    await mockServer(page)
    await openSessions(page)
    await rows(page).first().click()
    await page.getByRole('button', { name: /^View:/ }).click()
    await page.getByRole('menuitemradio', { name: /^Compare/ }).click()
    await expect(compare(page)).toBeVisible()
    await expect(compare(page)).toContainText('Pattern vs Trade')
    await compare(page).getByRole('button', { name: /Close/ }).click()
    await expect(compare(page)).toHaveCount(0)
  })

  test('the header fits one row and the controls are tappable', async ({ page }) => {
    const state = await mockServer(page)
    state.analysis.patterns = true
    await openSessions(page)
    await rows(page).first().click()
    await page.getByRole('button', { name: /^View:/ }).click()
    await page.getByRole('menuitemradio', { name: /^Compare/ }).click()
    const head = (await compare(page).locator('.analysis-comparison-head').boundingBox())!
    expect(head.height).toBeLessThanOrEqual(56)
    const close = (await compare(page).getByRole('button', { name: /Close/ }).boundingBox())!
    expect(close.height).toBeGreaterThanOrEqual(40)
    expect(close.x + close.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    for (const select of await compare(page).locator('.analysis-comparison-head select').all()) expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  })
})
