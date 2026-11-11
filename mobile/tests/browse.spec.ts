import { expect, test, type Page } from '@playwright/test'
import { LIVE_DAY, mockServer, signIn, VIEWPORTS, type MockServer } from './fixtures'

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main' })

/** Tuesday 10 Nov 2026, 11:05 in India: a trading day with the market open. */
const NOW = '2026-11-10T11:05:00+05:30'

async function openBrowse(page: Page, setup?: (state: MockServer) => void) {
  await page.clock.setFixedTime(new Date(NOW))
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
  expect(historical.query.get('trading_date')).toBe('2026-11-09') // the day before "today", never today
  await expect(page.getByRole('button', { name: 'Next day' })).toBeEnabled() // today can still be chosen
  await expect(page.getByRole('button', { name: 'Live' })).toHaveCount(0) // Live exists only on today
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
  // Stepping forward once more reaches today, the last selectable day.
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.getByRole('button', { name: 'Day: Tue 10 Nov' })).toBeVisible()
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
  // PE has its own strike: it starts nearest the money, not at the CE strike that was just moved up.
  const optionRequests = () => dataRequests(state).filter(r => r.path.endsWith('data/options-historical'))
  expect(optionRequests().at(-1)!.query.get('strike')).toBe(first.query.get('strike'))
  // Moving PE does not move CE, and going back to CE finds the strike chosen there.
  await page.getByRole('button', { name: /^Strike:/ }).click()
  const peTarget = String(Number(first.query.get('strike')) - 150)
  await page.getByRole('menu', { name: 'Strike' }).getByRole('menuitemradio', { name: peTarget, exact: true }).click()
  await expect.poll(() => optionRequests().at(-1)!.query.get('strike')).toBe(peTarget)
  // (An already loaded chart comes from the cache, so the proof is the strike shown.)
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await expect(page.getByRole('button', { name: `Strike: ${target}` })).toBeVisible()
  await page.getByRole('button', { name: 'PE', exact: true }).click()
  await expect(page.getByRole('button', { name: `Strike: ${peTarget}` })).toBeVisible()
})

/** Max price lives in the strike menu; while it is still searching (or failed) there is a pill for the cap instead. */
async function openMax(page: Page) {
  const pill = page.getByRole('button', { name: /^Max price: / })
  if (await pill.count()) await pill.click()
  else {
    await page.getByRole('button', { name: /^Strike:/ }).click()
    const item = page.getByRole('menuitem', { name: /^Max price/ })
    await expect(item).toBeInViewport() // pinned above the 43 strikes, not scrolled away with them
    await item.click()
  }
}
const maxRequests = (state: MockServer) => state.requests.filter(r => r.path === '/api/desktop/v1/trading/prepare-session')
const optionRequests = (state: MockServer) => dataRequests(state).filter(r => r.path.endsWith('data/options-historical'))

test('Max price finds the strike for each side from a premium cap, and looks it up again for another day', async ({ page }) => {
  const state = await openBrowse(page)
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Strike:/ })).toBeVisible()
  await openMax(page)
  const sheet = page.getByRole('dialog', { name: 'CE max price' })
  await expect(sheet.getByRole('group', { name: 'Premium cap presets' }).getByRole('button')).toHaveCount(6) // the NIFTY presets
  await expect(sheet.getByRole('button', { name: 'Use' })).toBeDisabled()
  await sheet.getByRole('button', { name: '₹50' }).click()
  await expect(sheet.getByLabel('Premium cap (₹)')).toHaveValue('50')
  await sheet.getByRole('button', { name: 'Use' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Strike:/ })).toContainText('≤₹50')
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('strike')).toBe('24600') // the mock's CE answer for 9 Nov
  const asked = maxRequests(state).at(-1)!
  expect(asked.authorization).toBe('Bearer access-token-1')
  expect(asked.body).toMatchObject({ mode: 'browse', reference_time: '09:30:00', panes: [{ kind: 'option', symbol: 'NIFTY', right: 'CE', selection_mode: 'max_price', max_price: 50, expiry: '2026-11-13' }] })
  // PE is independent: still manual, and its own cap finds its own strike.
  await page.getByRole('button', { name: 'PE', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Strike:/ })).not.toContainText('≤')
  await openMax(page)
  await page.getByRole('dialog', { name: 'PE max price' }).getByLabel('Premium cap (₹)').fill('75')
  await page.getByRole('dialog', { name: 'PE max price' }).getByRole('button', { name: 'Use' }).click()
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('right')).toBe('PE')
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('strike')).toBe('24200')
  expect(maxRequests(state).at(-1)!.body).toMatchObject({ panes: [{ right: 'PE', max_price: 75 }] })
  // Back on CE the cap is still 50; another day is searched again with that cap.
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Strike:/ })).toContainText('≤₹50')
  const before = maxRequests(state).length
  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect.poll(() => maxRequests(state).length).toBeGreaterThan(before)
  expect(maxRequests(state).at(-1)!.body).toMatchObject({ panes: [{ right: 'CE', max_price: 50 }] })
  expect((maxRequests(state).at(-1)!.body as { date: string }).date).toBe('2026-11-06')
})

