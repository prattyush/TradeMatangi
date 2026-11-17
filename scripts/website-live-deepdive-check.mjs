/**
 * Website in-session labeling with the Deep Dive percentages (Phase 26): the entry popup of PendingLabelPanel (replay, paper and
 * real share it) and StepwiseLabelPopup. The API is stubbed in the page; no server, broker or database request is made.
 *
 *   PLAYWRIGHT_MODULE=/abs/path/to/playwright-core/index.mjs node scripts/website-live-deepdive-check.mjs
 */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-live-deepdive-'))
const artifacts = root + '/.cache/website-live-deepdive'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import PendingLabelPanel from '${root}/frontend/src/components/PendingLabelPanel';
import StepwiseLabelPopup from '${root}/frontend/src/components/StepwiseLabelPopup';
import api from '${root}/frontend/src/services/api';
const block=(days,tags,success,failed)=>({days,buy_days:0,sell_days:0,success,failed,with_outcome:success+failed,success_pct:success+failed?Math.round(1000*success/(success+failed))/10:null,outcome_few_days:true,
  tags:tags.map(([name,valid,notValid])=>({tag_id:name,name,valid,not_valid:notValid,marked:valid+notValid,pct:Math.round(1000*valid/(valid+notValid))/10,few_days:valid+notValid<5}))});
// Buy setups: a second leg follows 7 of 8 times (87.5%); Sell setups: 1 of 6 (16.7%).
const stats=[{category:'Momentum',strategy:'Breakout',owner_id:'alice',shared:false,all:block(14,[['Second leg',8,6]],6,5),buy:block(8,[['Second leg',7,1]],5,1),sell:block(6,[['Second leg',1,5]],1,4)}];
window.statsMode='ok';window.statsCalls=0;window.tripCalls=0;window.tripsMode='ok';
window.entrySaves=[];window.exitSaves=[];window.labelSaves=[];window.stepwiseDone=false;
api.patternListStrategies=async()=>({strategies:['Breakout']});api.patternListCategories=async()=>({categories:['Momentum']});
api.getEntryTags=async()=>[];api.getExitTags=async()=>[];
api.getBehaviorQuestions=async()=>[];api.getBehaviorMarks=async()=>[];api.saveBehaviorMarks=async()=>[];
api.saveLabels=async rows=>{window.labelSaves.push(rows);return rows};
api.getDeepDiveStats=()=>{window.statsCalls++;if(window.statsMode==='hang')return new Promise(()=>{});if(window.statsMode==='fail')return Promise.reject(new Error('Not Found'));return Promise.resolve(window.statsMode==='empty'?[]:stats)};
api.getRoundTrips=async()=>{window.tripCalls++;if(window.tripsMode==='fail')throw new Error('down');return [{index:0,entry_trades:[{side:'BUY'}]},{index:1,entry_trades:[{side:'BUY'}]}]};
const app=createRoot(document.getElementById('root'));
// EQ bought, CE sold, PE sold.
const legs=[{right:null,rtIndex:0,label:'NIFTY (equity)',action:'BUY'},{right:'CE',rtIndex:1,label:'NIFTY CE',action:'SELL'},{right:'PE',rtIndex:2,label:'NIFTY PE',action:'SELL'}];
window.showPanel=()=>app.render(<PendingLabelPanel sessionId="s1" pendingExitLabels={[{right:null,round_trip_index:9,pnl:5,closed_at:Date.now()-60000}]} openLegs={legs} savedEntryRtKeys={[]}
  onSaveEntry={async(i,r,f)=>{window.entrySaves.push([i,r,f])}} onSaveExit={async(i,r,f)=>{window.exitSaves.push([i,r,f])}}/>);
