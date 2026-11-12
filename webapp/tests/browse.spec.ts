import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace } from './workspaceFixture'

const app = 'http://127.0.0.1:5174/webapp/'
const start = 1791447300
const bars = (count = 120, from = start) => Array.from({ length: count }, (_, i) => ({ time: from + i * 180, open: 100 + i / 4, high: 102 + i / 4, low: 99 + i / 4, close: 101 + i / 4, volume: 100 }))

interface Seen { path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: unknown }

/** The Browse routes, recorded: history, option metadata, the paged scroll-back route and the max price search. */
async function mockBrowse(page: Page, renderer: 'lightweight' | 'kline' = 'lightweight') {
  await mockWorkspace(page)
  // Browse follows the Trading Chart setting (Settings): the same renderer the trading screen would use.
  await page.route('**/api/users/settings', route => route.fulfill({ json: { website_chart_renderer: renderer } }))
  await page.addInitScript(value => localStorage.setItem('website-chart-renderer::alice', value), renderer)
  const seen: Seen[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url()), path = url.pathname
    const record = () => { let body: unknown; try { body = request.postDataJSON() } catch { body = undefined } seen.push({ path, query: url.searchParams, method: request.method(), headers: request.headers(), body }) }
    if (path.endsWith('/data/historical') || path.endsWith('/data/pre-session') || path.endsWith('/data/options-historical') || path.endsWith('/browse/history') || path.endsWith('/option-metadata') || path.endsWith('/prepare-session')) record()
    if (path.endsWith('/data/historical')) return route.fulfill({ json: { symbol: url.searchParams.get('symbol'), dates: ['2026-10-07'], candles: bars() } })
    if (path.endsWith('/data/pre-session')) return route.fulfill({ json: { symbol: url.searchParams.get('symbol'), date: url.searchParams.get('trading_date'), start_time: url.searchParams.get('start_time'), candles: bars(40, start + 120 * 180) } })
    if (path.endsWith('/data/options-historical')) return route.fulfill({ json: { symbol: 'x', dates: ['2026-10-08'], candles: bars(100).map(c => ({ ...c, open: 40 + (c.open - 100) / 5, high: 42 + (c.high - 100) / 5, low: 39 + (c.low - 100) / 5, close: 41 + (c.close - 100) / 5 })) } })
    if (path.endsWith('/browse/history')) return route.fulfill({ json: { candles: bars(60, start - 60 * 180), more: true, before: start - 60 * 180, oldest_date: '2026-10-05', interval: 3, provider: 'kite', partial: false, stale: false } })
    if (path.endsWith('/option-metadata')) return route.fulfill({ json: { version: 1, symbol: url.searchParams.get('symbol'), as_of_date: url.searchParams.get('as_of_date'), expiries: ['2026-10-13'], strike_interval: 50, available: true, unavailable_reason: null } })
    if (path.endsWith('/prepare-session')) return route.fulfill({ json: { version: 1, date: '2026-10-08', reference_time: '09:30:00', panes: [{ pane: { strike: '24650' }, availability: 'available', reason: null, premium: 48.5 }] } })
    return route.fallback()
  })
  return seen
}
const pane = (page: Page, index: number) => page.locator('[data-pane]').nth(index)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** Choose a day in the pane menu's calendar: open it, move month by month to the right month, click the day. */
async function pickDay(page: Page, iso: string) {
  const menu = page.getByRole('dialog', { name: 'Pane settings' })
  await menu.getByRole('button', { name: 'Choose a day' }).click()
  const calendar = menu.getByRole('group', { name: 'Choose a day' })
  const [year, month, day] = iso.split('-').map(Number)
  const wanted = `${MONTHS[month - 1]} ${year}`
  for (let step = 0; step < 36 && (await calendar.locator('strong').innerText()) !== wanted; step++) {
    const shown = (await calendar.locator('strong').innerText()).split(' ')
    const behind = Number(shown[1]) * 12 + MONTHS.indexOf(shown[0]) > year * 12 + month - 1
    await calendar.getByRole('button', { name: behind ? 'Previous month' : 'Next month' }).click()
  }
  await calendar.getByRole('button', { name: new RegExp(`\\b${day} ${MONTHS[month - 1]} ${year}$`) }).click()
}
const history = (seen: Seen[]) => seen.filter(item => item.path.endsWith('/data/historical'))

