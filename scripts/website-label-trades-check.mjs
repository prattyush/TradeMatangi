/** Website Label Trades: one round trip at a time (Prev/Next, auto-save, per-trade markers) and the All-together switch. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-label-trades-'))
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import TradeLabeling from '${root}/frontend/src/components/TradeLabeling';
import api from '${root}/frontend/src/services/api';
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
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#0d1117;margin:0"><div id="root" style="width:1200px;height:700px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Previous trade' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Save Labels', exact: true }).count(), 0, 'no explicit Save in one-at-a-time mode')
  // The equity trade has no option contract, so only the Underlying chart is offered.
  assert.equal(await page.getByRole('button', { name: /^CE 25000$/ }).count(), 0)
  await page.locator('canvas').first().waitFor()
  // Edit trade 1, then Next: only that trade is saved, before navigating.
  await page.locator('input[list^="et-"]').first().fill('FIRST TAG')
  await page.getByRole('button', { name: 'Next trade' }).click()
  await page.getByText('Trade 2 of 2', { exact: true }).waitFor()
  let saves = await page.evaluate(() => window.saves)
  assert.deepEqual(saves.map(rows => rows.map(r => [r.round_trip_index, r.entry_tag, r.exit_tag])), [[[0, 'FIRST TAG', 'AS_PER_PATTERN']]])
  // Trade 2 is the CE trade: its chart offers the Underlying and its own strike.
  await page.getByRole('button', { name: 'CE 25000' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Next trade' }).isDisabled(), true)
  await page.screenshot({ path: artifacts + '/website-label-one-by-one.png' })
  // Untouched trades are never written: navigating back and forth adds no save.
  await page.keyboard.press('ArrowLeft'); await page.getByText('Trade 1 of 2', { exact: true }).waitFor()
  assert.equal(await page.locator('input[list^="et-"]').first().inputValue(), 'FIRST TAG')
  assert.equal((await page.evaluate(() => window.saves)).length, 1)
  // "All markers" shows the other trade's strike as well.
  assert.equal(await page.getByRole('button', { name: 'CE 25000' }).count(), 0)
  await page.getByLabel('All markers').check(); await page.getByRole('button', { name: 'CE 25000' }).waitFor(); await page.getByLabel('All markers').uncheck()
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
  assert.deepEqual(errors, [])
  console.log('Website Label Trades one-at-a-time and all-together views passed in StrictMode')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
