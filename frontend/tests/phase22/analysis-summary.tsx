import React from "react";
import { createRoot } from "react-dom/client";
import TradeAnalysis from "../../src/components/TradeAnalysis";
import api from "../../src/services/api";
import { analysisRendererCacheKey } from "../../src/services/analysisRendererPreference";

// The website's Analysis page with a mocked backend and three days of trades, for the Summary: cards, the day's charts, the deck.
// `?renderer=kline`, `?fail=1` (the route answers 503), `?empty=1` (no days), `?truncated=1` (older days left out).
const w = window as any;
const params = new URLSearchParams(location.search);
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
localStorage.setItem(analysisRendererCacheKey(), params.get("renderer") === "kline" ? "kline" : "lightweight");
w.requests = [] as Array<{ method: string; url: string }>;
const base = Date.parse("2026-10-16T09:15:00Z") / 1000;
const candles = Array.from({ length: 80 }, (_, i) => ({ time: base + i * 180, open: 100 + i, high: 104 + i, low: 97 + i, close: 101 + i }));
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const session = (id: string, date: string, symbol: string) => ({ session_id: id, user_id: "owner", symbol, date, start_time: "09:30:00", instrument_type: "equity", session_type: "sim",
  strike: null, expiry: null, session_capital: 100000, net_pnl: 0, pnl_pct: 0, realized_pnl: 0, open_entry_fees: 0, open_quantity: 0, total_commission: 2,
  trade_count: 2, round_trip_count: 1, winning_round_trip_count: 1, buy_count: 1, sell_count: 1 });
const sessions = [session("s1", "2026-10-16", "NIFTY"), session("s2", "2026-10-16", "BANKNIFTY"), session("s3", "2026-10-15", "NIFTY"), session("s4", "2026-10-15", "BANKNIFTY"), session("s5", "2026-10-14", "NIFTY")];
const leg = (id: string, sessionId: string, symbol: string, side: string, t: number) => ({ trade_id: id, side, quantity: 65, price: 100 + t, timestamp: base + t * 180, session_id: sessionId, user_id: "owner", symbol, instrument_type: "equity", right: null, strike: null, expiry: null, commission: 1 });
const stub = api as any;
stub.patternListStrategies = async () => ({ strategies: [] });
stub.patternListCategories = async () => ({ categories: [] });
stub.getEntryTags = async () => [];
stub.getExitTags = async () => [];
stub.getBehaviorQuestions = async () => [];
stub.getBehaviorMarks = async () => [];
stub.getDeepDiveStats = async () => ({ strategies: [] });