window.showStepwise=()=>app.render(<StepwiseLabelPopup sid="s1" date="2026-10-07" symbol="NIFTY" roundTrips={[{right:'CE',pnl:10,round_trip_index:0},{right:'PE',pnl:-5,round_trip_index:1}]} onDone={()=>{window.stepwiseDone=true}}/>);
window.hideAll=()=>app.render(null);
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, nodePaths: [root + '/frontend/node_modules'], alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#0d1117;margin:0"><div id="root" style="width:560px;padding:12px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.showPanel)
  const popup = () => page.locator('div[style*="position: fixed"]').last()
  const panel = () => page.locator('.dd-stats')
  const choose = async () => { const selects = popup().locator('select'); await selects.nth(0).selectOption('Momentum'); await selects.nth(1).selectOption('Breakout') }
  const open = async (index) => { await page.getByTestId('entry-btn').nth(index).click(); await popup().waitFor() }
  const mount = async (mode, show = 'showPanel') => { await page.evaluate(() => window.hideAll()); await page.waitForFunction(() => document.getElementById('root').childElementCount === 0) /* unmounted, so no state of the last popup survives */; await page.evaluate(m => { window.statsMode = m }, mode); await page.evaluate(s => window[s](), show) }

  // Entry popup: the panel appears once an expected strategy with a deep dive is chosen, on the side the position profits from.
  await mount('ok')
  await page.getByTestId('entry-btn').first().waitFor()
  await page.waitForFunction(() => window.statsCalls >= 1)
  await open(0) // equity bought: Buy
  assert.equal(await panel().count(), 0, 'no panel before a strategy is chosen')
  await choose()
  await panel().waitFor()
  assert.match(await panel().innerText(), /this position is Buy-side/)
  assert.match(await panel().innerText(), /87\.5%\s*\(n=8\)/)
  assert.match(await panel().innerText(), /Success 5 of 6 \(83\.3%\)/)
  await panel().getByRole('button', { name: /^Sell \(6\)/ }).click()
  assert.match(await panel().innerText(), /16\.7%/)
  // Saving sends exactly the label fields it always did.
  await popup().getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.entrySaves.length === 1)
  assert.deepEqual(await page.evaluate(() => window.entrySaves[0]), [0, null, { expected_category: 'Momentum', expected_strategy: 'Breakout', entry_tag: 'AS_PER_PATTERN' }])

  await open(1) // CE sold: Sell
  await choose(); await panel().waitFor()
  assert.match(await panel().innerText(), /this position is Sell-side/)
  await popup().getByRole('button', { name: 'Cancel' }).click()
  await open(2) // PE sold: Buy
  await choose(); await panel().waitFor()
  assert.match(await panel().innerText(), /this position is Buy-side/)
  assert.match(await panel().innerText(), /87\.5%/)
  await page.screenshot({ path: artifacts + '/entry-popup.png' })
  await popup().getByRole('button', { name: 'Cancel' }).click()

  // An exit popup (the Actual Pattern) shows no panel.
  await page.getByTestId('pendingexit-btn').click(); await popup().waitFor()
  await choose()
  assert.equal(await panel().count(), 0, 'the exit popup has no deep dive panel')
  await popup().getByRole('button', { name: 'Cancel' }).click()

  // Stats that never answer, fail or are empty: no panel, and the label still saves unchanged.
  for (const mode of ['hang', 'fail', 'empty']) {
    const before = await page.evaluate(() => window.entrySaves.length)
    await mount(mode)
    await page.getByTestId('entry-btn').first().waitFor()
    await open(0); await choose()
    await page.waitForTimeout(150)
    assert.equal(await panel().count(), 0, `no panel when the stats are ${mode}`)
    await popup().getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(n => window.entrySaves.length === n + 1, before)
    assert.deepEqual((await page.evaluate(() => window.entrySaves.at(-1)))[2], { expected_category: 'Momentum', expected_strategy: 'Breakout', entry_tag: 'AS_PER_PATTERN' })
  }

  // Stepwise: one panel per round trip under its own Expected Pattern; the side comes from the trade's opening order.
  await mount('ok', 'showStepwise')
  await page.waitForFunction(() => window.tripCalls >= 1)
  const expected = i => popup().locator('select').nth(i * 4)
  for (const i of [0, 1]) { await expected(i).selectOption('Momentum'); await popup().locator('select').nth(i * 4 + 1).selectOption('Breakout') }
  await panel().first().waitFor()
  assert.equal(await panel().count(), 2)
  assert.match(await panel().nth(0).innerText(), /this position is Buy-side/)  // CE bought
  assert.match(await panel().nth(1).innerText(), /this position is Sell-side/) // PE bought is bearish
  await popup().getByRole('button', { name: 'Save & Continue' }).click()
  await page.waitForFunction(() => window.stepwiseDone === true)
  const labels = await page.evaluate(() => window.labelSaves.at(-1))
  assert.equal(labels.length, 2)
  assert.deepEqual(Object.keys(labels[0]).sort(), ['actual_category', 'actual_strategy', 'entry_tag', 'exit_tag', 'expected_category', 'expected_strategy', 'round_trip_index', 'session_id'])

  // If the round trips cannot be read, the panel still shows, opened on All.
  await page.evaluate(() => { window.tripsMode = 'fail'; window.stepwiseDone = false })
  await mount('ok', 'showStepwise')
  await page.waitForFunction(() => window.tripCalls >= 2)
  await expected(0).selectOption('Momentum'); await popup().locator('select').nth(1).selectOption('Breakout')
  await panel().first().waitFor()
  assert.doesNotMatch(await panel().first().innerText(), /this position is/)
  assert.match(await panel().first().innerText(), /Success 6 of 11 \(54\.5%\)/)
  assert.deepEqual(errors, [])
  console.log('Website live labeling with Deep Dive percentages passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
