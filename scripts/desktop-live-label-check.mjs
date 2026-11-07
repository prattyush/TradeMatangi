/** Desktop in-session labeling (replay/paper/real): behavior checklists in the Expected/Actual pattern popups. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'desktop-live-label-'))
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {DesktopLabelPanel} from '${root}/windowsapp/src/App.tsx';
import '${root}/windowsapp/src/styles.css';
const copy=q=>({...q});
let questions=[{question_id:'qe',kind:'entry',text:'Chased the move',status:'active',sort_order:0,created_at:'2026-10-01',archived_at:null},{question_id:'qx',kind:'exit',text:'Exited after one bar in profit',status:'active',sort_order:1,created_at:'2026-10-02',archived_at:null},{question_id:'qo',kind:'exit',text:'Old habit',status:'archived',sort_order:2,created_at:'2026-10-03',archived_at:'2026-10-20T10:00:00Z'}];
let marks=[{round_trip_index:2,question_id:'qo',kind:'exit'}];
window.saves=[];window.markSaves=[];window.failMarks=0;window.removeKind=kind=>{questions=questions.filter(q=>q.kind!==kind)};
const behaviorApi={
  getBehaviorQuestions:async()=>questions.map(copy),
  addBehaviorQuestion:async(text,kind)=>{const q={question_id:'n'+questions.length,kind,text:text.trim(),status:'active',sort_order:questions.length,created_at:'2026-10-05',archived_at:null};questions.push(q);return copy(q)},
  updateBehaviorQuestion:async(id,text)=>{const q=questions.find(x=>x.question_id===id);q.text=text;return copy(q)},
  archiveBehaviorQuestion:async id=>{const q=questions.find(x=>x.question_id===id);q.status='archived';return copy(q)},
  restoreBehaviorQuestion:async id=>{const q=questions.find(x=>x.question_id===id);q.status='active';return copy(q)},
  getBehaviorMarks:async()=>marks.map(copy),
  saveBehaviorMarks:async(sid,idx,answers)=>{if(window.failMarks>0){window.failMarks--;throw new Error('Analysis request failed (503): {"detail":"Behavior marks unavailable"}')}window.markSaves.push({sid,idx,answers});for(const [q,v] of Object.entries(answers)){marks=marks.filter(m=>!(m.round_trip_index===idx&&m.question_id===q));if(v)marks.push({round_trip_index:idx,question_id:q,kind:questions.find(x=>x.question_id===q).kind})}return marks.filter(m=>m.round_trip_index===idx)},
};
const leg=(id,side)=>({trade_id:id,side,quantity:65,price:100,timestamp:1});
// A real session: slots come from the committed broker book (open CE index 3 while PE index 2 already closed).
const state={open:[{index:3,right:'CE',strike:25000,expiry:'2026-10-15',entry_trades:[leg('a','BUY')],exit_trades:[],pnl:0}],completed:[{index:2,right:'PE',strike:24900,expiry:'2026-10-15',entry_trades:[leg('b','BUY')],exit_trades:[leg('c','SELL')],pnl:-12.5}],labels:[]};
const metadata={categories:['Momentum'],strategies:['Breakout'],entry_tags:[],exit_tags:[]};
window.show=()=>createRoot(document.getElementById('root')).render(<React.StrictMode><DesktopLabelPanel state={state} metadata={metadata} metadataStatus="ready" metadataError="" onReloadMetadata={()=>{}} behaviorApi={behaviorApi} sessionId="real-1"
  onSave={async(rt,fields,behaviors)=>{window.saves.push({index:rt.index,fields,behaviors});if(behaviors&&Object.keys(behaviors).length)await behaviorApi.saveBehaviorMarks('real-1',rt.index,behaviors)}}/></React.StrictMode>);
`, resolveDir: root + '/windowsapp', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, nodePaths: [root + '/windowsapp/node_modules'], alias: { react: root + '/windowsapp/node_modules/react', 'react-dom': root + '/windowsapp/node_modules/react-dom' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root" style="width:300px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.show); await page.evaluate(() => window.show())
  // Real session open trade: Expected-pattern popup asks only entry questions.
  await page.getByRole('button', { name: /CE 25000 open/ }).click()
  const popup = page.getByRole('dialog', { name: 'Label expected strategy' })
  const entry = popup.getByRole('group', { name: 'Entry behaviors' }); await entry.waitFor()
  assert.equal(await popup.getByRole('group', { name: 'Exit behaviors' }).count(), 0)
  await entry.getByRole('switch', { name: /Chased the move/ }).click()
  await popup.getByRole('button', { name: 'Save' }).click(); await popup.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => ({ saves: window.saves.map(s => [s.index, s.behaviors]), marks: window.markSaves })), { saves: [[3, { qe: true }]], marks: [{ sid: 'real-1', idx: 3, answers: { qe: true } }] })
  // Closed trade: Actual-pattern popup shows exit questions with the saved (archived) mark; a failed save stays open with a readable error.
  await page.getByRole('button', { name: /PE 24900 close/ }).click()
  const exitPopup = page.getByRole('dialog', { name: 'Label actual strategy' })
  const exit = exitPopup.getByRole('group', { name: 'Exit behaviors' }); await exit.waitFor()
  assert.equal(await exit.getByRole('switch', { name: /Old habit/ }).getAttribute('aria-checked'), 'true')
  await exit.getByRole('switch', { name: /Exited after/ }).click()
  await page.evaluate(() => { window.failMarks = 1 })
  await exitPopup.getByRole('button', { name: 'Save' }).click()
  await exitPopup.getByRole('alert').filter({ hasText: 'Behavior marks unavailable' }).waitFor()
  assert.equal(await exit.getByRole('switch', { name: /Exited after/ }).getAttribute('aria-checked'), 'true', 'the choice survives the failed save')
  await exitPopup.getByRole('button', { name: 'Save' }).click(); await exitPopup.waitFor({ state: 'detached' })
  assert.deepEqual((await page.evaluate(() => window.markSaves)).at(-1), { sid: 'real-1', idx: 2, answers: { qx: true } })
  assert.equal(await page.evaluate(() => window.saves.length), 3, 'the label is re-sent on retry, the behavior mark is saved once')
  // No entry questions: the popup offers to add one; the manager opens above it and the checklist updates in place.
  await page.evaluate(() => { window.removeKind('entry') })
  await page.evaluate(() => window.show())
  await page.getByRole('button', { name: /CE 25000 open/ }).click()
  const emptyPopup = page.getByRole('dialog', { name: 'Label expected strategy' })
  await emptyPopup.getByText('No entry behavior questions yet.').waitFor()
  await emptyPopup.getByRole('button', { name: 'Add questions' }).click()
  const manager = page.getByRole('dialog', { name: 'Behavior questions' }); await manager.waitFor()
  await manager.getByLabel('New question text').fill('Entered without a plan'); await manager.getByRole('button', { name: 'Add question' }).click()
  await manager.getByText('Entered without a plan', { exact: true }).waitFor()
  await page.screenshot({ path: artifacts + '/desktop-live-label.png' })
  await manager.getByRole('button', { name: 'Close' }).click(); await manager.waitFor({ state: 'detached' })
  await emptyPopup.getByRole('group', { name: 'Entry behaviors' }).getByRole('switch', { name: /Entered without a plan/ }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Desktop in-session behavior labeling (real-session slots, entry/exit popups, retry) passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
