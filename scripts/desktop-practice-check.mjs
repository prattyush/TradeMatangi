/**
 * Browser check of Strategy Practice on the desktop (Phase 26, S16) against the BUILT app (`cd windowsapp && npx vite build`).
 * The native layer and the server are faked in memory. It drives the whole path: Tools > Pattern Library > Practice > Start, the
 * workspace taking the launch (practice charts, Replay mode, date, start, speed), the ordinary Replay start with the practice
 * marker and no candidate prompt, a second Start refused while it runs, Stop, and the Review practice button into the review.
 * It checks the screens and the requests they make, not the server (which has its own tests).
 *
 *   PLAYWRIGHT_MODULE=/abs/path/to/playwright-core/index.mjs node scripts/desktop-practice-check.mjs
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = root + '/.cache/desktop-practice-check'
await mkdir(artifacts, { recursive: true })

const date = '2026-10-08'
const start = Date.parse(date + 'T09:15:00Z') / 1000
const at = minutes => start + minutes * 60
const settings = { desktop_hide_chart_labels: false, desktop_order_size_mode: 'quantity', desktop_pnl_display_mode: 'currency', desktop_confirm_flatten: true, context_menu_sl_mode: 'longOnly', target_deviation_pct: .01, funds_ratio_l_pct: .03, funds_ratio_m_pct: .06, funds_ratio_h_pct: .12, risk_ratio_l_pct: 1, risk_ratio_m_pct: 2, risk_ratio_h_pct: 4, default_sl_pct: .25, historical_days: 0, max_price_mode: 'otm' }
const flat = { symbol: 'NIFTY', side: 'FLAT', quantity: 0, avg_entry_price: 0, entry_commission: 0 }
const candles = Array.from({ length: 125 }, (_, i) => ({ timestamp: start - 86400 + i * 180, time: start - 86400 + i * 180, open: 100 + i / 10, high: 102 + i / 10, low: 99 + i / 10, close: 101 + i / 10 }))
const contract = t => ({ symbol: t.symbol, right: t.right, strike: Number(t.strike), expiry: t.expiry, contract_key: `${t.symbol}:${t.expiry}:${t.strike}:${t.right}` })

const state = { calls: [], prepared: [], running: false, replayState: 'running', picks: [], failPick: false }
const snapshot = () => ({
  version: 1, event_cursor: 0, owned: true, paper_status: null, source: 'desktop_replay', desktop_mode: 'replay',
  session: { session_id: 'practice1', symbol: 'NIFTY', date, start_time: '09:33:00', speed: 1, session_capital: 100000, instrument_type: 'options', strike: 24500, expiry: '2026-10-13', right: null, strike_ce: 24500, strike_pe: 24400,
    session_type: 'sim', state: state.running ? 'running' : 'ended', stepwise: false, total_bars: null, group_id: 'g', wallet_ledger_id: 'w', lot_size: 75, practice: { category: 'Breakout', strategy: 'Opening range' } },
  current_time: at(18), current_bar_index: 1, current_price: 24500, current_price_ce: 100, current_price_pe: 80,
  contract_quotes: Object.fromEntries(state.prepared.filter(t => t.kind === 'option').map(t => { const c = contract(t); return [c.contract_key, { ...c, price: 90, timestamp: at(18), source: 'synthetic' }] })),
  contracts: state.prepared.filter(t => t.kind === 'option').map(contract), positions: { equity: flat, CE: flat, PE: flat }, positions_by_contract: {}, open_orders: [], strategies: [], trades: [],
  wallet_balance: 100000, pnl: { equity: 0, ce: 0, pe: 0, day: 0, day_pct: 0, contracts: {} }, settings,
})
const replay = () => ({ run_id: 'run', event_id: 0, cursor: at(18), state: state.replayState, mode: 'replay', bar_index: 1, interval_seconds: 180,
  tile_states: state.prepared.map(t => ({ tile_id: t.id, availability: 'ready', interval_minutes: 3, candle: { timestamp: start, open: 100, high: 101, low: 99, close: 100 } })) })

const strategies = [{ category: 'Breakout', strategy: 'Opening range', days: 3, grades: { ideal: 1, average: 0, poor: 0, ungraded: 1, failed: 1, open: 0 }, symbols: [{ symbol: 'NIFTY', days: 3 }], negative_days: [{ symbol: 'NIFTY', days: 4 }] }]
const plan = { symbol: 'NIFTY', date, start_time: '09:33:00', interval_minutes: 3, instrument_type: 'options', strike_ce: 24500, strike_pe: 24400, expiry: '2026-10-13',
  practice: { category: 'Breakout', strategy: 'Opening range', start_offset_min: 12 }, days_available: 3, repeated: false }
const review = { session_id: 'practice1', category: 'Breakout', strategy: 'Opening range', symbol: 'NIFTY', date, start_time: '09:33:00', start_offset_min: 12, negative: false,
  setups: [{ side: 'buy', interval_minutes: 3, outcome: 'success', strength: 'ideal', strike_ce: 24500, strike_pe: null,
    recorded: { entry: { time: at(30), clock: '09:45', price: 100, instrument: 'underlying' }, exit: { time: at(75), clock: '10:30', price: 112, instrument: 'underlying' }, marks: [] },
    annotations: [], theoretical: [{ instrument: 'underlying', strike: null, expiry: null, entry: { time: at(30), clock: '09:45', price: 100 }, exit: { time: at(75), clock: '10:30', price: 112 }, points: 12, pct: 12 }], trades: [] }],
  other_trades: [], summary: { traded: false } }

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
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = [], dialogs = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()) })
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss() })

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
        if (command === 'desktop_replay_request') return call(`replay/${args.path}`, args.method, args.body)
        if (command === 'desktop_live_request') return call(`live/${args.path}`, args.method, args.body)
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
    const request = route.request(), url = new URL(request.url()), method = request.method()
    const path = url.pathname.replace('/api/desktop/v1/', '').replace('/api/', '')
    const body = request.postData() ? JSON.parse(request.postData()) : {}
    state.calls.push({ path, method, body })
    try {
      let value = {}
      if (path === 'auth/desktop/token') value = { access_token: 'synthetic' }
      else if (path === 'patterns/deep-dive/practice/strategies') value = { strategies }
      else if (path === 'patterns/deep-dive/practice/pick') { if (state.failPick) return route.fulfill({ status: 400, json: { detail: 'No day of this strategy with an Entry mark matches your choice' } }); state.picks.push(body); value = plan }
      else if (path === 'patterns/deep-dive/practice/runs') value = { runs: [{ session_id: 'practice1', category: 'Breakout', strategy: 'Opening range', symbol: 'NIFTY', date, start_time: '09:33:00', start_offset_min: 12, state: state.running ? 'running' : 'ended', ended: !state.running, created_at: 1, result: null }] }
      else if (path === 'patterns/deep-dive/practice/evaluate') { if (state.running) return route.fulfill({ status: 409, json: { detail: 'Stop the session first: the review shows the recorded answer' } }); value = review }
      else if (path === 'patterns/data/expiry') value = { expiry: '2026-10-13' }
      else if (path === 'patterns/data/price-at') value = { price: 24512 }
      else if (path.startsWith('patterns/pattern/')) value = path.endsWith('charts') ? { charts: [] } : path.endsWith('categories') ? { categories: [] } : { strategies: [] }
      else if (path === 'trading/settings/current') value = settings
      else if (path === 'trading/prepare-session') {
        value = { version: 1, date: body.date, reference_time: body.reference_time, panes: body.panes.map(t => ({ pane: { ...t, tradingDate: body.date }, availability: 'available', reason: null, premium: null })) }
        state.prepared = value.panes.map(p => p.pane)
      }
      else if (path === 'trading/start') { state.running = true; state.replayState = 'running'; value = { ...snapshot(), created_for_request: true } }
      else if (path.endsWith('/contracts')) value = snapshot()
      else if (path === 'replay/start') value = replay()
      else if (path === 'replay/run/stop') { state.running = false; state.replayState = 'stopped'; value = replay() }
      else if (path.startsWith('replay/run')) value = replay()
      else if (path.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(replay())}\n\n` })
      else if (path.endsWith('/snapshot') && path.startsWith('trading/')) value = snapshot()
      else if (path.endsWith('/stop') && path.startsWith('trading/')) { state.running = false; value = {} }
      else if (path.endsWith('/candidate')) value = { status: 'none' }
      else if (path.endsWith('catalogue')) value = { instruments: [{ symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }] }
      else if (path.endsWith('option-metadata')) value = { expiries: ['2026-10-13'], strike_interval: 50, rights: ['CE', 'PE'], available: true }
      else if (path.endsWith('historical/pages')) value = { candles, available: true }
      else if (path.endsWith('data/historical')) value = { symbol: 'NIFTY', dates: [], candles: candles.map(c => ({ ...c, time: c.time - 86400 })) }
      else if (path.endsWith('data/pre-session')) value = { candles }
      else if (path.endsWith('data/options-historical')) value = { candles }
      else if (path.endsWith('drawings')) value = { drawings: [] }
      else if (path.endsWith('screens')) value = { screens: [] }
      else if (path.endsWith('capabilities')) value = { user_id: 'alice', features: [] }
      else if (path.endsWith('chart-settings')) value = { settings: {} }
      else if (path.endsWith('wallet')) value = { balance: 100000, locked: false }
      else if (path.endsWith('trade-labels/metadata')) value = { categories: [], strategies: [], entry_tags: [], exit_tags: [] }
      else if (path.endsWith('trade-labels')) value = { completed: [], open: [], labels: [] }
      await route.fulfill({ status: 200, json: value })
    } catch (error) { await route.fulfill({ status: 400, json: { detail: String(error.message) } }) }
  })

  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  if (await signIn.waitFor({ timeout: 4000 }).then(() => true, () => false)) await signIn.click()
  await page.waitForTimeout(1200)
  const goToPractice = async () => {
    await page.getByRole('combobox', { name: 'Desktop view' }).selectOption('Tools')
    await page.getByRole('button', { name: 'Pattern Library' }).click()
    await page.getByRole('tab', { name: 'Practice', exact: true }).click()
  }
  const calls = path => state.calls.filter(c => c.path === path)

  // The Practice tab: strategies with their Entry-marked days, the no-setup option, the desktop's own speed list.
  await goToPractice()
  await page.getByRole('heading', { name: /Strategy \(1\)/ }).waitFor()
  await page.locator('.pr-strategies li button').click()
  await page.getByRole('checkbox', { name: 'Include no-setup days' }).waitFor()
  assert.deepEqual(await page.getByLabel('Replay speed').locator('option').evaluateAll(o => o.map(x => x.value)), ['0.25', '0.5', '1', '1.1', '1.25', '1.5', '2', '5', '10'])
  await page.getByLabel('Replay speed').selectOption('2')

  // Start: the pick, then the workspace starts the ordinary Replay on that day with the practice marker.
  await page.getByRole('button', { name: 'Start practice' }).click()
  await page.getByTestId('practice-badge').waitFor()
  await page.screenshot({ path: artifacts + '/started.png' })
  assert.deepEqual(state.picks, [{ category: 'Breakout', strategy: 'Opening range' }])
  assert.equal(calls('trading/candidate').length, 0, 'a practice start asks no candidate question and shows no prompt')
  assert.equal(dialogs.length, 0, 'no confirm dialog')
  const prepare = calls('trading/prepare-session')[0].body
  assert.deepEqual([prepare.mode, prepare.date, prepare.reference_time], ['replay', date, '09:33:00'])
  assert.deepEqual(prepare.panes.map(p => [p.kind, p.right || '', p.strike, p.interval, p.tradingDate]), [['spot', 'CE', '', '3', date], ['option', 'CE', '24500', '3', date], ['option', 'PE', '24400', '3', date]])
  const started = calls('trading/start')[0].body
  assert.equal(started.session_type, 'sim'); assert.equal(started.desktop_mode, 'replay'); assert.equal(started.override, false)
  assert.deepEqual([started.symbol, started.date, started.start_time, started.speed], ['NIFTY', date, '09:33:00', 2])
  assert.deepEqual(started.practice, { category: 'Breakout', strategy: 'Opening range', start_offset_min: 12 })
  assert.equal(started.strategy_interval_secs, 180)
  assert.equal(calls('replay/start')[0].body.start_time, '09:33:00')
  assert.match(await page.getByTestId('practice-badge').innerText(), /Practice: Opening range/)
  assert.equal(await page.getByRole('button', { name: 'Review practice' }).count(), 0, 'no review while the run goes')
  assert.equal(await page.locator('.run-controls input[type="time"]').inputValue(), '09:33')
  assert.equal(await page.locator('.run-controls select').first().inputValue(), '2')

  // A second Start while it runs is refused, with the reason, and starts nothing.
  await goToPractice()
  await page.locator('.pr-strategies li button').click()
  await page.getByRole('button', { name: 'Start practice' }).click()
  await page.getByRole('alert').filter({ hasText: 'A session is running on this screen' }).waitFor()
  assert.equal(calls('trading/start').length, 1)

  // The review is refused while it runs (the server's own sentence), then Stop, then the Review button opens it.
  await page.getByRole('combobox', { name: 'Desktop view' }).selectOption('Workspace')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.getByRole('button', { name: 'Review practice' }).waitFor()
  await page.getByRole('button', { name: 'Review practice' }).click()
  await page.getByText(/12 min before the first recorded entry/).waitFor()
  assert.match(await page.locator('.pr-recorded').first().innerText(), /Buy setup/)
  assert.match(await page.locator('.pr-recorded').first().innerText(), /entry 09:45/)
  await page.screenshot({ path: artifacts + '/review.png' })
  await page.getByRole('button', { name: '← Back' }).click()

  // A pick the server refuses shows its sentence and leaves the screen usable.
  state.failPick = true
  await page.getByRole('tab', { name: 'Start practice' }).click()
  await page.locator('.pr-strategies li button').click()
  await page.getByRole('button', { name: 'Start practice' }).click()
  await page.getByRole('alert').filter({ hasText: 'No day of this strategy with an Entry mark matches your choice' }).waitFor()
  assert.equal(calls('trading/start').length, 1)
  assert.deepEqual(errors, [])
  console.log(`Desktop Practice browser check passed: ${state.calls.length} requests`)
} finally { await browser.close(); await new Promise(r => server.close(r)) }
