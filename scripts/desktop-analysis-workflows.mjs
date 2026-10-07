/** StrictMode desktop workflow/real KLine hit-testing using synthetic APIs only. */
import {build} from '../frontend/node_modules/esbuild/lib/main.js'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),artifacts=root+'/.cache/desktop-analysis-validation'
await mkdir(artifacts,{recursive:true})
const dir=await mkdtemp(join(tmpdir(),'desktop-analysis-workflows-'))
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import App from '${root}/windowsapp/src/App.tsx';import{init}from'klinecharts';import '${root}/windowsapp/src/styles.css';window.getAnalysisChart=dom=>{dom.id=dom.getAttribute('k-line-chart-id');return init(dom)};createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`,resolveDir:root+'/windowsapp',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},alias:{react:root+'/windowsapp/node_modules/react','react-dom':root+'/windowsapp/node_modules/react-dom','lightweight-charts':root+'/frontend/node_modules/lightweight-charts'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const fixturePath=artifacts+'/workflow-fixture.json'
execFileSync(process.env.PYTHON_BIN||'python3',[root+'/scripts/phase20-browser-fixture.py',fixturePath],{env:{...process.env,PYTHONPATH:root+'/backend'}})
const fixture=JSON.parse(await readFile(fixturePath,'utf8'))
const base=fixture.cycles[0]
const start=Date.parse(base.date+'T09:15:00Z')/1000
const cycle={...base,user_id:'alice',right:'CE',strike:25000,expiry:'2026-10-08',exchange:'nse_fo',product:'MIS'}
const trades=cycle.executions.map((row,i)=>({...row,execution_id:`fill-${i}`,trade_id:`fill-${i}`,stored_trade_id:row.trade_id,session_id:cycle.session_id,user_id:'alice',symbol:'NIFTY',instrument_type:'options',right:'CE',strike:25000,expiry:'2026-10-08',exchange:'nse_fo',product:'MIS',underlying_price:100}))
const entryTotal=trades[0].quantity,entryFee=trades[0].commission
const extraFill={...trades[0],execution_id:'fill-extra',trade_id:'fill-extra',quantity:entryTotal-40,commission:entryFee*(entryTotal-40)/entryTotal}
trades[0]={...trades[0],quantity:40,commission:entryFee*40/entryTotal};trades.push(extraFill)
const session={session_id:cycle.session_id,user_id:'alice',symbol:'NIFTY',date:cycle.date,instrument_type:'options',session_type:'paper',session_capital:100000,trade_count:trades.length,round_trip_count:1,buy_count:2,sell_count:1,net_pnl:cycle.net_pnl,pnl_pct:cycle.pnl_pct,total_commission:cycle.fees}
const extraSession={...session,session_id:'shared-real',user_id:'bob',session_type:'real',shared:true,owner_email:'bob@example.com'}
const ordersOnly={...session,session_id:'orders-only',session_type:'real',trade_count:0,round_trip_count:0,buy_count:0,sell_count:0,net_pnl:0,pnl_pct:0,total_commission:0}
const rows=Array.from({length:125},(_,i)=>({time:start+i*180,open:100,high:102,low:88,close:99}))
const trip={index:0,right:'CE',pnl:cycle.net_pnl,entry_trades:[{...trades[0],quantity:entryTotal,commission:entryFee,trade_id:trades[0].stored_trade_id}],exit_trades:[{...trades[1],trade_id:trades[1].stored_trade_id}]}
let labels=[],snapshots=[],shareEmails=[],deleted=false,failDelete=false,failSnapshots=false,failLabels=false,failCompare=false,failExport=false
const captured={current_price:100,current_price_ce:100,current_price_pe:90,bar_time:Math.floor(trades[0].timestamp/180)*180,bar_ohlc:{open:99,high:101,low:98,close:100},bar_observation_resolution_seconds:1,position:{side:'FLAT',quantity:0,avg_entry_price:0,pnl:0,pnl_pct:0},position_ce:{side:'LONG',quantity:65,avg_entry_price:100,pnl:0,pnl_pct:0},position_pe:{side:'FLAT',quantity:0,avg_entry_price:0,pnl:0,pnl_pct:0},combined_pnl:0,combined_pnl_pct:0,session_pnl:0,session_pnl_pct:0,wallet_balance:90000,session_capital:100000,wallet_used_pct:10,active_positions:1,open_orders:[],strike_ce:25000,strike_pe:25000,expiry:'2026-10-08',event_timestamp:trades[0].timestamp,quantity_mode:'quantity',filled_trades:trades.filter(t=>t.side==='BUY')}
snapshots=[{event_id:'later',session_id:session.session_id,user_id:'alice',symbol:'NIFTY',date:cycle.date,instrument_type:'options',session_type:'paper',timestamp:trades[1].timestamp,event:{type:'order_filled',description:'Exit recorded',details:{}},snapshot:captured},{event_id:'earlier',session_id:session.session_id,user_id:'alice',symbol:'NIFTY',date:cycle.date,instrument_type:'options',session_type:'paper',timestamp:trades[0].timestamp,event:{type:'order_filled',description:'Entry recorded',details:{}},snapshot:captured}]
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
let page
try{
 page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});const errors=[],calls=[]
 page.on('pageerror',error=>errors.push(String(error)))
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();calls.push({path,method});let value={}
  const reject=async(status,message)=>route.fulfill({status,json:{detail:message}})
  if(path.endsWith('/auth/desktop/token'))value={access_token:'synthetic'}
  else if(path.endsWith('/settings/real-history-sharing')){if(method==='PUT')shareEmails=route.request().postDataJSON().emails;value={emails:shareEmails,shared_from:[{user_id:'bob',email:'bob@example.com'}]}}
  else if(path.endsWith('/settings/profile'))value={email:'alice@example.com',is_admin:false,real_trading_enabled:false}
  else if(path.endsWith('/analysis/sessions'))value=[session,extraSession,ordersOnly]
  else if(path.endsWith('/analysis/sessions/orders-only'))value={...ordersOnly,trades:[],cycles:[],orders:[{order_id:'pending',status:'PENDING',side:'BUY',quantity:65,order_type:'LIMIT'}]}
  else if(path.includes('/analysis/sessions/')){const shared=path.endsWith('/shared-real');value={...(shared?extraSession:session),trades:shared?trades.map(t=>({...t,session_id:'shared-real'})):trades,cycles:[{...cycle,executions:trades}],orders:[{order_id:'cancelled',status:'CANCELLED',side:'BUY',quantity:65,order_type:'LIMIT',analytics:{entry_method:'MARKET'}}]}}
  else if(path.endsWith('/analysis/data/historical'))value={candles:rows.map(c=>({...c,time:c.time-86400})),dates:[]}
  else if(path.endsWith('/analysis/data/pre-session')||path.endsWith('/analysis/data/options-historical')||path.includes('/analysis/pattern/ohlc/'))value={candles:rows}
  else if(path.endsWith('/analysis/round-trips')){if(failLabels)return reject(503,'Label data unavailable');value=[trip]}
  else if(path.endsWith('/analysis/labels')){if(method==='POST'){labels=route.request().postDataJSON().labels;value=labels}else value=labels}
  else if(path.endsWith('/analysis/snapshots')){if(method==='DELETE'){if(failDelete)return reject(503,'Deletion unavailable');deleted=true;value={deleted:snapshots.length};snapshots=[]}else{if(failSnapshots)return reject(503,'Snapshot history unavailable');value=snapshots}}
  else if(path.endsWith('/analysis/pattern/chart/by-date')){if(failCompare)return reject(503,'Pattern data unavailable');value={symbol:'NIFTY',date:cycle.date,strike:25000,annotations:[{time:trades[0].timestamp,price:100,instrument:'CE',type:'entry',strategy_name:'Breakout',category:'Momentum',text:'entry'}],top_patterns:{}}}
  else if(path.endsWith('/analysis/data/expiry'))value={expiry:'2026-10-08'}
  else if(path.endsWith('/analysis/pattern/categories'))value={categories:['Momentum']}
  else if(path.endsWith('/analysis/pattern/strategies'))value={strategies:['Breakout']}
  else if(path.endsWith('/analysis/entry-tags')||path.endsWith('/analysis/exit-tags'))value={tags:['AS_PER_PATTERN']}
  else if(path.endsWith('/analysis/performance'))value=fixture.report
  else if(path.endsWith('/analysis/performance/cycles')){if(failExport&&url.searchParams.get('offset')!=='0')return reject(503,'Export page unavailable');value={items:url.searchParams.get('offset')==='0'?[fixture.cycles[0]]:fixture.cycles.slice(1),total:fixture.cycles.length,next_offset:url.searchParams.get('offset')==='0'?1:null}}
  else if(path.includes('/analysis/performance/cycles/'))value={...cycle,excursion:{status:'unavailable',reason:'No reliable cached observations'}}
  else if(path.endsWith('/screens'))value={screens:[]}
  else if(path.endsWith('/catalogue'))value={instruments:[{symbol:'NIFTY',display_name:'NIFTY 50',exchange:'NSE',chart_type:'index',option_eligible:true,supported_intervals:[1,3,15]}]}
  else if(path.endsWith('/historical/pages'))value={candles:[],available:true}
  else if(path.endsWith('/settings/current'))value={}
  else if(path.endsWith('/chart-settings'))value={settings:{}}
  else if(path.endsWith('/candidate'))value={status:'none'}
  else if(path.endsWith('/drawings'))value={drawings:[]}
  await route.fulfill({status:200,json:value})
 })
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Sign in',exact:true}).click()
 const nav=page.getByRole('navigation',{name:'Desktop workspace'}),analysisViews=page.getByRole('navigation',{name:'Analysis views'})
 await nav.getByRole('button',{name:'Analysis',exact:true}).click()
 await page.locator('.analysis-kline canvas:visible').first().waitFor()
 const underlying=page.getByRole('region',{name:'Underlying chart'}).first()
 const before=await underlying.locator('.analysis-kline').getAttribute('k-line-chart-id')
 await underlying.getByRole('button',{name:'Maximize chart'}).click()
 assert.equal(await underlying.locator('.analysis-kline').getAttribute('k-line-chart-id'),before)
 await underlying.getByRole('button',{name:'Restore chart'}).click()
 assert.equal(await underlying.locator('.analysis-kline').getAttribute('k-line-chart-id'),before)
 const mark=await underlying.locator('.analysis-kline').evaluate(el=>{const chart=window.getAnalysisChart(el);const marker=chart.getOverlays({name:'analysisExecution'})[0];const point=chart.convertToPixel(marker.points[0],{paneId:'candle_pane'});const rect=el.getBoundingClientRect();return{x:rect.x+point.x,y:rect.y+point.y,range:chart.getVisibleRange(),bars:chart.getDataList().length}})
 console.log('Marker geometry',mark)
 assert.ok(mark.bars>=125&&mark.range.to-mark.range.from<=150)
 await page.mouse.click(mark.x,mark.y)
 const chooser=page.getByRole('dialog',{name:'Choose execution'});await chooser.waitFor();assert.equal(await chooser.getByRole('button',{name:/BUY/}).count(),2);await chooser.getByRole('button',{name:/BUY.*40/}).click()
 const inspector=page.getByRole('dialog',{name:'Execution inspector'});await inspector.waitFor()
 await inspector.getByRole('button',{name:'Close',exact:true}).click()
 const optionChart=page.getByRole('region',{name:'CE chart'}).first()
 const optionPoint=await optionChart.locator('.analysis-kline').evaluate(el=>{const chart=window.getAnalysisChart(el);const overlay=chart.getOverlays({name:'analysisExecution'})[0];const p=chart.convertToPixel(overlay.points[0]);const r=el.getBoundingClientRect();return{x:r.x+p.x,y:r.y+p.y}})
 await page.mouse.click(optionPoint.x,optionPoint.y);await chooser.waitFor();await chooser.getByRole('button',{name:/BUY.*25/}).click();await inspector.waitFor();await page.keyboard.press('Escape');await inspector.waitFor({state:'detached'})
 await page.getByRole('button',{name:'Label Trades',exact:true}).click()
 await page.getByRole('button',{name:'Save Labels',exact:true}).waitFor()
 const tag=page.locator('input[list^="et-"]').first();await tag.fill('CUSTOM ENTRY')
 let dismiss=true
 const dialogHandler=async dialog=>{if(dialog.message().includes('Discard unsaved labels')&&dismiss)await dialog.dismiss();else await dialog.accept()}
 page.on('dialog',dialogHandler)
 await page.getByRole('button',{name:'Trades',exact:true}).click()
 assert.equal(await tag.inputValue(),'CUSTOM ENTRY')
 await page.getByRole('button',{name:'Save Labels',exact:true}).click();await page.getByText('Saved!',{exact:true}).waitFor()
 assert.equal(labels[0].entry_tag,'CUSTOM ENTRY')
 await page.getByRole('button',{name:'Trades',exact:true}).click()
 failLabels=true;await page.getByRole('button',{name:'Label Trades',exact:true}).click();await page.getByRole('button',{name:'Retry labels'}).waitFor();failLabels=false;await page.getByRole('button',{name:'Retry labels'}).click();await page.getByText('1 round trip',{exact:true}).waitFor();await page.getByRole('button',{name:'Trades',exact:true}).click()
 failSnapshots=true;await page.getByRole('button',{name:/Snapshots/}).click();await page.getByRole('alert').filter({hasText:'503'}).waitFor();failSnapshots=false
 await page.getByRole('button',{name:/Snapshots/}).click();const snapshot=page.getByRole('dialog',{name:'Event snapshots'});await snapshot.waitFor()
 await snapshot.getByPlaceholder('Search... (* = wildcard)').fill('Ent*recorded');assert.equal(await snapshot.getByText('Exit recorded',{exact:false}).count(),0)
 await snapshot.getByPlaceholder('Search... (* = wildcard)').fill('');await snapshot.getByRole('button',{name:/Entry recorded/}).click()
 await page.screenshot({path:artifacts+'/snapshot-workflow.png'})
 await snapshot.getByRole('button',{name:'CE',exact:false}).filter({hasText:'CE 25000'}).first().click()
 await snapshot.locator('.analysis-kline canvas:visible').first().waitFor()
 const snapshotTimes=await snapshot.locator('.analysis-kline').first().evaluate(el=>window.getAnalysisChart(el).getDataList().map(row=>row.timestamp/1000))
 assert.ok(snapshotTimes.every(t=>t<captured.bar_time))
 failDelete=true;await snapshot.getByRole('button',{name:/Delete All/}).click();await snapshot.getByRole('alert').waitFor();assert.equal(deleted,false)
 failDelete=false;await snapshot.getByRole('button',{name:/Delete All/}).click();await snapshot.waitFor({state:'detached'});assert.equal(deleted,true)
 failCompare=true;await page.getByRole('button',{name:/Compare/}).click();let comparison=page.getByRole('dialog',{name:'Pattern comparison'});await comparison.getByRole('button',{name:'Retry comparison'}).waitFor();failCompare=false;await comparison.getByRole('button',{name:'Retry comparison'}).click();await comparison.getByText(/1 annotations/).waitFor();await comparison.getByRole('button',{name:/Close/}).click()
 await page.getByRole('complementary',{name:'Session navigator'}).getByRole('button',{name:/shared-real|Shared by/}).click()
 await page.getByRole('button',{name:'Label Trades',exact:true}).click();await page.getByText('Shared history · read only',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Save Labels',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'Trades',exact:true}).click();await page.getByRole('button',{name:/Snapshots/}).click();const sharedSnapshots=page.getByRole('dialog',{name:'Event snapshots'});await sharedSnapshots.waitFor();assert.equal(await sharedSnapshots.getByRole('button',{name:/Delete All/}).count(),0);await sharedSnapshots.getByRole('button',{name:/Close/}).click()
 await page.getByRole('complementary',{name:'Session navigator'}).getByRole('button').filter({hasText:'0 closed trades'}).click();await page.getByText('No executions yet.',{exact:true}).waitFor();await page.getByText('Stored order history (1)',{exact:true}).click();await page.getByRole('cell',{name:'PENDING',exact:true}).waitFor()
 await analysisViews.getByRole('button',{name:'Stats',exact:true}).click();await page.getByRole('heading',{name:'Your trading, understood.'}).waitFor()
 failExport=true;await page.getByRole('button',{name:'Export CSV',exact:true}).click();await page.getByRole('alert').filter({hasText:'503'}).waitFor();failExport=false
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export CSV',exact:true}).click();const csv=await readFile(await(await download).path(),'utf8');assert.equal(csv.split('\r\n').length,fixture.cycles.length+1)
 await nav.getByRole('button',{name:'Workspace',exact:true}).click();await page.getByRole('button',{name:'Chart settings',exact:true}).click();await page.getByRole('tab',{name:'History sharing',exact:true}).click();await page.getByLabel('Share real history with emails').fill('bob@example.com');await page.getByRole('button',{name:'Save sharing',exact:true}).click();await page.getByText('History sharing saved.',{exact:true}).waitFor();assert.deepEqual(shareEmails,['bob@example.com'])
 await page.screenshot({path:artifacts+'/desktop-history-sharing.png'})
 assert.deepEqual(errors,[])
 assert.equal(calls.filter(c=>c.path.includes('/analysis/')&&c.method!=='GET'&&!c.path.endsWith('/labels')&&!c.path.endsWith('/snapshots')).length,0)
 await writeFile(artifacts+'/workflow-summary.json',JSON.stringify({passed:true,errors,checks:['StrictMode','maximize keeps chart instance','actual underlying/option overlay hit tests and overlap chooser','150 bars','dirty labels dismiss/save','labels explicit error/retry','snapshot wildcard/chronology/boundary','delete failure/retry','comparison error/retry','shared labels/snapshots read only','real order-only sessions','all-page CSV failure/retry','desktop sharing settings'],calls},null,2))
 console.log('Desktop Analysis workflow acceptance passed')
}catch(error){if(page){await page.screenshot({path:artifacts+'/workflow-failure.png'});await writeFile(artifacts+'/workflow-failure.html',await page.content())};console.error(error);throw error}finally{await browser.close();await new Promise(r=>server.close(r))}