const totals = (trades: number, wins: number, net: number, pct: number) => ({ trades, wins, losses: trades - wins, win_pct: trades ? (100 * wins) / trades : null, net_pnl: net, pnl_pct: pct, mean_pnl_pct: trades ? pct / trades : null, fees: 4 });
const point = (n: number, cumulative: number) => ({ time: base + n * 600, cycle_id: `c${n}`, session_id: "s1", label: `NIFTY trade ${n}`, members: [{ cycle_id: `c${n}`, session_id: "s1", label: `NIFTY trade ${n}`, delta: cumulative, delta_pct: cumulative / 1000 }], grouped: false, delta: cumulative, delta_pct: cumulative / 1000, pnl: cumulative, pnl_pct: cumulative / 1000, drawdown: 0 });
const journey = (date: string, net: number) => ({ id: `j-${date}`, date, mode: "sim", capital: 100000, sessions: 1, completed: 1, open_cycles: 0, net_pnl: net, net_pnl_pct: net / 1000, max_drawdown: 0, max_drawdown_pct: 0, points: [point(1, net)] });
const trade = (id: string, symbol: string, net: number, strategy: string | null) => ({ cycle_id: id, session_id: "s1", mode: "sim", symbol, right: null, strike: null, direction: "LONG", entry_time: base + 120, exit_time: base + 600, net_pnl: net, pnl_pct: net / 1000, strategy });
const symbol = (name: string, trades: number, net: number, ids: string[]) => ({ symbol: name, instrument_type: "equity", trades, net_pnl: net, modes: ["sim"], session_ids: ids });
const days: any[] = [
  { date: "2026-10-16", symbols: [symbol("BANKNIFTY", 1, -120, ["s2"]), symbol("NIFTY", 2, 500, ["s1"])], open_trades: 0, totals: totals(3, 2, 380, 0.38),
    strategies: [{ strategy: "Breakout", ...totals(2, 2, 500, 0.5) }, { strategy: "Unlabelled", ...totals(1, 0, -120, -0.12) }], labels: { closed: 3, labelled: 2, plan_followed: 2, plan_not_followed: 0, plan_unknown: 0 },
    best: trade("c1", "NIFTY", 400, "Breakout"), worst: trade("c3", "BANKNIFTY", -120, null), journeys: [journey("2026-10-16", 380)], scores: [{ mode: "sim", score: 68, limit_source: "saved", partial: false }],
    note: { date: "2026-10-16", context: "Gap-up open, trend day", went_well: "Waited for the retest", to_improve: "", specific_points: "", updated_at: "t" } },
  { date: "2026-10-15", symbols: [symbol("BANKNIFTY", 1, -50, ["s4"]), symbol("NIFTY", 1, 150, ["s3"])], open_trades: 1, totals: totals(2, 1, 100, 0.1),
    strategies: [{ strategy: "Reversal", ...totals(2, 1, 100, 0.1) }], labels: { closed: 2, labelled: 2, plan_followed: 1, plan_not_followed: 1, plan_unknown: 0 },
    best: trade("c4", "NIFTY", 150, "Reversal"), worst: trade("c5", "BANKNIFTY", -50, "Reversal"), journeys: [journey("2026-10-15", 100)], scores: [{ mode: "sim", score: 82, limit_source: "saved", partial: false }], note: null },
  { date: "2026-10-14", symbols: [symbol("NIFTY", 1, -90, ["s5"])], open_trades: 0, totals: totals(1, 0, -90, -0.09),
    strategies: [{ strategy: "Unlabelled", ...totals(1, 0, -90, -0.09) }], labels: { closed: 1, labelled: 0, plan_followed: 0, plan_not_followed: 0, plan_unknown: 0 },
    best: null, worst: trade("c6", "NIFTY", -90, null), journeys: [journey("2026-10-14", -90)], scores: [], note: null },
];
const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  const method = (options.method || "GET").toUpperCase();
  w.requests.push({ method, url: url.pathname + url.search });
  const path = url.pathname;
  if (path === "/api/analysis/day-summary") {
    if (params.get("fail") === "1") return json({ detail: "The day summary could not be read; retry later" }, 503);
    const wanted = url.searchParams.get("symbol");
    const found = params.get("empty") === "1" ? [] : days.filter((day) => !wanted || day.symbols.some((s: any) => s.symbol === wanted));
    return json({ days: found, total_days: params.get("truncated") === "1" ? 90 : found.length, truncated: params.get("truncated") === "1" });
  }
  if (path === "/api/analysis/sessions") return json(sessions);
  const detail = /^\/api\/analysis\/sessions\/(s\d)$/.exec(path);
  if (detail) { const found = sessions.find((s) => s.session_id === detail[1])!; return json({ ...found, trades: [leg(`${found.session_id}a`, found.session_id, found.symbol, "BUY", 2), leg(`${found.session_id}b`, found.session_id, found.symbol, "SELL", 6)], orders: [], cycles: [] }); }
  if (path === "/api/analysis/round-trips") return json([]);
  if (path === "/api/pattern/ohlc/equity" || path === "/api/pattern/ohlc/options") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/data/historical") return json({ symbol: "NIFTY", dates: [], candles });
  if (path === "/api/data/pre-session") return json({ candles });
  if (path === "/api/analysis/labels") return json([]);
  if (path === "/api/whatif" || path === "/api/whatif/range") return json({ scenarios: [] });
  if (path.startsWith("/api/day-notes")) return json({ date: "x", note: null, todos: [] });
  if (path === "/api/analysis/day-scores") return json({ scores: [], pending: 0 });
  if (path === "/api/data/symbols") return json({ symbols: [{ symbol: "NIFTY", chart_type: "index" }, { symbol: "BANKNIFTY", chart_type: "index" }] });
  if (path === "/api/desktop/v1/chart-settings") return json({ settings: {} });
  if (path === "/api/desktop/v1/browse/history") {
    const daily = Array.from({ length: 100 }, (_, i) => { const t = Date.parse("2026-07-01T00:00:00Z") / 1000 + i * 86400; return { time: t, open: 24000 + i * 5, high: 24080 + i * 5, low: 23950 + i * 5, close: 24040 + i * 5 }; });
    return json({ interval: 1440, candles: daily, more: false });
  }
  if (path === "/api/desktop/v1/drawings") return json({ drawing_id: "d1", revision: 1, drawing: JSON.parse(options.body ?? "{}").drawing });
  if (path.startsWith("/api/desktop/v1/drawings")) return json({ version: 1, drawings: [] });
  return json({});
};
createRoot(document.getElementById("test-root")!).render(
  <div style={{ height: "100vh" }}><TradeAnalysis onClose={() => undefined} /></div>);
