/** Real Swing renderers and shared actions; synthetic Paper/Real APIs, no broker traffic. */
import {resolve} from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const root=resolve(new URL('..',import.meta.url).pathname);
const {build}=await import(root+'/frontend/node_modules/esbuild/lib/main.js');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const dir=await mkdtemp(tmpdir()+'/swing-orders-');
await build({stdin:{resolveDir:root+'/windowsapp',loader:'tsx',contents:`
import React from'react';import{createRoot}from'react-dom/client';import{init}from'klinecharts';
import Panel from'${root}/shared/SwingPortfolioPanel';import Desktop from'${root}/windowsapp/src/SwingChart';import Website from'${root}/frontend/src/components/SwingChart';import'${root}/windowsapp/src/styles.css';
window.calls=[];window.failEdit=false;const kind=new URLSearchParams(location.search).get('kind')||'LIMIT';const asset=new URLSearchParams(location.search).get('asset')||'equity';const surface=new URLSearchParams(location.search).get('surface')||'desktop';
const start=Date.parse('2026-10-15T09:15:00Z')/1000;const candles=Array.from({length:120},(_,i)=>({time:start+i*180,timestamp:start+i*180,open:100,high:120,low:80,close:100}));
let order={order_id:'exit-1',session_id:'child',user_id:'user',symbol:'HDFCBANK',side:kind==='TARGET'?'BUY':'SELL',order_type:kind,quantity:10,broker_filled_quantity:0,status:'PENDING',limit_price:110,trigger_price:110};const contract=asset==='equity'?{}:{instrument_type:asset,symbol:'NIFTY',expiry:'2026-10-27',...(asset==='options'?{right:'CE',strike:23000}:{})};order={...order,...contract,...(asset==='futures'?{side:kind==='STOPLOSS'?'SELL':'BUY',execution_role:kind==='STOPLOSS'?'exit':'entry',analytics:{futures:{contract:{tick_size:.05,lot_size:5}}}}:{})};let mode='paper';
const snapshot=()=>({portfolio:{session_id:'portfolio',state:'running',mode,execution_broker:'kite',session_capital:50000,guardrail_epoch:0,entries_paused:false},positions:[{symbol:'HDFCBANK',instrument_type:'equity',side:'LONG',quantity:10,avg_entry_price:100,mark_price:100,...contract}],open_orders:order?[order]:[],trades:[],contexts:[],pnl:0,wallet_balance:45000});
const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='capabilities')return{real_trading_enabled:true};if(path.startsWith('broker-status'))return{broker:'kite',authenticated:true};if(path.startsWith('active?'))mode=new URLSearchParams(path.split('?')[1]).get('mode');if(path.endsWith('/charts/history'))return{candles,provider:'kite',more:false};if(path.endsWith('/charts/workspace'))return{workspace:{panes:[{symbol:order?.symbol||'HDFCBANK',instrument_type:asset,...contract,interval:'3m',as_of_date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}],active:0,rail_open:true,ticket_open:true}};if(path.endsWith('/charts/watch'))return{watch_id:'watch'};if(path.startsWith('contracts/'))return{contracts:[{...contract,lot_size:asset==='futures'?5:1,tick_size:.05}]};if(path.endsWith('/amend-preview'))return{margin:200,fees:10,required_funds:210,existing_reservation:100,additional_funds:110,capital_revision:0,fee_hash:'f'.repeat(64),order_fingerprint:'a'.repeat(64)};if(method==='PATCH'){await new Promise(r=>setTimeout(r,50));if(window.failEdit)throw Error('Broker refused price edit');order={...order,limit_price:body.price,trigger_price:body.price,quantity:body.quantity??order.quantity}}if(path.endsWith('/cancel'))order=null;return snapshot()};
const subscribe=(path,receive)=>{if(path.includes('/charts/watch/')){window.emitQuote=(instrument,time=Date.now()/1000+19800)=>receive({quotes:[{instrument,time,close:107}],market_open:true,provider:'kite'});return()=>{window.emitQuote=null}}return()=>{}};
const drawings=async(path,method)=>path==='chart-settings'?{settings:{}}:{drawings:[]};
function Renderer(props){return surface==='desktop'?<Desktop {...props} drawingRequest={drawings}/>:<Website {...props}/>};
window.chart=()=>{const el=document.querySelector('.kline');el.id=el.getAttribute('k-line-chart-id');return init(el)};
createRoot(document.getElementById('root')).render(<Panel request={request} subscribe={subscribe} loadSymbols={async()=>[{symbol:'HDFCBANK',display_name:'HDFC Bank',chart_type:'equity',option_eligible:true},{symbol:'NIFTY',display_name:'NIFTY',chart_type:'index',option_eligible:true}]} renderChart={Renderer} surface={surface} onDetach={()=>{}}/>);
`},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom',klinecharts:root+'/windowsapp/node_modules/klinecharts'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://local').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(path==='/'?'/index.html':path)))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 for(const surface of ['desktop','website'])for(const mode of ['paper','real'])for(const asset of ['equity','options','futures']){
  const kind=process.env.SWING_ORDER_TYPE||'LIMIT',futureEntry=asset==='futures'&&kind!=='STOPLOSS';
  const page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/api/**',route=>route.fulfill({json:[]}));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?surface='+surface+'&asset='+asset+'&kind='+kind);
  if(mode==='real')await page.getByRole('combobox',{name:'Swing mode',exact:true}).selectOption('real');
  const panel=page.getByRole('region',{name:'Swing portfolio'});
  await panel.getByRole('button',{name:'Orders',exact:true}).click();
  await panel.getByRole('button',{name:'Edit order '+(asset==='equity'?'HDFCBANK':'NIFTY'),exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'Swing order actions'});
  await dialog.getByLabel('Order price',{exact:true}).fill('115');
  await dialog.getByLabel('Order total quantity',{exact:true}).fill(asset==='futures'?'10':'8');
  const saveOrder=async()=>{
    if(futureEntry) {await dialog.getByRole('button',{name:'Preview amendment',exact:true}).click();await dialog.getByRole('button',{name:'Confirm amendment',exact:true}).click()}
    else await dialog.getByRole('button',{name:'Save order',exact:true}).click();
  };
  await page.evaluate(()=>window.failEdit=true);
  await saveOrder();
  await dialog.getByText('Error: Broker refused price edit',{exact:true}).waitFor();
  assert.equal(await dialog.getByLabel('Order price',{exact:true}).inputValue(),'115');
  await page.evaluate(()=>window.failEdit=false);
  await saveOrder();
  await dialog.waitFor({state:'hidden'});
  const canvasIds=await page.locator('canvas').evaluateAll(nodes=>nodes.map((node,i)=>{node.dataset.identity=String(i);return node.dataset.identity}));
  const pointForLine = async (price) => {
    if(surface==='desktop') {
      await page.waitForFunction(()=>document.querySelector('.kline')&&window.chart().getOverlays().some(o=>o.extendData?.orderId==='exit-1'));
      const point=await page.evaluate(price=>window.chart().convertToPixel([{timestamp:(Date.parse('2026-10-15T09:15:00Z')/1000+119*180)*1000,value:price}],{paneId:'candle_pane'})[0],price);
      const box=await page.locator('.kline').boundingBox();return {x:box.x+140,y:box.y+point.y};
    }
    await page.waitForTimeout(150);
    return page.locator('canvas').evaluateAll(nodes=>{let best=null;for(const node of nodes){if(node.width<250||node.height<150)continue;const ctx=node.getContext('2d');if(!ctx)continue;const data=ctx.getImageData(0,0,node.width,node.height).data;for(let y=20;y<node.height-20;y++){let count=0;for(let x=70;x<node.width-110;x++){const i=(y*node.width+x)*4;if(Math.abs(data[i]-170)<3&&Math.abs(data[i+1]-170)<3&&Math.abs(data[i+2]-170)<3&&data[i+3]>240)count++}if(count>40&&(!best||count>best.count)){const rect=node.getBoundingClientRect();best={count,x:rect.x+rect.width*.4,y:rect.y+y*rect.height/node.height}}}}return best});
  };
  // A real drag submits once, does not open the action dialog, and a refused edit restores the confirmed line.
  const patches=()=>page.evaluate(()=>window.calls.filter(c=>c.method==='PATCH').length);
  let point=await pointForLine(115);assert(point);
  const beforeDrag=await patches();
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y+30,{steps:8});await page.mouse.up();
  if(futureEntry) {
    await dialog.waitFor({state:'visible'});
    assert.equal(await patches(),beforeDrag,'Futures drag must wait for explicit margin approval');
    await saveOrder();await dialog.waitFor({state:'hidden'});
  }
  await page.waitForFunction(n=>window.calls.filter(c=>c.method==='PATCH').length===n+1,beforeDrag);
  await page.waitForTimeout(180);
  assert.equal(await dialog.count(),0,'Dragging must not open a menu');
  const confirmed=await page.evaluate(()=>window.calls.filter(c=>c.method==='PATCH').at(-1).body.price);
  assert(confirmed!==115);assert(Math.abs(confirmed/.05-Math.round(confirmed/.05))<1e-6);
  point=await pointForLine(confirmed);await page.evaluate(()=>window.failEdit=true);
  const beforeFail=await patches();
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y+25,{steps:8});await page.mouse.up();
  if(futureEntry) {await dialog.waitFor({state:'visible'});await saveOrder();await dialog.getByText('Error: Broker refused price edit',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Close order actions'}).click()}
  await page.waitForFunction(n=>window.calls.filter(c=>c.method==='PATCH').length===n+1,beforeFail);
  await page.waitForTimeout(180);await page.evaluate(()=>window.failEdit=false);
  if(surface==='desktop')assert.equal(await page.evaluate(()=>window.chart().getOverlays().find(o=>o.extendData?.orderId==='exit-1').points[0].value),confirmed,'Rejected drag restores confirmed overlay value');
  // Clear the inline failure banner before comparing coordinates (it occupies layout space).
  await panel.getByRole('button',{name:'Edit order '+(asset==='equity'?'HDFCBANK':'NIFTY'),exact:true}).first().click();
  await dialog.getByRole('button',{name:'Close order actions'}).click();
  await page.waitForTimeout(180);
  const restored=await pointForLine(confirmed);assert(Math.abs(restored.y-point.y)<3,'Rejected drag must restore line');
  // Price pick changes only the editor draft; closing it sends no request.
  await panel.getByRole('button',{name:'Edit order '+(asset==='equity'?'HDFCBANK':'NIFTY'),exact:true}).first().click();
  assert(await dialog.getByRole('button',{name:'LTP',exact:true}).isDisabled(),'Missing quote must not use candles as LTP');
  const beforeQuote=await patches();
  await page.evaluate(()=>window.emitQuote({symbol:'OTHER'}));
  assert(await dialog.getByRole('button',{name:'LTP',exact:true}).isDisabled(),'Another contract quote must not be used');
  await page.evaluate(asset=>window.emitQuote(asset==='equity'?{symbol:'HDFCBANK'}:asset==='options'?{underlying:'NIFTY',right:'CE',strike:23000,expiry:'2026-10-27'}:{underlying:'NIFTY',expiry:'2026-10-27'}),asset);
  await dialog.getByRole('button',{name:'LTP',exact:true}).click();
  assert.equal(Number(await dialog.getByLabel('Order price',{exact:true}).inputValue()),107);
  assert.equal(await patches(),beforeQuote,'LTP must only update the draft');
  await page.evaluate(asset=>window.emitQuote(asset==='equity'?{symbol:'HDFCBANK'}:asset==='options'?{underlying:'NIFTY',right:'CE',strike:23000,expiry:'2026-10-27'}:{underlying:'NIFTY',expiry:'2026-10-27'},Date.now()/1000+19800-180),asset);
  await page.waitForTimeout(60);
  assert(await dialog.getByRole('button',{name:'LTP',exact:true}).isDisabled(),'Stale quote must not be used');
  const beforePick=await patches();
  await dialog.getByRole('button',{name:'Pick on chart',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.mouse.click(restored.x,restored.y+15);
  await dialog.waitFor({state:'visible'});
  assert(Number(await dialog.getByLabel('Order price',{exact:true}).inputValue())!==confirmed);
  assert.equal(await patches(),beforePick,'Picking must not amend before Save');
  await dialog.getByRole('button',{name:'Close order actions'}).click();
  point=await pointForLine(confirmed);await page.waitForTimeout(450);await page.mouse.click(point.x,point.y);
  await dialog.getByRole('button',{name:'Edit order',exact:true}).waitFor();
  assert.equal(await dialog.getByText(/Convert.*stoploss/i).count(),0);
  await dialog.getByRole('button',{name:'Edit order',exact:true}).click();
  await dialog.getByLabel('Order price',{exact:true}).fill('116');
  await saveOrder();
  await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await page.locator('canvas').evaluateAll(nodes=>nodes.map(node=>node.dataset.identity)),canvasIds);
  point=await pointForLine(116);
  const mutationsBeforeMenu=await page.evaluate(()=>window.calls.filter(c=>c.method==='PATCH'||c.path.endsWith('/orders')).length);
  await page.mouse.click(point.x,point.y+30,{button:'right'});
  const menu=page.getByRole('menu',{name:'Swing chart orders'});
  await menu.getByRole('menuitem',{name:/SELL Stoploss/}).click();
  assert.equal(await panel.getByRole('combobox',{name:'Side',exact:true}).inputValue(),'SELL');
  assert.equal(await panel.getByRole('combobox',{name:'Order',exact:true}).inputValue(),'STOPLOSS');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='PATCH'||c.path.endsWith('/orders')).length),mutationsBeforeMenu);
  await panel.getByRole('button',{name:'Cancel order '+(asset==='equity'?'HDFCBANK':'NIFTY'),exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.path==='portfolio/orders/exit-1/cancel'));
  assert.equal(await panel.getByRole('button',{name:'Edit order '+(asset==='equity'?'HDFCBANK':'NIFTY'),exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log(surface+' '+mode+' '+asset+' '+kind+': list edit/retry, drag/tick snapping, rejected drag rollback, draft-only chart pick, chart-line edit, cancel; canvases retained.');await page.close();
 }
}finally{await browser.close();await new Promise(done=>server.close(done))}
