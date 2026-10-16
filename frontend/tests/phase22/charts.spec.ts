import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";

test("Day and Swing chart rendering, release-only Real edits, drawings and renderer switching", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const patches = () =>
    page.evaluate(
      () =>
        (window as any).requests.filter(
          (r) => r.method === "PATCH" && r.url.includes("/api/orders/"),
        ).length,
    );
  await page.goto("/tests/phase22/harness.html", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().at(-1)?.high === 109,
  );
  assert.equal(await patches(), 0);
  const initial = await page.evaluate(() =>
    (window as any).chart().getDataList().at(-1),
  );
  assert.equal(initial.open, 103);
  assert.equal(initial.high, 109);
  assert.equal(initial.close, 107);
  console.log(
    "PASS real chart initially uses the existing data APIs without order writes",
  );
  const position = await page.evaluate(() => {
    const chart = (window as any).chart(),
      rect = document.querySelector(".kline").getBoundingClientRect();
    const p = chart.convertToPixel(
      [{ timestamp: chart.getDataList().at(-1).timestamp, value: 105 }],
      { paneId: "candle_pane" },
    )[0];
    return { x: rect.x + 350, y: rect.y + p.y };
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await page.mouse.move(position.x, position.y - 35, { steps: 8 });
  assert.equal(await patches(), 0);
  await page.mouse.up();
  await page.waitForFunction(() =>
    (window as any).requests.some((r) => r.method === "PATCH"),
  );
  await page.waitForFunction(
    () => (window as any).getPending()?.phase === "unconfirmed",
  );
  assert.equal(await patches(), 1);
  const pending = await page.evaluate(() => (window as any).getPending());
  assert.equal(pending.oldPrice, 105);
  assert.notEqual(pending.requestedPrice, 105);
  assert.equal(await page.locator(".order-line-label").count(), 2);
  console.log(
    "PASS physical drag sends one write only on release and shows old plus proposed prices",
  );
  await page.evaluate(() => {
    (window as any).confirmBroker = true;
    return (window as any).refreshBroker();
  });
  await page.waitForFunction(() => !(window as any).getPending());
  console.log("PASS broker evidence resolves the pending line");
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  await page
    .locator(".website-kline-tools button")
    .filter({ hasText: /^MA$/ })
    .click();
  await page
    .getByRole("button", { name: "Horizontal line", exact: true })
    .click();
  const rect = await page.locator(".kline").boundingBox();
  await page.mouse.click(rect.x + 400, rect.y + 250);
  await page.waitForFunction(() =>
    (window as any).requests.some(
      (r) => r.method === "POST" && r.url.endsWith("/drawings"),
    ),
  );
  assert.equal(await page.evaluate(() => (window as any).drawings.length), 1);
  console.log(
    "PASS a completed drawing persists to the existing drawing endpoint",
  );
  await page.getByTitle("delete selected drawing").click();
  await page.waitForFunction(() => (window as any).drawings.length === 0);
  console.log("PASS selected drawing deletion persists");
  const writesBefore = await patches();
  await page.evaluate(() => (window as any).switchRenderer("lightweight"));
  await page.waitForFunction(() => !document.querySelector(".website-kline"));
  await page.evaluate(() => (window as any).switchRenderer("kline"));
  await page.waitForSelector(".website-kline canvas");
  await page.waitForTimeout(100);
  assert.equal(await patches(), writesBefore);
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  assert.equal(
    await page
      .locator(".website-kline-tools button")
      .filter({ hasText: /^MA$/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  console.log(
    "PASS switching both ways preserves KLine indicator selection and sends no order writes",
  );
  await page.evaluate(() =>
    (window as any).setProps({
      onPriceSelect: (price) => ((window as any).picked = price),
    }),
  );
  const nextRect = await page.locator(".kline").boundingBox();
  await page.mouse.click(nextRect.x + nextRect.width - 100, nextRect.y + 100);
  await page.waitForFunction(
    () => Number.isFinite((window as any).picked) && (window as any).picked > 0,
  );
  console.log("PASS price picking works in chart space");
  await page.evaluate(() =>
    (window as any).setProps({
      onPriceSelect: null,
      historyMode: "replay",
      paneType: "options",
      right: "CE",
      strike: 24000,
      expiry: "2026-10-20",
      markerSessionKey: "replay-case",
      openOrders: [],
    }),
  );
  await page.waitForSelector(".website-kline canvas");
  await page.waitForTimeout(150);
  await page.waitForFunction(
    () => (window as any).chart().getDataList().at(-1)?.open === 103,
  );
  const replay = await page.evaluate(() =>
    (window as any)
      .chart()
      .getDataList()
      .map((c) => c.timestamp / 1000),
  );
  const cutoff = Date.parse("2026-10-16T09:24:00Z") / 1000;
  assert(replay.every((time) => time <= cutoff));
  assert(replay.includes(cutoff));
  console.log(
    "PASS replay full-day options history does not reveal future candles",
  );
  await page.evaluate(() =>
    (window as any).setProps({
      completedBar: {
        time: Date.parse("2026-10-16T09:24:00Z") / 1000,
        open: 103,
        high: 120,
        low: 99,
        close: 110,
      },
    }),
  );
  await page.waitForFunction(
    () => (window as any).chart().getDataList().at(-1).high === 120,
  );
  console.log("PASS Stepwise completed-bar correction survives batched ticks");
  await page.evaluate(() =>
    (window as any).setProps({
      externalCandles: [
        {
          time: Date.parse("2026-10-15T09:15:00Z") / 1000,
          open: 100,
          high: 110,
          low: 90,
          close: 108,
        },
        {
          time: Date.parse("2026-10-16T09:15:00Z") / 1000,
          open: 108,
          high: 112,
          low: 100,
          close: 110,
        },
      ],
      swingChart: true,
      intervalMinutes: 1440,
      markerSessionKey: "swing-case",
      paneType: "equity",
      right: undefined,
      strike: undefined,
      expiry: undefined,
    }),
  );
  await page.waitForSelector(".website-kline canvas");
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => (window as any).chart().getDataList().length),
    2,
  );
  console.log("PASS Swing external-candle rendering works");
  await page.setViewportSize({ width: 800, height: 650 });
  await page.waitForTimeout(100);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= (window as any).innerWidth,
    ),
  );
  console.log("PASS resizing does not introduce horizontal overflow");
  assert.deepEqual(errors, []);
  console.log("PASS no browser runtime errors");
});

