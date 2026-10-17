/** Verify real Stats drawer selection beyond pagination, grouped closes and request fencing. */
import {build} from '../frontend/node_modules/esbuild/lib/main.js'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'journey-inspection-'))
const fixture=JSON.parse(execFileSync(process.env.PYTHON_BIN||'python3',['-c',`
import json
from app.services.performance_service import build_cycles,report
s=dict(session_id='session',user_id='user',symbol='NIFTY',session_type='paper',instrument_type='options',date='2026-10-15',session_capital=10000)
start=1792055700
rows=[]
for i in range(63):
    stamp=start+i*10 if i<60 else start+610
    for side,price,t in [('BUY',100,stamp),('SELL',101 if i%2 else 99,stamp+5)]:
        rows.append(dict(trade_id=str(i)+'-'+side,timestamp=t,side=side,quantity=1,price=price,commission=0,right='CE',strike=25000+i,expiry='2026-10-15'))
cycles=build_cycles(s,rows)
print(json.dumps(dict(cycles=cycles,report=report(cycles))))
`],{env:{...process.env,PYTHONPATH:root+'/backend'},encoding:'utf8'}))
await build({stdin:{contents:`
import React from 'react';import{createRoot}from'react-dom/client';
import{AnalysisProvider}from'${root}/shared/analysis/environment';
import PerformanceDashboard from '${root}/shared/analysis/PerformanceDashboard';
const fixture=${JSON.stringify(fixture)};
window.requests=[];window.detailDelay=0;window.failDetail=false;
const performance={getPerformance:async()=>fixture.report,getPerformanceCycles:async(_,offset=0)=>{window.requests.push({type:'page',offset});return {items:fixture.cycles.slice(offset,offset+50),total:63,next_offset:offset===0?50:null}},getPerformanceDetail:async identity=>{window.requests.push({type:'detail',...identity});const fail=window.failDetail,delay=window.detailDelay;await new Promise(r=>setTimeout(r,delay));if(fail)throw new Error('Synthetic detail failure');return fixture.cycles.find(c=>c.cycle_id===identity.cycle_id&&c.session_id===identity.session_id)}};
const app=createRoot(document.getElementById('root'));window.show=host=>{window.requests=[];app.render(<AnalysisProvider value={{api:{},performance,desktop:host==='desktop',active:true}}><PerformanceDashboard key={host} onClose={()=>{}} defaultSymbol="" defaultStartDate="2026-10-15" defaultEndDate="2026-10-15" defaultInstrumentType="" defaultSessionType=""/></AnalysisProvider>)};
`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0d1117;color:white"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(String(e)))
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.show)
 for(const host of ['website','desktop']){
  await page.evaluate(host=>window.show(host),host)
  await page.getByRole('button',{name:'Behavior',exact:true}).click()
  const chart=page.locator('.day-paths .day-journey'), drawer=page.getByRole('dialog',{name:'Trade cycle details'})
  await chart.locator('circle').nth(55).waitFor()
  const target=fixture.report.day_paths[0].points[55].members[0]
  await chart.locator('circle').nth(55).click()
  await page.waitForFunction(id=>document.querySelector('.pa-drawer')?.getAttribute('data-cycle-id')===id,target.cycle_id)
  assert.equal(await drawer.getAttribute('data-session-id'),'session')
  assert.deepEqual(await page.evaluate(()=>window.requests.filter(r=>r.type==='page').map(r=>r.offset)),[0])
  await page.getByRole('button',{name:'Close trade details'}).click()
  await chart.getByRole('button',{name:/^3 trades:/}).click()
  const members=chart.getByRole('group',{name:'Same-second trades'}).getByRole('button')
  assert.equal(await members.count(),3)
  await members.nth(1).click()
  const grouped=fixture.report.day_paths[0].points.at(-1).members[1]
  await page.waitForFunction(id=>document.querySelector('.pa-drawer')?.getAttribute('data-cycle-id')===id,grouped.cycle_id)
  await page.getByRole('button',{name:'Close trade details'}).click()
  // Failed inspection has a working Retry and does not pretend that an empty page is the trade.
  await page.evaluate(()=>window.failDetail=true)
  await chart.locator('circle').nth(54).click()
  await drawer.getByRole('alert').waitFor()
  await page.evaluate(()=>window.failDetail=false)
  await drawer.getByRole('button',{name:'Retry trade details'}).click()
  await page.waitForFunction(()=>document.querySelector('.pa-drawer')?.hasAttribute('data-cycle-id'))
  await page.getByRole('button',{name:'Close trade details'}).click()
  // Closing while a request is pending prevents the delayed drawer from reopening.
  await page.evaluate(()=>window.detailDelay=200)
  await chart.locator('circle').nth(53).click()
  await drawer.getByRole('status').waitFor()
  await page.getByRole('button',{name:'Close trade details'}).click()
  await page.waitForTimeout(250);assert.equal(await drawer.count(),0)
  await page.evaluate(()=>window.detailDelay=0)
  // A later selection must win even if the earlier lookup completes afterwards.
  await page.evaluate(()=>window.detailDelay=200)
  await chart.locator('circle').nth(52).click()
  await page.evaluate(()=>{window.detailDelay=0;document.querySelectorAll('.day-paths .day-journey circle')[51].dispatchEvent(new MouseEvent('click',{bubbles:true}))})
  const latest=fixture.report.day_paths[0].points[51].members[0]
  await page.waitForFunction(id=>document.querySelector('.pa-drawer')?.getAttribute('data-cycle-id')===id,latest.cycle_id)
  await page.waitForTimeout(250)
  assert.equal(await drawer.getAttribute('data-cycle-id'),latest.cycle_id)
  await page.getByRole('button',{name:'Close trade details'}).click()
  // Filter changes retire pending requests too.
  await page.evaluate(()=>window.detailDelay=200)
  await chart.locator('circle').nth(50).click()
  await page.getByRole('combobox',{name:'Symbol',exact:true}).selectOption('NIFTY')
  await page.waitForTimeout(250);assert.equal(await drawer.count(),0)
  await page.evaluate(()=>window.detailDelay=0)
  assert.deepEqual(errors,[],host)
 }
 console.log('Stats inspection passed on website/desktop: >50 cycles, direct identity lookup, grouped member choice, retry and close fencing')
}finally{await browser.close();await new Promise(r=>server.close(r))}