test('Max price can go back to a manual strike', async ({ page }) => {
  const state = await openBrowse(page)
  await page.getByRole('button', { name: 'PE', exact: true }).click()
  await openMax(page)
  await page.getByRole('dialog', { name: 'PE max price' }).getByLabel('Premium cap (₹)').fill('30')
  await page.getByRole('dialog', { name: 'PE max price' }).getByRole('button', { name: 'Use' }).click()
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('strike')).toBe('24200')
  // Picking a strike from the menu leaves Max price.
  await page.getByRole('button', { name: /^Strike:/ }).click()
  await page.getByRole('menu', { name: 'Strike' }).getByRole('menuitemradio', { name: '24300', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Strike:/ })).not.toContainText('≤')
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('strike')).toBe('24300')
  const calls = maxRequests(state).length
  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect.poll(() => optionRequests(state).at(-1)!.query.get('strike')).toBe('24300')
  expect(maxRequests(state).length).toBe(calls) // manual mode asks nothing
})

test('Max price says why no strike was found and offers a manual strike', async ({ page }) => {
  const state = await openBrowse(page, s => { s.maxPriceFail = 'No observed premium at or below the cap within 30 strikes' })
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await openMax(page)
  await page.getByRole('dialog', { name: 'CE max price' }).getByLabel('Premium cap (₹)').fill('1')
  await page.getByRole('dialog', { name: 'CE max price' }).getByRole('button', { name: 'Use' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'No observed premium' })).toBeVisible()
  await expect(chart(page)).toHaveCount(0)
  state.maxPriceFail = undefined
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(chart(page)).toBeVisible()
  state.maxPriceFail = 'No observed premium at or below the cap within 30 strikes'
  await page.getByRole('button', { name: 'Previous day' }).click()
  await page.getByRole('button', { name: 'Manual strike' }).click()
  await expect(chart(page)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Strike:/ })).not.toContainText('≤')
})

