/** Actual Day/Swing option renderers sharing synthetic drawing storage only. */
import { resolve } from "node:path";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = resolve(new URL("..", import.meta.url).pathname);
const { build } = await import(
  root + "/frontend/node_modules/esbuild/lib/main.js"
);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const dir = await mkdtemp(tmpdir() + "/swing-drawings-");
await build({
  stdin: {
    resolveDir: root + "/windowsapp",
    loader: "tsx",
    contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{init}from'klinecharts';import{ChartTile}from'${root}/windowsapp/src/ChartTile';import Swing from '${root}/windowsapp/src/SwingChart';import '${root}/windowsapp/src/styles.css';import '${root}/shared/swingWorkspace.css';
const settings={background:'#151a23',textColor:'#aeb8ca',gridColor:'#fff',gridOpacity:.12,gridStyle:'solid',gridSize:1,movingAverageType:'MA',movingAveragePeriods:'5,10,20',showChartInfo:true,horizontalLineColor:'#facc15',horizontalLineWidth:2,trendLineColor:'#60a5fa',trendLineWidth:2,drawingLineColor:'#60a5fa',drawingLineWidth:2,drawingFillColor:'#60a5fa',drawingFillOpacity:.16};
const base={kind:'option',exchange:'NSE',underlying:'NIFTY',expiry:'2026-10-27',strike:22000,right:'CE'},fo={...base,exchange:'NFO'},key=i=>JSON.stringify(Object.fromEntries(Object.entries(i).sort()));
const start=Date.parse('2026-10-13T09:15:00Z')/1000;
const candles=Array.from({length:180},(_,i)=>({time:start+i*60,timestamp:start+i*60,open:100,high:120,low:90,close:110}));
const drawing={tool:'Horizontal',points:[{timestamp:start+160*60,price:105}],visible:true,locked:false};
const records=[{drawing_id:'shared-day',revision:1,instrument:base,drawing}, {drawing_id:'private-old',revision:1,instrument:{...fo,drawing_scope:'swing:p:window'},drawing:{...drawing,points:[{timestamp:start+160*60,price:108}]}}, {drawing_id:'unscoped-old',revision:1,instrument:fo,drawing:{...drawing,points:[{timestamp:start+160*60,price:112}]}}];window.calls=[];
const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='chart-settings')return{settings};if(method==='GET'){const instrument=JSON.parse(new URLSearchParams(path.split('?')[1]).get('instrument'));return{drawings:records.filter(r=>!r.deleted&&key(r.instrument)===key(instrument))}};if(method==='POST'){const row={drawing_id:'new-shared',revision:1,instrument:body.instrument,drawing:body.drawing};records.push(row);return row};const row=records.find(r=>r.drawing_id===path.split('/')[1]);if(row.revision!==body.revision)throw Error('revision conflict');Object.assign(row,{drawing:body.drawing,revision:row.revision+1,deleted:method==='DELETE'});return row};
window.overlays=id=>{const el=document.querySelector('#'+id+' .kline');el.id=el.getAttribute('k-line-chart-id');return init(el).getOverlays().map(o=>o.id)};
function App(){const[show,setShow]=useState(true);return <><button onClick={()=>setShow(v=>!v)}>{show?'Close Swing':'Reopen Swing'}</button><main style={{display:'grid',gridTemplateColumns:'1fr 1fr',height:650}}><div id='day' style={{display:'flex',minHeight:0,height:650}}><ChartTile symbol='NIFTY CE' interval='1' supportedIntervals={[]} onIntervalChange={()=>{}} candles={candles} loading={false} message='' settings={settings} isReplaying={false} isLive={false} instrument={base} baseUrl='' drawingRequest={request} onConfigure={()=>{}} onMaximize={()=>{}} maximized={false} active={false} indicators={[]} drawingCommand={null} drawingAction={null} drawingMode='once' onDrawingComplete={()=>{}} onActivate={()=>{}}/></div><div id='swing' className='swing-chart-pane' style={{display:'flex',minHeight:0,height:650}}>{show&&<Swing pane={{symbol:'NIFTY',instrument_type:'options',right:'CE',strike:22000,expiry:'2026-10-27',interval:'1m',as_of_date:'2026-10-13'}} drawingScope='swing:p:window' candles={candles} loading={false} message='' live={false} active picking={false} orders={[]} trades={[]} onPick={()=>{}} onActivate={()=>{}} drawingRequest={request}/>}</div></main></>};createRoot(document.getElementById('root')).render(<App/>);
`,
  },
  bundle: true,
  jsx: "automatic",
  outfile: dir + "/app.js",
  alias: {
    react: root + "/frontend/node_modules/react",
    "react-dom": root + "/frontend/node_modules/react-dom",
    klinecharts: root + "/windowsapp/node_modules/klinecharts",
  },
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
await writeFile(
  dir + "/index.html",
  '<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  try {
    const path = dir + (req.url.startsWith("/app") ? req.url : "/index.html");
    res.setHeader(
      "Content-Type",
      path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(path));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForTimeout(300);
  await page.locator("#swing .kline").waitFor();
  await page.waitForTimeout(300);
  await page.waitForFunction(
    () =>
      window.overlays("swing").includes("private-old") &&
      window.overlays("day").includes("shared-day"),
  );
  assert(
    !(await page.evaluate(() =>
      window.overlays("day").includes("private-old"),
    )),
  );
  assert(
    await page.evaluate(() =>
      window.overlays("swing").includes("unscoped-old"),
    ),
  );
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  const box = await page.locator("#swing .kline").boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.waitForFunction(() =>
    window.calls.some((c) => c.method === "POST"),
  );
  const created = await page.evaluate(
    () => window.calls.find((c) => c.method === "POST").body.instrument,
  );
  assert.equal(created.exchange, "NSE");
  assert.equal(created.drawing_scope, undefined);
  await page.waitForFunction(() =>
    window.overlays("day").includes("new-shared"),
  );
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.calls.some((c) => c.method === "DELETE"),
  );
  await page.waitForFunction(
    () => !window.overlays("day").includes("new-shared"),
  );
  await page.getByRole("button", { name: "Close Swing", exact: true }).click();
  await page.getByRole("button", { name: "Reopen Swing", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.overlays("swing").includes("shared-day") &&
      window.overlays("swing").includes("private-old"),
  );
  assert(
    !(await page.evaluate(() =>
      window.overlays("swing").includes("new-shared"),
    )),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Day/Swing option drawings: shared create/delete, reopen, legacy private and unscoped preservation passed",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
