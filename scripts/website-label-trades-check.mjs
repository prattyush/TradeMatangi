/** Website Label Trades: one round trip at a time (Prev/Next, auto-save, per-trade markers) and the All-together switch. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const renderer = process.env.ANALYSIS_RENDERER === 'kline' ? 'kline' : 'lightweight'
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-label-trades-'))
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import TradeLabeling from '${root}/frontend/src/components/TradeLabeling';
import api from '${root}/frontend/src/services/api';
import {init} from 'klinecharts';
window.getAnalysisChart=dom=>{dom.id=dom.getAttribute('k-line-chart-id');return init(dom)};
const end=Date.parse('2026-10-07T10:15:00Z')/1000;
const bars=Array.from({length:80},(_,i)=>({time:end-(79-i)*180,open:100+i,high:103+i,low:98+i,close:101+i}));
const leg=(trade_id,side,t,extra={})=>({trade_id,side,quantity:65,price:100+t,timestamp:end-(60-t)*180,...extra});
const ce={right:'CE',strike:25000,expiry:'2026-10-08'};
const trip0={index:0,right:null,pnl:120.5,entry_trades:[leg('t1','BUY',1)],exit_trades:[leg('t2','SELL',3)]};
const trip1={index:1,right:'CE',pnl:-45.25,entry_trades:[leg('t3','BUY',10,ce)],exit_trades:[leg('t4','SELL',12,ce)]};
const trade=(l,extra={})=>({...l,session_id:'s1',user_id:'u',symbol:'NIFTY',instrument_type:extra.right?'options':'equity',right:null,strike:null,expiry:null,commission:1,...extra});
const trades=[trade(trip0.entry_trades[0]),trade(trip0.exit_trades[0]),trade(trip1.entry_trades[0],ce),trade(trip1.exit_trades[0],ce)];
let labels=[];window.saves=[];window.settings=[];
api.getHistorical=async()=>({candles:bars});api.getPreSession=async()=>bars;api.getOptionsHistorical=async()=>({candles:bars});
api.getRoundTrips=async()=>[trip0,trip1];api.getLabels=async()=>labels;
api.saveLabels=async rows=>{window.saves.push(rows);labels=[...labels.filter(l=>!rows.some(r=>r.round_trip_index===l.round_trip_index)),...rows];return rows};
api.patternListStrategies=async()=>({strategies:['Breakout']});api.patternListCategories=async()=>({categories:['Momentum']});
api.getEntryTags=async()=>['AS_PER_PATTERN'];api.getExitTags=async()=>['AS_PER_PATTERN'];
api.getUserSettings=async()=>({analysis_label_view:'one_by_one'});
api.updateUserSettings=async s=>{window.settings.push(s);return s};
const app=createRoot(document.getElementById('root'));
app.render(<React.StrictMode><TradeLabeling symbol="NIFTY" date="2026-10-07" sessionIds={['s1']} allTrades={trades} historicalDays={2}/></React.StrictMode>);
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, nodePaths: [root + '/frontend/node_modules'], alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, loader: { '.css': 'css' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#0d1117;margin:0"><div id="root" style="width:min(1200px,100vw);min-height:700px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(value => { localStorage.setItem('website-analysis-renderer::', value) }, renderer)
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Previous trade' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Save Labels', exact: true }).count(), 0, 'no explicit Save in one-at-a-time mode')
  // The equity trade has no option contract, so only the Underlying pane is shown.
  const underlying = page.getByLabel('Underlying chart pane'), strike = page.getByLabel('Strike chart pane')
  await underlying.waitFor(); assert.equal(await strike.count(), 0)
  await underlying.locator('canvas').first().waitFor()
  // Edit trade 1, then Next: only that trade is saved, before navigating.
  await page.locator('input[list^="et-"]').first().fill('FIRST TAG')
  await page.getByRole('button', { name: 'Next trade' }).click()
  await page.getByText('Trade 2 of 2', { exact: true }).waitFor()
  let saves = await page.evaluate(() => window.saves)
  assert.deepEqual(saves.map(rows => rows.map(r => [r.round_trip_index, r.entry_tag, r.exit_tag])), [[[0, 'FIRST TAG', 'AS_PER_PATTERN']]])
  // Trade 2 is the CE trade: the Underlying and its own strike are stacked, both with its markers.
  await underlying.waitFor(); await strike.waitFor(); await strike.locator('canvas').first().waitFor()
  const heights = await Promise.all([underlying, strike].map(pane => pane.evaluate(el => el.getBoundingClientRect().height)))
  assert.ok(heights.every(h => h > 200), `both panes have usable height: ${heights}`)
  const boxes = await Promise.all([underlying, strike].map(pane => pane.boundingBox()))
  assert.ok(boxes[1].y >= boxes[0].y + boxes[0].height - 1, 'strike pane is stacked below the underlying pane')
  assert.equal(await page.getByRole('button', { name: 'Next trade' }).isDisabled(), true)
  if (renderer === 'kline') {
    // Both KLine panes centre on the viewed trade's entry (zoom is kept); Prev/Next recentres.
    const end = Date.parse('2026-10-07T10:15:00Z') / 1000, entry = { 2: end - 50 * 180, 1: end - 59 * 180 }
    const offset = async (pane, ts) => pane.locator('.analysis-kline').evaluate((el, at) => { const chart = window.getAnalysisChart(el); const p = chart.convertToPixel({ timestamp: at * 1000 }, { paneId: 'candle_pane' }); return Math.abs(p.x - chart.getSize('candle_pane', 'main').width / 2) }, ts)
    const settled = async (pane, ts) => { for (let n = 0; n < 40; n++) { if (await offset(pane, ts) < 30) return true; await page.waitForTimeout(100) } return false }
    assert.ok(await settled(underlying, entry[2]) && await settled(strike, entry[2]), 'KLine panes centre on trade 2 entry')
    await page.keyboard.press('ArrowLeft'); await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
    assert.ok(await settled(underlying, entry[1]), 'KLine underlying recentres on trade 1 entry')
    await page.keyboard.press('ArrowRight'); await page.getByText('Trade 2 of 2', { exact: true }).waitFor()
    assert.ok(await settled(underlying, entry[2]), 'KLine underlying recentres again on trade 2 entry')
  }
  await page.screenshot({ path: artifacts + '/website-label-one-by-one.png' })
  // Untouched trades are never written: navigating back and forth adds no save.
  await page.keyboard.press('ArrowLeft'); await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
  assert.equal(await page.locator('input[list^="et-"]').first().inputValue(), 'FIRST TAG')
  assert.equal((await page.evaluate(() => window.saves)).length, 1)
  // "All markers" shows the other trade's strike as well.
  assert.equal(await strike.count(), 0)
  await page.getByLabel('All markers').check(); await strike.waitFor(); await page.getByLabel('All markers').uncheck(); await page.waitForFunction(() => !document.querySelector('[aria-label="Strike chart pane"]'))
  // Debounced auto-save without navigating.
  await page.getByRole('group', { name: 'Round trips' }).getByRole('button', { name: '2', exact: true }).click(); await page.getByText('Trade 2 of 2', { exact: true }).waitFor()
  await page.locator('input[list^="et-"]').first().fill('SECOND TAG'); await page.getByText('Saved ✓', { exact: true }).waitFor()
  saves = await page.evaluate(() => window.saves)
  assert.deepEqual(saves.at(-1).map(r => [r.round_trip_index, r.entry_tag]), [[1, 'SECOND TAG']])
  // All together keeps the explicit Save, persists the choice, and lists both trades.
  await page.getByRole('group', { name: 'Label view' }).getByRole('button', { name: 'All together' }).click()
  await page.getByRole('button', { name: 'Save Labels', exact: true }).waitFor()
  assert.equal(await page.locator('input[list^="et-"]').count(), 2)
  assert.deepEqual(await page.evaluate(() => window.settings.at(-1)), { analysis_label_view: 'all' })
  await page.screenshot({ path: artifacts + '/website-label-all-together.png' })
  // Phone layout: one column, one chart pane at a time, Prev/Next in a sticky bottom bar, no sideways scroll.
  await page.getByRole('group', { name: 'Label view' }).getByRole('button', { name: 'One at a time' }).click()
  await page.getByText(/Trade \d of 2/).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  assert.ok(await overflow() <= 0, 'no horizontal scroll on a phone')
  const bar = page.locator('.tl-bottom-nav')
  await bar.waitFor()
  const barBox = await bar.boundingBox()
  assert.ok(Math.abs(barBox.y + barBox.height - 844) <= 1 && barBox.y > 400, `bottom bar is fixed to the bottom of the viewport: ${JSON.stringify(barBox)}`)
  await page.getByRole('button', { name: 'Next trade' }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.tl-head .tl-nav-button').first().isVisible(), false, 'header buttons hide on phones')
  const phoneCounter = await page.getByText(/Trade \d of 2/).textContent()
  await page.getByRole('button', { name: 'Previous trade' }).click(); await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Next trade' }).click(); await page.getByText('Trade 2 of 2', { exact: true }).waitFor()
  // Trade 2 has a strike: the pane tabs switch between the two charts.
  const tabs = page.getByRole('navigation', { name: 'Chart pane' })
  await tabs.waitFor(); assert.equal(await page.getByLabel('Strike chart pane').count(), 0)
  await tabs.getByRole('button', { name: 'CE 25000' }).click(); await page.getByLabel('Strike chart pane').waitFor()
  assert.equal(await page.getByLabel('Underlying chart pane').count(), 0)
  assert.ok(await overflow() <= 0, 'no horizontal scroll with the strike pane')
  await page.screenshot({ path: artifacts + '/website-label-phone.png' })
  // The bar stays reachable after scrolling the page.
  await page.mouse.wheel(0, 2000); await page.waitForTimeout(150)
  const scrolled = await bar.boundingBox(); assert.ok(scrolled.y + scrolled.height <= 845, 'bottom bar still on screen after scrolling')
  assert.deepEqual(errors, [])
  console.log('Website Label Trades one-at-a-time and all-together views passed in StrictMode')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