test('an older server without session preparation says Max price is not available', async ({ page }) => {
  await openBrowse(page, s => { s.maxPriceOld = true })
  await page.getByRole('button', { name: 'CE', exact: true }).click()
  await openMax(page)
  await page.getByRole('dialog', { name: 'CE max price' }).getByLabel('Premium cap (₹)').fill('50')
  await page.getByRole('dialog', { name: 'CE max price' }).getByRole('button', { name: 'Use' }).click()
  await expect(page.getByText('Max price is not available on this server')).toBeVisible()
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

    test('with Max price on (its cap shown) and Live the control row still fits one row', async ({ page }) => {
      await openBrowse(page)
      await page.getByRole('button', { name: 'Next day' }).click()
      await page.getByRole('button', { name: 'PE', exact: true }).click()
      await openMax(page)
      await page.getByRole('dialog', { name: 'PE max price' }).getByLabel('Premium cap (₹)').fill('125.5')
      await page.getByRole('dialog', { name: 'PE max price' }).getByRole('button', { name: 'Use' }).click()
      await expect(page.getByRole('button', { name: /^Strike:/ })).toContainText('≤₹125.5')
      await page.getByRole('button', { name: /^Live/ }).click()
      await expect(chart(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      expect((await page.locator('.desktop-analysis-chart header').boundingBox())!.height).toBeLessThanOrEqual(48)
      for (const name of [/^Live/, /^Strike:/]) {
        const box = (await page.getByRole('button', { name }).first().boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(36)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      }
    })

    test('on today with Live and a strike the control row still fits one row', async ({ page }) => {
      await openBrowse(page)
      await page.getByRole('button', { name: 'Next day' }).click()
      await page.getByRole('button', { name: 'CE', exact: true }).click()
      await expect(page.getByRole('button', { name: /^Strike:/ })).toBeVisible()
      await page.getByRole('button', { name: /^Live/ }).click()
      await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
      await expect(chart(page)).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      const header = (await page.locator('.desktop-analysis-chart header').boundingBox())!
      expect(header.height).toBeLessThanOrEqual(48)
      for (const name of [/^Live/, /^Strike:/, 'CE']) {
        const box = (await page.getByRole('button', { name }).first().boundingBox())!
        expect(box.height).toBeGreaterThanOrEqual(36)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      }
    })
  })
}


test.describe('Live', () => {
  const liveButton = (page: Page) => page.getByRole('button', { name: /^Live/ })
  const goToday = async (page: Page) => { await page.getByRole('button', { name: 'Next day' }).click(); await expect(page.getByRole('button', { name: 'Day: Tue 10 Nov' })).toBeVisible() }

  test('the Live button exists only on today', async ({ page }) => {
    await openBrowse(page)
    await expect(chart(page)).toBeVisible()
    await expect(liveButton(page)).toHaveCount(0)
    await goToday(page)
    await expect(liveButton(page)).toBeVisible()
    await page.getByRole('button', { name: 'Previous day' }).click()
    await expect(liveButton(page)).toHaveCount(0)
  })

  test('Live starts a chart-only stream for the spot, with the Bearer token, and shows it as live', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect.poll(() => state.live.starts.length).toBe(1)
    expect(state.live.starts[0].tiles).toEqual([{ tile_id: 'browse', instrument: { kind: 'index', exchange: 'NSE', symbol: 'NIFTY' }, interval_minutes: 3 }])
    const start = state.requests.find(r => r.path === '/api/desktop/v1/live/start')!
    expect(start.authorization).toBe('Bearer access-token-1')
    await expect.poll(() => state.live.eventRequests.length).toBeGreaterThan(0)
    expect(state.requests.find(r => r.path.endsWith('/events'))!.authorization).toBe('Bearer access-token-1')
    expect(state.live.eventRequests[0].get('last_event_id')).toBe('1')
    await expect(page.getByRole('button', { name: 'Live: Live' })).toHaveAttribute('data-phase', 'live')
    await expect(chart(page)).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: /Connecting|Starting/ })).toHaveCount(0)
  })

  test('the live chart does not fetch the day itself: the server stream is the data', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await expect.poll(() => dataRequests(state).filter(r => r.path.endsWith('data/historical') && r.query.get('trading_date') === LIVE_DAY).length).toBeGreaterThan(0)
    const before = dataRequests(state).length
    await liveButton(page).click()
    await expect.poll(() => state.live.starts.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    expect(dataRequests(state).length).toBe(before)
  })

  test('turning Live off stops the stream on the server and returns to the stored chart', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    await liveButton(page).click()
    await expect.poll(() => state.live.stops).toEqual(['live-1'])
    await expect(chart(page)).toBeVisible()
    await expect(liveButton(page)).toHaveAttribute('aria-pressed', 'false')
  })

  test('a CE option streams as that contract: the day\'s expiry, the strike and the right', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await page.getByRole('button', { name: 'CE', exact: true }).click()
    await expect(page.getByRole('button', { name: /^Strike:/ })).toBeVisible()
    await liveButton(page).click()
    await expect.poll(() => state.live.starts.length).toBe(1)
    const instrument = state.live.starts[0].tiles[0].instrument
    expect(instrument).toMatchObject({ kind: 'option', exchange: 'NSE', underlying: 'NIFTY', expiry: '2026-11-13', right: 'CE' })
    expect(Number(instrument.strike) % 50).toBe(0)
  })

  test('changing the strike moves the stream to the new contract (the old one is stopped)', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await page.getByRole('button', { name: 'CE', exact: true }).click()
    await liveButton(page).click()
    await expect.poll(() => state.live.starts.length).toBe(1)
    const first = Number(state.live.starts[0].tiles[0].instrument.strike)
    await page.getByRole('button', { name: /^Strike:/ }).click()
    await page.getByRole('menu', { name: 'Strike' }).getByRole('menuitemradio', { name: String(first + 50), exact: true }).click()
    await expect.poll(() => state.live.starts.length).toBe(2)
    expect(state.live.stops).toContain('live-1')
    expect(Number(state.live.starts[1].tiles[0].instrument.strike)).toBe(first + 50)
  })

  test('a new candle interval reloads the stream tile at that interval without a new stream', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    await page.getByLabel('Candle interval').selectOption('5')
    await expect.poll(() => state.live.puts.length).toBe(1)
    expect(state.live.puts[0].tile.interval_minutes).toBe(5)
    expect(state.live.starts).toHaveLength(1)
    await expect(chart(page)).toBeVisible()
  })

  test('an older server without live says so and offers Try again', async ({ page }) => {
    const state = await openBrowse(page, s => { s.live.startStatus = 404 })
    await goToday(page)
    await liveButton(page).click()
    const note = page.locator('.live-status')
    await expect(note).toContainText('not available on this server')
    await expect(liveButton(page)).toHaveAttribute('data-phase', 'error')
    state.live.startStatus = undefined
    await note.getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => state.live.starts.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
  })

  test('leaving the app stops the stream and coming back starts it again', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    const hide = (hidden: boolean) => page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
    await hide(true)
    await expect.poll(() => state.live.stops).toContain('live-1')
    await expect(page.locator('.live-status')).toContainText('Paused')
    await hide(false)
    await expect.poll(() => state.live.starts.length).toBe(2)
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
  })

  test('leaving Browse stops the stream', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    await rail(page).getByRole('button', { name: 'Stats' }).click()
    await expect.poll(() => state.live.stops).toContain('live-1')
  })

  test('Live is read-only: nothing but the live stream routes is written', async ({ page }) => {
    const state = await openBrowse(page)
    await goToday(page)
    await liveButton(page).click()
    await expect(page.getByRole('button', { name: 'Live: Live' })).toBeVisible()
    const writes = state.requests.filter(r => r.path.startsWith('/api/desktop/') && r.method !== 'GET').map(r => `${r.method} ${r.path.replace(/live-\d+/, 'live-N')}`)
    expect(new Set(writes)).toEqual(new Set(['POST /api/desktop/v1/live/start']))
  })
})