test("renderer switching waits for an outstanding modification and keeps its reconciliation state", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page.evaluate(() => ((window as any).waitForEdit = true));
  const position = await page.evaluate(() => {
    const chart = (window as any).chart(),
      rect = document.querySelector(".kline")!.getBoundingClientRect();
    const p = chart.convertToPixel(
      [{ timestamp: chart.getDataList().at(-1).timestamp, value: 105 }],
      { paneId: "candle_pane" },
    )[0];
    return { x: rect.x + 350, y: rect.y + p.y };
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await page.mouse.move(position.x, position.y - 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    () => typeof (window as any).releaseEdit === "function",
  );
  await page.evaluate(() => (window as any).switchRenderer("lightweight"));
  await expect(page.locator(".website-kline")).toHaveCount(1);
  await page.evaluate(() => (window as any).releaseEdit());
  await expect(page.locator(".website-kline")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).getPending()?.phase)).toBe(
    "unconfirmed",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).requests.filter((r: any) => r.method === "PATCH")
          .length,
    ),
  ).toBe(1);
});

test("a definite broker rejection restores the confirmed line and clears the proposal", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page.evaluate(() => ((window as any).rejectEdit = true));
  const position = await page.evaluate(() => {
    const chart = (window as any).chart(),
      rect = document.querySelector(".kline")!.getBoundingClientRect();
    const p = chart.convertToPixel(
      [{ timestamp: chart.getDataList().at(-1).timestamp, value: 105 }],
      { paneId: "candle_pane" },
    )[0];
    return { x: rect.x + 350, y: rect.y + p.y };
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await page.mouse.move(position.x, position.y - 30, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".website-kline-error")).toContainText(
    "Rejected for test",
  );
  expect(
    await page.evaluate(() => (window as any).getPending()),
  ).toBeUndefined();
  await expect(page.locator(".order-line-label")).toHaveCount(1);
});

