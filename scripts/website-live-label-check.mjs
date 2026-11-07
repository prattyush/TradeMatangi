/** Website in-session labeling (replay/paper/real share this panel): behavior checklists beside the entry/exit label popups. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const dir = await mkdtemp(join(tmpdir(), 'website-live-label-'))
const artifacts = root + '/.cache/desktop-analysis-validation'
await mkdir(artifacts, { recursive: true })
await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import PendingLabelPanel from '${root}/frontend/src/components/PendingLabelPanel';
import StepwiseLabelPopup from '${root}/frontend/src/components/StepwiseLabelPopup';
import api from '${root}/frontend/src/services/api';
const copy=q=>({...q});
let questions=[{question_id:'qe',kind:'entry',text:'Chased the move',status:'active',sort_order:0,created_at:'2026-10-01',archived_at:null},{question_id:'qx',kind:'exit',text:'Exited after one bar in profit',status:'active',sort_order:1,created_at:'2026-10-02',archived_at:null},{question_id:'qo',kind:'exit',text:'Old habit',status:'archived',sort_order:2,created_at:'2026-10-03',archived_at:'2026-10-20T10:00:00Z'}];
let marks=[{round_trip_index:1,question_id:'qx',kind:'exit'},{round_trip_index:1,question_id:'qo',kind:'exit'}];
window.markSaves=[];window.labelSaves=[];window.failMarks=0;window.questionsDown=false;
api.patternListStrategies=async()=>({strategies:['Breakout']});api.patternListCategories=async()=>({categories:['Momentum']});
api.getEntryTags=async()=>[];api.getExitTags=async()=>[];
api.saveLabels=async rows=>{window.labelSaves.push(rows);return rows};
api.getBehaviorQuestions=async()=>{if(window.questionsDown)throw new Error('Behavior service down');return questions.map(copy)};
api.addBehaviorQuestion=async(text,kind)=>{const q={question_id:'n'+questions.length,kind,text:text.trim(),status:'active',sort_order:questions.length,created_at:'2026-10-05',archived_at:null};questions.push(q);return copy(q)};
api.updateBehaviorQuestion=async(id,text)=>{const q=questions.find(x=>x.question_id===id);q.text=text;return copy(q)};
api.archiveBehaviorQuestion=async id=>{const q=questions.find(x=>x.question_id===id);q.status='archived';return copy(q)};
api.restoreBehaviorQuestion=async id=>{const q=questions.find(x=>x.question_id===id);q.status='active';return copy(q)};
api.getBehaviorMarks=async()=>marks.map(copy);
api.saveBehaviorMarks=async(sid,idx,answers)=>{if(window.failMarks>0){window.failMarks--;throw new Error('Marks could not be saved')}window.markSaves.push({sid,idx,answers});for(const [q,v] of Object.entries(answers)){marks=marks.filter(m=>!(m.round_trip_index===idx&&m.question_id===q));if(v)marks.push({round_trip_index:idx,question_id:q,kind:questions.find(x=>x.question_id===q).kind})}return marks.filter(m=>m.round_trip_index===idx)};
window.removeKind=kind=>{questions=questions.filter(q=>q.kind!==kind)};
window.entrySaves=[];window.exitSaves=[];
const app=createRoot(document.getElementById('root'));
window.showPanel=()=>app.render(<PendingLabelPanel sessionId="s1" pendingExitLabels={[{right:null,round_trip_index:1,pnl:12.5,closed_at:Date.now()-120000}]} openLegs={[{right:'CE',rtIndex:0,label:'NIFTY CE'}]} savedEntryRtKeys={[]}
  onSaveEntry={async(i,r,f)=>{window.entrySaves.push([i,r,f])}} onSaveExit={async(i,r,f)=>{window.exitSaves.push([i,r,f])}}/>);
window.showStepwise=()=>app.render(<StepwiseLabelPopup sid="s1" date="2026-10-07" symbol="NIFTY" roundTrips={[{right:'CE',pnl:10,round_trip_index:0},{right:'PE',pnl:-5,round_trip_index:1}]} onDone={()=>{window.stepwiseDone=true}}/>);
`, resolveDir: root + '/frontend', loader: 'tsx' }, bundle: true, jsx: 'automatic', outfile: dir + '/app.js', define: { 'import.meta.env': '{}' }, nodePaths: [root + '/frontend/node_modules'], alias: { react: root + '/frontend/node_modules/react', 'react-dom': root + '/frontend/node_modules/react-dom' }, logLevel: 'silent' })
await writeFile(dir + '/index.html', '<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#0d1117;margin:0"><div id="root" style="width:320px;padding:12px"></div><script type="module" src="/app.js"></script></body></html>')
const server = createServer(async (req, res) => { try { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(dir + (req.url === '/' ? '/index.html' : req.url))) } catch { res.statusCode = 404; res.end() } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.showPanel)
  await page.evaluate(() => window.showPanel())
  const rows = () => page.evaluate(() => ({ marks: window.markSaves, entries: window.entrySaves.length, exits: window.exitSaves.length }))

  // Entry popup: only entry questions; toggle one and save -> label first, then the mark; popup closes.
  await page.getByTestId('entry-btn').click()
  const dialogText = () => page.locator('body').innerText()
  const entry = page.getByRole('group', { name: 'Entry behaviors' }); await entry.waitFor()
  assert.equal(await page.getByRole('group', { name: 'Exit behaviors' }).count(), 0, 'an entry label asks only entry questions')
  await entry.getByRole('switch', { name: /Chased the move/ }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await entry.waitFor({ state: 'detached' })
  assert.deepEqual(await rows(), { marks: [{ sid: 's1', idx: 0, answers: { qe: true } }], entries: 1, exits: 0 })

  // Exit popup: exit questions, pre-filled from the saved marks (incl. the archived-but-marked one); change one.
  await page.getByTestId('pendingexit-btn').click()
  const exit = page.getByRole('group', { name: 'Exit behaviors' }); await exit.waitFor()
  assert.equal(await exit.getByRole('switch', { name: /Exited after/ }).getAttribute('aria-checked'), 'true')
  assert.equal(await exit.getByRole('switch', { name: /Old habit/ }).getAttribute('aria-checked'), 'true')
  await exit.getByRole('switch', { name: /Exited after/ }).click()
  // A failing behavior save keeps the popup (and the choice) so Save can be retried; the label is re-sent, the mark is not lost.
  await page.evaluate(() => { window.failMarks = 1 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.exitSaves.length === 1)
  await exit.waitFor()
  assert.equal(await exit.getByRole('switch', { name: /Exited after/ }).getAttribute('aria-checked'), 'false', 'the toggle survives the failed save')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await exit.waitFor({ state: 'detached' })
  assert.deepEqual((await rows()).marks.at(-1), { sid: 's1', idx: 1, answers: { qx: false } })
  assert.equal((await rows()).exits, 2)

  // Nothing changed -> no behavior request at all.
  const before = (await rows()).marks.length
  await page.evaluate(() => window.showPanel())
  await page.getByTestId('pendingexit-btn').click(); await page.getByRole('group', { name: 'Exit behaviors' }).waitFor()
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('group', { name: 'Exit behaviors' }).waitFor({ state: 'detached' })
  assert.equal((await rows()).marks.length, before, 'unchanged behaviors are not re-sent')

  // Empty state: no exit questions -> offer to add one; the manager opens above the popup and the checklist updates.
  await page.evaluate(() => { window.removeKind('exit') })
  await page.evaluate(() => window.showPanel())
  await page.getByTestId('pendingexit-btn').click()
  await page.getByText('No exit behavior questions yet.').waitFor()
  await page.getByRole('button', { name: 'Add questions' }).click()
  const manager = page.getByRole('dialog', { name: 'Behavior questions' }); await manager.waitFor()
  await manager.getByLabel('New question text').fill('Moved the stoploss out'); await manager.getByRole('radio', { name: 'Exit' }).click(); await manager.getByRole('button', { name: 'Add question' }).click()
  await manager.getByText('Moved the stoploss out', { exact: true }).waitFor()
  await page.screenshot({ path: artifacts + '/website-live-label-manager.png' })
  await manager.getByRole('button', { name: 'Close' }).click(); await manager.waitFor({ state: 'detached' })
  await page.getByRole('group', { name: 'Exit behaviors' }).getByRole('switch', { name: /Moved the stoploss out/ }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Behavior data unavailable: labeling still works, with a note, and no behavior call.
  await page.evaluate(() => { window.questionsDown = true })
  const marksBefore = (await rows()).marks.length
  await page.getByTestId('pendingexit-btn').click()
  await page.getByText(/Behavior questions unavailable: Behavior service down/).waitFor()
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText(/Behavior questions unavailable/).waitFor({ state: 'detached' })
  assert.equal((await rows()).marks.length, marksBefore)
  await page.evaluate(() => { window.questionsDown = false })

  // Stepwise popup: entry and exit questions per round trip, saved after the labels.
  await page.evaluate(() => window.showStepwise())
  await page.getByText('Label Trades', { exact: false }).first().waitFor().catch(() => undefined)
  const entryGroups = page.getByRole('group', { name: 'Entry behaviors' })
  await entryGroups.first().waitFor(); assert.equal(await entryGroups.count(), 2, 'one entry checklist per round trip')
  await entryGroups.nth(0).getByRole('switch').click()
  await page.getByRole('group', { name: 'Exit behaviors' }).nth(1).getByRole('switch', { name: /Moved the stoploss out/ }).click()
  await page.getByRole('button', { name: 'Save & Continue' }).click()
  await page.waitForFunction(() => window.stepwiseDone === true)
  const saved = await page.evaluate(() => ({ labels: window.labelSaves.at(-1).length, marks: window.markSaves.slice(-2) }))
  assert.equal(saved.labels, 2)
  // Trade 0 was marked earlier, so the popup pre-fills it and the click clears it; only changes are sent.
  assert.deepEqual(saved.marks, [{ sid: 's1', idx: 0, answers: { qe: false } }, { sid: 's1', idx: 1, answers: { n1: true } }])
  assert.deepEqual(errors, [])
  console.log('Website in-session behavior labeling (entry/exit popups, stepwise) passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
