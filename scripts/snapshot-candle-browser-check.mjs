/** Desktop snapshot viewer and real KLineCharts acceptance, with synthetic API data. */
import { build } from '../frontend/node_modules/esbuild/lib/main.js';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), 'snapshot-candle-ui-'));
const artifacts = root + '/.cache/snapshot-event-candle';
await mkdir(artifacts, { recursive: true });
await build({stdin:{contents:`
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{init}from'klinecharts';
import Viewer from '${root}/shared/analysis/EventSnapshotViewer';
import Chart from '${root}/windowsapp/src/AnalysisChart';import{AnalysisProvider}from'${root}/shared/analysis/environment';
import '${root}/windowsapp/src/desktopAnalysis.css';
const start=Date.parse('2026-10-09T09:15:00Z')/1000;
window.start=start;window.reads=[];
const rows=Array.from({length:50},(_,i)=>({time:start+i*180,open:100,high:200,low:80,close:140}));
const flat={side:'FLAT',quantity:0,avg_entry_price:0,pnl:0,pnl_pct:0};
const make=(id,offset,description)=>({event_id:id,session_id:'s',symbol:'NIFTY',date:'2026-10-09',instrument_type:'options',timestamp:start+offset,event:{description,type:'placed',details:{}},snapshot:{bar_time:start,bar_ohlc:{open:1,high:2,low:1,close:1},current_price:103,current_price_ce:104,current_price_pe:105,position:flat,position_ce:flat,position_pe:flat,open_orders:[{side:'BUY',order_type:'LIMIT',quantity:65,limit_price:101,trigger_price:0,is_stoploss:false}],strike_ce:25000,strike_pe:24950,expiry:'2026-10-13',filled_trades:[],session_capital:100000,wallet_balance:100000,combined_pnl:0,session_pnl:0,quantity_mode:'quantity'}});
const snapshots=[make('exact',225,'Exact event'),make('fallback',405,'Fallback event'),make('slow',585,'Slow event'),make('failed',765,'Failed reconstruction'),make('missing',10000,'Unavailable event')];
const api={getHistorical:async()=>({candles:[]}),getPreSession:async()=>rows,getOptionsHistorical:async()=>({candles:rows}),getSessionDetail:async()=>({trades:[]}),getSnapshotCandle:async(s,id,instrument)=>{window.reads.push({s,id,instrument});if(id==='fallback'||id==='missing')return{candle:null};if(id==='failed')throw Error('Cached history unreadable');if(id==='slow'){await new Promise(r=>setTimeout(r,300));return{candle:{time:start+540,open:100,high:999,low:80,close:999}}}return{candle:{time:start+180,open:100,high:108,low:95,close:103}}}};
const environment={api,performance:{},desktop:true,charts:{SnapshotChart:Chart,SnapshotOptionsChart:Chart}};
function App(){const[closed,setClosed]=useState(false);return <AnalysisProvider value={environment}>{!closed&&<Viewer session={{date:'2026-10-09',symbol:'NIFTY'}} snapshots={snapshots} onClose={()=>setClosed(true)} onDeleteAll={()=>{}}/>}</AnalysisProvider>}
createRoot(document.getElementById('root')).render(<App/>);
window.getChart=()=>{const dom=document.querySelector('.analysis-kline');dom.id=dom.getAttribute('k-line-chart-id');return init(dom)};
`,resolveDir:root+'/windowsapp',loader:'tsx'},alias:{react:root+'/windowsapp/node_modules/react','react-dom':root+'/windowsapp/node_modules/react-dom'},jsx:'automatic',bundle:true,outfile:dir+'/app.js',logLevel:'silent'});
await writeFile(dir+'/index.html','<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0d1117"><div id="root"></div><script src="/app.js"></script></body></html>');
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile(dir+(req.url==='/'?'/index.html':req.url)))}catch{res.statusCode=404;res.end()}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto('http://127.0.0.1:'+server.address().port);
 const waitCandle=async(offset,close)=>page.waitForFunction(({offset,close})=>{const last=window.getChart()?.getDataList().at(-1);return last?.timestamp===(window.start+offset)*1000&&last.close===close},{offset,close});
 await waitCandle(180,103);
 let data=await page.evaluate(()=>window.getChart().getDataList());
 assert.equal(data.length,2);assert.equal(data.at(-1).high,108);assert.equal(data.at(-1).low,95);
 await page.waitForFunction(()=>window.getChart().getOverlays().some(o=>o.name==='analysisLevel'&&o.extendData.text==='Captured current price'));
 const levels=await page.evaluate(()=>window.getChart().getOverlays().filter(o=>o.name==='analysisLevel').map(o=>({text:o.extendData.text,price:o.points[0].value})));
 assert(levels.some(o=>o.text==='Captured current price'&&o.price===103));assert(levels.some(o=>o.text==='BUY LIMIT 65'&&o.price===101));
 assert.equal(await page.locator('.analysis-snapshot-caption').count(),0);
 for(const tab of ['CE 25000','PE 24950','Underlying']){
   await page.getByRole('button',{name:tab,exact:true}).click();await waitCandle(180,103);
 }
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.reads.map(r=>r.instrument))].sort()),['CE','PE','underlying']);
 await page.getByRole('button',{name:/Fallback event/}).click();await waitCandle(360,140);
 data=await page.evaluate(()=>window.getChart().getDataList());assert.equal(data.length,3);assert.equal(data.at(-1).high,200);
 await page.getByRole('button',{name:/Slow event/}).click();await page.waitForFunction(()=>window.reads.some(r=>r.id==='slow'));
 await page.getByRole('button',{name:/Fallback event/}).click();await waitCandle(360,140);
 await page.waitForTimeout(400);await waitCandle(360,140);
 await page.getByRole('button',{name:/Failed reconstruction/}).click();await waitCandle(720,140);
 await page.keyboard.press('ArrowUp');await waitCandle(540,999);
 await page.keyboard.press('ArrowUp');await waitCandle(360,140);
 await page.setViewportSize({width:800,height:700});await waitCandle(360,140);
 const visible=await page.evaluate(()=>{const chart=window.getChart();const range=chart.getVisibleRange();const last=chart.getDataList().length-1;return last>=range.from&&last<range.to});assert(visible,'Selected event candle is visible after resize');
 await page.getByRole('button',{name:'Fit',exact:true}).click();await waitCandle(360,140);
 await page.screenshot({path:artifacts+'/desktop-snapshot-candle.png',fullPage:true});
 await page.getByRole('button',{name:/Unavailable event/}).click();
 await page.getByRole('alert').filter({hasText:'No candle data is available for the selected event'}).waitFor();
 assert.equal(await page.evaluate(()=>window.getChart().getDataList().length),0);
 await page.getByRole('button',{name:'✕ Close',exact:true}).click();assert.equal(await page.locator('.analysis-kline').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS desktop snapshots: event-second OHLC, full-bar fallback, stale captured boundary, underlying/CE/PE, late responses, reconstruction failure, keyboard navigation, resize/Fit, price lines, missing candle, close; no page errors');
} finally {await browser.close();await new Promise(r=>server.close(r))}
