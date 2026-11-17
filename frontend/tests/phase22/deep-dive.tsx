import React from "react";
import { createRoot } from "react-dom/client";
import PatternLibrary from "../../src/pages/PatternLibrary";
import { analysisRendererCacheKey } from "../../src/services/analysisRendererPreference";

// A mocked backend for the Deep Dive on the website: the /api/deep-dive routes in memory, plus the candle and strike calls.
const w = window as any;
const params = new URLSearchParams(location.search);
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
localStorage.setItem(analysisRendererCacheKey(), params.get("renderer") === "kline" ? "kline" : "lightweight");
localStorage.setItem("maxPriceMode", "otm");
w.requests = [] as { path: string; query: Record<string, string>; method: string; body?: any }[];
const store = { setups: [] as any[], tags: [] as any[], saved: [] as string[] };
w.store = store;
const key = (s: any) => `${s.date}|${s.symbol}|${s.side}`;
const active = () => store.tags.filter((t) => t.status === "active");
const withGaps = (s: any) => { const missing = active().filter((t) => !(t.tag_id in s.tag_values)).map((t) => t.tag_id); return { ...s, missing, complete: missing.length === 0 }; };
const order = (list: any[]) => [...list].sort((a, b) => a.date.localeCompare(b.date) || (a.side === "buy" ? -1 : 1));
const dive = () => {
  const setups = order(store.setups).map(withGaps);
  return { owner_id: "owner", can_edit: true, category: "Breakout", strategy: "Opening range", setups, tags: store.tags,
    incomplete_days: setups.filter((s) => !s.complete).length, unmarked_total: setups.reduce((n, s) => n + s.missing.length, 0) };
};
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
const candles = Array.from({ length: 80 }, (_, i) => ({ time: base + i * 180, open: 100 + i, high: 104 + i, low: 97 + i, close: 101 + i }));
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function deepDive(path: string, method: string, body: any, query: Record<string, string>) {
  if (path === "dives") {
    const d = dive();
    return { dives: d.setups.length || store.tags.length ? [{ owner_id: "owner", can_edit: true, category: d.category, strategy: d.strategy, days: d.setups.length,
      buy_days: d.setups.filter((s) => s.side === "buy").length, sell_days: d.setups.filter((s) => s.side === "sell").length, tags: active().length, incomplete_days: d.incomplete_days }] : [] };
  }
  if (path === "dive") return dive();
  if (path === "setup" && method === "PUT") {
    const { category, strategy, symbol, date, side, ...fields } = body;
    let s = store.setups.find((x) => key(x) === `${date}|${symbol}|${side}`);
    if (!s) { s = { category, strategy, symbol, date, side, strike_ce: null, strike_pe: null, strike_mode: null, interval_minutes: 3, annotations: [], outcome: null, tag_values: {}, notes: "", created_at: "", updated_at: "" }; store.setups.push(s); }
    Object.assign(s, fields);
    return s;
  }
  if (path === "setup" && method === "DELETE") {
    const k = `${query.date}|${query.symbol}|${query.side}`;
    const had = store.setups.some((s) => key(s) === k);
    store.setups = store.setups.filter((s) => key(s) !== k);
    return { status: had ? "deleted" : "not_found" };
  }
  if (path === "setup/tag-values") {
    const s = store.setups.find((x) => key(x) === `${body.date}|${body.symbol}|${body.side}`);
    for (const [id, v] of Object.entries(body.tag_values)) { if (v === null) delete s.tag_values[id]; else s.tag_values[id] = v; }
    return s;
  }
  if (path === "setup/save-to-patterns") {
    const s = store.setups.find((x) => key(x) === `${body.date}|${body.symbol}|${body.side}`);
    store.saved.push(key(s));
    return { chart_id: "chart-1", merged: store.saved.length > 1, added: s.annotations.length };
  }
  if (path === "tags" && method === "POST") {
    const tag = { tag_id: "t" + (store.tags.length + 1), name: body.name, status: "active", sort_order: store.tags.length, created_at: "", archived_at: null };
    store.tags.push(tag);
    return tag;
  }
  const m = /^tags\/(\w+)\/(archive|restore)$/.exec(path);
  if (m) { const t = store.tags.find((x) => x.tag_id === m[1]); t.status = m[2] === "archive" ? "archived" : "active"; return t; }
  throw new Error("unhandled deep dive path " + path);
}