test("failed drawing creation stays visible and explicit refresh can reload saved state", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page.evaluate(() => ((window as any).failDrawingSave = true));
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  await page
    .getByRole("button", { name: "Horizontal line", exact: true })
    .click();
  const rect = await page.locator(".kline").boundingBox();
  await page.mouse.click(rect!.x + 400, rect!.y + 250);
  await expect(page.locator(".website-kline-error")).toContainText(
    "Drawing revision conflict",
  );
  expect(await page.evaluate(() => (window as any).drawings.length)).toBe(0);
  const localDrawingCount = () =>
    page.evaluate(
      () =>
        (window as any)
          .chart()
          .getOverlays()
          .filter(
            (o: any) =>
              !o.extendData?.orderId &&
              !o.extendData?.strategyId &&
              o.name !== "desktopTradeMarker",
          ).length,
    );
  expect(await localDrawingCount()).toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Refresh chart and drawings" })
    .click();
  await expect.poll(localDrawingCount).toBe(0);
});

test("failed drawing deletion retains both the saved drawing and its visible shape", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  await page
    .getByRole("button", { name: "Horizontal line", exact: true })
    .click();
  const rect = await page.locator(".kline").boundingBox();
  await page.mouse.click(rect!.x + 400, rect!.y + 250);
  await page.waitForFunction(() => (window as any).drawings.length === 1);
  await page.evaluate(() => ((window as any).failDrawingDelete = true));
  await page.getByTitle("delete selected drawing").click();
  await expect(page.locator(".website-kline-error")).toContainText(
    "Drawing revision conflict",
  );
  expect(await page.evaluate(() => (window as any).drawings.length)).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as any)
          .chart()
          .getOverlays()
          .filter(
            (o: any) =>
              !o.extendData?.orderId &&
              !o.extendData?.strategyId &&
              o.name !== "desktopTradeMarker",
          ).length,
    ),
  ).toBe(1);
});

test("website Day markers show the open cycle and can reveal closed cycles", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page.evaluate(() => {
    const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
    const fill = {
      session_id: "session",
      user_id: "owner",
      symbol: "NIFTY",
      side: "BUY",
      quantity: 50,
      price: 102,
      timestamp: base,
      commission: 1,
    };
    (window as any).setProps({
      trades: [
        { ...fill, trade_id: "closed-buy" },
        {
          ...fill,
          trade_id: "closed-sell",
          side: "SELL",
          timestamp: base + 180,
        },
        { ...fill, trade_id: "open-buy", timestamp: base + 540 },
      ],
    });
  });
  const markerCount = () =>
    page.evaluate(
      () =>
        (window as any)
          .chart()
          .getOverlays()
          .filter((o: any) => o.name === "desktopTradeMarker").length,
    );
  await expect.poll(markerCount).toBe(1);
  await page
    .getByRole("button", { name: "Show closed trade markers", exact: true })
    .click();
  await expect.poll(markerCount).toBe(3);
  expect(
    await page.evaluate(() =>
      (window as any).requests.some((r: any) => r.method === "PATCH"),
    ),
  ).toBe(false);
});

test("Swing Futures drawings retain their exact expiry and derivatives venue", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.evaluate(() => {
    const time = Date.parse("2026-10-16T09:15:00Z") / 1000;
    (window as any).setProps({
      swingChart: true,
      liveChart: false,
      externalCandles: [{ time, open: 100, high: 110, low: 95, close: 105 }],
      paneType: "futures",
      expiry: "2026-10-27",
      intervalMinutes: 1440,
      openOrders: [],
      markerSessionKey: "future",
    });
  });
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length === 1,
  );
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  await page
    .getByRole("button", { name: "Horizontal line", exact: true })
    .click();
  const rect = await page.locator(".kline").boundingBox();
  await page.mouse.click(rect!.x + 400, rect!.y + 150);
  await page.waitForFunction(() => (window as any).drawings.length === 1);
  expect(
    await page.evaluate(() => (window as any).drawings[0].instrument),
  ).toEqual({
    kind: "future",
    underlying: "NIFTY",
    exchange: "NFO",
    expiry: "2026-10-27",
  });
  expect(await page.locator(".candle-close").count()).toBe(0);
});

