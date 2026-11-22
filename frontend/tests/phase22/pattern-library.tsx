import React from "react";
import { createRoot } from "react-dom/client";
import PatternLibrary from "../../src/pages/PatternLibrary";

// A mocked backend for the Pattern Library: the strike pick, the minute-data calls and the saved strikes.
const w = window as any;
const params = new URLSearchParams(location.search);
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
localStorage.setItem("maxPriceMode", params.get("mode") ?? "otm");
localStorage.setItem("maxPriceThresholdCE", params.get("ce") ?? "60");
localStorage.setItem("maxPriceThresholdPE", params.get("pe") ?? "45");
w.requests = [] as { path: string; query: Record<string, string>; method: string; body?: any }[];
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
// ?saved=both: a chart saved with different CE and PE strikes (Max Price); ?saved=old: one saved before strike_pe existed.
const savedKind = params.get("saved");
const savedChart = (extra: any) => ({
  chart_id: "c9", user_id: "owner", symbol: "NIFTY", date: "2026-10-16", instrument_type: "options", right: "CE",
  notes: "", created_at: "", updated_at: "", entry_count: 1, exit_count: 0, strategy_names: ["Pullback"], categories: ["Trend"],
  can_delete: true, interval_minutes: 3, has_top_patterns: false, top_patterns: {}, risk_reward_ratios: {},
  annotations: [
    { id: "a1", time: base + 180, price: 100, type: "entry", instrument: "CE", strategy_name: "Pullback", category: "Trend" },
    { id: "a2", time: base + 360, price: 90, type: "entry", instrument: "PE", strategy_name: "Pullback", category: "Trend" },
  ],
  ...extra,
});
w.savedCharts = savedKind === "both" ? [savedChart({ strike: 24650, strike_pe: 24350 })]
  : savedKind === "old" ? [savedChart({ strike: 24500 })] : [] as any[];
w.failFindStrike = params.get("fail") === "1";
const candles = Array.from({ length: 40 }, (_, i) => ({
  time: base + i * 180, open: 100 + i, high: 104 + i, low: 97 + i, close: 101 + i,
}));
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  const query = Object.fromEntries(url.searchParams.entries());
  const method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  w.requests.push({ path: url.pathname, query, method, body });
  const path = url.pathname;
  if (path === "/api/pattern/strategies") return json({ strategies: [] });
  if (path === "/api/pattern/categories") return json({ categories: [] });
  if (path === "/api/pattern/charts") return json({ charts: w.savedCharts });
  if (path === "/api/pattern/chart/by-date") return json({ detail: "none" }, 404);
  if (path === "/api/pattern/chart/c9") return json(w.savedCharts[0]);
  if (path === "/api/pattern/chart" && method === "POST") {
    const chart = { chart_id: "c1", user_id: "owner", annotations: [], notes: "", ...body };
    w.savedCharts = [chart];
    return json(chart);
  }
  if (path === "/api/pattern/ohlc/equity") return json({ symbol: query.symbol, candles });
  if (path === "/api/pattern/ohlc/options") return json({ symbol: query.symbol, strike: Number(query.strike), candles });
  if (path === "/api/data/price-at") return json({ symbol: query.symbol, date: query.date, time: query.time, price: 24512 });
  if (path === "/api/data/expiry") return json({ symbol: query.symbol, date: query.date, expiry: "2026-10-20" });
  if (path === "/api/data/options/find-strike-by-price") {
    if (w.failFindStrike) return json({ detail: "No observed premium at or below the cap within 30 strikes" }, 404);
    return json({ strike: query.right === "CE" ? 24650 : 24350, price: 50, symbol: query.symbol, date: query.date, right: query.right });
  }
  return json({});
};
createRoot(document.getElementById("test-root")!).render(<PatternLibrary />);
