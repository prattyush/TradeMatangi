/** Both Swing renderers against synthetic owned books; never live broker orders. */
import { resolve } from "node:path";
const root = resolve(new URL("..", import.meta.url).pathname);
const { build } = await import(
  resolve(root, "frontend/node_modules/esbuild/lib/main.js")
);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const dir = await mkdtemp(tmpdir() + "/swing-workspace-");
await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import Panel from '${root}/shared/SwingPortfolioPanel';import Web from '${root}/frontend/src/components/SwingChart';import Native from '${root}/windowsapp/src/SwingChart';import '${root}/windowsapp/src/styles.css';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());const day=Date.parse(today+'T00:00:00Z')/1000;window.calls=[];
const position={session_id:'child',symbol:'RELIND',side:'LONG',quantity:10,avg_entry_price:100,mark_price:110,unrealized_pnl:99,unrealized_pnl_pct:9.9,quote_status:'live'};
let book={portfolio:{session_id:'portfolio',mode:'paper',state:'running',entries_paused:false,session_capital:100000,guardrail_epoch:0},wallet_balance:99000,pnl:99,positions:[position],open_orders:[],trades:[],reconciliation_pending:[]};
const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='capabilities')return{real_trading_enabled:true};if(path.includes('/charts/workspace'))return method==='GET'?{workspace:null}:{saved:true};if(path.endsWith('/charts/watch'))return{watch_id:'viewer'};if(path.includes('/charts/watch/'))return{quotes:[],market_open:false,provider:'kite'};if(path.endsWith('/charts/history')){const end=Date.parse(body.as_of_date+'T00:00:00Z')/1000;return{candles:Array.from({length:260},(_,i)=>({time:end-(259-i)*86400,timestamp:end-(259-i)*86400,open:100,high:120,low:90,close:110,volume:100})),provider:'kite',more:false,partial:false}};if(path.includes('contracts/metadata'))return{contracts:[]};if(path.endsWith('/pause')){book={...book,portfolio:{...book.portfolio,entries_paused:body.paused}};return book};if(path.endsWith('/orders'))return book;return book};
const drawing=async(path)=>path==='chart-settings'?{settings:{}}:{drawings:[]};const render=(props)=><Native {...props} drawingRequest={drawing}/>;
const desktop=location.search.includes('desktop');createRoot(document.getElementById('root')).render(<Panel request={request} surface={desktop?'desktop':'website'} renderChart={desktop?render:Web} loadSymbols={async()=>[{symbol:'HDFCBANK',display_name:'HDFC Bank',chart_type:'equity',option_eligible:true},{symbol:'RELIND',display_name:'Reliance',chart_type:'equity',option_eligible:true}]} onDetach={()=>{window.detached=true}}/>);`,
    resolveDir: root + "/windowsapp",
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  outfile: dir + "/app.js",
  alias: {
    react: root + "/frontend/node_modules/react",
    "react-dom": root + "/frontend/node_modules/react-dom",
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
const results = [];
try {
  for (const surface of ["website", "desktop"]) {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(
      "http://127.0.0.1:" + server.address().port + "/?" + surface,
    );
    await page.locator(".swing-workspace").waitFor();
    console.log("Checking", surface);
    await page.locator("canvas:visible").first().waitFor();
    await page.getByLabel("Swing chart layout").selectOption("4");
    await page.waitForFunction(
      () => document.querySelectorAll(".swing-chart-pane").length === 4,
    );
    await page.getByLabel("Chart 2 date").fill("2026-09-21");
    await page.waitForFunction(() =>
      window.calls.some(
        (c) =>
          c.path.endsWith("/charts/history") &&
          c.body.as_of_date === "2026-09-21",
      ),
    );
    await page
      .locator(".swing-chart-pane")
      .nth(1)
      .click({ position: { x: 30, y: 15 } });
    await page.locator(".swing-position-row").first().click();
    assert.equal(
      await page.getByLabel("Chart 2 date").inputValue(),
      "2026-09-21",
    );
    await page
      .getByRole("button", { name: "Pick price on chart", exact: true })
      .click();
    await page.waitForTimeout(500);
    const pane = page.locator(".swing-chart-pane").nth(1);
    const canvas =
      surface === "desktop"
        ? pane.locator(".kline")
        : pane.locator("canvas").first();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.4);
    await page.waitForFunction(() => {
      const input = document.querySelector(
        '.swing-trade-ticket input[type="number"][step="0.01"]',
      );
      return input && Number(input.value) > 0;
    });
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((c) => c.path.endsWith("/orders")).length,
      ),
      0,
    );
    await page
      .getByRole("button", { name: "Place intention", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.calls.some((c) => c.path.endsWith("/orders")),
    );
    assert.equal(
      await page.evaluate(
        () => window.calls.find((c) => c.path.endsWith("/orders")).body.symbol,
      ),
      "RELIND",
    );
    await page
      .getByRole("button", { name: "Pause entries", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Resume entries", exact: true })
      .waitFor();
    await page
      .locator(".swing-chart-pane")
      .nth(1)
      .getByTitle("Maximize chart")
      .click();
    assert.equal(await page.locator(".swing-maximized").count(), 1);
    await page
      .locator(".swing-chart-pane")
      .nth(1)
      .getByTitle("Restore chart")
      .click();
    assert.deepEqual(errors, []);
    await mkdir(root + "/.cache/swing-improvements", { recursive: true });
    await page.screenshot({
      path: root + "/.cache/swing-improvements/" + surface + ".png",
    });
    results.push({
      surface,
      panes: 4,
      independentDates: true,
      confirmedPick: true,
      errors,
    });
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
