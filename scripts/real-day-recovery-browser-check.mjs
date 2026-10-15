/** Actual website session hook with synthetic broker responses and a fake clock. */
import {resolve} from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(new URL('..',import.meta.url).pathname);
const {build}=await import(resolve(root,'frontend/node_modules/esbuild/lib/main.js'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const dir=await mkdtemp(tmpdir()+'/real-recovery-');
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{useSimulation}from'${root}/frontend/src/hooks/useSimulation';import api from'${root}/frontend/src/services/api';function Harness(){const sim=useSimulation();window.sim=sim;window.api=api;return <div><button onClick={()=>sim.restoreActiveGroup().catch(e=>window.restoreError=String(e))}>Restore</button><pre>{sim.sessionId}:{sim.sessionCapital}</pre><span data-testid="trade-count">{sim.trades.length}</span></div>}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html');res.end(await readFile(dir+(req.url==='/app.js'?'/app.js':'/index.html')))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[],calls=[];let failRestore=false,stallStart=false,refreshMode="valid";
 page.on('pageerror',error=>errors.push(String(error)));
 const session={session_id:'main-book',symbol:'NIFTY',date:'2026-10-15',start_time:'09:15:00',speed:1,session_type:'real',instrument_type:'equity',state:'running',session_capital:50000};
 const flat={symbol:'NIFTY',side:'FLAT',quantity:0,avg_entry_price:0};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;calls.push({path,method:route.request().method()});let value={};
  if(path.endsWith('/simulation/active')&&new URL(route.request().url()).searchParams.get('session_id')==='paper-ended')return route.fulfill({status:404,json:{detail:'Session not found'}});
  if(path.endsWith('/groups/active')){if(failRestore)return route.fulfill({status:503,json:{detail:'Temporary backend recovery'}});value=null}
  else if(path.endsWith('/brokers/status'))value={broker:'kotak',authenticated:true,active_session_id:'main-book'};
  else if(path.endsWith('/recover')||path.endsWith('/simulation/active'))value=session;
  else if(path.endsWith('/simulation/start')){if(stallStart)return;value=session}
  else if(path.endsWith('/close-summary'))value={position_count:0,pending_order_count:0,restrictions_enabled:false};
  else if(path.endsWith('/simulation/stop'))value={status:'stopped'};
  else if(path.endsWith('/brokers/main-book/refresh')){
   if(refreshMode==='failure')return route.fulfill({status:503,json:{detail:'Broker temporarily unavailable'}});
   value=refreshMode==='invalid'?{positions:[],verified_flat:true}:{orders:[],open_orders:[],trades:[],application_orders:[],positions:[],session_capital:50000,state_version:10,state_generation:'test'};
  }
  else if(path.endsWith('/position-snapshot'))value={session_id:'main-book',positions:[],trades:[],application_orders:[],state_version:1,state_generation:'test'};
  else if(path.endsWith('/position'))value=flat;
  else if(path.endsWith('/by-context'))value={trades:[],sessionIds:[]};
  else if(path.endsWith('/trades')||path.endsWith('/orders'))value=[];
  return route.fulfill({status:200,json:value,headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.clock.install();
 await page.getByRole('button',{name:'Restore',exact:true}).click();
 await page.getByText('main-book:50000',{exact:true}).waitFor();
 await page.waitForFunction(()=>window.sim.sessionId==='main-book');
 const beats=()=>calls.filter(c=>c.path.endsWith('/heartbeat')).length;
 await page.waitForTimeout(20);assert.equal(beats(),1);
 await page.clock.fastForward(179000);assert.equal(beats(),1);
 await page.clock.fastForward(1000);await page.waitForTimeout(20);assert.equal(beats(),2);
 assert.equal(calls.filter(c=>c.path.endsWith('/simulation/start')).length,0);
 assert.equal(calls.filter(c=>c.path.endsWith('/recover')).length,1);
 // Transient restoration failure remains an error, never a false "no session".
 failRestore=true;await page.getByRole('button',{name:'Restore',exact:true}).click();
 await page.waitForFunction(()=>window.restoreError?.includes('503'));
 assert.equal(await page.evaluate(()=>window.sim.sessionId),'main-book');
 // A timed-out Start checks status and attaches; it never dispatches another Start.
 stallStart=true;
 await page.evaluate(()=>{window.startResult=null;window.api.startSimulation({session_type:'real',symbol:'NIFTY',date:'2026-10-15',instrument_type:'equity'}).then(v=>window.startResult=v).catch(e=>window.startError=String(e))});
 await page.clock.fastForward(31000);
 await page.waitForFunction(()=>window.startResult?.session_id==='main-book');
 assert.equal(calls.filter(c=>c.path.endsWith('/simulation/start')).length,1);
 const recoverCount=calls.filter(c=>c.path.endsWith('/recover')).length;
 const paperError=await page.evaluate(()=>window.sim.attachToActiveSession('paper-ended').then(()=>null).catch(e=>e.status));
 assert.equal(paperError,404);assert.equal(calls.filter(c=>c.path.endsWith('/recover')).length,recoverCount);
 // Trade History uses a complete broker snapshot, not the verification report.
 await page.evaluate(async()=>{window.sim.applyBrokerSnapshot('main-book',await window.api.reconcileKotakOrders('main-book'))});
 await page.getByText('main-book:50000',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('trade-count').textContent(),'0');
 for(const mode of ['invalid','failure']){
  refreshMode=mode;
  const message=await page.evaluate(()=>window.api.reconcileKotakOrders('main-book').then(()=>null).catch(error=>String(error)));
  assert.match(message,mode==='invalid'?/Incomplete broker history/:/Broker temporarily unavailable/);
  assert.equal(await page.getByTestId('trade-count').textContent(),'0');
 }
 const beforeStop=beats();let dialogs=0;page.on('dialog',dialog=>{dialogs++;void dialog.dismiss()});
 await page.evaluate(()=>window.sim.stopSession());
 await page.waitForFunction(()=>window.sim.sessionState==='ended');
 assert.equal(dialogs,0);
 await page.clock.fastForward(181000);assert.equal(beats(),beforeStop);
 assert(calls.some(c=>c.path.endsWith('/brokers/main-book/refresh')));
 assert(!calls.some(c=>c.path.endsWith('/reconcile')));
 assert.deepEqual(errors,[]);
 console.log('Website: refresh success/malformed/503 retains rendered state; Stop has no popup and ends heartbeat; existing main book restored without Start; original capital; immediate/3-minute presence; transient restore error preserved; timed-out Start checks status without duplicate submission.');
}finally{await browser.close();await new Promise(done=>server.close(done))}
