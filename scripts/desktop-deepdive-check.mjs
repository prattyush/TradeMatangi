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
const store = { setups: [], tags: [], names: { categories: ['Breakout'], strategies: ['Opening range'] }, calls: [] }
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
    Object.assign(s, fields); return s
  }
  if (path === 'setup' && method === 'DELETE') { const k = `${params.get('date')}|${params.get('symbol')}|${params.get('side')}`; const had = store.setups.some(s => key(s) === k); store.setups = store.setups.filter(s => key(s) !== k); return { status: had ? 'deleted' : 'not_found' } }
  if (path === 'setup/tag-values') { const s = store.setups.find(x => key(x) === `${body.date}|${body.symbol}|${body.side}`); for (const [id, v] of Object.entries(body.tag_values)) { if (v === null) delete s.tag_values[id]; else s.tag_values[id] = v } return s }
  if (path === 'tags' && method === 'POST') { const tag = { tag_id: 't' + (store.tags.length + 1), name: body.name, status: 'active', sort_order: store.tags.length, created_at: '', archived_at: null }; store.tags.push(tag); return tag }
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
  assert.match(await page.locator('.dd-depth-head strong').innerText(), new RegExp(`BUY`))
  await page.locator('.dd-chartbox canvas').first().waitFor()
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
  await page.getByRole('button', { name: 'Success', exact: true }).click()
  await page.getByLabel('Notes').fill('clean break'); await page.getByLabel('Notes').blur()
  await page.waitForFunction(() => document.querySelector('.dd-save')?.textContent?.includes('Saved'))
  assert.ok(store.setups.some(s => s.outcome === 'success' && s.notes === 'clean break'))

  // Mark a candle on the underlying chart (pick mode) and see it saved.
  const box = await page.locator('.dd-chartbox canvas').first().boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => /1 marks/.test(document.body.textContent))
  await page.waitForFunction(() => document.querySelector('.dd-save')?.textContent?.includes('Saved'))
  assert.equal(store.setups.reduce((n, s) => n + s.annotations.length, 0), 1)
  await page.screenshot({ path: artifacts + '/step2-indepth.png' })

  // Jump with "Next unmarked day"; an archived tag stops counting at once.
  await page.getByRole('button', { name: 'Next unmarked day' }).click()
  await page.getByRole('button', { name: 'Archive Double top' }).click()
  await page.getByText('Archived tags (1)').waitFor()
  await page.waitForFunction(() => /Needs marking: [0-9] day/.test(document.body.textContent))

  // Back on the list: counts match, then everything survives a reopen.
  await page.getByRole('button', { name: '← All deep dives' }).click()
  await page.getByText('Your deep dives (1)').waitFor()
  await page.getByRole('button', { name: 'Open' }).click()
  await page.getByRole('tab', { name: /2 · In-depth/ }).waitFor()
  assert.equal(store.setups.length, 4)
  assert.deepEqual(errors, [])
  console.log('Desktop Deep Dive browser check passed:', store.calls.length, 'server calls')
} finally { await browser.close(); await new Promise(r => server.close(r)) }