test('the header Browse button goes to Trading and back, and the layout choice lives in that same header row', async ({ page }) => {
  await mockBrowse(page)
  await page.goto(app)
  const header = page.locator('.website-header')
  await expect(header.getByLabel('Browse layout')).toBeVisible()
  await header.getByRole('button', { name: '← Trading' }).click()
  await expect(page.getByRole('region', { name: 'Browse' })).toHaveCount(0)
  await expect(header.getByLabel('Browse layout')).toHaveCount(0)
  await header.getByRole('button', { name: /Browse/ }).click()
  await expect(page.getByRole('region', { name: 'Browse' })).toBeVisible()
  // The Browse area starts right under the header: no row of its own.
  const headerBox = (await header.boundingBox())!
  const region = (await page.getByRole('region', { name: 'Browse' }).boundingBox())!
  expect(Math.abs(region.y - (headerBox.y + headerBox.height))).toBeLessThanOrEqual(1)
})

test('the layouts are the website\'s: 1, 2, 3, 4, 5 equal, 5 wide right, 4 as 1+3', async ({ page }) => {
  await mockBrowse(page)
  await page.goto(app)
  const select = page.getByLabel('Browse layout')
  await expect(select.locator('option')).toHaveText(['1 pane', '2 panes', '3 panes', '4 panes', '5 equal', '5 wide right', '4 (1 + 3)'])
  const counts: Record<string, number> = { '1 pane': 1, '2 panes': 2, '3 panes': 3, '4 panes': 4, '5 equal': 5, '5 wide right': 5, '4 (1 + 3)': 4 }
  for (const [label, count] of Object.entries(counts)) {
    await select.selectOption({ label })
    await expect(page.locator('[data-pane]')).toHaveCount(count)
  }
  // 4 as 1 + 3: the first pane spans the width, three share the row below.
  await select.selectOption({ label: '4 (1 + 3)' })
  const widths = await Promise.all([0, 1, 2, 3].map(async i => (await pane(page, i).boundingBox())!))
  expect(widths[0].width).toBeGreaterThan(widths[1].width * 2.5)
  expect(Math.abs(widths[1].width - widths[2].width)).toBeLessThan(3)
  expect(widths[1].y).toBeGreaterThan(widths[0].y + widths[0].height - 2)
  // 5 wide right: the second and third panes are half as wide as the first.
  await select.selectOption({ label: '5 wide right' })
  const top = await Promise.all([0, 1, 2].map(async i => (await pane(page, i).boundingBox())!))
  expect(top[0].width / top[1].width).toBeGreaterThan(1.8)
  expect(Math.abs(top[1].width - top[2].width)).toBeLessThan(3)
})


