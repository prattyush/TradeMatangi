import React from "react";
import { createRoot } from "react-dom/client";
import TradeAnalysis from "../../src/components/TradeAnalysis";
import { analysisRendererCacheKey } from "../../src/services/analysisRendererPreference";

// The website's Analysis modal with a mocked backend: one ordinary replay, one practice run with trades and one practice run with none.
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
const practice = { category: "Breakout", strategy: "Opening range" };
const sessions = [
  session("normal1", "2026-10-16", { net_pnl: 500 }),
  session("practice1", "2026-10-16", { net_pnl: -300, winning_round_trip_count: 0, practice }),
  session("practice2", "2026-10-14", { net_pnl: 0, trade_count: 0, round_trip_count: 0, winning_round_trip_count: 0, practice }),
];
const mk = (id: string, type: string, instrument: string, time: number, price: number) => ({ id, time, price, type, instrument, strategy_name: "Opening range", category: "Breakout", text: "" });
const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
const review = (negative: boolean) => ({ session_id: negative ? "practice2" : "practice1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: negative ? "2026-10-14" : "2026-10-16", start_time: "09:33:00", start_offset_min: 12, negative,
  setups: negative ? [] : [{ side: "buy", interval_minutes: 3, outcome: "success", strength: "ideal", strike_ce: 24500, strike_pe: null,
    recorded: { entry: { time: base + 1800, clock: clock(base + 1800), price: 100, instrument: "underlying" }, exit: { time: base + 4500, clock: clock(base + 4500), price: 112, instrument: "underlying" }, marks: [] },
    annotations: [mk("a1", "entry", "underlying", base + 1800, 100)],
    theoretical: [{ instrument: "underlying", strike: null, expiry: null, entry: { time: base + 1800, clock: clock(base + 1800), price: 100 }, exit: { time: base + 4500, clock: clock(base + 4500), price: 112 }, points: 12, pct: 12 }],
    trades: [{ index: 0, instrument: "CE", right: "CE", strike: 24500, expiry: "2026-10-20", action: "BUY", side: "buy", state: "closed", quantity: 75, pnl: -300, pnl_pct: -0.3, entry: { time: base + 2160 + 20, price: 55 }, exit: { time: base + 4140 + 5, price: 51 },
      points: -4, entry_delta_min: 6, exit_delta_min: -6, capture_pct: null, theoretical_points: 12, theoretical_rupees: 900 }] }],
  other_trades: [], summary: { traded: !negative, negative, correct: negative } });
const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  w.requests.push(url.pathname + url.search);
  const path = url.pathname;
  if (path === "/api/analysis/sessions") return json(sessions);
  if (path === "/api/deep-dive/practice/evaluate") {
    if (params.get("running") === "1") return json({ detail: "Stop the session first: the review shows the recorded answer" }, 409);
    return json(review(url.searchParams.get("session_id") === "practice2"));
  }
  if (path === "/api/pattern/ohlc/equity") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/pattern/ohlc/options") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/data/historical") return json({ symbol: "NIFTY", dates: [], candles });
  if (path === "/api/data/pre-session") return json({ candles });
  if (path === "/api/analysis/labels" || path === "/api/analysis/round-trips") return json([]);
  return json({});
};
createRoot(document.getElementById("test-root")!).render(
  <div style={{ height: "100vh" }}><TradeAnalysis onClose={() => undefined} /></div>);
