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