test("a drawing cannot be deleted before its pending creation is acknowledged", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.waitForFunction(
    () => (window as any).chart().getDataList().length > 0,
  );
  await page.evaluate(() => ((window as any).waitForDrawingSave = true));
  await page
    .getByRole("button", { name: "Toggle drawing and indicator tools" })
    .click();
  await page
    .getByRole("button", { name: "Horizontal line", exact: true })
    .click();
  const rect = await page.locator(".kline").boundingBox();
  await page.mouse.click(rect!.x + 400, rect!.y + 250);
  await page.waitForFunction(
    () => typeof (window as any).releaseDrawingSave === "function",
  );
  await page.getByTitle("delete selected drawing").click();
  await expect(
    page.getByText("This drawing is saving; try again when it finishes."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).requests.filter((r: any) => r.method === "DELETE")
          .length,
    ),
  ).toBe(0);
  await page.evaluate(() => (window as any).releaseDrawingSave());
  await page.waitForFunction(() => (window as any).drawings.length === 1);
  await page.getByTitle("delete selected drawing").click();
  await page.waitForFunction(() => (window as any).drawings.length === 0);
});

test("Lightweight drawings and indicator choices return after switching renderers", async ({
  page,
}) => {
  await page.goto("/tests/phase22/harness.html");
  await page.waitForSelector(".website-kline canvas");
  await page.evaluate(() => (window as any).switchRenderer("lightweight"));
  await page.waitForSelector(".tv-lightweight-charts");
  await page.getByTitle("Indicators", { exact: true }).click();
  await page.getByLabel("EMA 9/21", { exact: true }).uncheck();
  await page.getByTitle("Indicators", { exact: true }).click();
  await page.getByTitle("Drawing tools", { exact: true }).click();
  await page.getByText("─ Horizontal Line", { exact: true }).click();
  const rect = await page.locator(".tv-lightweight-charts").boundingBox();
  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await expect(
    page.getByRole("button", { name: "Clear", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).switchRenderer("kline"));
  await page.waitForSelector(".website-kline canvas");
  expect(await page.evaluate(() => (window as any).drawings.length)).toBe(0);
  await page.evaluate(() => (window as any).switchRenderer("lightweight"));
  await page.waitForSelector(".tv-lightweight-charts");
  await expect(
    page.getByRole("button", { name: "Clear", exact: true }),
  ).toBeVisible();
  await page.getByTitle("Indicators", { exact: true }).click();
  await expect(page.getByLabel("EMA 9/21", { exact: true })).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      (window as any).requests.some((r: any) => r.method === "PATCH"),
    ),
  ).toBe(false);
});

test('KLine respects authoritative and unavailable website P&L', async ({page}) => {
  await page.goto('/tests/phase22/harness.html');
  await page.waitForSelector('.website-kline canvas');
  await page.waitForFunction(() => (window as any).chart().getDataList().length > 0);
  await page.evaluate(() => (window as any).setProps({pnl:123.45,pnlAvailable:true}));
  await expect(page.locator('.position-pnl-label')).toHaveText('+123.45');
  await page.evaluate(() => (window as any).setProps({pnlAvailable:false,latestTick:null}));
  await expect(page.locator('.position-pnl-label')).toHaveText('—');
  await page.evaluate(() => (window as any).setProps({pnlAvailable:true,pnl:-50,pnlPctMode:true,sessionCapital:1000}));
  await expect(page.locator('.position-pnl-label')).toHaveText('-5.00%');
});

test('inactive-pane tools activate their own chart before drawing', async ({page}) => {
  await page.goto('/tests/phase22/harness.html');
  await page.waitForSelector('.website-kline canvas');
  await page.waitForFunction(() => (window as any).chart().getDataList().length > 0);
  await page.evaluate(() => (window as any).setProps({isActive:false,onActivate:()=>{
    (window as any).activations=((window as any).activations??0)+1;
    (window as any).setProps({isActive:true});
  }}));
  await page.getByRole('button',{name:'Toggle drawing and indicator tools'}).click();
  await page.getByRole('button',{name:'Horizontal line',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).activations??0)).toBeGreaterThan(0);
  const rect=await page.locator('.kline').boundingBox();
  await page.mouse.click(rect!.x+400,rect!.y+250);
  await page.waitForFunction(()=>(window as any).drawings.length===1);
});

