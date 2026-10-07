/** Synthetic acceptance of the built desktop app. No broker/database requests. */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
const fixturePath = artifacts + '/browser-fixture.json'
execFileSync(process.env.PYTHON_BIN || 'python3', [root + '/scripts/phase20-browser-fixture.py', fixturePath], { env: {...process.env, PYTHONPATH:root + '/backend'} })
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const cycle = fixture.cycles[0]
const trades = cycle.executions.map(t => ({ ...t, session_id: cycle.session_id, user_id: 'alice', symbol: cycle.symbol, instrument_type: 'equity', right: null, strike: null, expiry: null }))
const session = { session_id: cycle.session_id, user_id: 'alice', symbol: cycle.symbol, date: cycle.date, instrument_type: 'equity', session_type: 'paper', session_capital: cycle.capital, trade_count: trades.length, round_trip_count: 1, buy_count: 1, sell_count: 1, net_pnl: cycle.net_pnl, pnl_pct: cycle.pnl_pct, total_commission: cycle.fees }
const start = Date.parse(cycle.date + 'T09:15:00Z') / 1000
const candles = Array.from({length:125}, (_, i) => ({time: start + i * 180, open:100+i/10, high:102+i/10, low:99+i/10, close:101+i/10}))
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    const data = await readFile(root + '/windowsapp/dist' + (path === '/' ? '/index.html' : path))
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(data)
  } catch { res.statusCode = 404; res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}, acceptDownloads:true})
  const errors = [], requests = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; requests.push({path,method:route.request().method()})
    let value = {}
    if (path === '/api/auth/desktop/token') value = {access_token:'synthetic-alice'}
    else if (path.endsWith('/analysis/sessions')) value = [session]
    else if (path.includes('/analysis/sessions/')) value = {...session, trades, cycles:[cycle]}
    else if (path.endsWith('/analysis/performance')) value = fixture.report
    else if (path.endsWith('/analysis/performance/cycles')) value = {items:fixture.cycles,total:fixture.cycles.length,next_offset:null}
    else if (path.includes('/analysis/performance/cycles/')) value = fixture.cycles.find(c => c.cycle_id === path.split('/').at(-1)) ?? cycle
    else if (path.endsWith('/data/historical')) value = {symbol:cycle.symbol,dates:[],candles: candles.map(c=>({...c,time:c.time-86400}))}
    else if (path.endsWith('/data/pre-session')) value = {candles}
    else if (path.endsWith('/pattern/chart/by-date')) { await route.fulfill({status:404,json:{detail:'No saved pattern'}}); return }
    else if (path.endsWith('/screens')) value = {screens:[]}
    else if (path.endsWith('/catalogue')) value = {instruments:[{symbol:'NIFTY',display_name:'NIFTY 50',exchange:'NSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,15]}]}
    else if (path.endsWith('/historical/pages')) value = {candles:[],available:true}
    else if (path.endsWith('/wallet')) value = {balance:150000}
    else if (path.endsWith('/candidate')) value = {status:'none'}
    else if (path.endsWith('/drawings')) value = {drawings:[]}
    else if (path.endsWith('/strategies')) value = {strategies:[]}
    else if (path.endsWith('/categories')) value = {categories:[]}
    else if (path.endsWith('/entry-tags') || path.endsWith('/exit-tags')) value = {tags:[]}
    else if (path.endsWith('/labels') || path.endsWith('/round-trips') || path.endsWith('/snapshots')) value = []
    await route.fulfill({status:200,json:value})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  const nav = page.getByRole('navigation',{name:'Desktop workspace'})
  await nav.getByRole('button',{name:'Analysis',exact:true}).click()
  await page.getByRole('complementary',{name:'Session navigator'}).getByRole('button').first().click()
  await page.locator('.analysis-kline').first().waitFor()
  await page.screenshot({path:artifacts+'/chart-layout.png'})
  assert.ok(await page.locator('.analysis-kline').first().evaluate(el => [...el.querySelectorAll('canvas')].some(c => c.height > 100)), 'Candlestick pane has usable height')
  await page.locator('.analysis-kline canvas:visible').first().waitFor()
  await page.getByRole('button',{name:/Inspect BUY execution/}).first().press('Enter')
  const inspector = page.getByRole('dialog',{name:'Execution inspector'})
  await inspector.getByRole('button',{name:'Open cycle'}).first().waitFor()
  await page.screenshot({path:artifacts+'/execution-inspector.png'})
  await inspector.getByRole('button',{name:'Open cycle'}).first().click()
  await page.getByRole('dialog',{name:'Trade cycle details'}).waitFor()
  await page.getByRole('button',{name:'Close trade details'}).click()
  for (const name of ['Overview','Entries','Exits','Sizing','Behavior']) await page.getByRole('navigation',{name:'Performance sections'}).getByRole('button',{name,exact:true}).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button',{name:/CSV/}).click()
  assert.match((await downloadPromise).suggestedFilename(), /performance.*csv/)
  await nav.getByRole('button',{name:'Workspace',exact:true}).click()
  assert.equal(await page.locator('.analysis-kline').count(),0)
  await nav.getByRole('button',{name:'Analysis',exact:true}).click()
  await page.getByRole('navigation',{name:'Analysis views'}).getByRole('button',{name:'Sessions',exact:true}).click()
  await page.locator('.analysis-kline canvas:visible').first().waitFor()
  await page.setViewportSize({width:800,height:700})
  await page.screenshot({path:artifacts+'/analysis-narrow.png'})
  await nav.getByRole('button',{name:'Workspace',exact:true}).click()
  await page.getByRole('button',{name:'Log out',exact:true}).click()
  assert.equal(await page.locator('.desktop-analysis').count(),0)
  assert.deepEqual(errors,[])
  assert.equal(requests.filter(r=>r.path.includes('/analysis/') && r.method !== 'GET').length,0)
  await writeFile(artifacts+'/browser-summary.json',JSON.stringify({passed:true,checks:['desktop login','lazy tab','session detail/KLine','keyboard inspector/cycle link','five Stats views','CSV','chart disposal/restoration','narrow viewport','logout isolation','no analysis trading writes'],errors,requests},null,2))
  console.log('Desktop Analysis integration acceptance passed')
} finally { await browser.close(); await new Promise(r=>server.close(r)) }
