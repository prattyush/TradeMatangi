import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname)
const dir=await mkdtemp(join(tmpdir(),'notification-check-'))
const artifacts=root+'/.cache/website-notification-validation';await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`
import React,{useEffect,useRef}from'react';import{createRoot}from'react-dom/client';import{createChart}from'lightweight-charts';
import Center from '${root}/frontend/src/components/NotificationCenter';import api from '${root}/frontend/src/services/api';window.fixtureApi=api;
import{flashMessage,setNotificationAccount,setNotificationContext}from'${root}/frontend/src/services/notifications';
setNotificationAccount('alice','fixture');setNotificationContext({sessionId:'real-sensex',symbol:'BSESEN',mode:'real'});
window.notify=flashMessage;window.account=id=>setNotificationAccount(id,'fixture');
function Harness(){const ref=useRef(null);useEffect(()=>{const c=createChart(ref.current,{width:1100,height:650,layout:{background:{color:'#0d1117'},textColor:'#ddd'},timeScale:{timeVisible:true}});const s=c.addCandlestickSeries();s.setData(Array.from({length:200},(_,i)=>({time:1791320400+i*180,open:73800+i,high:73830+i,low:73770+i,close:73810+i})));window.fixtureChart=c;window.chartCreates=(window.chartCreates||0)+1;return()=>c.remove()},[]);return <><header style={{height:50,color:'#ddd'}}>TradeMatangi · Real · BSESEN</header><div id="chart" ref={ref}/><Center/></>};createRoot(document.getElementById('root')).render(<Harness/>);
`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0d1117"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{const path=dir+(req.url==='/'?'/index.html':req.url);const file=await readFile(path);res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(file)}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try{
 const context=await browser.newContext({viewport:{width:1440,height:950},acceptDownloads:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)))
 const url=`http://127.0.0.1:${server.address().port}`;await page.goto(url);await page.waitForFunction(()=>window.fixtureChart)
 const bounds=await page.locator('#chart').boundingBox()
 const timeout='Kotak positions: Kotak SDK/transport failure: (0) Reason: Request timeout after 30 seconds'
 const protection='Exit protection · BSESEN CE 73800 2026-10-08 · Recovery could not verify protection within 30 seconds; refresh to retry'
 await page.evaluate(({timeout,protection})=>{window.notify(timeout,'error','Broker');window.notify(protection,'warning','Exit protection');window.notify('Conversion to LIMIT pending Kotak confirmation','info','Kotak exit conversion')},{timeout,protection})
 await page.locator('.notification-card').first().waitFor();assert.equal(await page.locator('.notification-card').count(),3);assert.deepEqual(await page.locator('#chart').boundingBox(),bounds);assert.equal(await page.evaluate(()=>window.chartCreates),1)
 assert.equal(await page.evaluate(()=>document.elementFromPoint(300,300)?.tagName),'CANVAS');await page.mouse.click(300,300)
 await page.screenshot({path:artifacts+'/floating-messages.png'})
 await page.getByRole('button',{name:'Dismiss message'}).first().click();assert.deepEqual(await page.locator('#chart').boundingBox(),bounds)
 await page.getByRole('button',{name:/Message history/}).click();const history=page.getByRole('dialog',{name:'Message history'});await history.waitFor();assert.match(await history.innerText(),/BSESEN.*real.*Session real-sensex/);assert.match(await history.innerText(),/IST/)
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download',exact:true}).click();const download=await downloadPromise;const json=JSON.parse(await readFile(await download.path(),'utf8'));assert.equal(json.length,3)
 await page.screenshot({path:artifacts+'/history.png'});await page.getByRole('button',{name:'Close message history'}).click()
 await page.waitForTimeout(8300);assert.equal(await page.locator('.notification-card').count(),0);assert.deepEqual(await page.locator('#chart').boundingBox(),bounds)
 await page.reload();await page.waitForFunction(()=>window.fixtureChart);assert.equal(await page.locator('.notification-card').count(),0);await page.getByRole('button',{name:/Message history/}).click();assert.match(await page.getByRole('dialog').innerText(),/Recovery could not verify/)
 await page.evaluate(()=>window.account('bob'));assert.equal(await page.getByRole('dialog').getByText('No messages recorded.').count(),1);await page.evaluate(()=>window.account('alice'))
 await page.setViewportSize({width:420,height:800});await page.screenshot({path:artifacts+'/narrow-history.png'});const drawer=await page.getByRole('dialog').boundingBox();assert.ok(drawer.x>=0&&drawer.x+drawer.width<=420)
 await page.route(/\/api\/trades/,route=>route.fulfill({status:502,body:'Fixture failure'}))
 await page.evaluate(()=>window.fixtureApi.getTrades('fixture').catch(()=>{}));assert.match(await page.getByRole('dialog').innerText(),/Get trades failed: 502/)
 const recorded=await page.locator('.notification-history article').count()
 await page.route(/\/api\/pattern\/chart\/by-date/,route=>route.fulfill({status:404,body:'No saved pattern'}))
 await page.evaluate(()=>window.fixtureApi.patternGetChartByDate('BSESEN','2026-10-07','options').catch(()=>{}));assert.equal(await page.locator('.notification-history article').count(),recorded)
 await page.unroute(/\/api\/trades/)
 await page.route(/\/api\/trades/,async route=>{await new Promise(r=>setTimeout(r,150));await route.fulfill({status:503,body:'Late fixture failure'})})
 await page.evaluate(()=>{window.lateRequest=window.fixtureApi.getTrades('fixture').catch(()=>{})});await page.evaluate(()=>window.account('bob'));await page.evaluate(()=>window.lateRequest);assert.equal(await page.locator('.notification-history article').count(),0)
 assert.deepEqual(errors,[]);await writeFile(artifacts+'/summary.json',JSON.stringify({passed:true,checks:['3 floating severities','unchanged chart bounds on show/dismiss/expiry','same chart instance','chart interaction','IST timestamps/context','download','reload without replay','account isolation','narrow history','API failures journaled','expected 404 silent','late-account failures suppressed','no page errors']},null,2));console.log('Notification browser acceptance passed')
}finally{await browser.close();server.close()}
