/** Synthetic website/desktop analysis interval checks; no broker or database calls. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname), dir=await mkdtemp(join(tmpdir(),'analysis-interval-'))
const chartModule=JSON.stringify(root+'/frontend/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs')
await writeFile(dir+'/instrumented-charts.mjs',`export * from ${chartModule};
import {createChart as originalCreateChart} from ${chartModule};
export function createChart(...args){
 const chart=originalCreateChart(...args),records=[];
 for(const name of ['addCandlestickSeries','addLineSeries']){const add=chart[name].bind(chart);chart[name]=(...opts)=>{const series=add(...opts),set=series.setData.bind(series),entry={kind:name,data:[],removed:false,series,chart,owner:args[0]};records.push(entry);(globalThis.__chartDebug??=[]).push(entry);series.setData=data=>{entry.data=data;return set(data)};return series}}
 const remove=chart.removeSeries.bind(chart);chart.removeSeries=series=>{const entry=records.find(e=>e.series===series);if(entry)entry.removed=true;return remove(series)};
 const dispose=chart.remove.bind(chart);chart.remove=()=>{records.forEach(e=>e.removed=true);return dispose()};return chart;
}
`)
await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {AnalysisProvider} from '${root}/shared/analysis/environment';
import {CandleInterval} from '${root}/shared/analysis/CandleInterval';
import {WebsiteAnalysisChartPanel} from '${root}/frontend/src/components/analysis/AnalysisCharts';
import {WebsiteSnapshotChart,WebsiteSnapshotOptionsChart} from '${root}/frontend/src/components/analysis/SnapshotCharts';
import {WebsiteTradesChart,WebsitePatternChart} from '${root}/frontend/src/components/analysis/ComparisonCharts';
import AnalysisPanels from '${root}/windowsapp/src/AnalysisPanels';
import DesktopAnalysisChart from '${root}/windowsapp/src/AnalysisChart';
import '${root}/windowsapp/src/desktopAnalysis.css';
const date='2026-10-15',event=Date.parse(date+'T09:33:13Z')/1000,start=Date.parse(date+'T09:15:00Z')/1000;
window.calls=[];
const bars=interval=>Array.from({length:100},(_,i)=>({time:Math.floor(start/(interval*60))*interval*60+i*interval*60,open:100,high:103,low:98,close:101}));
const response=async interval=>{const fail=window.failInterval===interval,empty=window.emptyInterval===interval;await new Promise(r=>setTimeout(r,window.delays?.[interval]??0));if(fail)throw new Error('Synthetic history failure');return empty?[]:bars(interval)};
const history=(method,index)=>async(...args)=>{window.calls.push({method,interval:args[index],strike:args[2]});return {candles:await response(args[index])}};
const api={getSessionDetail:async()=>({trades}),getHistorical:history('historical',2),getOptionsHistorical:history('options',5),patternOhlcOptions:history('pattern-options',5),patternOhlcEquity:history('pattern-equity',2),getPreSession:async(...args)=>{window.calls.push({method:'day',interval:args[3]});return response(args[3])}};
const base={session_id:'session',user_id:'user',symbol:'BSESEN',date,side:'BUY',quantity:20,price:102,timestamp:event,instrument_type:'options',commission:1,right:'CE',strike:73800,expiry:'2026-10-15',exchange:'bse_fo',product:'MIS'};
const trades=[{...base,trade_id:'ce'}, {...base,trade_id:'pe',right:'PE',strike:74000}];
const props={symbol:'BSESEN',date,trades,allTrades:trades,isOptions:true,historicalDays:0};
const snapshot={...props,sessionId:'session',snapshotEventTime:event,barTime:Math.floor(event/180)*180,barOhlc:{open:100,high:103,low:99,close:102},currentPrice:102,openOrders:[],position:null,filledTrades:[]};
const strikeTabs=[{key:'CE',label:'CE 73800',right:'CE',strike:73800,expiry:base.expiry,trades:[trades[0]]}];
function Host({mode}){let content;if(mode==='website')content=<WebsiteAnalysisChartPanel {...props}/>;
else if(mode==='website-snapshot')content=<div style={{height:500}}><WebsiteSnapshotChart {...snapshot} position={{side:'LONG',quantity:1,avg_entry_price:100,pnl:10,pnl_pct:1}}/></div>;
else if(mode==='website-option-snapshot')content=<div style={{height:500}}><WebsiteSnapshotOptionsChart {...snapshot} right="CE" strike={73800} expiry={base.expiry}/></div>;
else if(mode==='website-comparison')content=<WebsiteTradesChart {...props} getMarkerText={t=>t.side} strikeTabs={strikeTabs} isOpt/>;
else if(mode==='website-pattern')content=<WebsitePatternChart {...props} annotations={[]} topPatterns={{}} activeStrategy={null} activeCategory={null} instFilter="underlying" setInstFilter={()=>{}} isOpt patternStrike={{ce:null,pe:null,exp:null}}/>;
else if(mode==='desktop'||mode==='desktop-nested')content=<AnalysisPanels {...props}/>;
else content=<div style={{height:500}}><DesktopAnalysisChart {...snapshot}/></div>;
return <AnalysisProvider value={{api,performance:{},active:true}}>{mode==='desktop-nested'?<><CandleInterval/><AnalysisProvider value={{api,performance:{},active:true}}>{content}</AnalysisProvider></>:content}</AnalysisProvider>}
const app=createRoot(document.getElementById('root'));window.show=mode=>{window.calls=[];app.render(<React.StrictMode><Host key={mode} mode={mode}/></React.StrictMode>)};
`,resolveDir:root+'/frontend',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',alias:{'lightweight-charts':dir+'/instrumented-charts.mjs',react:root+'/frontend/node_modules/react','react-dom':root+'/frontend/node_modules/react-dom'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="background:#10131a;color:#eee"><div id="root" style="width:1200px;height:620px"></div><script type="module" src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
try{
 const page=await browser.newPage({viewport:{width:1280,height:760}}),errors=[]
 page.on('pageerror',e=>{errors.push(String(e));console.error(String(e))})
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.show)
 for(const mode of ['website','website-snapshot','website-option-snapshot','website-comparison','website-pattern','desktop','desktop-snapshot','desktop-nested']){
  console.log('Checking',mode)
  await page.evaluate(mode=>window.show(mode),mode)
  await page.getByRole('combobox',{name:'Candle interval',exact:true}).first().waitFor()
  for(const interval of [1,5,10,15,30,60,3]){
   await page.evaluate(()=>{window.calls=[]})
   await page.getByRole('combobox',{name:'Candle interval',exact:true}).first().selectOption(String(interval))
   await page.waitForFunction(interval=>window.calls.length>0&&window.calls.every(c=>c.interval===interval),interval)
   await page.waitForTimeout(120)
   for(const select of await page.getByRole('combobox',{name:'Candle interval',exact:true}).all())assert.equal(await select.inputValue(),String(interval),mode)
   assert.deepEqual(errors,[],mode)
  }
  if(mode.startsWith('website')){
   const select=page.getByRole('combobox',{name:'Candle interval',exact:true}).first()
   await page.evaluate(()=>window.failInterval=5)
   await select.selectOption('5')
   await page.getByRole('alert').filter({hasText:'Could not load 5m candles.'}).first().waitFor()
   assert.equal(await page.evaluate(()=>window.__chartDebug.filter(e=>!e.removed&&e.owner.isConnected).every(e=>e.data.length===0)),true,mode+' clears failed interval data and overlays')
   await page.evaluate(()=>{window.failInterval=null;window.emptyInterval=15})
   await select.selectOption('15')
   await page.getByRole('status').filter({hasText:'No 15m candles available.'}).first().waitFor()
   assert.equal(await page.evaluate(()=>window.__chartDebug.filter(e=>!e.removed&&e.owner.isConnected).every(e=>e.data.length===0)),true,mode+' clears empty interval data')
   await page.evaluate(()=>window.emptyInterval=null)
   await page.getByRole('button',{name:'Retry candles',exact:true}).evaluateAll(buttons=>buttons.forEach(button=>button.click()))
   await page.waitForFunction(()=>window.__chartDebug.filter(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries').every(e=>e.data.length>0))
   await page.evaluate(()=>window.delays={5:200,1:10})
   await select.selectOption('5');await select.selectOption('1');await page.waitForTimeout(300)
   assert.equal(await select.inputValue(),'1')
   assert.equal(await page.evaluate(()=>window.__chartDebug.filter(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries').every(e=>e.data.length>1&&Number(e.data[1].time)-Number(e.data[0].time)===60)),true,mode+' ignores late history')
   await page.evaluate(()=>window.delays={})
   if(mode==='website-snapshot'){
    await page.evaluate(()=>window.__chartDebug.filter(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries').forEach(e=>e.chart.timeScale().fitContent()))
    const chip=page.locator('[style*="translateX(-50%)"]')
    await chip.waitFor()
    await page.waitForTimeout(100)
    const offset=await chip.evaluate(el=>{const e=window.__chartDebug.find(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries');return {actual:el.getBoundingClientRect().top-e.owner.getBoundingClientRect().top,expected:Math.max(0,e.series.priceToCoordinate(102)-14)}})
    assert.ok(Math.abs(offset.actual-offset.expected)<3,JSON.stringify(offset))
    for(const height of [600,450]){
     await page.evaluate(height=>{const e=window.__chartDebug.find(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries');e.owner.parentElement.parentElement.parentElement.style.height=height+'px';e.chart.timeScale().scrollToPosition(3,false)},height)
     await page.waitForTimeout(120)
     const resized=await chip.evaluate(el=>{const e=window.__chartDebug.find(e=>!e.removed&&e.owner.isConnected&&e.kind==='addCandlestickSeries');return {actual:el.getBoundingClientRect().top-e.owner.getBoundingClientRect().top,expected:Math.max(0,e.series.priceToCoordinate(102)-14)}})
     assert.ok(Math.abs(resized.actual-resized.expected)<3,JSON.stringify(resized))
    }
   }
  }
  if(mode==='desktop'){
   const tabs=page.getByRole('navigation',{name:'Exact option contracts'}).getByRole('button')
   assert.deepEqual(await tabs.allTextContents(),['CE 73800','PE 74000'])
   assert.match(await tabs.first().getAttribute('title'),/2026-10-15.*bse_fo.*MIS/)
   const fit=page.getByRole('button',{name:'Fit chart',exact:true}).first()
   assert.equal(await fit.innerText(),'');assert.equal(await fit.locator('svg').count(),1)
   await page.getByRole('button',{name:'Maximize chart',exact:true}).first().click()
   assert.equal(await page.getByRole('combobox',{name:'Candle interval',exact:true}).first().inputValue(),'3')
   await page.getByRole('button',{name:'Restore chart',exact:true}).click()
  }
 }
 console.log('Analysis interval browser checks passed: eight website/desktop chart modes, synchronized selectors, short contract labels and icon controls')
}finally{await browser.close();await new Promise(r=>server.close(r))}
