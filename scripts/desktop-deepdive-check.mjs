/**
 * Browser check of the desktop Deep Dive tab (Phase 26) against the BUILT app (`cd windowsapp && npx vite build`).
 * The native layer and the server are faked in memory: this checks the screens (marking days, walking them, tags, gaps,
 * saving), not the server, which has its own tests. No broker or database request is made.
 *
 *   PLAYWRIGHT_MODULE=/abs/path/to/playwright-core/index.mjs node scripts/desktop-deepdive-check.mjs
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = root + '/.cache/desktop-deepdive-check'
await mkdir(artifacts, { recursive: true })

// ── weekdays before today, newest first ──────────────────────────────────────
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const days = []
for (let back = 1; days.length < 3; back += 1) {
  const d = new Date(); d.setDate(d.getDate() - back)
  if (![0, 6].includes(d.getDay())) days.push(iso(d))
}
const [dayA, dayB, dayC] = days // newest first
const weekend = (() => { const d = new Date(); while (![0, 6].includes(d.getDay())) d.setDate(d.getDate() - 1); return iso(d) })()

// ── in-memory Deep Dive server ───────────────────────────────────────────────
// Phase 26, S10: the strategies labelled on trades and the trades behind one (entry 09:21, exit 09:48 on the chart clock).
const tradeBase = Date.parse(dayA + 'T09:00:00Z') / 1000
const tradedTrade = (index, extra) => ({ session_id: 's' + index, round_trip_index: index, date: dayA, symbol: 'NIFTY', session_type: 'paper', instrument_type: 'options', right: 'CE', strike: 24500,
  expiry: dayA, action: 'BUY', side: 'buy', state: 'closed', pnl: 1950, pnl_pct: 1.9, entry: { time: tradeBase + 21 * 60 + 5, price: 100, quantity: 65 }, exit: { time: tradeBase + 48 * 60, price: 130, quantity: 65 },
  expected: { category: 'Breakout', strategy: 'Opening range' }, actual: { category: '', strategy: '' }, matched_as: 'expected', ...extra })
const tradedSummary = [{ category: 'Breakout', strategy: 'Opening range', trades: 2, expected: 1, actual: 1, last_date: dayA, sessions: 2 },
  { category: 'Reversal', strategy: 'Double top', trades: 1, expected: 1, actual: 0, last_date: dayB, sessions: 1 }]
const tradedList = { category: 'Breakout', strategy: 'Opening range', total: 2, truncated: false, unavailable: 0, trades: [tradedTrade(1, {}),
  tradedTrade(2, { right: 'PE', strike: 24400, action: 'SELL', pnl: -300, matched_as: 'actual', entry: { time: tradeBase + 100 * 60, price: 90, quantity: 65 }, exit: { time: tradeBase + 130 * 60, price: 96, quantity: 65 } })] }
const tradedChart = { chart_id: 'chart-9', user_id: 'alice', symbol: 'NIFTY', date: dayA, instrument_type: 'options', right: 'CE', strike: 24500, notes: '', interval_minutes: 3, top_patterns: {}, risk_reward_ratios: {}, created_at: '', updated_at: '', can_delete: true,
  annotations: [{ id: 'm1', time: tradeBase + 21 * 60, price: 100, type: 'entry', instrument: 'CE', strategy_name: 'Opening range', category: 'Breakout', text: '' }] }
const store = { setups: [], tags: [], tradedSaves: [], renames: [], names: { categories: ['Breakout'], strategies: ['Opening range'] }, calls: [], saved: [] }
const key = s => `${s.date}|${s.symbol}|${s.side}`
const order = list => [...list].sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'buy' ? -1 : 1))
const active = () => store.tags.filter(t => t.status === 'active')
const withGaps = s => { const missing = active().filter(t => !(t.tag_id in s.tag_values)).map(t => t.tag_id); return { ...s, missing, complete: missing.length === 0 } }
const dive = () => { const setups = order(store.setups).map(withGaps); return { owner_id: 'alice', can_edit: true, category: 'Breakout', strategy: 'Opening range', setups, tags: store.tags,
  incomplete_days: setups.filter(s => !s.complete).length, unmarked_total: setups.reduce((n, s) => n + s.missing.length, 0) } }
function deepDive(path, method, body, params) {
  store.calls.push(`${method} ${path}`)
  if (path === 'dives') { const d = dive(); return { dives: d.setups.length || store.tags.length ? [{ owner_id: 'alice', can_edit: true, category: d.category, strategy: d.strategy, days: d.setups.length,
    buy_days: d.setups.filter(s => s.side === 'buy').length, sell_days: d.setups.filter(s => s.side === 'sell').length, tags: active().length, incomplete_days: d.incomplete_days }] : [] } }
  if (path === 'dive') return dive()
  if (path === 'setup' && method === 'PUT') {
    const { category, strategy, symbol, date, side, ...fields } = body
    let s = store.setups.find(x => key(x) === `${date}|${symbol}|${side}`)
    if (!s) { s = { category, strategy, symbol, date, side, strike_ce: null, strike_pe: null, strike_mode: null, interval_minutes: 3, annotations: [], outcome: null, tag_values: {}, notes: '', created_at: '', updated_at: '' }; store.setups.push(s) }
    Object.assign(s, fields)
    if (fields.strength) s.outcome = 'success' // what the server does: a grade makes the day a success, and a failed or cleared day has no grade
    else if ('outcome' in fields && fields.outcome !== 'success') delete s.strength
    return s
  }
  if (path === 'setup' && method === 'DELETE') { const k = `${params.get('date')}|${params.get('symbol')}|${params.get('side')}`; const had = store.setups.some(s => key(s) === k); store.setups = store.setups.filter(s => key(s) !== k); return { status: had ? 'deleted' : 'not_found' } }
  if (path === 'setup/save-to-patterns') { const s = store.setups.find(x => key(x) === `${body.date}|${body.symbol}|${body.side}`); store.saved.push(key(s)); return { chart_id: 'chart-1', merged: store.saved.length > 1, added: s.annotations.length } }
  if (path === 'setup/tag-values') { const s = store.setups.find(x => key(x) === `${body.date}|${body.symbol}|${body.side}`); for (const [id, v] of Object.entries(body.tag_values)) { if (v === null) delete s.tag_values[id]; else s.tag_values[id] = v } return s }
  if (path === 'tags' && method === 'POST') { const tag = { tag_id: 't' + (store.tags.length + 1), name: body.name, status: 'active', sort_order: store.tags.length, created_at: '', archived_at: null }; store.tags.push(tag); return tag }
  const renamed = /^tags\/(\w+)\/update$/.exec(path)
  if (renamed) {
    const t = store.tags.find(x => x.tag_id === renamed[1])
    if (store.tags.some(x => x.status === 'active' && x.tag_id !== t.tag_id && x.name.toLowerCase() === String(body.name).trim().toLowerCase())) throw new Error('An active tag with this name already exists')
    t.name = String(body.name).trim(); store.renames.push(t.name); return t
  }
  const m = /^tags\/(\w+)\/(archive|restore)$/.exec(path)
  if (m) { const t = store.tags.find(x => x.tag_id === m[1]); t.status = m[2] === 'archive' ? 'archived' : 'active'; return t }
  throw new Error('unhandled deep dive path ' + path)
}
const candles = Array.from({ length: 125 }, (_, i) => ({ time: Date.parse(dayA + 'T09:15:00Z') / 1000 + i * 180, open: 100 + i / 10, high: 102 + i / 10, low: 99 + i / 10, close: 101 + i / 10 }))

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    const data = await readFile(root + '/windowsapp/dist' + (path === '/' ? '/index.html' : path))
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(data)
  } catch { res.statusCode = 404; res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()) })

  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(); let sequence = 0
    const call = async (path, method = 'GET', body) => {
      const response = await fetch(`/api/desktop/v1/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}) })
      if (!response.ok) throw new Error(`Native request failed (${response.status}) ${await response.text()}`)
      return response.status === 204 ? null : response.json()
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { const id = ++sequence; callbacks.set(id, callback); return id },
      invoke: async (command, args = {}) => {
        if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id }
        if (command === 'plugin:event|unlisten') return listeners.delete(args.eventId)
        if (command === 'list_screen_windows') return []
        if (command === 'desktop_login') return {}
        if (command.startsWith('desktop_connection_monitor')) return { connection: 'connected', revision: 0 }
        if (command === 'desktop_patterns_request') return call(`patterns/${args.path}`, args.method, args.body)
        if (command === 'desktop_analysis_request') return call(`analysis/${args.path}`, args.method, args.body)
        if (command === 'desktop_drawing_request') return call(args.path, args.method, args.body)
        if (command === 'desktop_catalogue') return call('catalogue')
        if (command === 'desktop_option_metadata') return call('option-metadata')
        if (command === 'desktop_historical_page' || command === 'desktop_option_historical_page') return call('historical/pages')
        if (command === 'desktop_settings_request') return call(`settings/${args.path}`, args.method, args.body)
        if (command === 'desktop_get_chart_settings') return call('chart-settings')
        return null
      },
    }
  })

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname.replace('/api/desktop/v1/', '').replace('/api/', ''); const method = route.request().method()
    if (process.env.DEBUG_REQUESTS) console.log('REQ', method, path)
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : {}
    try {
      let value = {}
      if (path === 'auth/desktop/token') value = { access_token: 'synthetic' }
      else if (path.startsWith('patterns/deep-dive/')) value = deepDive(path.replace('patterns/deep-dive/', ''), method, body, url.searchParams)
      else if (path === 'patterns/pattern/traded/summary') value = { strategies: tradedSummary }
      else if (path === 'patterns/pattern/traded') value = tradedList
      else if (path === 'patterns/pattern/traded/save') { store.tradedSaves.push(body); value = { chart_id: 'chart-9', merged: store.tradedSaves.length > 1, added: 2 } }
      else if (path === 'patterns/pattern/chart/chart-9') value = tradedChart
      else if (path === 'patterns/pattern/categories') value = { categories: store.names.categories }
      else if (path === 'patterns/pattern/strategies') value = { strategies: store.names.strategies }
      else if (path === 'patterns/pattern/charts') value = { charts: [] }
      else if (path === 'patterns/data/expiry') value = { expiry: dayA }
      else if (path === 'patterns/data/price-at') value = { price: 24512 }
      else if (path === 'trading/settings/current') value = { max_price_mode: 'otm', historical_days: 2 }
      else if (path.endsWith('data/historical')) value = { symbol: 'NIFTY', dates: [], candles: candles.map(c => ({ ...c, time: c.time - 86400 })) }
      else if (path.endsWith('data/pre-session')) value = { candles }
      else if (path.endsWith('data/options-historical')) value = { candles }
      else if (path.endsWith('catalogue')) value = { instruments: [{ symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 15] }] }
      else if (path.endsWith('drawings')) value = { drawings: [] }
      else if (path.endsWith('screens')) value = { screens: [] }
      else if (path.endsWith('capabilities')) value = { user_id: 'alice', features: [] }
      else if (path.endsWith('historical/pages')) value = { candles: [], available: true }
      else if (path.endsWith('wallet')) value = { balance: 150000 }
      else if (path.endsWith('candidate')) value = { status: 'none' }
      else if (path.endsWith('strategies') && !path.startsWith('patterns/')) value = { strategies: [] }
      await route.fulfill({ status: 200, json: value })
    } catch (error) { await route.fulfill({ status: 400, json: { detail: String(error.message) } }) }
  })

  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  if (await signIn.waitFor({ timeout: 4000 }).then(() => true, () => false)) await signIn.click()
  await page.waitForTimeout(1500)
  if (process.env.DEBUG_REQUESTS) console.log('ERRORS', errors)
  await page.screenshot({ path: artifacts + '/after-login.png' })
  await page.getByRole('combobox', { name: 'Desktop view' }).selectOption('Tools')
  await page.getByRole('button', { name: 'Pattern Library' }).click()
  await page.getByRole('tab', { name: 'Deep dive' }).click()

  // Home: start form, empty list
  await page.getByText('Start a deep dive').waitFor()
  await page.getByText('No deep dives yet').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Start deep dive' }).isDisabled(), true)
  const selects = page.locator('.dd-start select')
  assert.deepEqual(await page.locator('.dd-start select[aria-label="Symbol"] option').evaluateAll(options => options.map(o => o.value)), ['NIFTY', 'BSESEN', 'RELIND', 'TATMOT', 'TATPOW'], 'the symbol list is the Pattern Library symbols')
  await selects.nth(0).selectOption('Breakout')
  await selects.nth(1).selectOption('Opening range')
  await page.getByRole('button', { name: 'Start deep dive' }).click()
  await page.getByRole('tab', { name: /1 · Mark days/ }).waitFor()

  // Step 1: mark days. Weekend has no buttons.
  const cell = date => page.locator('.dd-cal-cell', { has: page.locator(`[aria-label^="${date}"]`) })
  const ensureVisible = async date => { // the calendar opens on the latest trading day's month; step back when a day sits earlier
    for (let i = 0; i < 3; i += 1) { if (await cell(date).isVisible()) return; await page.getByRole('button', { name: 'Previous month' }).click() }
    throw new Error(`${date} is not on the calendar`)
  }
  for (const d of [dayA, dayB, dayC]) await ensureVisible(d)
  // Every day of the month sits under its own weekday header (a hidden neighbouring-month cell must not shift the grid).
  const misplaced = () => page.evaluate(() => {
    const heads = [...document.querySelectorAll('.dd-cal-dow')].map(e => { const r = e.getBoundingClientRect(); return r.left + r.width / 2 })
    return [...document.querySelectorAll('.dd-cal-cell:not([hidden]) .dd-cal-day')].flatMap(button => {
      const date = (button.getAttribute('aria-label') ?? '').slice(0, 10)
      const r = button.getBoundingClientRect(), x = r.left + r.width / 2
      const column = heads.reduce((best, h, i) => (Math.abs(h - x) < Math.abs(heads[best] - x) ? i : best), 0)
      const wanted = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7 // Monday first
      return column === wanted ? [] : [`${date} is under column ${column}, wanted ${wanted}`]
    })
  })
  assert.deepEqual(await misplaced(), [])
  await page.getByRole('button', { name: 'Previous month' }).click()
  assert.deepEqual(await misplaced(), [], 'the previous month too')
  await page.getByRole('button', { name: 'Next month' }).click()
  if (await cell(weekend).isVisible()) assert.equal(await cell(weekend).locator('.dd-side').count(), 0, 'weekend has no B/S')
  await cell(dayC).getByRole('button', { name: 'B', exact: true }).click()
  await cell(dayB).getByRole('button', { name: 'B', exact: true }).click()
  await cell(dayB).getByRole('button', { name: 'S', exact: true }).click()
  await cell(dayA).getByRole('button', { name: 'S', exact: true }).click()
  await page.getByRole('heading', { name: 'Marked days' }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.dd-days li').length === 4)
  assert.deepEqual(store.setups.map(key).sort(), [`${dayA}|NIFTY|sell`, `${dayB}|NIFTY|buy`, `${dayB}|NIFTY|sell`, `${dayC}|NIFTY|buy`].sort())
  await page.locator('.dd-chart canvas').first().waitFor()
  await page.screenshot({ path: artifacts + '/step1-marking.png' })
  await cell(dayA).getByRole('button', { name: 'S', exact: true }).click() // empty side: removed without a question
  await page.waitForFunction(() => document.querySelectorAll('.dd-days li').length === 3)
  await cell(dayA).getByRole('button', { name: 'S', exact: true }).click() // back again
  await page.waitForFunction(() => document.querySelectorAll('.dd-days li').length === 4)

  // Step 2: in-depth. Oldest day first, Buy before Sell.
  await page.getByRole('tab', { name: /2 · In-depth/ }).click()
  await page.getByText(/1 \/ 4 ·/).waitFor()
  assert.match(await page.locator('.dd-head-group strong[aria-live="polite"]').innerText(), new RegExp(`BUY`))
  await page.locator('.dd-chartbox canvas').first().waitFor()
  // The day area runs to the bottom of the window and the two stacked charts share it, half each (no empty half-page).
  const layout = () => page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left } }
    return { inner: innerHeight, day: rect(document.querySelector('.dd-day')), charts: [...document.querySelectorAll('.dd-chartbox')].map(rect) }
  })
  // The Deep Dive's controls sit in the Pattern Library's own header row (no rows of their own).
  await page.setViewportSize({ width: 1920, height: 1100 }) // wide enough for the library's tabs and the Deep Dive's controls on one line
  const rowY = async locator => (await locator.first().boundingBox()).y
  const libraryRow = await rowY(page.getByRole('heading', { name: 'Pattern Library' }))
  for (const control of [page.getByRole('button', { name: 'All deep dives' }), page.getByRole('tab', { name: /2 · In-depth/ }), page.getByRole('button', { name: 'Previous day' }), page.getByRole('button', { name: 'Next day' })]) {
    assert.ok(Math.abs(await rowY(control) - libraryRow) < 10, 'a Deep Dive control is not in the Pattern Library header row')
  }
  await page.setViewportSize({ width: 1500, height: 1100 })
  await page.waitForFunction(() => { const d = document.querySelector('.dd-day').getBoundingClientRect(); return d.bottom > innerHeight - 40 && d.bottom <= innerHeight }) // the layout refits a moment after a resize
  const fill = await layout()
  assert.ok(fill.day.bottom > fill.inner - 40 && fill.day.bottom <= fill.inner, 'the day area runs to the bottom of the window')
  assert.equal(fill.charts.length, 2)
  assert.ok(fill.charts[1].top > fill.charts[0].top && fill.charts[1].left === fill.charts[0].left, 'the charts are stacked')
  assert.ok(Math.abs(fill.charts[0].height - fill.charts[1].height) < 4, 'half each')
  assert.ok(fill.charts[0].height + fill.charts[1].height > fill.day.height * 0.75, 'together they use the area')
  // Maximize one chart: the other hides, the choice stays on the next day, Restore brings both back.
  await page.getByRole('button', { name: /Maximize .* chart/ }).nth(1).click()
  await page.waitForFunction(() => document.querySelectorAll('.dd-chartbox')[0].hidden)
  const maxed = await layout()
  assert.ok(maxed.charts[1].height > fill.charts[1].height * 1.6, 'the maximized chart takes the whole chart area')
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByText(/2 \/ 4 ·/).waitFor()
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dd-chartbox')[0].hidden), true, 'still maximized on the next day')
  await page.getByRole('button', { name: /Restore .* chart/ }).click()
  await page.getByRole('button', { name: 'Previous day' }).click()
  await page.getByText(/1 \/ 4 ·/).waitFor()
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dd-chartbox')[0].hidden), false)
  await page.getByText('No tags yet').waitFor()
  assert.equal(await page.locator('.dd-chip').count(), 4)

  // Add two tags: every day now needs marking.
  await page.getByLabel('New tag').fill('Second leg'); await page.getByRole('button', { name: 'Add tag' }).click()
  await page.getByText(/not marked on 4 days/).waitFor()
  await page.getByLabel('New tag').fill('Double top'); await page.getByRole('button', { name: 'Add tag' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dd-taglist li').length === 2)
  await page.getByText(/2 tags are not marked on this day/).waitFor()
  assert.equal(await page.locator('.dd-chip.incomplete').count(), 4)
  await page.getByText('Needs marking: 4 days').waitFor()

  // Mark day 1: Valid, Not valid; the chip turns complete; a second tap clears.
  const row = name => page.locator('.dd-taglist li', { hasText: name })
  await row('Second leg').getByRole('button', { name: 'Valid', exact: true }).click()
  await row('Second leg').getByRole('button', { name: 'Valid', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.dd-taglist li.unmarked .dd-tagname')?.textContent === 'Second leg')
  await row('Second leg').getByRole('button', { name: 'Valid', exact: true }).click()
  await row('Double top').getByRole('button', { name: 'Not valid', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dd-chip.complete').length === 1)
  assert.equal(store.setups.map(withGaps).filter(s => s.complete).length, 1)

  // Next day: banner, "mark the rest not valid" completes it, Next unmarked day skips ahead.
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.getByText(/2 tags are not marked on this day/).waitFor()
  await page.getByRole('button', { name: /Mark the rest not valid \(2\)/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dd-chip.complete').length === 2)
  await page.getByRole('button', { name: 'Failed', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.dd-save')?.textContent?.includes('Saved'))
  assert.ok(store.setups.some(s => s.outcome === 'failed' && !s.strength))
  await page.getByRole('button', { name: 'Ideal', exact: true }).click() // grading a failed day makes it a success again
  await page.getByRole('button', { name: 'Average', exact: true }).click() // one grade per day: the last click wins
  await page.getByRole('button', { name: 'Ideal', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Ideal', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Average', exact: true }).getAttribute('aria-pressed'), 'false')
  await page.getByText('Mark an Entry and an Exit on the chart to record their times.').waitFor()
  await page.getByLabel('Notes').fill('clean break'); await page.getByLabel('Notes').blur()
  await page.waitForFunction(() => document.querySelector('.dd-save')?.textContent?.includes('Saved'))
  assert.ok(store.setups.some(s => s.outcome === 'success' && s.notes === 'clean break'))

  // Mark a candle on the underlying chart (pick mode) and see it saved.
  const box = await page.locator('.dd-chartbox canvas').first().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => /1 marks/.test(document.body.textContent))
  await page.waitForFunction(() => document.querySelector('.dd-save')?.textContent?.includes('Saved'))
  assert.equal(store.setups.reduce((n, s) => n + s.annotations.length, 0), 1)
  const markedDay = store.setups.find(s => s.annotations.length)
  const clockOf = t => `${String(Math.floor(t % 86400 / 3600)).padStart(2, '0')}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`
  const markClock = clockOf(markedDay.annotations[0].time)
  await page.getByText(`Entry ${markClock} · Exit —`).waitFor() // the day shows the time of its Entry mark
  await page.screenshot({ path: artifacts + '/step2-indepth.png' })

  // Jump with "Next unmarked day"; an archived tag stops counting at once.
  await page.getByRole('button', { name: 'Next unmarked day' }).click()
  // Rename a tag: a name another active tag has is refused with nothing sent; a free name is saved, and the marks stay.
  await page.getByRole('button', { name: 'Rename Second leg' }).click()
  await page.getByLabel('New name for Second leg').fill('double TOP'); await page.getByLabel('New name for Second leg').press('Enter')
  await page.getByRole('alert').filter({ hasText: /already exists/ }).waitFor()
  assert.deepEqual(store.renames, [])
  await page.getByLabel('New name for Second leg').press('Escape')
  await page.getByRole('button', { name: 'Rename Second leg' }).click()
  await page.getByLabel('New name for Second leg').fill('Second leg follows'); await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.locator('.dd-taglist li', { hasText: 'Second leg follows' }).waitFor()
  assert.deepEqual(store.renames, ['Second leg follows'])
  assert.ok(store.setups.some(s => Object.keys(s.tag_values).includes('t1')), 'the marks of the renamed tag are still there')
  await page.getByRole('button', { name: 'Archive Double top' }).click()
  await page.getByText('Archived tags (1)').waitFor()
  await page.waitForFunction(() => /Needs marking: [0-9] day/.test(document.body.textContent))

  // Step 3: results. One active tag (Second leg): valid on 1 of the 2 days it was marked on.
  await page.getByRole('tab', { name: '3 · Results' }).click()
  await page.getByText('How often each tag was valid').waitFor()
  const freq = page.locator('.dd-freq li', { hasText: 'Second leg' })
  assert.match(await freq.innerText(), /50%\s*\(n=2\)/)
  assert.match(await freq.innerText(), /1 valid · 1 not valid/)
  assert.match(await freq.innerText(), /Only 2 days marked/)
  assert.equal(await page.locator('.dd-freq li', { hasText: 'Double top' }).count(), 0, 'archived tag is not counted')
  await page.getByText('Success 1 of 1 (100%)').waitFor()
  await page.getByText(/Ideal 1 · Average 0 · Poor 0/).waitFor()
  assert.ok(store.setups.some(s => s.outcome === 'success' && s.strength === 'ideal'))
  assert.deepEqual(await page.locator('.dd-days-table tbody td.dd-clock:nth-child(4)').allInnerTexts().then(list => list.filter(t => t !== '—')), [markClock]) // one day has an Entry
  assert.deepEqual(await page.locator('.dd-days-table tbody td.dd-clock:nth-child(5)').allInnerTexts().then(list => list.filter(t => t !== '—')), []) // none has an Exit
  assert.match(await page.locator('.dd-days-table tbody').innerText(), /Ideal/)
  assert.equal(await page.locator('.dd-days-table tbody tr').count(), 4)
  await page.getByRole('button', { name: /^Sell \(2\)/ }).click()   // the sell days never marked Second leg
  assert.match(await page.locator('.dd-freq li', { hasText: 'Second leg' }).innerText(), /—\s*\(n=0\)/)
  assert.equal(await page.locator('.dd-days-table tbody tr').count(), 2)
  await page.getByRole('button', { name: /^Buy \(2\)/ }).click()
  assert.match(await page.locator('.dd-freq li', { hasText: 'Second leg' }).innerText(), /50%\s*\(n=2\)/)
  await page.getByRole('button', { name: /^All \(4\)/ }).click()
  await page.screenshot({ path: artifacts + '/step3-results.png' })
  // Save the one day that has a chart mark into the Pattern Library.
  assert.equal(await page.getByRole('button', { name: 'Save to Patterns' }).count(), 1)
  await page.getByRole('button', { name: 'Save to Patterns' }).click()
  await page.getByText(/saved as a new pattern chart with 1 mark/).waitFor()
  assert.deepEqual(store.saved, [`${dayB}|NIFTY|buy`])
  await page.getByRole('button', { name: /Save 1 marked day to Pattern Library/ }).click()
  await page.getByText(/0 new and 1 updated pattern chart, 1 marks added/).waitFor()
  // A day's date opens it in the in-depth step.
  await page.locator('.dd-days-table tbody tr').first().getByRole('button', { name: 'Open' }).click()
  await page.getByText(/1 \/ 4 ·/).waitFor()
  await page.getByRole('tab', { name: '3 · Results' }).click()
  await page.locator('.dd-days-table tbody tr').nth(2).locator('.dd-day-link').click()
  await page.getByText(/3 \/ 4 ·/).waitFor()

  // Back on the list: counts match, then everything survives a reopen.
  await page.getByRole('button', { name: 'All deep dives' }).click()
  await page.getByText('Your deep dives (1)').waitFor()
  await page.getByRole('button', { name: 'Open' }).click()
  await page.getByRole('tab', { name: /2 · In-depth/ }).waitFor()
  assert.equal(store.setups.length, 4)
  // "From your trades": the strategies labelled on trades, the trades behind one, a trade drawn on its charts, save, and edit.
  await page.getByRole('tab', { name: 'From your trades' }).click()
  await page.getByRole('heading', { name: /From your trades \(2\)/ }).waitFor()
  const strategyItems = page.locator('.td-strategies li')
  assert.equal(await strategyItems.count(), 2)
  assert.match(await strategyItems.first().innerText(), /2 trades · 1 expected · 1 actual/)
  await page.getByLabel('Filter strategies').fill('double'); assert.equal(await strategyItems.count(), 1)
  await page.getByLabel('Filter strategies').fill('')
  await strategyItems.first().getByRole('button').click()
  const tradeRows = page.locator('.td-table tbody tr')
  await tradeRows.nth(1).waitFor()
  assert.match(await tradeRows.nth(0).innerText(), /NIFTY CE 24500[\s\S]*bought[\s\S]*09:21 → 09:48[\s\S]*\+1950\.00/)
  assert.match(await tradeRows.nth(1).innerText(), /NIFTY PE 24400[\s\S]*Buy[\s\S]*sold[\s\S]*Actual/) // a short put is a Buy-side position
  await page.locator('.td-chartbox canvas').first().waitFor()
  assert.equal(await page.locator('.td-chartbox').count(), 2)
  assert.match(await page.locator('.td-legend').innerText(), /your actual orders/)
  const viewer = await page.evaluate(() => { const r = document.querySelector('.td-viewer').getBoundingClientRect(); const [a, b] = [...document.querySelectorAll('.td-chartbox')].map(e => e.getBoundingClientRect()); return { bottom: r.bottom, inner: innerHeight, row: b.left > a.left && Math.abs(b.top - a.top) < 2 && Math.abs(b.width - a.width) < 4 && Math.abs(b.height - a.height) < 2, height: a.height } })
  assert.ok(viewer.row && viewer.bottom <= viewer.inner + 1, 'the two charts are side by side and the viewer runs to the bottom of the window')
  assert.ok(viewer.height > 400, 'each chart has the full height')
  // Maximize the contract chart: the underlying hides, the contract takes the whole width; Restore brings both back.
  const tradedWidths = () => page.evaluate(() => [...document.querySelectorAll('.td-chartbox')].map(e => ({ hidden: e.hidden, width: e.getBoundingClientRect().width })))
  const sideBySide = await tradedWidths()
  await page.getByRole('button', { name: /Maximize .* chart/ }).nth(1).click()
  await page.waitForFunction(() => document.querySelectorAll('.td-chartbox')[0].hidden)
  assert.ok((await tradedWidths())[1].width > sideBySide[1].width * 1.8, 'the maximized chart takes the whole width')
  await page.getByRole('button', { name: /Restore .* chart/ }).click()
  await page.waitForFunction(() => !document.querySelectorAll('.td-chartbox')[0].hidden)
  assert.ok(Math.abs((await tradedWidths())[1].width - sideBySide[1].width) < 4, 'Restore brings both charts back')
  await page.screenshot({ path: artifacts + '/step4-traded.png' })
  await tradeRows.nth(1).getByRole('button').click()
  await page.getByText('NIFTY PE 24400 · 3m').first().waitFor()
  await page.getByRole('button', { name: 'Save as pattern chart' }).click()
  await page.getByText(/Saved as a new pattern chart with 2 marks/).waitFor()
  assert.deepEqual(store.tradedSaves, [{ session_id: 's2', round_trip_index: 2, category: 'Breakout', strategy: 'Opening range' }])
  await page.getByRole('button', { name: 'Save and edit' }).click()
  await page.getByRole('tab', { name: 'Annotate' }).waitFor()
  await page.waitForFunction(() => document.querySelector('.pl-tabs [aria-selected="true"]')?.textContent === 'Annotate')
  await page.getByRole('button', { name: 'Update' }).waitFor() // the saved chart is open for editing
  assert.equal(store.tradedSaves.length, 2)
  assert.deepEqual(errors, [])
  console.log('Desktop Deep Dive browser check passed:', store.calls.length, 'server calls')
} finally { await browser.close(); await new Promise(r => server.close(r)) }
