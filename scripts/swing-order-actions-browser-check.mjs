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
window.calls=[];window.failEdit=false;const surface=new URLSearchParams(location.search).get('surface')||'desktop';
const start=Date.parse('2026-10-15T09:15:00Z')/1000;const candles=Array.from({length:120},(_,i)=>({time:start+i*180,timestamp:start+i*180,open:100,high:120,low:80,close:100}));
let order={order_id:'exit-1',session_id:'child',user_id:'user',symbol:'HDFCBANK',side:'SELL',order_type:'LIMIT',quantity:10,broker_filled_quantity:0,status:'PENDING',limit_price:110,trigger_price:110};let mode='paper';
const snapshot=()=>({portfolio:{session_id:'portfolio',state:'running',mode,execution_broker:'kite',session_capital:50000,guardrail_epoch:0,entries_paused:false},positions:[{symbol:'HDFCBANK',instrument_type:'equity',side:'LONG',quantity:10,avg_entry_price:100,mark_price:100}],open_orders:order?[order]:[],trades:[],contexts:[],pnl:0,wallet_balance:45000});
const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='capabilities')return{real_trading_enabled:true};if(path.startsWith('broker-status'))return{broker:'kite',authenticated:true};if(path.startsWith('active?'))mode=new URLSearchParams(path.split('?')[1]).get('mode');if(path.endsWith('/charts/history'))return{candles,provider:'kite',more:false};if(path.endsWith('/charts/workspace'))return{workspace:null};if(path.endsWith('/charts/watch'))return{watch_id:'watch'};if(path.includes('/contracts/metadata'))return{contracts:[]};if(method==='PATCH'){await new Promise(r=>setTimeout(r,50));if(window.failEdit)throw Error('Broker refused price edit');order={...order,limit_price:body.price,trigger_price:body.price,quantity:body.quantity}}if(path.endsWith('/cancel'))order=null;return snapshot()};
const drawings=async(path,method)=>path==='chart-settings'?{settings:{}}:{drawings:[]};
function Renderer(props){return surface==='desktop'?<Desktop {...props} drawingRequest={drawings}/>:<Website {...props}/>};
window.chart=()=>{const el=document.querySelector('.kline');el.id=el.getAttribute('k-line-chart-id');return init(el)};
createRoot(document.getElementById('root')).render(<Panel request={request} subscribe={()=>()=>{}} loadSymbols={async()=>[{symbol:'HDFCBANK',display_name:'HDFC Bank',chart_type:'equity',option_eligible:true}]} renderChart={Renderer} surface={surface} onDetach={()=>{}}/>);
`},bundle:true,jsx:'automatic',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom',klinecharts:root+'/windowsapp/node_modules/klinecharts'},outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://local').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(path==='/'?'/index.html':path)))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try{
 for(const surface of ['desktop','website'])for(const mode of ['paper','real']){
  const page=await browser.newPage({viewport:{width:1450,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/api/**',route=>route.fulfill({json:[]}));
  await page.goto('http://127.0.0.1:'+server.address().port+'/?surface='+surface);
  if(mode==='real')await page.getByRole('combobox',{name:'Swing mode',exact:true}).selectOption('real');
  const panel=page.getByRole('region',{name:'Swing portfolio'});
  await panel.getByRole('button',{name:'Orders',exact:true}).click();
  await panel.getByRole('button',{name:'Edit order HDFCBANK',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'Swing order actions'});
  await dialog.getByLabel('Order price',{exact:true}).fill('115');
  await dialog.getByLabel('Order total quantity',{exact:true}).fill('8');
  await page.evaluate(()=>window.failEdit=true);
  await dialog.getByRole('button',{name:'Save order',exact:true}).click();
  await dialog.getByText('Error: Broker refused price edit',{exact:true}).waitFor();
  assert.equal(await dialog.getByLabel('Order price',{exact:true}).inputValue(),'115');
  await page.evaluate(()=>window.failEdit=false);
  await dialog.getByRole('button',{name:'Save order',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  const canvasIds=await page.locator('canvas').evaluateAll(nodes=>nodes.map((node,i)=>{node.dataset.identity=String(i);return node.dataset.identity}));
  // Click the actual rendered order line, not a harness-provided action button.
  if(surface==='desktop'){
   await page.waitForFunction(()=>document.querySelector('.kline')&&window.chart().getOverlays().some(o=>o.extendData?.orderId==='exit-1'));
   const point=await page.evaluate(()=>window.chart().convertToPixel([{timestamp:(Date.parse('2026-10-15T09:15:00Z')/1000+119*180)*1000,value:115}],{paneId:'candle_pane'})[0]);
   const box=await page.locator('.kline').boundingBox();await page.mouse.click(box.x+140,box.y+point.y);
  }else{
   await page.waitForTimeout(150);
   const line=await page.locator('canvas').evaluateAll(nodes=>{let best=null;for(const node of nodes){if(node.width<250||node.height<150)continue;const ctx=node.getContext('2d');if(!ctx)continue;const data=ctx.getImageData(0,0,node.width,node.height).data;for(let y=20;y<node.height-20;y++){let count=0;for(let x=70;x<node.width-110;x++){const i=(y*node.width+x)*4;if(Math.abs(data[i]-170)<3&&Math.abs(data[i+1]-170)<3&&Math.abs(data[i+2]-170)<3&&data[i+3]>240)count++}if(count>40&&(!best||count>best.count)){const rect=node.getBoundingClientRect();best={count,x:rect.x+rect.width*.4,y:rect.y+y*rect.height/node.height}}}}return best});
   assert(line,'Website rendered order line missing');await page.mouse.click(line.x,line.y);
  }
  await dialog.getByRole('button',{name:'Edit order',exact:true}).waitFor();
  assert.equal(await dialog.getByText(/Convert.*stoploss/i).count(),0);
  await dialog.getByRole('button',{name:'Edit order',exact:true}).click();
  await dialog.getByLabel('Order price',{exact:true}).fill('116');
  await dialog.getByRole('button',{name:'Save order',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await page.locator('canvas').evaluateAll(nodes=>nodes.map(node=>node.dataset.identity)),canvasIds);
  await panel.getByRole('button',{name:'Cancel order HDFCBANK',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.path==='portfolio/orders/exit-1/cancel'));
  assert.equal(await panel.getByRole('button',{name:'Edit order HDFCBANK',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log(surface+' '+mode+': list edit, failed save/retry, actual chart-line edit, cancel; chart canvases retained.');await page.close();
 }
}finally{await browser.close();await new Promise(done=>server.close(done))}
