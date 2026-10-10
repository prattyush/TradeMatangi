/** Phase 21 acceptance against the built desktop, with synthetic APIs only. */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root = resolve(new URL('..', import.meta.url).pathname)
const artifacts = process.env.PHASE21_ARTIFACT_DIR || resolve(root, '.cache/phase21-validation')
await mkdir(artifacts, {recursive:true})
const server = createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html');res.end(await readFile(resolve(root,'windowsapp/dist')+(path==='/'?'/index.html':path)))}catch{res.statusCode=404;res.end()}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
const date='2026-10-08', start=Date.parse(date+'T09:15:00Z')/1000, results=[]
const tile=(id,kind='spot',right='CE',strike='71700',expiry=date)=>({id,kind,symbol:'BSESEN',right,strike:kind==='spot'?'':strike,expiry:kind==='spot'?'':expiry,tradingDate:'2026-10-01',interval:'3'})
const baseTiles=[tile('underlying'),tile('ce','option'),tile('pe','option','PE','71300'),tile('expired','option','CE','71000','2026-10-01')]
const flat={symbol:'BSESEN',side:'FLAT',quantity:0,avg_entry_price:0,entry_commission:0}
const settings={desktop_hide_chart_labels:false,desktop_order_size_mode:'quantity',desktop_pnl_display_mode:'currency',desktop_confirm_flatten:true,context_menu_sl_mode:'longOnly',target_deviation_pct:.01,funds_ratio_l_pct:.03,funds_ratio_m_pct:.06,funds_ratio_h_pct:.12,risk_ratio_l_pct:1,risk_ratio_m_pct:2,risk_ratio_h_pct:4,default_sl_pct:.25,historical_days:0}
const contract=tile=>({symbol:tile.symbol,right:tile.right,strike:Number(tile.strike),expiry:tile.expiry,contract_key:`${tile.symbol}:${tile.expiry}:${tile.strike}:${tile.right}`})
const candles=Array.from({length:240},(_,i)=>({timestamp:start-86400+i*180,open:100+i/10,high:102+i/10,low:99+i/10,close:101+i/10}))
async function scenario(mode='Stepwise', five=false, emptyStopped=false) {
 const page=await browser.newPage({viewport:{width:1400,height:850}}),errors=[],calls=[],submissions=[]
 page.on('pageerror',e=>errors.push(String(e)))
 if(mode==='Paper')await page.clock.install({time:new Date(date+'T05:30:00Z')})
 const dialogs=[];page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss()})
 const expectedPanes=five?5:3
 let record={screen_id:'record',name:'Synthetic',revision:1,order:0,active:true,state:{id:'screen',layout:five?'5-equal':'4-grid',tiles:five?[...baseTiles.slice(0,3),tile('ce-extra','option','CE','71800'),tile('pe-extra','option','PE','71200')]:baseTiles,mode,run_date:date,start_time:'09:15'}}
 let walletBalance=100000;let trading=null,preparedTiles=[],cursor=start+179,availability='normal',failReplay=false,uncertain=false,raceAttach=false
 const pending=[{order_id:'sl',session_id:'session',user_id:'user',symbol:'BSESEN',side:'SELL',order_type:'STOPLOSS',is_stoploss:true,right:'CE',strike:71700,expiry:date,quantity:40,trigger_price:90,limit_price:90,status:'PENDING',created_at:start},{order_id:'entry',session_id:'session',user_id:'user',symbol:'BSESEN',side:'BUY',order_type:'LIMIT',is_stoploss:false,right:'PE',strike:71300,expiry:date,quantity:20,trigger_price:80,limit_price:80,status:'PENDING',created_at:start}]
 const snapshot=()=>({version:1,event_cursor:0,owned:true,paper_status:mode==='Paper'?'running':null,source:'desktop_'+mode.toLowerCase(),desktop_mode:mode.toLowerCase(),session:{session_id:'session',symbol:'BSESEN',date,start_time:'09:15:00',speed:1,session_capital:100000,instrument_type:'options',strike:71700,expiry:date,right:null,strike_ce:71700,strike_pe:71300,session_type:mode==='Paper'?'paper':mode==='Stepwise'?'stepwise':'sim',state:mode==='Stepwise'?'paused':'running',stepwise:mode==='Stepwise',total_bars:100,group_id:'g',wallet_ledger_id:'w',lot_size:20},current_time:cursor,current_bar_index:1,current_price:71700,current_price_ce:100,current_price_pe:80,contract_quotes:Object.fromEntries(preparedTiles.filter(t=>t.kind==='option').map(t=>{const c=contract(t);return [c.contract_key,{...c,price:t.right==='CE'?100:80,timestamp:cursor,source:'synthetic'}]})),contracts:preparedTiles.filter(t=>t.kind==='option').map(contract),positions:{equity:flat,CE:{...flat,side:'LONG',quantity:80,avg_entry_price:100},PE:flat},positions_by_contract:{['BSESEN:'+date+':71700:CE']:{...flat,side:'LONG',quantity:80,avg_entry_price:100}},open_orders:pending,strategies:[],trades:[],wallet_balance:walletBalance,pnl:{equity:0,ce:0,pe:0,day:0,day_pct:0,contracts:{}},settings})
 const replay=()=>({run_id:'run',event_id:0,cursor,state:mode==='Stepwise'?'paused':'running',mode:mode.toLowerCase(),bar_index:1,interval_seconds:180,tile_states:preparedTiles.map(t=>({tile_id:t.id,availability:'ready',interval_minutes:3,candle:{timestamp:start,open:100,high:101,low:99,close:100}}))})
 const live=()=>({stream_id:'live',event_id:0,feed:{connection:'connected',actual_provider:'breeze',selected_provider:'breeze'},tiles:preparedTiles.map(t=>({tile_id:t.id,availability:'available',instrument:t.kind==='option'?{kind:'option',exchange:'BSE',underlying:t.symbol,expiry:t.expiry,strike:Number(t.strike),right:t.right}:{kind:'index',exchange:'BSE',symbol:t.symbol},interval_minutes:3,latest_tick:{timestamp:cursor,open:100,high:100,low:100,close:100},history_candles:candles,current_date_seconds:[]}))})
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),body=method==='GET'?{}:request.postDataJSON()||{};calls.push({path,method,body});let value={}
  if(path.endsWith('/auth/desktop/token'))value={access_token:'synthetic'}
  else if(path.endsWith('/screens'))value={screens:[record]}
  else if(path.endsWith('/screens/record')){if(method==='PUT')record={...record,...body,revision:record.revision+1};value=record}
  else if(path.endsWith('/catalogue'))value={instruments:[{symbol:'BSESEN',display_name:'SENSEX',exchange:'BSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,5,15,30,60]},{symbol:'NIFTY',display_name:'NIFTY 50',exchange:'NSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,5,15,30,60]}]}
  else if(path.endsWith('/option-metadata'))value={expiries:[date],strike_interval:100,rights:['CE','PE'],available:true}
  else if(path.endsWith('/historical/pages'))value={candles,available:true}
  else if(path.endsWith('/settings/current'))value=settings
  else if(path.endsWith('/chart-settings'))value={settings:{}}
  else if(path.endsWith('/candidate')){value={status:trading?'active':'none',active:trading?snapshot():null};if(emptyStopped&&!trading){const stopped=snapshot();value={status:'stopped',existing_session_id:'session',stopped:{...stopped,paper_status:'stopped',session:{...stopped.session,state:'ended'},positions:{equity:flat,CE:flat,PE:flat},positions_by_contract:{},open_orders:[],trades:[],strategies:[]}}}}
  else if(path.endsWith('/prepare-session')){
   value={version:1,date,reference_time:body.reference_time,panes:body.panes.map(t=>({pane:{...t,tradingDate:date,strike:t.selection_mode==='max_price'?'71800':t.strike},availability:availability==='error'?'error':availability==='all-invalid'||t.id==='expired'?'unavailable':'available',reason:availability==='error'?'Provider timeout':t.id==='expired'?'Expired contract':null,premium:t.selection_mode==='max_price'?50:null}))}
   const resolved=value.panes.filter(t=>t.availability==='available').map(t=>t.pane)
   preparedTiles=body.panes.length>1?resolved:preparedTiles.map(t=>resolved.find(next=>next.id===t.id)||t)
  }
  else if(path.endsWith('/trading/session/resume')){trading=true;value=snapshot()}
  else if(path.endsWith('/trading/start')){trading=true;value={...snapshot(),created_for_request:!raceAttach}}
  else if(path.endsWith('/contracts'))value=snapshot()
  else if(path.endsWith('/replay/start')){if(failReplay)return route.fulfill({status:503,json:{detail:'Replay startup failed'}});value=replay()}
  else if(path.endsWith('/live/start')||path.includes('/live/live/'))value=live()
  else if(path.endsWith('/trading/session/stop')){trading=false;value={}}
  else if(path.endsWith('/trading/session/snapshot'))value=snapshot()
  else if(path.endsWith('/chart-orders')||path.endsWith('/trading/session/orders')){
   submissions.push(body)
   if(path.endsWith('/trading/session/orders')&&body.session_id!=='session')return route.fulfill({status:422,json:{detail:[{type:'missing',loc:['body','session_id'],msg:'Field required'}]}})
   if(uncertain)return route.fulfill({status:503,json:{detail:'Acknowledgement uncertain'}})
   value={...pending[0],order_id:'new',group_id:body.group_id}
  }
  else if(path.endsWith('/orders/sl')&&method==='PATCH'){Object.assign(pending[0],body);value=pending[0]}
  else if(path.endsWith('/events'))return route.fulfill({status:200,contentType:'text/event-stream',body:`event: snapshot\ndata: ${JSON.stringify(path.includes('/replay/')?replay():path.includes('/live/')?live():snapshot())}\n\n`})
  else if(path.includes('/replay/run'))value=replay()
  else if(path.endsWith('/drawings'))value={drawings:[]}
  else if(path.endsWith('/wallet/reset')){walletBalance=body.amount;value={balance:walletBalance,locked:false}}
  else if(path.endsWith('/wallet'))value={balance:walletBalance,locked:false}
  else if(path.endsWith('/trade-labels/metadata'))value={categories:[],strategies:[],entry_tags:[],exit_tags:[]}
  else if(path.endsWith('/trade-labels'))value={completed:[],open:[],labels:[]}
  await route.fulfill({status:200,json:value})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('button',{name:'Start',exact:true}).waitFor()
 if(emptyStopped){
  availability='error';await page.getByRole('button',{name:'Start',exact:true}).click()
  await page.getByText('Provider timeout',{exact:false}).first().waitFor()
  await page.getByRole('button',{name:/^Wallet ₹/}).click()
  const wallet=page.locator('.wallet-popover');await wallet.getByRole('button',{name:'Reset',exact:true}).waitFor()
  await page.waitForFunction(()=>!document.querySelector('.wallet-popover button').disabled)
  await wallet.locator('input[type="number"]').fill('180000')
  await wallet.getByRole('button',{name:'Reset',exact:true}).click()
  await wallet.waitFor({state:'hidden'})
  assert.equal(walletBalance,180000);assert(calls.some(c=>c.path.endsWith('/wallet/reset')&&c.body.amount===180000))
  availability='normal'
 }
 if(mode==='Stepwise') {
  const initial=await page.locator('.tile-grid .chart').count()
  availability='error';await page.getByRole('button',{name:'Start',exact:true}).click();await page.getByText('Provider timeout',{exact:false}).first().waitFor()
  assert.equal(await page.locator('.tile-grid .chart').count(),initial);assert(!calls.some(c=>c.path.endsWith('/trading/start')))
  availability='all-invalid';await page.getByRole('button',{name:'Start',exact:true}).click();await page.waitForTimeout(150);assert.equal(await page.locator('.tile-grid .chart').count(),initial)
  availability='normal';failReplay=true;await page.getByRole('button',{name:'Start',exact:true}).click();await page.getByText('Replay startup failed',{exact:false}).first().waitFor();assert.equal(await page.locator('.tile-grid .chart').count(),initial);assert(calls.some(c=>c.path.endsWith('/trading/session/stop')))
  // Simulate the other screen winning between candidate lookup and POST start.
  const stopCount=calls.filter(c=>c.path.endsWith('/trading/session/stop')).length
  raceAttach=true;await page.getByRole('button',{name:'Start',exact:true}).click();await page.getByRole('button',{name:'Recover charts',exact:true}).waitFor();assert.equal(calls.filter(c=>c.path.endsWith('/trading/session/stop')).length,stopCount)
  await page.getByRole('button',{name:'Detach session',exact:true}).click();trading=false;raceAttach=false
  failReplay=false
 }
 await page.getByRole('button',{name:/^(Start|Resume)$/,exact:true}).click()
 if(emptyStopped){await page.getByRole('button',{name:'Stop',exact:true}).waitFor();assert.equal(dialogs.length,0);assert(calls.some(c=>c.path.endsWith('/trading/session/resume')));assert(calls.some(c=>c.path.endsWith('/prepare-session')&&c.body.session_id==='session'));assert(!calls.some(c=>c.path.endsWith('/trading/start')))}
 await page.getByRole('button',{name:'Order',exact:true}).waitFor({state:'visible'})
 await page.waitForFunction(count=>document.querySelectorAll('.tile-grid .chart').length===count,expectedPanes)
 const ids=await page.locator('.kline').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('k-line-chart-id')))
 await page.getByRole('button',{name:'Draw / Indicators',exact:false}).click()
 assert.equal(await page.getByRole('button',{name:'Clear indicators',exact:true}).count(),0)
 assert.deepEqual(await page.locator('.kline').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('k-line-chart-id'))),ids)
 assert.match(await page.locator('.connection-dot').getAttribute('aria-label'),/connected/)
 await page.getByRole('button',{name:'Order',exact:true}).click()
 const order=page.getByRole('dialog',{name:'Order window'})
 await order.waitFor();assert.equal(await page.locator('.modal-backdrop:visible').count(),0)
 const clickPane=async index=>{
  const pane=page.locator('.kline').nth(index)
  const point=await pane.evaluate(node=>{const r=node.getBoundingClientRect();for(const y of [80,r.height/2,r.height-50])for(const x of [35,r.width*.3,r.width*.65]){const hit=document.elementFromPoint(r.x+x,r.y+y);if(hit&&node.contains(hit))return{x,y}}return null})
  assert(point,'A chart point must be exposed beside the order window');await pane.click({position:point})
 }

 await order.getByRole('button',{name:'CE 71700',exact:true}).click()
 await order.getByLabel('New order quantity',{exact:true}).fill('2')
 await order.getByRole('button',{name:'Submit BUY',exact:true}).click();await order.getByText('Order submitted',{exact:true}).waitFor()
 assert.equal(submissions.at(-1).quantity,40);assert.equal(submissions.at(-1).intent,'market');assert.equal(submissions.at(-1).strike,71700)
 // Chart picking fills a draft for the exact contract; it never submits.
 const beforePick=submissions.length
 for(const type of ['Limit','Target','SL']) {
  await order.getByRole('button',{name:type,exact:true}).click()
  if(type==='Target')await order.getByLabel('New order price',{exact:true}).click();else await order.getByRole('button',{name:'Pick new order price on chart',exact:true}).click()
  await clickPane(2)
  assert.equal(await order.getByLabel('New order price',{exact:true}).inputValue(),'')
  await clickPane(1)
  await page.getByText('Pick price',{exact:true}).waitFor({state:'hidden'})
  assert(Number(await order.getByLabel('New order price',{exact:true}).inputValue())>0)
  assert.equal(submissions.length,beforePick)
 }
 await order.getByRole('button',{name:'Market',exact:true}).click()
 // Chart clicks leave the window's selected contract unchanged.
 await page.locator('.chart-head').last().click({position:{x:30,y:12}})
 assert.equal(await order.getByRole('button',{name:'CE 71700',exact:true}).getAttribute('aria-pressed'),'true')
 const from=await order.boundingBox(),head=await order.locator('header').boundingBox();await page.mouse.move(head.x+35,head.y+8);await page.mouse.down();await page.mouse.move(head.x-120,head.y+90);await page.mouse.up();const moved=await order.boundingBox();assert(moved.x<from.x&&moved.y>from.y)
 await order.getByRole('button',{name:'SL',exact:true}).click();await order.getByLabel('New order quantity',{exact:true}).fill('20');await order.getByLabel('New order price',{exact:true}).fill('90');await order.getByRole('button',{name:'Submit SELL',exact:true}).click();await order.getByText('Order submitted',{exact:true}).waitFor();assert.equal(submissions.at(-1).order_type,'STOPLOSS');assert.equal(submissions.at(-1).session_id,'session');assert.equal(submissions.at(-1).side,'SELL');assert.equal(submissions.at(-1).right,'CE');assert.equal(submissions.at(-1).strike,71700);assert.equal(submissions.at(-1).expiry,date)
 const close=order.getByRole('button',{name:'Close order window'}),closeBefore=await close.boundingBox()
 await close.hover();assert.deepEqual(await close.boundingBox(),closeBefore)
 await page.mouse.move(closeBefore.x+closeBefore.width-3,closeBefore.y+closeBefore.height/2)
 await page.mouse.down();assert.deepEqual(await close.boundingBox(),closeBefore);await page.mouse.up()
 await order.waitFor({state:'hidden'})

 const sl=page.locator('.desktop-open-order').filter({hasText:'SELL · SL'})
 await sl.getByRole('button',{name:'Edit',exact:true}).click()
 const qty=sl.getByLabel('Order quantity');await qty.focus();await page.mouse.move(...Object.values(await qty.boundingBox()).slice(0,2).map((v,i)=>v+5));await page.mouse.wheel(0,-100);assert.equal(await qty.inputValue(),'60')
 await qty.press('ArrowDown');assert.equal(await qty.inputValue(),'40')
 const price=sl.getByLabel('Order price')
 await sl.getByRole('button',{name:'Use LTP for order edit',exact:true}).click();assert.equal(await price.inputValue(),'100.00')
 const patches=calls.filter(c=>c.method==='PATCH').length
 await price.click()
 await clickPane(1)
 await page.getByText('Pick price',{exact:true}).waitFor({state:'hidden'})
 assert(Number(await price.inputValue())>0)
 assert.equal(calls.filter(c=>c.method==='PATCH').length,patches)
 await price.fill('90');await price.focus();await price.press('ArrowUp');assert.equal(await price.inputValue(),'90.25');assert.equal(await price.evaluate(node=>{node.stepUp();return node.value}),'90.5');await price.fill('90.25')
 await sl.getByRole('button',{name:'Save order edits'}).click();await sl.getByRole('button',{name:'Save order edits'}).waitFor({state:'hidden'});assert(calls.some(c=>c.method==='PATCH'&&c.body.trigger_price===90.25),JSON.stringify(calls.filter(c=>c.method==='PATCH')))
 const entry=page.locator('.desktop-open-order').filter({hasText:'BUY · LIMIT'})
 await entry.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await entry.getByLabel('Order quantity').count(),0);await entry.getByRole('button',{name:'Cancel order edits'}).click()
 // Modal close buttons also stay under the pointer, including their right edge.
 await page.locator('.chart').nth(1).getByRole('button',{name:'Choose instrument'}).click()
 const closePicker=page.getByRole('dialog',{name:'Select chart instrument'})
 const pickerClose=closePicker.locator('header button'),pickerBox=await pickerClose.boundingBox()
 await pickerClose.hover();assert.deepEqual(await pickerClose.boundingBox(),pickerBox)
 await page.mouse.move(pickerBox.x+pickerBox.width-3,pickerBox.y+pickerBox.height/2);await page.mouse.down();assert.deepEqual(await pickerClose.boundingBox(),pickerBox);await page.mouse.up()
 await closePicker.waitFor({state:'hidden'})
 // Max-price picker captures and displays the search time before applying.
 await page.locator('.chart').nth(1).getByRole('button',{name:'Choose instrument'}).click()
 const picker=page.getByRole('dialog',{name:'Select chart instrument'});await picker.getByLabel('Strike selection').selectOption('max_price');await picker.getByLabel('Symbol',{exact:true}).selectOption('NIFTY');const presets=picker.getByRole('group',{name:'Premium cap presets'});assert.deepEqual(await presets.getByRole('button').allTextContents(),['₹30','₹50','₹75','₹100','₹125','₹150']);await presets.getByRole('button',{name:'₹30',exact:true}).click();assert.equal(await picker.getByLabel('Premium cap',{exact:true}).inputValue(),'30');await picker.getByLabel('Symbol',{exact:true}).selectOption('BSESEN');await picker.getByLabel('Premium cap',{exact:true}).fill('50');await picker.getByRole('button',{name:'Find strike'}).click();await picker.getByText('Selected CE 71800',{exact:false}).waitFor();await picker.getByRole('button',{name:'Apply to chart'}).click();await picker.waitFor({state:'hidden'})
 await page.getByRole('button',{name:'Order',exact:true}).click();await order.getByRole('button',{name:'CE 71800',exact:true}).waitFor()
 await page.setViewportSize({width:600,height:650});await page.waitForTimeout(100);const bounded=await order.boundingBox();assert(bounded.x>=0&&bounded.x+bounded.width<=600)
 await page.screenshot({path:resolve(artifacts,`phase21-${mode.toLowerCase()}${five?'-five':emptyStopped?'-empty':''}.png`)})
 // Uncertain acknowledgement fences another placement even after closing/reopening.
 await order.getByRole('button',{name:'PE 71300',exact:true}).click();await order.getByRole('button',{name:'Market',exact:true}).click();await order.getByLabel('New order quantity',{exact:true}).fill('1');uncertain=true
 await order.getByRole('button',{name:'Submit BUY',exact:true}).click();await order.getByRole('button',{name:'Refresh submission status'}).waitFor();assert(await order.getByRole('button',{name:'Submit BUY',exact:true}).isDisabled());await order.getByRole('button',{name:'Close order window'}).click();await page.getByRole('button',{name:'Order',exact:true}).click();assert(await order.getByRole('button',{name:'Submit BUY',exact:true}).isDisabled())
 assert.deepEqual(errors,[])
 results.push({mode,emptyStopped,panes:expectedPanes,checks:'startup rollback/removal, chart retention, non-modal orders, exact-contract draft price picks, edit LTP/chart picks, stationary edge close hitbox, lot/price edits, premium picker, dragging/clamping, uncertainty fencing',errors})
 await page.close()
}
try {for(const mode of ['Stepwise','Replay','Paper'])await scenario(mode);await scenario('Stepwise',true);await scenario('Paper',false,true);await writeFile(resolve(artifacts,'phase21-browser-summary.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))}finally{await browser.close();server.close()}
