import WebsiteChartAppearanceSettings from "../../src/components/WebsiteChartAppearanceSettings";
import { buildDayChartContextMenu } from "../../src/services/dayChartContextMenu";
import ChartContextMenu from "../../src/components/ChartContextMenu";
import ChartEntryTicket, { type EntryTicket } from "../../src/components/ChartEntryTicket";
import { chartPaneHeight } from "../../src/services/chartLayout";
import { WebsiteChartTools } from "../../src/components/WebsiteChartTools";
import SwingChart from "../../src/components/SwingChart";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import TradingChartHost from "../../src/components/TradingChartHost";
import api from "../../src/services/api";
import {
  publishRenderer,
  rendererAccountKey,
} from "../../src/services/websiteChartPreferences";
import { init } from "klinecharts";
import { pendingOrderEdits } from "../../../shared/charts/pendingOrderEdits";
const w = window as any;
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
const prior = base - 86400;
const history = Array.from({ length: 70 }, (_, i) => ({
  time: prior + i * 180,
  open: 100 + Math.sin(i),
  high: 104 + Math.sin(i),
  low: 97 + Math.sin(i),
  close: 101 + Math.sin(i),
}));
const today = Array.from({ length: 12 }, (_, i) => ({
  time: base + i * 180,
  open: 100 + i,
  high: 104 + i,
  low: 97 + i,
  close: 101 + i,
}));
const order = {
  order_id: "o1",
  session_id: "session",
  user_id: "owner",
  symbol: "NIFTY",
  side: "SELL",
  order_type: "LIMIT",
  quantity: 50,
  trigger_price: 0,
  limit_price: 105,
  status: "PENDING",
  is_stoploss: false,
  created_at: base,
  filled_at: null,
  filled_price: null,
  broker_order_id: "broker1",
};
w.requests = [];
w.drawings = [];
w.mockSettings = "kline";
w.confirmBroker = false;
w.brokerVersion = 0;
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
localStorage.setItem("website-chart-renderer::owner", "kline");
const originalFetch = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(
    typeof input === "string" ? input : input.url,
    location.origin,
  );
  if (!url.pathname.startsWith("/api/")) return originalFetch(input, options);
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  w.requests.push({ url: url.pathname, query: url.search, method, body });
  let data: any = {};
  if (url.pathname === "/api/users/settings") {
    if (body?.website_chart_renderer)
      w.mockSettings = body.website_chart_renderer;
    data = {
      website_chart_renderer: w.mockSettings,
      historical_days: 2,
      target_deviation_configured: true,
    };
  } else if (url.pathname === "/api/data/symbols")
    data = {
      symbols: [
        {
          symbol: "NIFTY",
          display_name: "NIFTY",
          chart_type: "index",
          option_eligible: true,
        },
      ],
    };
  else if (url.pathname.includes("/api/data/historical"))
    data = { candles: history };
  else if (url.pathname.includes("/api/data/pre-session"))
    data = { candles: today.filter((c) => c.time < base + 600) };
  else if (url.pathname.includes("/api/data/options-historical"))
    data = {
      candles: [...history, ...today].filter(
        (c) =>
          !url.searchParams.get("as_of_time") ||
          c.time <
            Date.parse(`2026-10-16T${url.searchParams.get("as_of_time")}Z`) /
              1000,
      ),
      as_of_time: url.searchParams.get("as_of_time"),
    };
  else if (url.pathname.endsWith("/chart-settings")) {
    if (method === "PUT") w.appearance = body.settings;
    data = { settings: w.appearance ?? {background:"#0d1117", trendLineColor:"#123456"} };
  }
  else if (url.pathname.includes("/drawings")) {
    if (method === "POST" && w.waitForDrawingSave)
      await new Promise((resolve) => (w.releaseDrawingSave = resolve));
    if (
      (method === "POST" && w.failDrawingSave) ||
      (method === "DELETE" && w.failDrawingDelete)
    )
      return new Response(
        JSON.stringify({ detail: "Drawing revision conflict for test" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    if (method === "GET")
      data = {
        drawings: w.drawings.filter(
          (d: any) =>
            JSON.stringify(
              Object.fromEntries(Object.entries(d.instrument).sort()),
            ) === url.searchParams.get("instrument"),
        ),
      };
    if (method === "POST") {
      data = {
        drawing_id: "d" + w.drawings.length,
        revision: 1,
        drawing: body.drawing,
        instrument: body.instrument,
      };
      w.drawings.push(data);
    }
    if (method === "PUT") {
      const d = w.drawings.find((d: any) =>
        url.pathname.endsWith(d.drawing_id),
      );
      data = { ...d, drawing: body.drawing, revision: d.revision + 1 };
      Object.assign(d, data);
    }
    if (method === "DELETE") {
      w.drawings = w.drawings.filter(
        (d: any) => !url.pathname.endsWith(d.drawing_id),
      );
      data = { deleted: true };
    }
  } else if (url.pathname.includes("/api/orders/")) {
    if (w.waitForEdit)
      await new Promise((resolve) => (w.releaseEdit = resolve));
    if (w.rejectEdit)
      return new Response(JSON.stringify({ detail: "Rejected for test" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    data = { ...order, ...body };
    w.latestRequested = data.limit_price;
  } else if (url.pathname.endsWith("/refresh"))
    data = {
      state_generation: "test",
      state_version: ++w.brokerVersion,
      reconciled: 1,
      updated: 1,
      imported: 0,
      orders: [
        {
          broker_order_id: "broker1",
          kotak_order_id: "broker1",
          status: "open",
          limit_price: w.confirmBroker ? (w.latestRequested ?? 105) : 105,
          trigger_price: 0,
        },
      ],
      open_orders: [],
      trades: [],
      positions: [],
      application_orders: [
        {
          ...order,
          limit_price: w.confirmBroker ? (w.latestRequested ?? 105) : 105,
        },
      ],
      snapshot_revision: "r" + w.brokerVersion,
      wallet_balance: 100000,
    };
  else
    return new Response(
      JSON.stringify({ detail: "Unexpected mock API " + url.pathname }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
function Harness() {
  const [entryTicket,setEntryTicket]=useState<EntryTicket|null>(null);
  const [menu,setMenu]=useState<any>(null);
  const [props, setProps] = useState<any>({
    symbol: "NIFTY",
    tradingDate: "2026-10-16",
    startTime: "09:15:00",
    intervalMinutes: 3,
    historyMode: "live",
    height: 480,
    chartKind: "index",
    paneType: "equity",
    isActive: true,
    currentSimTime: base + 600,
    latestTick: {
      type: "tick",
      time: base + 600,
      open: 104,
      high: 109,
      low: 100,
      close: 107,
    },
    openOrders: [order],
    trades: [],
    realTrading: true,
    position: {
      symbol: "NIFTY",
      side: "LONG",
      quantity: 50,
      avg_entry_price: 100,
      entry_commission: 1,
    },
    onCandlesChange: (rows: any) => (w.lastCandles = rows),
    onContextMenu: () => (w.contextCalled = true),
    onPriceSelect: null,
  });
  w.setProps = (change: any) =>
    setProps((current: any) => ({ ...current, ...change }));
  w.switchRenderer = async (value: any) => {
    await api.updateUserSettings({ website_chart_renderer: value });
  };
  w.directSwitch = (value: any) => publishRenderer(value, rendererAccountKey());
  w.refreshBroker = () => api.reconcileKotakOrders("session");
  w.getPending = () => pendingOrderEdits.get("session", "o1");
  const chart = (
    <TradingChartHost
      {...props}
      onBrokerSnapshot={(_session, snapshot) =>
        setProps((p: any) => ({
          ...p,
          openOrders: snapshot.application_orders,
        }))
      }
      onOrderDrag={async (order: any, price: number) => {
        const updated = await api.updateOrder(
          "session",
          order.order_id,
          undefined,
          price,
        );
        setProps((p: any) => ({ ...p, openOrders: [updated] }));
        return updated;
      }}
    />
  );
  if (props.appearanceUI) return <><WebsiteChartAppearanceSettings />{chart}</>;
  if (props.menuHarness) {
    const flat={side:'FLAT',quantity:0};
    const pane={id:1,type:props.paneType??'equity',right:props.right,strike:props.strike,expiry:props.expiry};
    const environment={contextMenu:menu,sim:{sessionId:'session',symbol:'NIFTY',sessionType:'sim',sessionInstrumentType:'options',trades:[],openOrders:[],position:flat,positionCE:flat,positionPE:flat},simRef:{current:{sessionId:'session'}},panes:[pane],sizingMode:'quantity',cancelPricePick:()=>{},setMissingSlPick:()=>{},setContextMenuEntryTicket:setEntryTicket,setBrokerError:()=>{},strategySyncVersionRef:{current:0},setRunningStrategies:()=>{},setBrokerOrdersSnapshot:()=>{},targetDeviationPct:.01};
    return <>{React.cloneElement(chart,{onContextMenu:(price:number,x:number,y:number,ctx:any)=>setMenu({sessionId:'session',paneId:1,price,x,y,...ctx,strike:props.strike,expiry:props.expiry})})}
      {menu&&<ChartContextMenu x={menu.x} y={menu.y} price={menu.price} actions={buildDayChartContextMenu(environment as unknown as Parameters<typeof buildDayChartContextMenu>[0])} onClose={()=>setMenu(null)}/>}
      {entryTicket&&<ChartEntryTicket ticket={entryTicket} fundsRatios={{l:3,m:6,h:12}} riskRatios={{l:1,m:2,h:4}} instrumentType="options" sessionType="sim" onChange={setEntryTicket} onSubmit={(ticket,quantity)=>{w.submittedTicket={ticket,quantity};setEntryTicket(null)}} onClose={()=>setEntryTicket(null)}/>}
    </>;
  }
  if (props.threeCharts) {
    const height = chartPaneHeight(700, 'kline', 2);
    return <WebsiteChartTools><div data-testid="three-chart-area" style={{height:700,display:'flex',flexDirection:'column',gap:4}}>
      {React.cloneElement(chart,{height})}
      <div style={{display:'flex',gap:4}}>{["CE","PE"].map(right=><div key={right} style={{flex:1,minWidth:0}}>{React.cloneElement(chart,{height,paneType:'options',right,strike:24000,expiry:'2026-10-20',openOrders:[],isActive:false})}</div>)}</div>
    </div></WebsiteChartTools>;
  }
  if (props.swingHarness) return <WebsiteChartTools><div style={{display:'flex',height:'70vh'}}>
    <SwingChart pane={{symbol:'NIFTY',instrument_type:'equity',interval:'3m',as_of_date:'2026-10-16'}} drawingScope="test" chartKind="index" candles={today} loading={false} message="" live={false} active picking={false} orders={[]} onPick={()=>{}} onActivate={()=>{}} loadOlder={async()=>({candles:[],more:false})} />
  </div></WebsiteChartTools>;
  if (props.sharedTools) return <WebsiteChartTools><div style={{display:'flex',minWidth:0}}>
    <div style={{flex:1,minWidth:0}}>{React.cloneElement(chart,{isActive:!props.activeIndex,onActivate:()=>setProps((p:any)=>({...p,activeIndex:0}))})}</div>
    <div style={{flex:1,minWidth:0}}>{React.cloneElement(chart,{paneType:'options',right:'PE',strike:24000,expiry:'2026-10-20',openOrders:[],isActive:props.activeIndex===1,onActivate:()=>setProps((p:any)=>({...p,activeIndex:1}))})}</div>
  </div></WebsiteChartTools>;
  return chart;
}
createRoot(document.getElementById("test-root")!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
w.chart = () => {
  const element = document.querySelector(".kline") as HTMLElement;
  element.id = element.getAttribute("k-line-chart-id") ?? "";
  return init(element);
};
w.ready = true;

w.charts = () => [...document.querySelectorAll(".kline")].map(element => {
  element.id = element.getAttribute("k-line-chart-id") ?? "";
  return init(element as HTMLElement);
});
