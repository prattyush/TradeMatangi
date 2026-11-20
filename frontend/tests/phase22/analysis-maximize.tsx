import React from "react";
import { createRoot } from "react-dom/client";
import TradeAnalysis from "../../src/components/TradeAnalysis";
import api from "../../src/services/api";
import { analysisRendererCacheKey } from "../../src/services/analysisRendererPreference";

// The website's Analysis modal with a mocked backend: one ordinary replay day with two round trips (one on an option), for the day card's one Maximize.
const w = window as any;
const params = new URLSearchParams(location.search);
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
localStorage.setItem(analysisRendererCacheKey(), params.get("renderer") === "kline" ? "kline" : "lightweight");
w.requests = [] as string[];
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
const candles = Array.from({ length: 80 }, (_, i) => ({ time: base + i * 180, open: 100 + i, high: 104 + i, low: 97 + i, close: 101 + i }));
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const session = (id: string, date: string, extra: any = {}) => ({ session_id: id, user_id: "owner", symbol: "NIFTY", date, start_time: "09:30:00", instrument_type: "options", session_type: "sim",
  strike: 24500, expiry: "2026-10-20", session_capital: 100000, net_pnl: 0, pnl_pct: 0, realized_pnl: 0, open_entry_fees: 0, open_quantity: 0, total_commission: 10,
  trade_count: 2, round_trip_count: 1, winning_round_trip_count: 1, buy_count: 1, sell_count: 1, ...extra });
const sessions = [session("s1", "2026-10-16", { net_pnl: 500 })];
const leg = (trade_id: string, side: string, t: number, extra: any = {}) => ({ trade_id, side, quantity: 65, price: 100 + t, timestamp: base + t * 180, session_id: "s1", user_id: "owner", symbol: "NIFTY", instrument_type: extra.right ? "options" : "equity", right: null, strike: null, expiry: null, commission: 1, ...extra });
const ce = { right: "CE", strike: 24500, expiry: "2026-10-20" };
const trades = [leg("t1", "BUY", 2), leg("t2", "SELL", 5), leg("t3", "BUY", 10, ce), leg("t4", "SELL", 14, ce)];
const trips = [
  { index: 0, right: null, pnl: 120, pnl_pct: 0.12, max_capital_pct: 1.5, entry_trades: [trades[0]], exit_trades: [trades[1]] },
  { index: 1, right: "CE", pnl: -45, pnl_pct: -0.05, max_capital_pct: 3, entry_trades: [trades[2]], exit_trades: [trades[3]] },
];
// The label form's lists (the tabs read them through the api object).
const stub = api as any;
stub.patternListStrategies = async () => ({ strategies: ["Breakout"] });
stub.patternListCategories = async () => ({ categories: ["Momentum"] });
stub.getEntryTags = async () => ["AS_PER_PATTERN"];
stub.getExitTags = async () => ["AS_PER_PATTERN"];
stub.getBehaviorQuestions = async () => [];
stub.getBehaviorMarks = async () => [];
stub.getDeepDiveStats = async () => ({ strategies: [] });
const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  w.requests.push(url.pathname + url.search);
  const path = url.pathname;
  if (path === "/api/analysis/sessions") return json(sessions);
  if (path === "/api/analysis/sessions/s1") return json({ ...sessions[0], trades, orders: [], cycles: [] });
  if (path === "/api/analysis/round-trips") return json(trips);
  if (path === "/api/pattern/ohlc/equity") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/pattern/ohlc/options") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/data/historical") return json({ symbol: "NIFTY", dates: [], candles });
  if (path === "/api/data/pre-session") return json({ candles });
  if (path === "/api/analysis/labels") return json([]);
  if (path === "/api/whatif" || path === "/api/whatif/range") return json({ scenarios: [] });
  return json({});
};
createRoot(document.getElementById("test-root")!).render(
  <div style={{ height: "100vh" }}><TradeAnalysis onClose={() => undefined} /></div>);
