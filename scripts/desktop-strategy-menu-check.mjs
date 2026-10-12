/** Actual desktop chart context menu; synthetic callbacks, no broker requests. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core')
const root=resolve(new URL('..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'strategy-menu-')),artifacts=root+'/.cache/desktop-strategy-menu'
await mkdir(artifacts,{recursive:true})
await build({stdin:{contents:`
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ChartTile}from'${root}/windowsapp/src/ChartTile';import'${root}/windowsapp/src/styles.css';
const start=Date.parse('2026-10-12T09:15:00Z')/1000;const candles=Array.from({length:200},(_,i)=>({timestamp:start+i*180,open:100,high:110,low:90,close:105}));window.actions=[];
function Demo(){const[underlying,setUnderlying]=useState(false);const[held,setHeld]=useState(true);window.underlying=setUnderlying;window.held=setHeld;
return <div style={{height:620,width:'100%',display:'grid'}}><ChartTile symbol='NIFTY' interval='3' supportedIntervals={[3]} onIntervalChange={()=>{}} candles={candles} loading={false} message='' settings={{background:'#151a23',textColor:'#aeb8ca',gridColor:'#ffffff',gridOpacity:.1,gridStyle:'solid',gridSize:1,movingAverageType:'MA',movingAveragePeriods:'5,10,20',showChartInfo:true,horizontalLineColor:'#facc15',horizontalLineWidth:2,trendLineColor:'#60a5fa',trendLineWidth:2,drawingLineColor:'#60a5fa',drawingLineWidth:2,drawingFillColor:'#60a5fa',drawingFillOpacity:.15}} isReplaying={false} isLive={true} instrument={underlying?{kind:'index',exchange:'NSE',symbol:'NIFTY'}:{kind:'option',exchange:'NFO',symbol:'NIFTY',right:'CE',strike:25000,expiry:'2026-10-13'}} baseUrl='' drawingRequest={async()=>({drawings:[]})} onConfigure={()=>{}} onMaximize={()=>{}} maximized={false} active={true} indicators={[]} drawingCommand={null} drawingAction={null} drawingMode='once' onDrawingComplete={()=>{}} onActivate={()=>{}} tradingEnabled orderEntryEnabled={!underlying} underlyingStrategyEnabled={underlying} position={!underlying&&held?{symbol:'NIFTY',side:'LONG',quantity:65,avg_entry_price:100,entry_commission:0}:null} onChartOrderAction={(action,price,anchor)=>window.actions.push({action,price,anchor})}/></div>}
createRoot(document.getElementById('root')).render(<Demo/>);
`,resolveDir:root+'/windowsapp',loader:'tsx'},bundle:true,jsx:'automatic',outfile:dir+'/app.js',define:{'import.meta.env':'{}'},logLevel:'silent'})
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0a1020"><div id="root"></div><script src="/app.js"></script></body></html>')
const server=createServer(async(req,res)=>{try{const path=dir+(req.url==='/'?'/index.html':req.url);res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(path))}catch{res.statusCode=404;res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1366,height:800}}),errors=[];page.on('pageerror',error=>errors.push(String(error)))
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.kline canvas').first().waitFor()
 const menu=page.locator('.chart-context-menu')
 const open=async(edge=false)=>{await page.mouse.click(edge?1330:600,edge?570:300,{button:'right'});await menu.waitFor()}
 await open();assert.equal(await menu.locator(':scope > button').filter({hasText:/Aggressive SL|Breakeven|Lock profit/}).count(),0)
 assert.equal(await menu.locator(':scope > .profit-size-menu > button').filter({hasText:'Take profit here'}).count(),1)
 assert.equal(await menu.getByRole('button',{name:'Aggressive SL',exact:true}).isVisible(),false)
 for(const [name,action] of [['Aggressive SL','START_AGGRESSIVE_SL'],['Breakeven','START_BREAKEVEN'],['Lock profit here','START_LOCK_PROFIT']]){
   if(!await menu.isVisible())await open()
   await menu.getByRole('button',{name:'Strategies ▸',exact:true}).hover();await menu.getByRole('button',{name,exact:true}).click()
   assert.equal(await page.evaluate(()=>window.actions.at(-1).action),action);assert.equal(await menu.count(),0)
 }
 await open();await menu.getByRole('button',{name:'Take profit here ▸',exact:true}).hover();await menu.getByRole('button',{name:'Half',exact:true}).click();assert.equal(await page.evaluate(()=>window.actions.at(-1).action),'START_TARGET_PROFIT_HALF')
 await open();await menu.getByRole('button',{name:'Strategies ▸',exact:true}).focus();assert(await menu.getByRole('button',{name:'Breakeven',exact:true}).isVisible());await menu.getByRole('button',{name:'Breakeven',exact:true}).click()
 await open(true);await menu.getByRole('button',{name:'Strategies ▸',exact:true}).hover();const strategy=await menu.getByRole('button',{name:'Aggressive SL',exact:true}).boundingBox();assert(strategy.x>=0&&strategy.x+strategy.width<=1366);await menu.getByRole('button',{name:'Lock profit here',exact:true}).click()
 await page.evaluate(()=>window.underlying(true));await open(true);await menu.getByRole('button',{name:'Strategies ▸',exact:true}).hover();await menu.getByRole('button',{name:'Underlying target here ▸',exact:true}).hover();await menu.getByRole('button',{name:'Full',exact:true}).click();assert.equal(await page.evaluate(()=>window.actions.at(-1).action),'START_UNDERLYING_TARGET')
 await open(true);await menu.getByRole('button',{name:'Strategies ▸',exact:true}).hover();await menu.getByRole('button',{name:'Underlying SL here ▸',exact:true}).hover();await menu.getByRole('button',{name:'Half',exact:true}).click();assert.equal(await page.evaluate(()=>window.actions.at(-1).action),'START_UNDERLYING_SL_HALF')
 await page.evaluate(()=>{window.underlying(false);window.held(false)});await open();await menu.getByRole('button',{name:'Strategies ▸',exact:true}).hover();assert.equal(await menu.getByRole('button',{name:'Aggressive SL',exact:true}).count(),0);assert.equal(await menu.getByRole('button',{name:'Breakeven',exact:true}).count(),0);assert(await menu.getByRole('button',{name:'Lock profit here',exact:true}).isVisible())
 await page.screenshot({path:artifacts+'/strategies-submenu.png'});assert.deepEqual(errors,[])
 assert((await page.evaluate(()=>window.actions)).every(entry=>Number.isFinite(entry.price)&&entry.anchor.x>0&&entry.anchor.y>0))
 console.log('PASS desktop strategy submenu: grouped actions, Take Profit at root, same action/price/anchor, focus, edge opening, underlying strategy sizes, existing position eligibility; no page errors')
}finally{await browser.close();server.close()}