// Browse uses the Trading Chart setting: Lightweight when that is Lightweight, KLine when it is KLine. The same scenarios on both.
for (const renderer of ['lightweight', 'kline'] as const) {
  test.describe(`Browse on the ${renderer} chart`, () => {
    test('opens with the setting\'s own chart renderer in every pane', async ({ page }) => {
      await mockBrowse(page, renderer)
      await page.goto(app)
      await expect(page.getByRole('region', { name: 'Browse' })).toBeVisible()
      await expect(page.locator('[data-pane]')).toHaveCount(2)
      await expect(page.locator('[data-pane] canvas').first()).toBeVisible()
      // KLine panes are the website's KLine host (`.website-kline`); Lightweight panes are not.
      await expect(page.locator('[data-pane] .website-kline')).toHaveCount(renderer === 'kline' ? 2 : 0)
    })

  test('Browse is where the website opens, two panes, each its own symbol, on minute data', async ({ page }) => {
    const seen = await mockBrowse(page, renderer)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(app)
    await expect(page.getByRole('region', { name: 'Browse' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Pane: NIFTY/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Pane: BSESEN/ })).toBeVisible()
    await expect(page.locator('canvas').first()).toBeVisible()
    await expect.poll(() => history(seen).length).toBeGreaterThanOrEqual(2)
    expect([...new Set(history(seen).map(item => item.query.get('symbol')))].sort()).toEqual(['BSESEN', 'NIFTY'])
    expect(history(seen).every(item => item.query.get('granularity') === 'minute' && item.query.get('historical_days') === '2')).toBe(true)
    expect(errors).toEqual([])
  })

  test('each pane has its own symbol and its own day: comparing two symbols across days', async ({ page }) => {
    const seen = await mockBrowse(page, renderer)
    await page.goto(app)
    await page.getByRole('button', { name: /^Pane: BSESEN/ }).click()
    const menu = page.getByRole('dialog', { name: 'Pane settings' })
    await menu.getByRole('combobox', { name: 'Symbol' }).click()
    await menu.getByRole('combobox', { name: 'Symbol' }).fill('reliance')
    await page.getByRole('option', { name: 'Reliance Industries' }).click()
    await pickDay(page, '2026-10-01')
    await expect(page.getByRole('button', { name: /^Pane: RELIND · / })).toBeVisible()
    await expect.poll(() => history(seen).some(item => item.query.get('symbol') === 'RELIND' && item.query.get('trading_date') === '2026-10-01')).toBe(true)
    // The first pane is untouched: same symbol, its own day.
    const first = history(seen).filter(item => item.query.get('symbol') === 'NIFTY')
    expect(first.every(item => item.query.get('trading_date') !== '2026-10-01')).toBe(true)
  })

  test('an option pane picks a strike from the day\'s ladder and loads about three days of that contract', async ({ page }) => {
    const seen = await mockBrowse(page, renderer)
    await page.goto(app)
    await page.getByRole('button', { name: /^Pane: NIFTY/ }).click()
    const menu = page.getByRole('dialog', { name: 'Pane settings' })
    await menu.getByRole('button', { name: 'CE', exact: true }).click()
    await expect(menu.getByLabel('Strike', { exact: true })).toBeVisible()
    await expect.poll(() => seen.filter(item => item.path.endsWith('/option-metadata')).length).toBeGreaterThan(0)
    await expect(menu.getByLabel('Strike', { exact: true }).locator('option')).not.toHaveCount(1)
    const strikes = await menu.getByLabel('Strike', { exact: true }).locator('option').allTextContents()
    await menu.getByLabel('Strike', { exact: true }).selectOption(strikes[strikes.length - 3])
    await expect.poll(() => seen.some(item => item.path.endsWith('/data/options-historical'))).toBe(true)
    const request = seen.find(item => item.path.endsWith('/data/options-historical'))!
    expect(request.query.get('symbol')).toBe('NIFTY')
    expect(request.query.get('right')).toBe('CE')
    expect(request.query.get('expiry')).toBe('2026-10-13')
    expect(request.query.get('granularity')).toBe('minute')
    expect(request.query.get('historical_days')).toBe('2')
    await expect(page.getByRole('button', { name: /^Pane: NIFTY · .* · CE \d+/ })).toBeVisible()
  })

  test('Max price finds the strike on the server with the website\'s own header, and the pane loads that contract', async ({ page }) => {
    const seen = await mockBrowse(page, renderer)
    await page.goto(app)
    await page.getByRole('button', { name: /^Pane: NIFTY/ }).click()
    const menu = page.getByRole('dialog', { name: 'Pane settings' })
    await menu.getByRole('button', { name: 'PE', exact: true }).click()
    await menu.getByRole('button', { name: 'Max price', exact: true }).click()
    await expect.poll(() => seen.some(item => item.path.endsWith('/option-metadata'))).toBe(true)
    await menu.getByRole('button', { name: '50', exact: true }).click()
    await expect.poll(() => seen.some(item => item.path.endsWith('/prepare-session'))).toBe(true)
    const prepare = seen.find(item => item.path.endsWith('/prepare-session'))!
    expect(prepare.headers['x-user-id']).toBe('alice')
    expect(prepare.headers['authorization']).toBeUndefined()
    expect(prepare.body).toMatchObject({ mode: 'browse', reference_time: '09:30:00', panes: [{ kind: 'option', symbol: 'NIFTY', right: 'PE', selection_mode: 'max_price', max_price: 50 }] })
    await expect(page.getByRole('button', { name: /PE 24650/ })).toBeVisible()
    await expect.poll(() => seen.some(item => item.path.endsWith('/data/options-historical') && item.query.get('strike') === '24650')).toBe(true)
  })

  test('the panes, symbols, days, strikes and intervals come back after a reload', async ({ page }) => {
    await mockBrowse(page, renderer)
    await page.goto(app)
    await page.getByLabel('Browse layout').selectOption({ label: '3 panes' })
    await page.getByRole('button', { name: /^Pane: BSESEN/ }).click()
    const menu = page.getByRole('dialog', { name: 'Pane settings' })
    await menu.getByRole('combobox', { name: 'Symbol' }).click()
    await menu.getByRole('combobox', { name: 'Symbol' }).fill('tata power')
    await page.getByRole('option', { name: 'Tata Power' }).click()
    await pickDay(page, '2026-10-02')
    await page.keyboard.press('Escape')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tradematangi_browse_alice')!))
    expect(saved.layout).toBe(3)
    expect(saved.panes[1]).toMatchObject({ symbol: 'TATPOW', date: '2026-10-02' })
    await page.reload()
    await expect(page.locator('[data-pane]')).toHaveCount(3)
    await expect(page.getByRole('button', { name: /^Pane: TATPOW · .*/ })).toBeVisible()
    await expect(page.getByLabel('Browse layout')).toHaveValue('3')
  })

  test('scrolling an index chart to its left edge asks the paged route for older days; an option chart does not', async ({ page }) => {
    const seen = await mockBrowse(page, renderer)
    await page.goto(app)
    const chart = pane(page, 0)
    await expect(chart.locator('canvas').first()).toBeVisible()
    const box = (await chart.boundingBox())!
    const drag = async () => {
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5, { steps: 12 })
      await page.mouse.up()
    }
    for (let attempt = 0; attempt < 8 && !seen.some(item => item.path.endsWith('/browse/history')); attempt++) await drag()
    await expect.poll(() => seen.filter(item => item.path.endsWith('/browse/history')).length).toBeGreaterThan(0)
    const request = seen.find(item => item.path.endsWith('/browse/history'))!
    expect(request.query.get('symbol')).toBe('NIFTY')
    expect(request.query.get('interval')).toBe('3')
    expect(Number(request.query.get('before'))).toBeGreaterThan(0)
    expect(request.headers['x-user-id']).toBe('alice')
  })
  })
}

