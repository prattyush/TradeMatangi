/** Synthetic shared-book windows using both actual renderers; no broker orders. */
import { resolve } from "node:path";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = resolve(new URL("..", import.meta.url).pathname);
const { build } = await import(
  resolve(root, "frontend/node_modules/esbuild/lib/main.js")
);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const dir = await mkdtemp(tmpdir() + "/swing-linked-analytics-");
await build({
  stdin: {
    contents: `import{browserSwingSubscribe}from'${root}/shared/swingStream';import React,{useCallback} from 'react';import{createRoot}from'react-dom/client';import Panel from '${root}/shared/SwingPortfolioPanel';import Dashboard from '${root}/shared/analysis/PerformanceDashboard';import TradeAnalysis from '${root}/shared/analysis/TradeAnalysis';import{AnalysisProvider}from'${root}/shared/analysis/environment';import Web from '${root}/frontend/src/components/SwingChart';import Native from '${root}/windowsapp/src/SwingChart';import '${root}/windowsapp/src/styles.css';
const query=new URLSearchParams(location.search),surface=query.get('surface')??'website',child=query.get('child');window.calls=[];
const subscribe=browserSwingSubscribe(location.origin+'/stream',()=>({'X-User-Id':'u'}));const request=async(path,method,body)=>{window.calls.push({path,method,body});const response=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,method,body})});if(!response.ok)throw new Error('Fixture rejected');return response.json()};
const drawing=async(path,method,body)=>{window.calls.push({path:"drawing:"+path,drawingPath:path,method,body});return path==='chart-settings'?{settings:{}}:{drawings:[]}};const renderer=props=><Native {...props} drawingRequest={drawing}/>;
const symbols=async()=>[{symbol:'HDFCBANK',display_name:'HDFC Bank',chart_type:'equity',option_eligible:true},{symbol:'RELIND',display_name:'Reliance',chart_type:'equity',option_eligible:true}];
const summary={session_id:'child',user_id:'u',symbol:'RELIND',date:'2026-10-06',instrument_type:'equity',session_type:'paper',trading_style:'swing',portfolio_id:'portfolio',trade_count:1,round_trip_count:0,net_pnl:0,total_commission:1,session_capital:10000};const environment={swingRequest:request,charts:{SwingChart:surface==='desktop'?renderer:Web},api:{getAnalysisSessions:async()=>[summary],getSessionDetail:async()=>({...summary,trades:[],cycles:[]}),patternGetChartByDate:async()=>{throw new Error('no pattern')},saveLabels:labels=>request('portfolio/labels','POST',labels[0])},performance:{getSwingReport:async filters=>({portfolios:[{portfolio_id:'portfolio',mode:'paper',state:'running'}],report:await request('portfolio/analytics?'+new URLSearchParams(filters),'GET')}),getPerformance:filters=>{window.dayFilters=filters;return Promise.reject(new Error('Day fixture'))},getPerformanceCycles:async()=>({items:[],total:0,next_offset:null}),getPerformanceDetail:async()=>({})},onDirtyChange:value=>{window.dirty=value},onLabelSavingChange:value=>{window.saving=value}};
function App(){const create=useCallback(()=>{window.open(location.pathname+'?surface='+surface+'&child=child-one','swing-child')},[]);if(query.get('sessions'))return <AnalysisProvider value={environment}><TradeAnalysis initialPortfolioId='portfolio' onClose={()=>{window.detached=true}}/></AnalysisProvider>;if(query.get('global'))return <AnalysisProvider value={environment}><Dashboard defaultTradingStyle='swing' defaultPortfolioId='portfolio' onClose={()=>{window.detached=true}}/></AnalysisProvider>;return <Panel request={request} subscribe={subscribe} loadSymbols={symbols} renderChart={surface==='desktop'?renderer:Web} surface={surface} portfolioId={child?'portfolio':undefined} workspaceId={child??undefined} companion={Boolean(child)} onPopOut={surface==='desktop'&&!child?()=>{create();window.mainView='day'}:undefined} onCreateLinked={surface==='desktop'&&!child?create:undefined} onDetach={()=>{window.detached=true}}/>}createRoot(document.getElementById('root')).render(<App/>);`,
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
const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date()),
  now = Date.parse(today + "T10:00:00Z") / 1000;
let book, cycle, prefs, calls;
let saveDelay = 0;
function reset() {
  book = {
    portfolio: {
      session_id: "portfolio",
      mode: "paper",
      state: "running",
      entries_paused: false,
      session_capital: 10000,
      guardrail_epoch: 0,
    },
    wallet_balance: 9000,
    pnl: 100,
    positions: [
      {
        session_id: "child",
        symbol: "RELIND",
        quantity: 10,
        avg_entry_price: 100,
        mark_price: 110,
        invested_value: 1000,
        unrealized_pnl: 99,
        unrealized_pnl_pct: 9.9,
        quote_status: "stale",
        side: "LONG",
      },
    ],
    open_orders: [],
    trades: [],
    reconciliation_pending: [],
  };
  cycle = {
    session_id: "child",
    cycle_id: "123456789abcdef012345678",
    index: 0,
    symbol: "RELIND",
    right: null,
    strike: null,
    expiry: null,
    entry_date: "2026-10-06",
    entry_time: now - 6 * 86400,
    exit_date: null,
    state: "open",
    net_pnl: 0,
    holding_days: 6,
    executions: [
      {
        trade_id: "entry",
        side: "BUY",
        symbol: "RELIND",
        quantity: 10,
        price: 100,
        commission: 1,
        timestamp: now - 6 * 86400,
        role: "entry",
      },
    ],
    label: null,
  };
  prefs = {};
  calls = [];
}
const streams = new Map();
const publish = () => { for (const [response, path] of streams) if (!path.includes('/charts/watch/')) response.write('data: '+JSON.stringify({type:'portfolio_snapshot',...book})+'\n\n'); };
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/stream/')) {
      assert.equal(req.headers['x-user-id'], 'u');
      res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      streams.set(res, req.url);
      const initial = req.url.includes('/charts/watch/') ? {type:'chart_quotes',quotes:[],market_open:false,provider:'kite'} : {type:'portfolio_snapshot',...book};
      res.write('data: '+JSON.stringify(initial)+'\n\n');
      req.on('close',()=>streams.delete(res));
      return;
    }
    if (req.url === "/fixture") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { path, method, body } = JSON.parse(raw);
      calls.push({ path, method, body });
      let value = book;
      if (path === "capabilities") value = { real_trading_enabled: true };
      else if (path === "label-metadata")
        value = {
          categories: ["Momentum"],
          strategies: ["Breakout"],
          entry_tags: ["AS_PER_PATTERN"],
          exit_tags: ["AS_PER_PATTERN"],
        };
      else if (path.includes("/charts/workspace")) {
        const key =
          body?.workspace_id ??
          new URLSearchParams(path.split("?")[1]).get("workspace_id") ??
          "primary";
        if (method === "PUT") prefs[key] = body;
        value = { workspace: prefs[key] ?? null };
      } else if (path.endsWith("/charts/history")) {
        const end = Date.parse(body.as_of_date + "T00:00:00Z") / 1000;
        value = {
          candles: Array.from({ length: 100 }, (_, i) => ({
            time: end - (99 - i) * 86400,
            timestamp: end - (99 - i) * 86400,
            open: 100 + i / 10,
            high: 112 + i / 10,
            low: 98 + i / 10,
            close: 108 + i / 10,
            volume: 100,
          })),
          provider: "kite",
          more: false,
        };
      } else if (path.endsWith("/charts/watch")) value = { watch_id: "viewer" };
      else if (path.includes("/charts/watch/"))
        value = { quotes: [], market_open: false, provider: "kite" };
      else if (path.endsWith("/orders")) {
        book = {
          ...book,
          open_orders: [
            ...book.open_orders,
            { ...body, order_id: "new-order", limit_price: body.price },
          ],
        };
        value = book;
        publish();
      } else if (path.endsWith("/execution-history"))
        value = {
          cycles: [cycle],
          contexts: [
            {
              session_id: "child",
              trades: cycle.executions,
              orders: book.open_orders,
            },
          ],
        };
      else if (path.endsWith("/labels")) {
        if (saveDelay)
          await new Promise((resolve) => setTimeout(resolve, saveDelay));
        assert.equal(body.analytics_cycle_id, cycle.cycle_id);
        cycle = { ...cycle, label: body };
        value = [body];
      } else if (path.includes("/analytics"))
        value = {
          portfolio: {
            portfolio_id: "portfolio",
            mode: "paper",
            state: "running",
          },
          start_date: "2026-10-06",
          end_date: today,
          period_realized_pnl: 0,
          cycles: [cycle],
          closed_trades: {
            count: 0,
            wins: 0,
            losses: 0,
            breakeven: 0,
            net_pnl: 0,
            streaks: { winning: 0, losing: 0 },
            groups: { symbol: [] },
            r_count: 0,
          },
          portfolio_performance: {
            return_method: "Daily Modified Dietz, geometrically linked",
            coverage_complete: true,
            return_pct: 1,
            max_drawdown_pct: 0,
            max_drawdown_rupees: 0,
            drawdown_duration_trading_days: 0,
            annual: {},
            monthly_returns: [
              { month: today.slice(0, 7), return_pct: 1, partial: true },
            ],
            series: [
              { date: "2026-10-06", nav: 10000, drawdown_pct: 0 },
              { date: today, nav: 10100, drawdown_pct: 0 },
            ],
          },
          exposure: {
            as_of: now,
            cash: book.wallet_balance,
            positions: book.positions,
            invested_cost: 1000,
            largest_position_pct: 100,
            allocation: [{ kind: "equity", cost: 1000 }],
          },
        };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
      return;
    }
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
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const surface of ["website", "desktop"]) {
    reset();
    const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    context.on("page", (p) =>
      p.on("pageerror", (error) => errors.push(String(error))),
    );
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(
      `http://127.0.0.1:${server.address().port}?surface=${surface}`,
    );
    await page.locator(".swing-workspace").waitFor();
    await page
      .getByRole("button", { name: "Execution history", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Swing execution history" })
      .waitFor();
    await page.getByLabel("actual strategy", { exact: true }).fill("Breakout");
    await page
      .getByRole("button", { name: "Save trade label", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.calls.some((c) => c.path.endsWith("/labels")),
    );
    assert.equal(cycle.label.actual_strategy, "Breakout");
    await page
      .getByRole("button", { name: "Close history", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Swing Stats", exact: true })
      .click();
    await page.getByRole("region", { name: "Swing statistics" }).waitFor();
    await page.getByText("Daily portfolio value", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Trades", exact: true })
      .last()
      .click();
    await page.getByText("Completed cycles", { exact: true }).waitFor();
    await page
      .getByRole("region", { name: "Swing statistics" })
      .getByRole("button", { name: "RELIND", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save trade label", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Swing history chart date"]')
          ?.value,
    );
    assert.equal(
      await page.getByLabel("actual strategy", { exact: true }).inputValue(),
      "Breakout",
    );
    assert.equal(
      await page.getByLabel("Swing history chart date").inputValue(),
      today,
    );
    await page.getByLabel("actual strategy", { exact: true }).fill("Unsaved");
    await page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await page.waitForTimeout(200);
    assert.equal(
      await page.getByLabel("actual strategy", { exact: true }).inputValue(),
      "Unsaved",
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "Close history", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("region", { name: "Swing execution history" })
        .count(),
      1,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Close history", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Swing Stats", exact: true })
      .click();
    await page.getByText("Daily portfolio value", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Exposure", exact: true }).click();
    await page.getByText("Invested cost", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Close statistics", exact: true })
      .click();
    if (surface === "desktop") {
      const popup = context.waitForEvent("page");
      await page
        .getByRole("button", { name: "Pop out Swing", exact: true })
        .click();
      assert.equal(await page.evaluate(() => window.mainView), "day");
      const child = await popup;
      await child.locator(".swing-workspace").waitFor();
      await child.getByLabel("Swing chart layout").selectOption("2");
      await child.getByLabel("Chart 2 date").fill("2026-09-21");
      await child.waitForTimeout(900);
      assert.equal(prefs["child-one"].panes.length, 2);
      assert(!prefs.primary || prefs.primary.panes.length === 1);
      assert.equal(
        await child
          .getByRole("button", { name: "Pause entries", exact: true })
          .count(),
        0,
      );
      await child
        .getByRole("button", { name: "Manage portfolio", exact: true })
        .click();
      assert.equal(
        await child
          .getByRole("button", { name: "Reset capital", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await child
          .getByRole("button", { name: "Close portfolio…", exact: true })
          .count(),
        0,
      );
      await child
        .getByRole("button", { name: "Close management", exact: true })
        .click();
      await child.getByLabel("Limit ₹").fill("100");
      await child
        .getByRole("button", { name: "Place intention", exact: true })
        .click();
      await page.getByRole("button", { name: "Orders", exact: true }).click();
      await page
        .locator(".swing-portfolio-rail")
        .getByText("RELIND", { exact: true })
        .waitFor();
      assert.equal(calls.filter((c) => c.path.endsWith("/orders")).length, 1);
      book = {
        ...book,
        open_orders: [],
        positions: [{ ...book.positions[0], quantity: 11 }],
      };
      publish();
      await page
        .getByRole("button", { name: "Positions", exact: true })
        .click();
      await page
        .locator(".swing-portfolio-rail")
        .getByText("11 at ₹100", { exact: false })
        .waitFor();
      await child
        .locator(".swing-portfolio-rail")
        .getByText("11 at ₹100", { exact: false })
        .waitFor();
      const mainDrawing = (await page.evaluate(() => window.calls))
        .filter((c) => c.drawingPath?.startsWith("drawings?"))
        .map((c) =>
          JSON.parse(
            new URLSearchParams(c.drawingPath.split("?")[1]).get("instrument"),
          ),
        );
      const childDrawing = (await child.evaluate(() => window.calls))
        .filter((c) => c.drawingPath?.startsWith("drawings?"))
        .map((c) =>
          JSON.parse(
            new URLSearchParams(c.drawingPath.split("?")[1]).get("instrument"),
          ),
        );
      assert(
        mainDrawing.some((i) => i.drawing_scope === "swing:portfolio:primary"),
      );
      assert(
        childDrawing.some(
          (i) => i.drawing_scope === "swing:portfolio:child-one",
        ),
      );
      assert(
        !childDrawing.some(
          (i) => i.drawing_scope === "swing:portfolio:primary",
        ),
      );
      assert(mainDrawing.some(i => !i.drawing_scope && i.symbol === 'RELIND'));
      assert(childDrawing.some(i => !i.drawing_scope && i.symbol === 'RELIND'));
      assert.equal(await child.getByLabel("Swing mode").count(), 0);
      assert.equal(await child.getByLabel("Swing broker").count(), 0);
      assert.equal(
        await child
          .getByRole("button", { name: "Pop out Swing", exact: true })
          .count(),
        0,
      );
      const childCalls = await child.evaluate(() => window.calls);
      assert(!childCalls.some((c) => c.path.startsWith("active?")));
      await child.close();
      assert.equal(calls.filter((c) => c.path.endsWith("/close")).length, 0);
    }
    await mkdir(root + "/.cache/swing-linked-analytics", { recursive: true });
    await page
      .getByRole("button", { name: "Swing Stats", exact: true })
      .click();
    await page.getByText("Daily portfolio value", { exact: true }).waitFor();
    await page.screenshot({
      path: root + "/.cache/swing-linked-analytics/" + surface + ".png",
    });
    assert.deepEqual(errors, []);
    results.push({
      surface,
      openLabel: true,
      statsViews: true,
      sharedBook: surface === "desktop",
      errors,
    });
    await context.close();
  }
  reset();
  const globalPage = await browser.newPage();
  await globalPage.goto(`http://127.0.0.1:${server.address().port}?global=1`);
  await globalPage
    .getByText("Daily portfolio value", { exact: true })
    .waitFor();
  await globalPage.getByRole("button", { name: "Trades", exact: true }).click();
  await globalPage.getByRole("button", { name: "RELIND", exact: true }).click();
  await globalPage.getByLabel("actual strategy", { exact: true }).fill("Draft");
  globalPage.once("dialog", (dialog) => dialog.dismiss());
  await globalPage.getByLabel("Stats trading style").selectOption("intraday");
  assert.equal(
    await globalPage.getByLabel("Stats trading style").inputValue(),
    "swing",
  );
  globalPage.once("dialog", (dialog) => dialog.dismiss());
  await globalPage.getByLabel("Swing stats through").fill("2026-10-09");
  assert.equal(
    await globalPage.getByLabel("Swing stats through").inputValue(),
    today,
  );
  globalPage.once("dialog", (dialog) => dialog.accept());
  await globalPage.getByLabel("Stats trading style").selectOption("intraday");
  await globalPage.waitForFunction(() => window.dayFilters);
  assert.equal(
    (await globalPage.evaluate(() => window.dayFilters)).portfolio_id,
    "",
  );
  await globalPage.getByLabel("Stats trading style").selectOption("swing");
  await globalPage
    .getByText("Daily portfolio value", { exact: true })
    .waitFor();
  assert.equal(
    await globalPage.getByLabel("Swing stats portfolio").inputValue(),
    "portfolio",
  );
  await globalPage.getByRole("button", { name: "Trades", exact: true }).click();
  await globalPage.getByRole("button", { name: "RELIND", exact: true }).click();
  await globalPage.getByLabel("actual strategy", { exact: true }).fill("Saved");
  saveDelay = 600;
  await globalPage
    .getByRole("button", { name: "Save trade label", exact: true })
    .click();
  await globalPage.waitForFunction(() => window.saving === true);
  await globalPage.getByLabel("Stats trading style").selectOption("intraday");
  assert.equal(
    await globalPage.getByLabel("Stats trading style").inputValue(),
    "swing",
  );
  await globalPage.waitForFunction(() => window.saving === false);
  assert.equal(cycle.label.actual_strategy, "Saved");
  await globalPage.close();
  saveDelay = 0;
  reset();
  const sessionsPage = await browser.newPage();
  await sessionsPage.goto(
    `http://127.0.0.1:${server.address().port}?sessions=1`,
  );
  await sessionsPage.getByText("Paper · Swing", { exact: true }).click();
  await sessionsPage
    .getByLabel("actual strategy", { exact: true })
    .fill("Session draft");
  sessionsPage.once("dialog", (dialog) => dialog.dismiss());
  await sessionsPage
    .getByRole("button", { name: "Search", exact: true })
    .click();
  assert.equal(
    await sessionsPage
      .getByLabel("actual strategy", { exact: true })
      .inputValue(),
    "Session draft",
  );
  sessionsPage.once("dialog", (dialog) => dialog.dismiss());
  await sessionsPage.getByText("Paper · Swing", { exact: true }).click();
  assert.equal(
    await sessionsPage
      .getByRole("region", { name: "Swing execution history" })
      .count(),
    1,
  );
  sessionsPage.once("dialog", (dialog) => dialog.dismiss());
  await sessionsPage.getByRole("button", { name: "✕", exact: true }).click();
  assert.equal(
    await sessionsPage.evaluate(() => Boolean(window.detached)),
    false,
  );
  sessionsPage.once("dialog", (dialog) => dialog.accept());
  await sessionsPage
    .getByRole("button", { name: "Search", exact: true })
    .click();
  await sessionsPage.getByText("Paper · Swing", { exact: true }).click();
  await sessionsPage.getByLabel("actual strategy", { exact: true }).waitFor();
  assert.equal(
    await sessionsPage
      .getByLabel("actual strategy", { exact: true })
      .inputValue(),
    "",
  );
  await sessionsPage.close();
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  server.close();
}
