/** Actual desktop chart loader/viewport checks with synthetic candles only. */
import { build } from "../frontend/node_modules/esbuild/lib/main.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "phase20-chart-"));
const artifacts = resolve(
  process.env.PHASE20_ARTIFACT_DIR || root + "/.cache/phase20-validation",
);
await mkdir(artifacts, { recursive: true });
const source = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{init}from'klinecharts';import{ChartTile}from'${root}/windowsapp/src/ChartTile.tsx';import'${root}/windowsapp/src/styles.css';
const start=Date.parse('2026-10-06T09:15:00Z')/1000;
const make=(time,i)=>({timestamp:time,open:100+i/10,high:102+i/10,low:99+i/10,close:101+i/10});
const initial=Array.from({length:375},(_,i)=>make(start+i*60,i));
window.historyCalls=0;
function Demo(){const[candles,setCandles]=useState(initial);const[reset,setReset]=useState(0);window.refresh=()=>setReset(x=>x+1);window.append=()=>setCandles(c=>[...c,make(c[c.length-1].timestamp+60,c.length)]);
return <div style={{height:620,width:1000,display:'grid'}}><ChartTile symbol='NIFTY' interval='1m' supportedIntervals={[1,3,15]} onIntervalChange={()=>{}} candles={candles} viewportResetKey={String(reset)} loadOlder={async before=>{window.historyCalls++;const older=Array.from({length:100},(_,i)=>make(start-86400+i*60,i));setCandles(c=>[...older,...c]);return{candles:older,more:false}}} loading={false} message='' settings={{background:'#151a23',textColor:'#aeb8ca',gridColor:'#ffffff',gridOpacity:.1,gridStyle:'solid',gridSize:1,movingAverageType:'MA',movingAveragePeriods:'5,10,20',showChartInfo:true,horizontalLineColor:'#facc15',horizontalLineWidth:2,trendLineColor:'#60a5fa',trendLineWidth:2,drawingLineColor:'#60a5fa',drawingLineWidth:2,drawingFillColor:'#60a5fa',drawingFillOpacity:.15}} isReplaying={false} isLive={true} instrument={{kind:'index',exchange:'NSE',symbol:'NIFTY'}} baseUrl='' drawingRequest={async()=>({drawings:[]})} onConfigure={()=>{}} onMaximize={()=>{}} maximized={false} active={true} indicators={['MA']} drawingCommand={null} drawingAction={null} drawingMode='once' onDrawingComplete={()=>{}} onActivate={()=>{}}/></div>}
createRoot(document.getElementById('root')).render(<Demo/>);window.getChart=()=>{const dom=document.querySelector('.kline');dom.id=dom.getAttribute('k-line-chart-id');return init(dom)};
`;
await build({
  stdin: { contents: source, resolveDir: root + "/windowsapp", loader: "tsx" },
  bundle: true,
  outfile: directory + "/app.js",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
await writeFile(
  directory + "/index.html",
  '<html><head><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#0a1020"><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
const server = createServer(async (req, res) => {
  try {
    const file = await readFile(
      directory + (req.url === "/" ? "/index.html" : req.url),
    );
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js")
        ? "text/javascript"
        : req.url.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--js-flags=--expose-gc"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() =>
    document.querySelector(".kline")?.getAttribute("k-line-chart-id"),
  );
  await page.waitForTimeout(300);
  const initial = await page.evaluate(() => {
    window.chart = window.getChart();
    return {
      range: window.chart.getVisibleRange(),
      count: window.chart.getDataList().length,
    };
  });
  if (initial.count !== 375 || initial.range.to - initial.range.from > 151)
    throw Error(
      "Initial viewport does not preserve all data within 150 visible bars: " +
        JSON.stringify(initial),
    );
  await page.evaluate(() => {
    window.chart.createOverlay({
      name: "horizontalStraightLine",
      points: [
        { timestamp: window.chart.getDataList()[10].timestamp, value: 100 },
      ],
      lock: true,
    });
    window.chart.scrollToDataIndex(0, 0);
  });
  await page.waitForFunction(
    () =>
      window.historyCalls === 1 && window.chart.getDataList().length === 475,
  );
  const before = await page.evaluate(() => ({
    range: window.chart.getVisibleRange(),
    overlays: window.chart.getOverlays().length,
  }));
  await page.evaluate(() => window.append());
  await page.waitForFunction(() => window.chart.getDataList().length === 476);
  const after = await page.evaluate(() => ({
    range: window.chart.getVisibleRange(),
    overlays: window.chart.getOverlays().length,
  }));
  if (before.overlays !== after.overlays || before.range.to !== after.range.to)
    throw Error(
      "Live append changed historical viewport/drawings: " +
        JSON.stringify({ before, after }),
    );
  await page.evaluate(() => window.refresh());
  await page.waitForTimeout(100);
  const refreshed = await page.evaluate(() => window.chart.getVisibleRange());
  if (refreshed.to - refreshed.from > 151 || refreshed.to < 470)
    throw Error(
      "Refresh did not restore latest 150 candles: " +
        JSON.stringify(refreshed),
    );
  await page.screenshot({ path: join(artifacts, "desktop-browsing.png") });
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    JSON.stringify(
      {
        initial,
        historyRequests: 1,
        prepended: 100,
        beforeAppend: before,
        afterAppend: after,
        refreshed,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.close();
}