// Phase 26, S10: the strategies labelled on trades and the trades behind one (entry 09:21, exit 09:48 on the 3-minute chart clock).
w.tradedSaves = [] as any[];
const tradeBase = Date.parse("2026-10-16T09:00:00Z") / 1000;
const tradedSummary = [
  { category: "Breakout", strategy: "Opening range", trades: 2, expected: 1, actual: 1, last_date: "2026-10-16", sessions: 2 },
  { category: "Reversal", strategy: "Double top", trades: 1, expected: 1, actual: 0, last_date: "2026-10-09", sessions: 1 },
];
const tradedTrade = (index: number, extra: any) => ({
  session_id: "s" + index, round_trip_index: index, date: "2026-10-16", symbol: "NIFTY", session_type: "paper", instrument_type: "options",
  right: "CE", strike: 24500, expiry: "2026-10-20", action: "BUY", side: "buy", state: "closed", pnl: 1950, pnl_pct: 1.9,
  entry: { time: tradeBase + 21 * 60 + 5, price: 100, quantity: 65 }, exit: { time: tradeBase + 48 * 60, price: 130, quantity: 65 },
  expected: { category: "Breakout", strategy: "Opening range" }, actual: { category: "", strategy: "" }, matched_as: "expected", ...extra,
});
const tradedList = { category: "Breakout", strategy: "Opening range", total: 2, truncated: false, unavailable: 0, trades: [
  tradedTrade(1, {}),
  tradedTrade(2, { right: "PE", strike: 24400, action: "SELL", side: "buy", pnl: -300, matched_as: "actual", entry: { time: tradeBase + 100 * 60, price: 90, quantity: 65 }, exit: { time: tradeBase + 130 * 60, price: 96, quantity: 65 } }),
] };
const savedTradedChart = { chart_id: "chart-9", user_id: "owner", symbol: "NIFTY", date: "2026-10-16", instrument_type: "options", right: "CE", strike: 24500,
  notes: "", interval_minutes: 3, top_patterns: {}, risk_reward_ratios: {}, created_at: "", updated_at: "", can_delete: true,
  annotations: [{ id: "m1", time: tradeBase + 21 * 60, price: 100, type: "entry", instrument: "CE", strategy_name: "Opening range", category: "Breakout", text: "" }] };

const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  const query = Object.fromEntries(url.searchParams.entries());
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  w.requests.push({ path: url.pathname, query, method, body });
  const path = url.pathname;
  try {
    if (path.startsWith("/api/deep-dive/")) return json(deepDive(path.replace("/api/deep-dive/", ""), method, body, query));
    if (path === "/api/pattern/traded/summary") return json({ strategies: tradedSummary });
    if (path === "/api/pattern/traded") return json(tradedList);
    if (path === "/api/pattern/traded/save") { w.tradedSaves.push(body); return json({ chart_id: "chart-9", merged: w.tradedSaves.length > 1, added: 2 }); }
    if (path === "/api/pattern/chart/chart-9") return json(savedTradedChart);
    if (path === "/api/pattern/strategies") return json({ strategies: ["Opening range"] });
    if (path === "/api/pattern/categories") return json({ categories: ["Breakout"] });
    if (path === "/api/pattern/charts") return json({ charts: [] });
    if (path === "/api/pattern/ohlc/equity") return json({ symbol: query.symbol, candles });
    if (path === "/api/pattern/ohlc/options") return json({ symbol: query.symbol, strike: Number(query.strike), candles });
    if (path === "/api/data/price-at") return json({ symbol: query.symbol, date: query.date, time: query.time, price: 24512 });
    if (path === "/api/data/expiry") return json({ symbol: query.symbol, date: query.date, expiry: "2026-10-20" });
    if (path === "/api/data/historical") return json({ symbol: query.symbol, dates: [], candles: candles.map((c) => ({ ...c, time: c.time - 86400 })) });
    if (path === "/api/data/pre-session") return json({ candles });
    if (path === "/api/data/options-historical") return json({ candles });
  } catch (error) { return json({ detail: String((error as Error).message) }, 400); }
  return json({});
};
createRoot(document.getElementById("test-root")!).render(<PatternLibrary />);