/** Colour counts on the canvases of the Browse panes: where a saved drawing of that colour was painted. */
const paintedRows = (page: Page, rgb: [number, number, number]) => page.evaluate(([red, green, blue]) => {
  const near = (a: number, b: number) => Math.abs(a - b) < 40
  for (const canvas of document.querySelectorAll('[data-pane] canvas')) {
    const c = canvas as HTMLCanvasElement, ctx = c.getContext('2d')
    if (!ctx || !c.width || !c.height) continue
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let y = 0; y < c.height; y++) {
      let hits = 0
      for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (near(data[i], red) && near(data[i + 1], green) && near(data[i + 2], blue) && data[i + 3] > 100) hits++ }
      if (hits > c.width * 0.5) { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + y * r.height / c.height } }
    }
  }
  return null
}, rgb)

test('KLine in Browse draws the saved support/resistance lines of its instrument and saves a delete', async ({ page }) => {
  const calls: string[] = []
  await mockBrowse(page, 'kline')
  await page.route('**/api/desktop/v1/drawings**', async route => {
    const url = new URL(route.request().url())
    calls.push(`${route.request().method()} ${url.pathname}${route.request().method() === 'GET' ? `?${new URLSearchParams(url.search).get('instrument')}` : ''}`)
    if (route.request().method() === 'GET') return route.fulfill({ json: { drawings: [{ drawing_id: 'd1', revision: 1, drawing: { tool: 'Horizontal', points: [{ timestamp: start + 60 * 180, price: 105 }], style: { color: '#ff00ff', width: 3 } } }] } })
    return route.fulfill({ json: { drawing_id: 'd1', revision: 2, drawing: {} } })
  })
  await page.goto(app)
  await expect(page.locator('[data-pane] .website-kline')).toHaveCount(2)
  // The same instrument identity the trading and Analysis charts use, so a line drawn there shows here.
  await expect.poll(() => calls.includes('GET /api/desktop/v1/drawings?{"exchange":"NSE","kind":"index","symbol":"NIFTY"}')).toBe(true)
  await expect.poll(() => paintedRows(page, [255, 0, 255])).not.toBeNull()
  const line = (await paintedRows(page, [255, 0, 255]))!
  await page.mouse.move(line.x, line.y)
  await page.mouse.click(line.x, line.y)
  await page.waitForTimeout(400) // the chart selects the line on the click; Delete acts on the selection
  await page.keyboard.press('Delete')
  await expect.poll(() => calls.some(call => call === 'DELETE /api/desktop/v1/drawings/d1')).toBe(true)
})


