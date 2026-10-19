/** Shared Day journey UI acceptance for website and desktop; synthetic records only. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'day-journey-'))
const start=Date.parse('2026-10-15T09:15:00Z')/1000
const c=(i,pnl,sid='one')=>({cycle_id:String(i),user_id:'u',session_id:sid,symbol:'NIFTY',mode:'paper',date:'2026-10-15',trading_style:'intraday',starting_capital:sid==='one'?10000:30000,capital:sid==='one'?10000:30000,state:'closed',right:'CE',strike:25000,expiry:'2026-10-15',entry_time:start+i*600,exit_time:start+i*600+300,net_pnl:pnl,fees:0,entries:[{timestamp:start+i*600,analytics:{effective_allocation_pct:10*(i+1),effective_risk_pct:i+1}}],executions:[]})
const cycles=[c(0,800),c(1,-400),c(2,800,'two')]
const statsCycles=[4,-5,-4,7,8].map((pnl,i)=>({...c(i,pnl),starting_capital:100}))
const paths=JSON.parse(execFileSync(process.env.PYTHON_BIN||'python3',['-c','import sys,json;from app.services.day_journey import journeys;print(json.dumps(journeys(json.load(sys.stdin))))'],{input:JSON.stringify(statsCycles),env:{...process.env,PYTHONPATH:root+'/backend'},encoding:'utf8'}))
await build({stdin:{contents:`
import React from 'react';import{createRoot}from'react-dom/client';
import{AnalysisProvider}from'${root}/shared/analysis/environment';
import{GroupCard}from'${root}/shared/analysis/TradeAnalysis';
import DayPathBehavior from '${root}/shared/analysis/DayPathBehavior';
import '${root}/windowsapp/src/desktopAnalysis.css';
const cycles=${JSON.stringify(cycles)},paths=${JSON.stringify(paths)};
const sessions=['one','two'].map((id,i)=>({session_id:id,user_id:'u',symbol:'NIFTY',date:'2026-10-15',start_time:'09:15',instrument_type:'options',session_type:'paper',session_capital:i?30000:10000,net_pnl:i?800:400,pnl_pct:4,total_commission:0,trade_count:2,round_trip_count:1,buy_count:1,sell_count:1}));
const group={key:'group',date:'2026-10-15',symbol:'NIFTY',instrument_type:'options',session_type:'paper',sessions,totalPnl:1200,totalTrades:3,totalCommission:0,sessionCapital:10000};
const trade=(i,session)=>({trade_id:String(i),session_id:session,user_id:'u',symbol:'NIFTY',side:i%2?'SELL':'BUY',quantity:20,price:100,timestamp:${start}+i*60,instrument_type:'options',right:'CE',strike:25000,expiry:'2026-10-15',commission:0});
const api={getSessionDetail:async id=>({...sessions.find(s=>s.session_id===id),cycles:cycles.filter(c=>c.session_id===id),trades:Array.from({length:20},(_,i)=>trade(i,id)),orders:[]}),patternGetChartByDate:async()=>null};
const app=createRoot(document.getElementById('root'));
const chart=()=> <div className="analysis-panels" data-testid="price-charts" style={{height:280,display:'flex'}}><div style={{flex:1}}>Underlying chart</div><div style={{flex:1}}>Option chart</div></div>;
window.selectCycle='';window.show=(host,view)=>app.render(<React.StrictMode><AnalysisProvider value={{api,performance:{},desktop:host==='desktop',charts:{AnalysisChartPanel:chart},active:true}}><main className={host==='desktop'?'analysis-selected-session':undefined} data-host={host} style={{padding:12,...(host==='desktop'?{height:'100vh',boxSizing:'border-box'}:{})}}>{view==='trades'?<GroupCard key={host} group={group} initiallyExpanded/>:<DayPathBehavior paths={paths} onSelect={identity=>{window.selectCycle=identity.cycle_id}}/>}</main></AnalysisProvider></React.StrictMode>);
`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},alias:{react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0d1117;color:#eee"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(String(e)))
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.show)
 for(const host of ['website','desktop']){
  await page.evaluate(host=>window.show(host,'trades'),host)
  const journey=page.getByRole('region',{name:'Day P&L journey',exact:true})
  await journey.getByText(/Average session capital ₹20,000/).waitFor()
  assert.equal(await journey.locator('circle').count(),3)
  assert.equal(await journey.getByRole('combobox').inputValue(),'pct')
  await journey.getByRole('button',{name:'Trade 2: 2.00%',exact:true}).focus()
  await journey.getByText(/Trade ₹-400 \(-2.00%\).*Cumulative 2.00%/).waitFor()
  await journey.getByRole('combobox').selectOption('money')
  assert.equal(await journey.getByRole('button',{name:'Trade 3: ₹1,200',exact:true}).count(),1)
  assert.equal(await page.getByTestId('price-charts').count(),1)
  let columns=await page.locator('.analysis-trades-top').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)
  assert.equal(columns,2)
  if(host==='desktop'){
   const listBox=await page.locator('.analysis-trades-list').boundingBox()
   const journeyBox=await journey.boundingBox()
   assert.ok(Math.abs(listBox.height-journeyBox.height)<1,'Desktop journey matches trades height')
   assert.ok(Math.abs(listBox.y-journeyBox.y)<1,'Desktop top panels align')
   const chartBox=await page.getByTestId('price-charts').boundingBox()
   assert.ok(chartBox.y>=listBox.y+listBox.height&&chartBox.y<=listBox.y+listBox.height+13,'Journey does not push charts down')
  }
  if(host==='desktop'){
   for(const size of [{width:1920,height:1080},{width:1366,height:768}]){
    await page.setViewportSize(size)
    const fits=await journey.evaluate(el=>el.scrollHeight<=el.clientHeight+1)
    assert.ok(fits,'Complete desktop journey fits without internal scrolling')
    const chartBox=await page.getByTestId('price-charts').boundingBox()
    assert.ok(Math.abs(chartBox.y+chartBox.height-(size.height-29))<3,'Price charts fill remaining desktop height')
    const listBox=await page.locator('.analysis-trades-list').boundingBox()
    const journeyBox=await journey.boundingBox()
    assert.ok(Math.abs(listBox.height-journeyBox.height)<1,'Both top panels share height after resize')
   }
  }
  await page.setViewportSize({width:760,height:1000})
  columns=await page.locator('.analysis-trades-top').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)
  assert.equal(columns,1)
  await page.setViewportSize({width:1440,height:1000})
  await page.evaluate(host=>window.show(host,'behavior'),host)
  const panel=page.getByRole('region',{name:'Day P&L path and sizing'})
  await panel.getByText('Maximum drawdown (%)',{exact:true}).waitFor({state:'attached'})
  await panel.getByText('₹9 · 9.00%',{exact:true}).first().waitFor()
  assert.ok((await panel.innerText()).includes('Below zero · 2 entries'))
  await panel.getByRole('combobox',{name:'Day behavior trend metric'}).selectOption('allocation')
  await panel.getByRole('img',{name:'Allocation ratio: down / up',exact:true}).waitFor()
  await panel.getByRole('button',{name:'Trade 1: 4.00%',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.selectCycle),'0')
  assert.deepEqual(errors,[],host)
 }
 console.log('Day journey browser checks passed for website/desktop: combined-capital curve, units, keyboard inspection, responsive layout, behavior metrics and cycle drilldown')
}finally{await browser.close();await new Promise(r=>server.close(r))}