test('strategy edits block overlapping releases and recover after rejection', async ({page})=>{
  await page.goto('/tests/phase22/harness.html');
  await page.waitForSelector('.website-kline canvas');
  await page.waitForFunction(()=>(window as any).chart().getDataList().length>0);
  await page.evaluate(()=>(window as any).setProps({openOrders:[],strategyPaneActive:true,
    targetProfitStrategies:[{strategy_id:'s1',strategy_type:'UnderlyingStoploss',status:'RUNNING',symbol:'NIFTY',right:null,price:104}],
    onStrategyDrag:()=>{(window as any).strategyCalls=((window as any).strategyCalls??0)+1;return new Promise((_resolve,reject)=>{(window as any).rejectStrategy=()=>reject(new Error('Rejected strategy update'))})},
  }));
  await page.waitForFunction(()=>(window as any).chart().getOverlays().some((o:any)=>o.extendData?.strategyId));
  const release=()=>page.evaluate(()=>{const o=(window as any).chart().getOverlays().find((o:any)=>o.extendData?.strategyId);o.onPressedMoveEnd({overlay:{id:o.id,points:[{value:103}]}})});
  await release();await release();
  await expect.poll(()=>page.evaluate(()=>(window as any).strategyCalls)).toBe(1);
  await page.evaluate(()=>(window as any).switchRenderer('lightweight'));
  await expect(page.locator('.website-kline')).toHaveCount(1);
  await page.evaluate(()=>(window as any).rejectStrategy());
  await expect(page.locator('.website-kline')).toHaveCount(0);
  await page.evaluate(()=>(window as any).switchRenderer('kline'));
  await page.waitForSelector('.website-kline canvas');
  await page.waitForFunction(()=>(window as any).chart().getOverlays().some((o:any)=>o.extendData?.strategyId));
  await release();
  await expect.poll(()=>page.evaluate(()=>(window as any).strategyCalls)).toBe(2);
  await page.evaluate(()=>(window as any).rejectStrategy());
});

for(const drawing of [
  {label:'▲ Buy Marker',clicks:1,marker:'arrowUp'},
  {label:'▼ Sell Marker',clicks:1,marker:'arrowDown'},
  {label:'─ Horizontal Line',clicks:1},
  {label:'↗ Trend Line',clicks:2},
  {label:'◫ Fib Retracement',clicks:2},
  {label:'⊟ Parallel Channel',clicks:3},
  {label:'⚡ Risk:Reward',clicks:2},
])test(`Lightweight ${drawing.label} survives switching and Clear`,async({page})=>{
  await page.goto('/tests/phase22/harness.html');
  await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>(window as any).switchRenderer('lightweight'));
  await page.waitForSelector('.tv-lightweight-charts');
  await page.waitForFunction(()=>((window as any).lastCandles?.length??0)>0);
  // Inspect real series without adding a production test interface.
  await page.evaluate(async()=>{
    const url=performance.getEntriesByType('resource').find(r=>/deps\/lightweight-charts/.test(r.name))!.name;
    const {createChart}=await import(/* @vite-ignore */ url);
    const element=document.createElement('div');document.body.append(element);
    const chart=createChart(element,{width:10,height:10});
    const proto=Object.getPrototypeOf(chart),add=proto.addLineSeries,remove=proto.removeSeries;
    (window as any).capturedSeries=[];(window as any).invalidRemovals=0;
    proto.addLineSeries=function(...args:any[]){const s=add.apply(this,args);(window as any).capturedSeries.push(s);return s};
    proto.removeSeries=function(s:any){if(!s)(window as any).invalidRemovals++;return remove.call(this,s)};
    chart.remove();element.remove();
  });
  await page.getByTitle('Drawing tools',{exact:true}).click();
  await page.getByText(drawing.label,{exact:true}).click();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  const rect=await page.locator('.tv-lightweight-charts').boundingBox();
  for(let i=0;i<drawing.clicks;i++){
    await page.mouse.click(rect!.x+rect!.width*(.4+i*.12),rect!.y+rect!.height*(.4+i*.1));
    // Separate clicks so the chart does not interpret the second point as a double-click.
    await page.waitForTimeout(550);
  }
  await expect(page.getByRole('button',{name:'Clear',exact:true})).toBeVisible();
  const capture=()=>page.evaluate(()=>(window as any).capturedSeries.map((s:any)=>({data:s.data(),markers:s.markers(),color:s.options().color,lineVisible:s.options().lineVisible})));
  const before=await capture();
  await page.evaluate(()=>(window as any).switchRenderer('kline'));
  await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>{(window as any).capturedSeries=[];return (window as any).switchRenderer('lightweight')});
  await page.waitForSelector('.tv-lightweight-charts');
  await expect(page.getByRole('button',{name:'Clear',exact:true})).toBeVisible();
  const after=await capture();
  for(const series of before)expect(after).toContainEqual(series);
  if(drawing.marker)expect(after.some((s:any)=>s.markers.some((m:any)=>m.shape===drawing.marker))).toBe(true);
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  await expect(page.getByRole('button',{name:'Clear',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).invalidRemovals)).toBe(0);
});

