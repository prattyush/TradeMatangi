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
const request=async(path,method,body)=>{window.calls.push({path,method,body});if(path==='capabilities')return{real_trading_enabled:true};if(path.includes('/charts/workspace'))return method==='GET'?{workspace:null}:{saved:true};if(path.endsWith('/charts/watch'))return{watch_id:'viewer'};if(path.includes('/charts/watch/'))return{quotes:[],market_open:false,provider:'kite'};if(path.endsWith('/charts/history')){const end=Date.parse(body.as_of_date+'T00:00:00Z')/1000;return{candles:Array.from({length:260},(_,i)=>({time:end-(259-i)*86400,timestamp:end-(259-i)*86400,open:100,high:120,low:90,close:110,volume:100})),provider:'kite',more:false,partial:false}};if(path.includes('contracts/futures'))return{contracts:[{symbol:body?.symbol??'RELIND',instrument_type:'futures',expiry:'2026-10-27',lot_size:5,tick_size:.05,entry_eligible:true}]};if(path.includes('contracts/metadata'))return{contracts:[]};if(path.endsWith('/pause')){book={...book,portfolio:{...book.portfolio,entries_paused:body.paused}};return book};if(path.endsWith('/order-preview')){if(body.instrument_type==='futures'){const budget=body.capital_pct?book.portfolio.session_capital*body.capital_pct:201;const q=body.capital_pct?Math.floor((budget-1)/100)*5:body.quantity;return{quantity:q,lot_size:5,budget,fees:1,margin:q*20,required_funds:q*20+1,minimum_funds:101,capital_revision:0,fee_hash:'captured',execution_enabled:true,evidence:{live:false,source:'dated fixture'}}};if(window.failSizing)throw new Error('Sizing unavailable');const budget=book.portfolio.session_capital*body.capital_pct;const q=Math.max(0,Math.floor((budget-1)/(body.price*1.00006803)));return{quantity:q,lot_size:1,budget,fees:1,required_funds:q*body.price+1,unused_budget:budget-q*body.price-1,minimum_funds:body.price+1,capital_revision:book.portfolio.guardrail_epoch}};if(path.endsWith('/orders'))return book;return book};
const drawing=async(path)=>path==='chart-settings'?{settings:{}}:{drawings:[]};const render=(props)=><Native {...props} drawingRequest={drawing}/>;
const desktop=location.search.includes('desktop');createRoot(document.getElementById('root')).render(<Panel request={request} surface={desktop?'desktop':'website'} renderChart={desktop?render:Web} loadSymbols={async()=>[{symbol:'HDFCBANK',display_name:'HDFC Bank',chart_type:'equity',option_eligible:true},{symbol:'RELIND',display_name:'Reliance',chart_type:'equity',option_eligible:true}]} onDetach={()=>{window.detached=true}} onPopOut={id=>{window.poppedOut=id}} onCreateLinked={id=>{window.linked=id}}/>);`,
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
    for (const label of ["Pause entries", "Pop out Swing", "Create linked window", "Execution history", "Swing Stats", "Manage portfolio", "Detach"]) {
      const button = page.getByRole("button", { name: label, exact: true });
      assert.equal(await button.locator("svg").count(), 1, label);
      assert.equal((await button.textContent()).trim(), "", label);
      assert.equal(await button.getAttribute("title"), label);
    }
    await page.getByRole("button", { name: "Pop out Swing", exact: true }).click();
    await page.getByRole("button", { name: "Create linked window", exact: true }).click();
    assert.equal(await page.evaluate(() => window.poppedOut), "portfolio");
    assert.equal(await page.evaluate(() => window.linked), "portfolio");
    for (const [panel, hide, show] of [[".swing-portfolio-rail", "Hide portfolio panel", "Show portfolio panel"], [".swing-trade-ticket", "Hide trade ticket", "Show trade ticket"]]) {
      const button = page.getByRole("button", { name: hide, exact: true });
      const before = await button.boundingBox();
      const bounds = await page.locator(panel).boundingBox();
      assert.ok(before.x >= bounds.x && before.x + before.width <= bounds.x + bounds.width + 1);
      await button.hover();
      assert.deepEqual(await button.boundingBox(), before, "Hover must not move the target");
      await button.focus();
      await button.press("Enter");
      assert.equal(await page.locator(panel).isVisible(), false);
      const reopen = page.getByRole("button", { name: show, exact: true });
      assert.equal(await reopen.getAttribute("aria-expanded"), "false");
      await reopen.click();
      assert.equal(await page.locator(panel).isVisible(), true);
    }
    if (surface === "desktop") {
      assert.equal(
        await page.locator(".swing-chart-pane .swing-data-label").count(),
        0,
      );
      assert.equal(
        await page
          .locator(".swing-chart-pane select[aria-label='Add chart indicator']")
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator(".swing-tools-bar select[aria-label='Add chart indicator']")
          .count(),
        1,
      );
      await page.getByRole("button", { name: "Hide chart tools", exact: true }).click();
      assert.equal(
        await page.getByLabel("Add chart indicator").isVisible(),
        false,
      );
      await page.getByRole("button", { name: "Show chart tools", exact: true }).click();
      const historyCalls = await page.evaluate(
        () =>
          window.calls.filter((c) => c.path.endsWith("/charts/history")).length,
      );
      const watchCalls = await page.evaluate(
        () =>
          window.calls.filter(
            (c) => c.path.endsWith("/charts/watch") && c.method === "POST",
          ).length,
      );
      await page.getByLabel("Active chart markers").selectOption("all");
      await page.waitForTimeout(900);
      assert.equal(
        await page.evaluate(
          () =>
            window.calls.filter((c) => c.path.endsWith("/charts/history"))
              .length,
        ),
        historyCalls,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.calls.filter(
              (c) => c.path.endsWith("/charts/watch") && c.method === "POST",
            ).length,
        ),
        watchCalls,
      );
      const settings = await page.evaluate(
        () =>
          window.calls
            .filter(
              (c) => c.path.endsWith("/charts/workspace") && c.method === "PUT",
            )
            .at(-1).body,
      );
      assert.equal(settings.panes[0].marker_mode, "all");
      assert.equal(settings.rail_open, true);
      assert.equal(settings.ticket_open, true);
      assert.equal(settings.tools_collapsed, false);
      assert.equal(
        await page
          .getByRole("button", { name: "Place intention", exact: true })
          .innerText(),
        "",
      );
    }
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
    // Both clients use a confirmed server estimate; no preview submits an order.
    await page.getByLabel("Swing sizing mode").selectOption("capital_pct");
    await page.getByLabel("Portfolio capital percentage").fill("10");
    await page
      .locator('.swing-trade-ticket input[type="number"][required][min="0.01"]')
      .last()
      .fill("100");
    await page.waitForFunction(() =>
      document
        .querySelector('.swing-trade-ticket [aria-live="polite"]')
        ?.textContent.includes("99 units"),
    );
    const placedBeforePreview = await page.evaluate(
      () => window.calls.filter((c) => c.path.endsWith("/orders")).length,
    );
    assert.equal(placedBeforePreview, 1);
    await page
      .getByRole("button", { name: "Place intention", exact: true })
      .click();
    await page.waitForFunction(
      () => window.calls.filter((c) => c.path.endsWith("/orders")).length === 2,
    );
    const percentageOrder = await page.evaluate(
      () => window.calls.filter((c) => c.path.endsWith("/orders")).at(-1).body,
    );
    assert.equal(percentageOrder.quantity, 99);
    assert.equal(percentageOrder.capital_pct, 0.1);
    assert.equal(percentageOrder.capital_revision, 0);
    await page.evaluate(() => {
      window.failSizing = true;
    });
    await page.getByLabel("Portfolio capital percentage").fill("11");
    assert.equal(
      await page
        .getByRole("button", { name: "Place intention", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByText("Error: Sizing unavailable", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Place intention", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByLabel("Side", { exact: true }).selectOption("SELL");
    assert.equal(
      await page.getByLabel("Quantity", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.getByLabel("Portfolio capital percentage").count(),
      0,
    );
    await page.getByLabel("Side", { exact: true }).selectOption("BUY");
    await page.getByLabel("Swing sizing mode").selectOption("quantity");
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
    await page
      .getByRole("button", { name: "Resume entries", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Pause entries", exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.failSizing = false;
    });
    await page
      .getByLabel("Chart instrument", { exact: true })
      .selectOption("futures");
    await page.getByLabel("Chart Futures contract").selectOption("0");
    await page.getByLabel("Side", { exact: true }).selectOption("SELL");
    await page.getByLabel("Quantity", { exact: true }).fill("5");
    await page
      .locator('.swing-trade-ticket input[type="number"][required][min="0.01"]')
      .last()
      .fill("100");
    await page.waitForFunction(() =>
      window.calls.some(
        (c) =>
          c.path.endsWith("/order-preview") &&
          c.body.instrument_type === "futures" &&
          c.body.side === "SELL",
      ),
    );
    const futureButton = page.getByRole("button", {
      name: "Place intention",
      exact: true,
    });
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Place intention"]').disabled,
    );
    const previousOrders = await page.evaluate(
      () => window.calls.filter((c) => c.path.endsWith("/orders")).length,
    );
    await futureButton.click();
    await page.waitForFunction(
      (count) =>
        window.calls.filter((c) => c.path.endsWith("/orders")).length > count,
      previousOrders,
    );
    const futureOrder = await page.evaluate(
      () => window.calls.filter((c) => c.path.endsWith("/orders")).at(-1).body,
    );
    assert.equal(futureOrder.instrument_type, "futures");
    assert.equal(futureOrder.expiry, "2026-10-27");
    assert.equal(futureOrder.side, "SELL");
    assert.equal(futureOrder.quantity, 5);
    assert.equal(futureOrder.approved_budget, 201);
    assert.equal(futureOrder.fee_hash, "captured");
    assert.equal(futureOrder.right, undefined);
    assert.equal(futureOrder.strike, undefined);
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
