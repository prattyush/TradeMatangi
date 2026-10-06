/** Four production charts + order editor, synthetic market data only.
 * node scripts/performance-chart-soak.mjs [--realtime] [--minutes=60]
 */
import { build } from '../frontend/node_modules/esbuild/lib/main.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'

const realtime = process.argv.includes('--realtime')
const minutes = Number(process.argv.find(arg => arg.startsWith('--minutes='))?.split('=')[1] ?? 60)
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new Error('minutes must be 1–240')
const seconds = Math.round(minutes * 60)
const directory = await mkdtemp(join(tmpdir(), 'tradematangi-soak-'))
const source = `
import React, { useState, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Chart from './src/components/Chart';
import OrderPanel from './src/components/OrderPanel';
import api from './src/services/api';
import { useSnapshot } from './src/hooks/useSnapshot';
import { startPerformanceDiagnostics } from './src/services/performanceDiagnostics';
const originalFetch=window.fetch.bind(window);
const failures=[];window.addEventListener('error', e=>failures.push(e.message));
window.addEventListener('unhandledrejection', e=>failures.push(String(e.reason)));
const warn=console.warn;console.warn=(...args)=>{failures.push(args.map(String).join(' '));warn(...args)};
localStorage.setItem('tradingPerformance','1');const stopDiagnostics=startPerformanceDiagnostics();
const start=Date.parse('2026-10-06T09:15:00Z')/1000;
const requests={};let edits=0;let snapshots=0;
let orders=[{order_id:'sl',session_id:'soak',symbol:'BSESEN',side:'SELL',order_type:'STOPLOSS',
  status:'PENDING',quantity:20,trigger_price:90,limit_price:89,right:'CE',strike:80000,expiry:'2026-10-08',is_stoploss:true}];
window.fetch=async (url,options={})=>{
  const parsed=new URL(url,location.href);requests[parsed.pathname]=(requests[parsed.pathname]||0)+1;
  if(parsed.pathname==='/api/snapshots'){snapshots++;return new Response(JSON.stringify({event_id:JSON.parse(options.body).event_id}));}
  if(parsed.pathname.startsWith('/api/orders/')){edits++;orders=[{...orders[0],...JSON.parse(options.body)}];return new Response(JSON.stringify(orders[0]));}
  if(parsed.pathname.includes('pre-session'))return new Response(JSON.stringify({candles:[]}));
  const interval=Number(parsed.searchParams.get('interval_minutes')||3)*60;
  const candles=Array.from({length:Math.round(750*60/interval)},(_,i)=>{
    const time=start-172800+i*interval;const price=parsed.pathname.includes('options')?100:80000;
    return {time,open:price,high:price+2,low:price-2,close:price+1};
  });return new Response(JSON.stringify({candles}));
};
let advance;const candles={};const flat={symbol:'BSESEN',side:'FLAT',quantity:0,avg_entry_price:0,entry_commission:0};
const panes=[{id:1,type:'equity',interval:3},{id:2,type:'equity',interval:1},{id:3,type:'options',interval:3,right:'CE'},{id:4,type:'options',interval:3,right:'PE'}];
function Harness(){
  const [tick,setTick]=useState(null),[trades,setTrades]=useState([]),[openOrders,setOrders]=useState(orders);
  const ref=useRef({});const snapshot=useSnapshot(ref);
  const positions={...flat,side:'LONG',quantity:20,avg_entry_price:100};
  ref.current={sessionId:'soak',symbol:'BSESEN',date:'2026-10-06',sessionType:'real',sessionInstrumentType:'options',
    currentPrice:tick?.close||80000,currentPriceCE:100,currentPricePE:100,latestEquityTick:tick,
    position:flat,positionCE:positions,positionPE:positions,trades,openOrders,sessionCapital:100000,
    sessionStrikeCE:80000,sessionStrikePE:80000,sessionExpiry:'2026-10-08'};
  advance=(second)=>{
    const price=80000+Math.sin(second/60)*100;
    const next={type:'tick',time:start+second,open:price,high:price+2,low:price-2,close:price};
    flushSync(()=>setTick(next));
    // 100 fills over the first 50 minutes; entries and full exits alternate per leg.
    if(second%30===0&&second<=3000){const index=second/30;const right=index%2?'CE':'PE';
      const trade={trade_id:String(index),session_id:'soak',symbol:'BSESEN',right,strike:80000,expiry:'2026-10-08',
        side:Math.floor((index-1)/2)%2?'SELL':'BUY',quantity:20,price:100+Math.sin(second/60),timestamp:start+second,
        underlying_price:price,commission:1};flushSync(()=>setTrades(prev=>[...prev,trade]));
      snapshot.captureSnapshot({type:'order_filled',description:'Mock fill',details:{}});
    }
  };
  const paneInputs=useMemo(()=>new Map(panes.map(pane=>[pane.id,{trades:pane.type==='equity'?trades:trades.filter(t=>t.right===pane.right),
    orders:pane.type==='equity'?[]:openOrders.filter(order=>order.right===pane.right)}])),[trades,openOrders]);
  const optionTicks=useMemo(()=>tick?{CE:{...tick,right:'CE',open:100,high:102,low:98,close:100+Math.sin(tick.time)},
    PE:{...tick,right:'PE',open:100,high:102,low:98,close:100+Math.cos(tick.time)}}:{},[tick]);
  return <><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',width:1200}}>{panes.map(pane=><Chart key={pane.id}
    symbol='BSESEN' tradingDate='2026-10-06' startTime='09:15:00' historyMode='live' markerSessionKey='soak'
    paneType={pane.type} intervalMinutes={pane.interval} right={pane.right} strike={pane.right?80000:undefined}
    expiry={pane.right?'2026-10-08':undefined} height={280} latestTick={pane.right?optionTicks[pane.right]||null:tick}
    trades={paneInputs.get(pane.id).trades} openOrders={paneInputs.get(pane.id).orders}
    onCandlesChange={data=>{candles[pane.id]=data.length}} onMaximize={()=>{}} />)}</div>
    <OrderPanel sessionState='running' currentPrice={100} openOrders={openOrders} position={positions} instrumentType='options'
      activeRight='CE' lotSize={20} sizingMode='quantity' fundsRatios={{l:3,m:5,h:10}} riskRatios={{l:1,m:2,h:3}}
      defaultSlPct={1} sessionCapital={100000} sessionType='real' targetDeviationPct={.01} injectedEditPrice={null}
      onRequestPricePick={()=>{}} onPlaceOrder={async()=>{}} onCancelOrder={async()=>{}}
      onUpdateOrder={async(id,trigger,limit,quantity)=>{await api.updateOrder('soak',id,trigger,limit,undefined,quantity);setOrders(orders)}} />
    <button id='snapshots' onClick={snapshot.startSnapshots}>Snapshots</button></>;
}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(<Harness/>));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const samples=[],interactionTimes=[];
async function editOrder(){const started=performance.now();document.querySelector('[title="Click to edit price"]').click();await pause(0);
  const input=document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
  if(!input){failures.push('Order edit input unavailable');return;}
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'95.00');
  input.dispatchEvent(new Event('input',{bubbles:true}));await pause(0);
  const save=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save');
  if(!save){failures.push('Order save unavailable');return;}save.click();await pause(0);interactionTimes.push(performance.now()-started);
}
(async()=>{
  await pause(100);document.getElementById('snapshots').click();await pause(0);
  window.gc?.();samples.push({minute:0,heapMB:performance.memory?.usedJSHeapSize/1024/1024,...await (await originalFetch('/soak-sample')).json()});
  for(let second=1;second<=${seconds};second++){
    advance(second);await pause(${realtime ? 1000 : 0});
    if(second%300===0||second===${seconds}){await editOrder();window.gc?.();const sample={minute:second/60,heapMB:performance.memory?.usedJSHeapSize/1024/1024};
      try{Object.assign(sample,await (await originalFetch('/soak-sample')).json())}catch{}samples.push(sample);}
    if(second===1200||second===1260){document.querySelector('[aria-label="All markers"]').click();await pause(0);}
  }
  const diagnostics=window.tradingPerformance;
  const counters={...diagnostics.counters};const tickDurations=diagnostics.entries.filter(e=>e.name==='chart-tick-update').map(e=>e.duration).sort((a,b)=>a-b);
  stopDiagnostics();root.unmount();await pause(20);window.gc?.();
  const processAfterUnmount=await (await originalFetch('/soak-sample')).json();
  const result={mode:'${realtime ? 'real-time' : 'accelerated'}',simulatedMinutes:${minutes},edits,snapshots,requests,candles,samples,counters,
    interactionP95Ms:interactionTimes.sort((a,b)=>a-b)[Math.floor(interactionTimes.length*.95)],
    chartTickP95Ms:tickDurations[Math.floor(tickDurations.length*.95)],afterUnmountHeapMB:performance.memory?.usedJSHeapSize/1024/1024,processAfterUnmount,failures};
  await originalFetch('/soak-result',{method:'POST',body:JSON.stringify(result)});
  document.body.innerHTML='<pre id="result">'+JSON.stringify(result)+'</pre>';
})().catch(error=>{document.body.innerHTML='<pre id="result">'+JSON.stringify({failures:[String(error)]})+'</pre>'});
`
let server, browser
try {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: resolve('frontend') },
    bundle: true, write: false, minify: true, define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(directory, 'bundle.js'), bundle.outputFiles[0].contents)
  const html = '<!doctype html><html><body><div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>'
  const completion = Promise.withResolvers()
  server = createServer((request, response) => {
    if (request.url === '/soak-sample') {
      let rendererRssMB = null, rendererPrivateMB = null, rendererPssMB = null, rendererProcesses = []
      try {
        const rows = execFileSync('ps', ['-eo', 'pid,ppid,rss,args'], { encoding: 'utf8' }).trim().split('\n').slice(1)
          .map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
        const descendants = new Set([browser.pid])
        for (let i = 0; i < 6; i++) for (const row of rows) if (descendants.has(Number(row[2]))) descendants.add(Number(row[1]))
        rendererProcesses = rows.filter(row => descendants.has(Number(row[1])) && row[4].includes('--type=renderer')).map(row => {
          const smaps = readFileSync('/proc/' + row[1] + '/smaps_rollup', 'utf8')
          const amount = name => Number(smaps.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1] ?? 0) / 1024
          return { pid: Number(row[1]), rssMB: Number(row[3]) / 1024, privateMB: amount('Private_Clean') + amount('Private_Dirty'), pssMB: amount('Pss') }
        })
        rendererRssMB = rendererProcesses.reduce((sum, row) => sum + row.rssMB, 0)
        rendererPrivateMB = rendererProcesses.reduce((sum, row) => sum + row.privateMB, 0)
        rendererPssMB = rendererProcesses.reduce((sum, row) => sum + row.pssMB, 0)
      } catch { /* RSS is available on Linux; heap remains available elsewhere. */ }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ rendererRssMB, rendererPrivateMB, rendererPssMB, rendererProcesses })); return
    }
    if (request.url === '/soak-result') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => { response.end('ok'); completion.resolve(JSON.parse(body)) })
      return
    }
    response.setHeader('Content-Type', 'text/html'); response.end(html)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const args = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info', '--js-flags=--expose-gc', '--user-data-dir=' + join(directory, 'chrome')]
  if (!realtime) args.push('--dump-dom', '--virtual-time-budget=' + (seconds * 20 + 5000))
  args.push('http://127.0.0.1:' + server.address().port)
  browser = spawn(process.env.CHROME_BIN || 'google-chrome', args)
  let output = '', errors = ''
  browser.stdout.on('data', data => { output += data })
  browser.stderr.on('data', data => { errors = (errors + data).slice(-4000) })
  const timeout = setTimeout(() => { browser.kill(); completion.reject(new Error('Soak timed out: ' + errors)) },
    realtime ? seconds * 1000 + 60_000 : Math.max(120_000, seconds * 20))
  browser.on('error', completion.reject)
  browser.on('exit', () => {
    const match = output.match(/<pre id="result">(.*?)<\/pre>/s)
    if (match) completion.resolve(JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')))
    else completion.reject(new Error('Browser exited without a soak result: ' + errors))
  })
  let result
  try { result = await completion.promise }
  finally { clearTimeout(timeout) }
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length) process.exitCode = 1
} finally {
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const closed = new Promise(done => browser.once('close', done))
    browser.kill()
    await closed
  }
  server?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