test('one collapsible tools panel controls only the active KLine chart', async ({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>(window as any).setProps({sharedTools:true}));
  await expect(page.locator('.website-kline')).toHaveCount(2);
  await page.waitForFunction(()=>(window as any).charts().every((c:any)=>c.getDataList().length>0));
  await expect(page.getByRole('button',{name:'Toggle drawing and indicator tools'})).toHaveCount(1);
  await page.getByRole('button',{name:'Toggle drawing and indicator tools'}).click();
  await expect(page.locator('.website-chart-tools-name')).toHaveText('NIFTY');
  await page.locator('.website-chart-tools button').filter({hasText:/^MA$/}).click();
  const second=await page.locator('.kline').nth(1).boundingBox();await page.mouse.click(second!.x+100,second!.y+100);
  await expect(page.locator('.website-chart-tools-name')).toContainText('24000 PE');
  await expect(page.locator('.website-chart-tools button').filter({hasText:/^MA$/})).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Horizontal line',exact:true}).click();
  await page.waitForFunction(()=>(window as any).charts()[1].getOverlays().length>0);
  await page.waitForTimeout(550); // Keep activation and placement distinct from a chart double-click.
  await page.mouse.click(second!.x+150,second!.y+180);
  await page.waitForFunction(()=>(window as any).drawings.length===1);
  expect(await page.evaluate(()=>(window as any).drawings[0].instrument.right)).toBe('PE');
  const first=await page.locator('.kline').nth(0).boundingBox();await page.mouse.click(first!.x+100,first!.y+100);
  await expect(page.locator('.website-chart-tools button').filter({hasText:/^MA$/})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Toggle drawing and indicator tools'}).click();
  await expect(page.locator('.website-kline-tools')).toBeHidden();
  await page.evaluate(()=>(window as any).switchRenderer('lightweight'));
  await expect(page.getByRole('complementary',{name:'Active chart drawings and indicators'})).toBeHidden();
  expect(errors).toEqual([]);
});

test('Swing chart resizes and toggles the shared tools without ResizeObserver errors', async ({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>(window as any).setProps({swingHarness:true}));
  await page.waitForSelector('.swing-renderer .website-kline canvas');
  for(const width of [760,1101,800,1200]){
    await page.setViewportSize({width,height:700});
    await page.getByRole('button',{name:'Toggle drawing and indicator tools'}).click();
    await page.waitForTimeout(100);
  }
  await page.evaluate(()=>(window as any).switchRenderer('lightweight'));
  await page.waitForSelector('.tv-lightweight-charts');
  for(const width of [800,1200]){await page.setViewportSize({width,height:750});await page.waitForTimeout(100)}
  await page.evaluate(()=>(window as any).switchRenderer('kline'));
  await page.waitForSelector('.website-kline canvas');
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('KLine recovery reports the real error and retries only the chart',async({page})=>{
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  const writes=()=>page.evaluate(()=>(window as any).requests.filter((r:any)=>r.method!=='GET').length);
  const before=await writes();
  await page.evaluate(()=>(window as any).setProps({trades:{invalid:'reconnect fixture'}}));
  await expect(page.getByRole('alert')).toContainText('KLine could not load or render');
  await page.getByText('Chart error details',{exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('iterable');
  await expect(page.getByRole('button',{name:/Use Lightweight|Retry KLine/})).toHaveCount(0);
  await page.evaluate(()=>(window as any).setProps({trades:[]}));
  await page.getByRole('button',{name:'Retry chart',exact:true}).click();
  await page.waitForSelector('.website-kline canvas');
  expect(await writes()).toBe(before);
  await page.evaluate(()=>(window as any).setProps({trades:{invalid:true}}));
  await expect(page.getByRole('alert')).toContainText('KLine could not load or render');
  await page.evaluate(()=>(window as any).setProps({trades:[],markerSessionKey:'different-session'}));
  await page.waitForSelector('.website-kline canvas');
  expect(await writes()).toBe(before);
});

test('chart renderer switches only through settings and Escape cancels picking without a numeric write',async({page})=>{
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await expect(page.getByRole('button',{name:/Lightweight/})).toHaveCount(0);
  await page.evaluate(()=>(window as any).setProps({onPriceSelect:(p:number)=>(window as any).picked=p,onCancelPricePick:()=>{(window as any).cancelled=true;(window as any).setProps({onPriceSelect:null})}}));
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>(window as any).cancelled===true);
  expect(await page.evaluate(()=>(window as any).picked)).toBeUndefined();
  await page.evaluate(()=>(window as any).switchRenderer('lightweight'));await page.waitForSelector('.tv-lightweight-charts');
  expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.includes('/api/orders/')&&r.method!=='GET').length)).toBe(0);
});

test('three KLine replay charts use the available height without the old toolbar gap',async({page})=>{
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>(window as any).setProps({threeCharts:true}));
  await expect(page.locator('.website-kline')).toHaveCount(3);
  await page.waitForFunction(()=>(window as any).charts().length===3&&(window as any).charts().every((c:any)=>c.getDataList().length>0));
  const gap=await page.evaluate(()=>{
    const area=document.querySelector('[data-testid="three-chart-area"]')!.getBoundingClientRect();
    const bottoms=[...document.querySelectorAll('.website-kline')].map(e=>e.getBoundingClientRect().bottom);
    return area.bottom-Math.max(...bottoms);
  });
  expect(gap).toBeGreaterThanOrEqual(0);expect(gap).toBeLessThanOrEqual(1);
});

