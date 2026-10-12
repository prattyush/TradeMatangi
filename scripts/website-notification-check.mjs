/** Header notification FIFO/history and actual website order-panel clickability. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname)
const dir=await mkdtemp(join(tmpdir(),'notification-check-'))
const artifacts=root+'/.cache/website-header-notifications';await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`
import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{createChart}from'lightweight-charts';
import Center,{NotificationHeadline}from'${root}/frontend/src/components/NotificationCenter';import OrderPanel from '${root}/frontend/src/components/OrderPanel';import api from '${root}/frontend/src/services/api';window.fixtureApi=api;
import{flashMessage,flashPatternAlert,setNotificationAccount,setNotificationContext,getNotifications,clearNotifications,flushNotifications}from'${root}/frontend/src/services/notifications';
setNotificationAccount('alice','fixture');setNotificationContext({sessionId:'real-sensex',symbol:'BSESEN',mode:'real'});
window.notify=flashMessage;window.pattern=flashPatternAlert;window.account=id=>setNotificationAccount(id,'fixture');window.clear=clearNotifications;window.messages=getNotifications;window.flush=flushNotifications;window.actions=[];
const flat={side:'FLAT',quantity:0,avg_entry_price:0};const pending={session_id:'s',order_id:'edit-me',order_type:'LIMIT',side:'BUY',status:'PENDING',quantity:65,limit_price:100,trigger_price:0,is_stoploss:false,right:'CE',strike:25000,expiry:'2026-10-13'};
function Harness(){const ref=useRef(null);const[request,setRequest]=useState(null);const[orders,setOrders]=useState([pending]);const[mode,setMode]=useState('real');window.mode=setMode;
useEffect(()=>{const c=createChart(ref.current,{width:ref.current.clientWidth,height:550,layout:{background:{color:'#0d1117'},textColor:'#ddd'},timeScale:{timeVisible:true}});const s=c.addCandlestickSeries();s.setData(Array.from({length:200},(_,i)=>({time:1791320400+i*180,open:73800+i,high:73830+i,low:73770+i,close:73810+i})));window.fixtureChart=c;window.chartCreates=(window.chartCreates||0)+1;const observer=new ResizeObserver(()=>c.applyOptions({width:ref.current.clientWidth}));observer.observe(ref.current);return()=>{observer.disconnect();c.remove()}},[]);
return <><header style={{height:50,display:'flex',gap:6,padding:'0 12px',alignItems:'center',color:'#ddd'}}><span>TradeMatangi</span><button>NIFTY</button><button>BSESEN</button><button id='add-session'>+ Add Session</button><NotificationHeadline onOpenHistory={notificationId=>setRequest({notificationId})}/><span id='day-pnl' style={{whiteSpace:'nowrap'}}>Day P&amp;L ₹0</span></header><main style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 320px',gap:8}}><div id='chart' ref={ref} style={{minWidth:0,overflow:'hidden'}}/><aside id='orders' style={{color:'#ddd',padding:8}}><OrderPanel sessionState='running' currentPrice={110} openOrders={orders} position={flat} positionCE={flat} positionPE={flat} sizingMode='quantity' fundsRatios={{l:1,m:2,h:3}} riskRatios={{l:1,m:2,h:3}} defaultSlPct={1} sessionCapital={100000} sessionType={mode} targetDeviationPct={.01} instrumentType='options' lotSize={65} activeRight='CE' onPlaceOrder={async(side)=>{window.actions.push(side)}} onCancelOrder={async(id)=>{window.actions.push('cancel');setOrders(prev=>prev.filter(o=>o.order_id!==id))}} onUpdateOrder={async(id,trigger,limit)=>{window.actions.push('edit');setOrders(prev=>prev.map(o=>o.order_id===id?{...o,limit_price:limit??o.limit_price}:o))}} onRequestPricePick={()=>{}} injectedEditPrice={null}/></aside></main><Center request={request} onRequestChange={setRequest} showLauncher={false}/></>}
createRoot(document.getElementById('root')).render(<Harness/>);
`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0d1117;font-family:Arial"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{const path=dir+(req.url==='/'?'/index.html':req.url);const file=await readFile(path);res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(file)}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try{
 const context=await browser.newContext({viewport:{width:1440,height:950},acceptDownloads:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)))
 const url=`http://127.0.0.1:${server.address().port}`;await page.goto(url);await page.waitForFunction(()=>window.fixtureChart)
 const bounds=await page.locator('#chart').boundingBox(),ordersBounds=await page.locator('#orders').boundingBox()
 const message='Order submission failed: '+('long error detail '.repeat(80))+'\nComplete diagnostic line'
 await page.evaluate(message=>{window.notify('Recovery warning','warning');window.notify('Conversion pending','info');window.notify('Order succeeded','success');window.notify(message,'error','Broker');window.notify('Second failure','error','Orders')},message)
 const headline=page.getByRole('button',{name:'Read current error message'});await headline.waitFor();assert.equal(await headline.count(),1)
 assert.match(await headline.innerText(),/Order submission failed/);assert.equal(await page.locator('.notification-card,.notification-flashes,.notification-standalone').count(),0)
 assert.deepEqual(await page.locator('#chart').boundingBox(),bounds);assert.deepEqual(await page.locator('#orders').boundingBox(),ordersBounds);assert.equal(await page.evaluate(()=>window.chartCreates),1)
 const slot=await page.locator('.notification-header').boundingBox(),add=await page.locator('#add-session').boundingBox(),pnl=await page.locator('#day-pnl').boundingBox()
 assert(slot.x>=add.x+add.width&&slot.x+slot.width<=pnl.x,'Notification stays between Add Session and Day P&L')
 assert(await page.locator('.notification-headline span').evaluate(el=>el.scrollWidth>el.clientWidth),'Long headlines are clipped')
 const panel=page.locator('#orders');await panel.getByRole('button',{name:'Mkt',exact:true}).click()
 for(const mode of ['real','paper','sim','stepwise']){
   await page.evaluate(mode=>window.mode(mode),mode)
   await panel.getByRole('button',{name:'BUY',exact:true}).click();await panel.getByRole('button',{name:/^BUY Mkt/}).click()
   await panel.getByRole('button',{name:'SELL',exact:true}).click();await panel.getByRole('button',{name:/^SELL Mkt/}).click()
 }
 assert.deepEqual(await page.evaluate(()=>window.actions),['BUY','SELL','BUY','SELL','BUY','SELL','BUY','SELL'])
 await panel.locator('[title="Click to edit price"]').click();await panel.getByText('New limit price',{exact:true}).waitFor();await panel.getByText('New limit price',{exact:true}).locator('..').getByRole('spinbutton').first().fill('105')
 await panel.getByRole('button',{name:'Save order edits',exact:true}).click();await page.waitForFunction(()=>window.actions.includes('edit'))
 await panel.getByTitle('Cancel order',{exact:true}).click();await page.waitForFunction(()=>window.actions.includes('cancel'))
 await page.screenshot({path:artifacts+'/header-errors-order-panel.png'})
 await headline.click();const history=page.getByRole('dialog',{name:'Message history'});await history.waitFor()
 assert.match(await history.innerText(),/Complete diagnostic line/);assert.match(await history.innerText(),/Recovery warning/);assert.match(await history.innerText(),/Order succeeded/);assert.match(await history.innerText(),/BSESEN.*real.*Session real-sensex/);assert.match(await history.innerText(),/IST/)
 const selectedId=await page.evaluate(()=>window.messages().visible[0]);const selected=page.locator(`[id="message-${selectedId}"]`);assert(await selected.isVisible())
 const downloadPromise=page.waitForEvent('download');await history.getByRole('button',{name:'Download',exact:true}).click();const download=await downloadPromise;const json=JSON.parse(await readFile(await download.path(),'utf8'));assert.equal(json.length,5)
 await page.keyboard.press('Escape');await history.waitFor({state:'hidden'})
 await page.getByRole('button',{name:'Dismiss message',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.notification-headline')?.textContent.includes('Second failure'))
 await page.waitForTimeout(8100);assert.equal(await headline.count(),0);assert.deepEqual(await page.locator('#chart').boundingBox(),bounds)
 await page.evaluate(()=>window.flush());await page.reload();await page.waitForFunction(()=>window.fixtureChart);assert.equal(await headline.count(),0)
 await page.getByRole('button',{name:/Message history/}).click();assert.match(await history.innerText(),/Recovery warning/)
 await page.evaluate(()=>window.account('bob'));await history.getByText('No messages recorded.',{exact:true}).waitFor();await page.evaluate(()=>window.account('alice'))
 await page.setViewportSize({width:420,height:800});const drawer=await history.boundingBox();assert.ok(drawer.x>=0&&drawer.x+drawer.width<=420)
 await page.screenshot({path:artifacts+'/narrow-history.png'});await page.getByRole('button',{name:'Close message history'}).click()
 await page.setViewportSize({width:768,height:950});await page.evaluate(()=>window.notify('Narrow error'));await headline.waitFor()
 const narrowSlot=await page.locator('.notification-header').boundingBox(),narrowOrders=await panel.boundingBox();assert(narrowSlot.y+narrowSlot.height<=narrowOrders.y)
 await panel.getByRole('button',{name:'Mkt',exact:true}).click();await panel.getByRole('button',{name:'BUY',exact:true}).click();await panel.getByRole('button',{name:/^BUY Mkt/}).click()
 await page.evaluate(()=>{window.clear();window.pattern({title:'Pattern warning',description:'Only history',severity:'warning'});window.pattern({title:'Critical pattern',description:'Full pattern detail',severity:'critical'})});await headline.waitFor();assert.match(await headline.innerText(),/Critical pattern/)
 await page.route(/\/api\/trades/,route=>route.fulfill({status:502,body:'Fixture failure'}));await page.evaluate(()=>window.fixtureApi.getTrades('fixture').catch(()=>{}))
 await headline.click();assert.match(await history.innerText(),/Get trades failed: 502/)
 await page.unroute(/\/api\/trades/);await page.route(/\/api\/trades/,async route=>{await new Promise(r=>setTimeout(r,150));await route.fulfill({status:503,body:'Late fixture failure'})})
 await page.evaluate(()=>{window.lateRequest=window.fixtureApi.getTrades('fixture').catch(()=>{})});await page.evaluate(()=>window.account('bob'));await page.evaluate(()=>window.lateRequest);assert.equal(await history.locator('article').count(),0)
 assert.deepEqual(errors,[]);await writeFile(artifacts+'/summary.json',JSON.stringify({passed:true,checks:['one error-only header headline','FIFO/dismissal/expiry','all severities in history','long text ellipsis and full details','Real/Paper/Replay/Stepwise Buy/Sell and order edit/cancel clickable','header location','stable chart bounds/instance','history download/IST/context','reload without replay','account isolation','narrow layout/history','pattern alerts journaled','API failure and stale account fencing','no page errors']},null,2));console.log('Header notification browser acceptance passed')
}finally{await browser.close();server.close()}
