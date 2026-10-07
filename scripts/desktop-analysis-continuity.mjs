/** Paper/Replay/Stepwise stream continuity across Analysis tabs, using mocks only. */
import {build} from '../frontend/node_modules/esbuild/lib/main.js'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),artifacts=root+'/.cache/desktop-analysis-validation',dir=await mkdtemp(join(tmpdir(),'desktop-analysis-continuity-'))
await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import App from '${root}/windowsapp/src/App.tsx';import '${root}/windowsapp/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`,resolveDir:root+'/windowsapp',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},alias:{react:root+'/windowsapp/node_modules/react','react-dom':root+'/windowsapp/node_modules/react-dom'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
const results=[]
let currentPage
try{
 for(const mode of ['Paper','Replay','Stepwise']){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],calls=[]
  currentPage=page
  page.on('pageerror',error=>{errors.push(String(error));console.error(mode+' page error',error.stack)})
  const date='2026-10-07',start=Date.parse(date+'T09:15:00Z')/1000,id=mode.toLowerCase(),screenId='screen-'+id,sessionId='engine-'+id
  const tile={id:'tile-'+id,kind:'spot',symbol:'NIFTY',interval:'3',tradingDate:date,expiry:'',strike:'',right:'CE'}
  let record={screen_id:screenId,name:mode+' active',state:{id:screenId,mode,tiles:[tile],layout:'1',session_id:sessionId,owned:false,run_date:date,...(mode==='Paper'?{}:{run_id:'run-'+id})},revision:1,order:0,active:true}
  let cursor=10,streams=0
  const flat={symbol:'NIFTY',side:'FLAT',quantity:0,avg_entry_price:0,entry_commission:0}
  const snapshot=()=>({version:1,event_cursor:cursor,owned:false,paper_status:'running',wallet_locked:true,source:'desktop_'+id,desktop_mode:id,session:{session_id:sessionId,symbol:'NIFTY',date,start_time:'09:15',speed:1,session_capital:100000,instrument_type:'equity',strike:null,expiry:null,right:null,strike_ce:null,strike_pe:null,session_type:mode==='Paper'?'paper':'sim',state:mode==='Stepwise'?'paused':'running',stepwise:mode==='Stepwise',total_bars:100,group_id:'g',wallet_ledger_id:'w',lot_size:1},current_time:start+cursor*180,current_bar_index:cursor,current_price:100+cursor,current_price_ce:0,current_price_pe:0,contract_quotes:{},positions:{equity:flat,CE:flat,PE:flat},positions_by_contract:{},open_orders:[],strategies:[],trades:[],wallet_balance:100000,margin_used:0,pnl:{equity:0,ce:0,pe:0,day:cursor,day_pct:cursor/1000,contracts:{}},settings:{desktop_hide_chart_labels:false,desktop_order_size_mode:'quantity',desktop_pnl_display_mode:'currency',desktop_confirm_flatten:true,context_menu_sl_mode:'longOnly',target_deviation_pct:.01,funds_ratio_l_pct:.03,funds_ratio_m_pct:.06,funds_ratio_h_pct:.12,risk_ratio_l_pct:1,risk_ratio_m_pct:2,risk_ratio_h_pct:4,default_sl_pct:.2}})
  const replay=()=>({run_id:'run-'+id,event_id:cursor,cursor:start+cursor*180,state:mode==='Stepwise'?'paused':'running',mode:id,bar_index:cursor,interval_seconds:180,tile_states:[{tile_id:tile.id,availability:'ready',interval_minutes:3,candle:{timestamp:start+cursor*180,open:100+cursor,high:102+cursor,low:99+cursor,close:101+cursor}}]})
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname,method=route.request().method();calls.push({path,method});let value={}
   if(path.endsWith('/auth/desktop/token'))value={access_token:'synthetic'}
   else if(path.endsWith('/screens'))value={screens:[record]}
   else if(path.endsWith('/screens/'+screenId)){if(method==='PUT'){record={...record,...route.request().postDataJSON(),revision:record.revision+1}}value=record}
   else if(path.endsWith('/catalogue'))value={instruments:[{symbol:'NIFTY',display_name:'NIFTY 50',exchange:'NSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,15]}]}
   else if(path.endsWith('/historical/pages'))value={candles:[{timestamp:start,open:100,high:102,low:99,close:101}],available:true}
   else if(path.endsWith('/analysis/sessions'))value=[]
   else if(path.endsWith('/settings/current'))value=snapshot().settings
   else if(path.endsWith('/chart-settings'))value={settings:{}}
   else if(path.includes('/trading/'+sessionId+'/events')){cursor++;streams++;await route.fulfill({status:200,contentType:'text/event-stream',body:`id: ${cursor}\ndata: ${JSON.stringify(snapshot())}\n\n`});return}
   else if(path.includes('/trading/'+sessionId+'/snapshot'))value=snapshot()
   else if(path.includes('/replay/run-'+id+'/events')){cursor++;await route.fulfill({status:200,contentType:'text/event-stream',body:`id: ${cursor}\ndata: ${JSON.stringify(replay())}\n\n`});return}
   else if(path.includes('/replay/run-'+id))value=replay()
   else if(path.endsWith('/drawings'))value={drawings:[]}
   else if(path.endsWith('/wallet'))value={balance:100000}
   else if(path.endsWith('/trade-labels/metadata')||path.endsWith('/label-metadata'))value={categories:[],strategies:[],entry_tags:[],exit_tags:[]}
   else if(path.includes('/trading/')&&path.endsWith('/trade-labels'))value={completed:[],open:[],labels:[]}
   else if(path.endsWith('/round-trips')||path.endsWith('/labels'))value=[]
   else if(path.endsWith('/categories'))value={categories:[]}
   else if(path.endsWith('/strategies'))value={strategies:[]}
   else if(path.endsWith('/entry-tags')||path.endsWith('/exit-tags'))value={tags:[]}
   await route.fulfill({status:200,json:value})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.locator('.trading-pill').filter({hasText:'P&L'}).waitFor()
  await page.locator('.kline canvas:visible').first().waitFor()
  const countBefore=streams,chartIds=await page.locator('.kline').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('k-line-chart-id')))
  const pnlBefore=await page.locator('.trading-pill').filter({hasText:'P&L'}).textContent()
  const nav=page.getByRole('combobox',{name:'Desktop view'})
  await nav.selectOption('Analysis')
  await page.getByText('No executions for these filters.',{exact:true}).waitFor()
  await page.waitForTimeout(1800)
  assert.ok(streams>countBefore,mode+' stream continues while hidden')
  const pnlAfter=await page.locator('.trading-pill').filter({hasText:'P&L'}).textContent()
  assert.notEqual(pnlAfter,pnlBefore,mode+' receives authoritative updates while hidden')
  await nav.selectOption('Workspace')
  assert.deepEqual(await page.locator('.kline').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('k-line-chart-id'))),chartIds)
  assert.equal(calls.filter(call=>call.path.includes('/trading/')&&call.method!=='GET'&&!call.path.includes('settings/current')).length,0)
  assert.deepEqual(errors,[])
  results.push({mode,streams,pnlBefore,pnlAfter,chartsRetained:true})
  await page.screenshot({path:artifacts+'/continuity-'+id+'.png'});await page.close()
 }
 await writeFile(artifacts+'/continuity-summary.json',JSON.stringify({passed:true,results},null,2));console.log('Paper, Replay and Stepwise continuity acceptance passed')
}catch(error){if(currentPage){await currentPage.screenshot({path:artifacts+'/continuity-failure.png'});await writeFile(artifacts+'/continuity-failure.html',await currentPage.content())};throw error}finally{await browser.close();await new Promise(r=>server.close(r))}