test('production underlying context menu prevents option-premium orders',async({page})=>{
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await page.evaluate(()=>(window as any).setProps({menuHarness:true,openOrders:[]}));
  const rect=await page.locator('.kline').boundingBox();await page.mouse.click(rect!.x+250,rect!.y+150,{button:'right'});
  await expect(page.getByText('Place option orders on a CE/PE chart',{exact:true})).toBeVisible();
  await expect(page.getByText(/^Use as SL @/)).toHaveCount(0);
  await expect(page.getByText('Shift SL to here',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.includes('/api/orders')&&r.method!=='GET').length)).toBe(0);
});
for(const right of ['CE','PE'])test(`production ${right} right-click menu and ticket preserve the selected contract`,async({page})=>{
  await page.goto('/tests/phase22/harness.html');await page.waitForSelector('.website-kline canvas');
  await page.evaluate(right=>(window as any).setProps({menuHarness:true,paneType:'options',right,strike:24000,expiry:'2026-10-20',openOrders:[]}),right);
  await page.waitForSelector('.website-kline canvas');
  const rect=await page.locator('.kline').boundingBox();await page.mouse.click(rect!.x+250,rect!.y+150,{button:'right'});
  await page.getByText(/^Use as SL @/).click();
  await expect(page.getByRole('dialog',{name:'Chart entry ticket'})).toContainText(`24000 ${right}`);
  await page.getByRole('button',{name:'Limit',exact:true}).click();
  await page.getByRole('button',{name:'Qty 1',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).submittedTicket)).toMatchObject({ticket:{sessionId:'session',paneId:1,right,strike:24000,expiry:'2026-10-20',orderType:'LIMIT'},quantity:1});
});