test('the calendar waits: month arrows move between months and nothing loads until a day is clicked', async ({ page }) => {
  const seen = await mockBrowse(page)
  await page.addInitScript(() => localStorage.setItem('tradematangi_browse_alice', JSON.stringify({
    layout: 1, maximized: null,
    panes: [{ id: 1, symbol: 'NIFTY', kind: 'spot', date: '2026-11-11', expiry: null, strike: null, pick: { mode: 'manual', cap: null }, interval: 3 }],
  })))
  await page.goto(app)
  await expect(page.getByRole('button', { name: /^Pane: NIFTY/ })).toBeVisible()
  await expect.poll(() => history(seen).length).toBeGreaterThan(0)
  const before = history(seen).length
  await page.getByRole('button', { name: /^Pane: NIFTY/ }).click()
  const menu = page.getByRole('dialog', { name: 'Pane settings' })
  await menu.getByRole('button', { name: 'Choose a day' }).click()
  const calendar = menu.getByRole('group', { name: 'Choose a day' })
  await expect(calendar.locator('strong')).toHaveText('November 2026')
  await calendar.getByRole('button', { name: 'Previous month' }).click()
  await expect(calendar.locator('strong')).toHaveText('October 2026')
  await calendar.getByRole('button', { name: 'Previous month' }).click()
  await expect(calendar.locator('strong')).toHaveText('September 2026')
  await page.waitForTimeout(600)
  // Still the same day, the same chart, and no request was made for another day.
  await expect(page.getByRole('button', { name: /^Pane: NIFTY · .*11 Nov/ })).toBeVisible()
  expect(history(seen).length).toBe(before)
  // Weekends and days after today cannot be chosen.
  await expect(calendar.getByRole('button', { name: /\b5 September 2026/ })).toBeDisabled()
  await calendar.getByRole('button', { name: /\b2 September 2026/ }).click()
  await expect(page.getByRole('button', { name: /^Pane: NIFTY · Wed 2 Sep/ })).toBeVisible()
  await expect.poll(() => history(seen).some(item => item.query.get('trading_date') === '2026-09-02')).toBe(true)
})

for (const renderer of ['lightweight', 'kline'] as const) {
  test(`the ${renderer} chart keeps its time axis inside the pane`, async ({ page }) => {
    await mockBrowse(page, renderer)
    await page.goto(app)
    await expect(page.locator('[data-pane] canvas').first()).toBeVisible()
    await page.waitForTimeout(1500)
    for (const index of [0, 1]) {
      const box = (await pane(page, index).boundingBox())!
      const chart = renderer === 'kline' ? pane(page, index).locator('.website-kline') : pane(page, index).locator('.tv-lightweight-charts')
      const chartBox = (await chart.first().boundingBox())!
      expect(chartBox.y + chartBox.height).toBeLessThanOrEqual(box.y + box.height + 1)
      // The time axis is the last strip of the chart: its canvas is inside the pane too.
      const canvases = await pane(page, index).locator('canvas').evaluateAll(list => list.map(item => { const r = item.getBoundingClientRect(); return r.bottom }))
      expect(Math.max(...canvases)).toBeLessThanOrEqual(box.y + box.height + 1)
    }
  })
}
