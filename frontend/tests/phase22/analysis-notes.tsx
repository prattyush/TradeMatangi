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
// `?symbols=2` adds a second symbol (an equity session) to the same date, for the day chart's tabs.
const sessions = [session("s1", "2026-10-16", { net_pnl: 500 }), ...(params.get("symbols") === "2" ? [session("s2", "2026-10-16", { symbol: "BANKNIFTY", instrument_type: "equity", strike: null, expiry: null, net_pnl: -120 })] : [])];
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
// A small in-memory /api/day-notes with the server's rules: a TODO is shown from the day it was written until it is closed.
w.noteSaves = [] as any[];
const noteStore = { notes: {} as Record<string, any>, todos: [{ todo_id: "old1", text: "Wait for the retest", created_date: "2026-10-14", history: [{ date: "2026-10-14", status: "open", at: "1" }] }] as any[] };
w.noteStore = noteStore;
const statusOn = (t: any, d: string) => [...t.history].sort((a: any, b: any) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).filter((h: any) => h.date <= d).pop()?.status;
const dayView = (d: string) => ({ date: d, note: noteStore.notes[d] ?? null, todos: noteStore.todos.filter((t) => t.created_date <= d && (["open", "working"].includes(statusOn(t, d)) || t.history.some((h: any) => h.date === d && ["done", "improved"].includes(h.status))))
  .map((t) => ({ todo_id: t.todo_id, text: t.text, created_date: t.created_date, status: statusOn(t, d), history: t.history, carried: t.created_date < d })) });
let tick = 10;
function notes(path: string, options: any, url: URL) {
  const body = options.body ? JSON.parse(options.body) : {};
  const method = (options.method || "GET").toUpperCase();
  if (path === "/api/day-notes" && method === "GET") return json(dayView(url.searchParams.get("date")!));
  if (path === "/api/day-notes" && method === "POST") {
    w.noteSaves.push(body);
    const { date, ...parts } = body;
    if (Object.values(parts).some((v: any) => String(v).trim())) noteStore.notes[date] = { date, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, String(v).trim()])), updated_at: "now" }; else delete noteStore.notes[date];
    return json(dayView(date));
  }
  if (path === "/api/day-notes/todos" && method === "GET") return json({ todos: noteStore.todos.map((t) => ({ ...t, status: t.history[t.history.length - 1].status })) });
  if (path === "/api/day-notes/todos" && method === "POST") {
    noteStore.todos.push({ todo_id: "t" + ++tick, text: body.text, created_date: body.date, history: [{ date: body.date, status: "open", at: String(tick) }] });
    return json(dayView(body.date));
  }
  if (path === "/api/day-notes/todos/status") {
    const t = noteStore.todos.find((x) => x.todo_id === body.todo_id)!;
    t.history = [...t.history.filter((h: any) => h.date !== body.date), { date: body.date, status: body.status, at: String(++tick) }];
    return json(dayView(body.date));
  }
  if (path === "/api/day-notes/todos" && method === "DELETE") {
    noteStore.todos = noteStore.todos.filter((x) => x.todo_id !== url.searchParams.get("todo_id"));
    return json(dayView(url.searchParams.get("date")!));
  }
  return json({ detail: "unhandled" }, 404);
}
// The day score: `?score=` picks what the server says (scored, estimated limit with partial candles, pending labels, none stored).
const scoreMode = params.get("score") ?? "scored";
w.scoreReads = [] as any[]; w.scoreModes = [] as any[]; w.scoreRanges = [] as string[];
const item = (key: string, title: string, points: number, detail: string, count: number | null = null) => ({ key, title, points, detail, count });
const dayScore = () => scoreMode === "pending" ? { date: "2026-10-16", status: "pending_labels", score: null, closed: 4, labelled: 3, sessions: 1 }
  : { date: "2026-10-16", status: "scored", score: scoreMode === "estimated" ? 41 : 72, closed: 4, labelled: 4, sessions: 1, base: 60, capital: 100000,
    limit_pct: scoreMode === "estimated" ? 12 : 10, limit_source: scoreMode === "estimated" ? "estimated" : "saved",
    drawdown: { worst: -6200, worst_pct: 6.2, limit_ratio: 0.52, at: 1, missing_contracts: scoreMode === "estimated" ? 1 : 0, open_cycles: 0, partial: scoreMode === "estimated" },
    items: [item("drawdown", "Drawdown against the guardrail limit", -8, "The day's total P&L reached -6.2% of capital"), item("repeat_entry", "Repeat entries after a loss", 0, "None", 0),
      item("add_to_loser", "Adding to a loser", 0, "None", 0), item("clean_day", "Closed P&L never negative", 15, "The running closed P&L never went below zero over 4 trades"),
      item("big_loss_wipes_gains", "One loss wiped out three or more wins", scoreMode === "estimated" ? -22 : 0, "None", 0)] };
const original = window.fetch.bind(window);
window.fetch = async (input: any, options: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.origin);
  if (!url.pathname.startsWith("/api/")) return original(input, options);
  w.requests.push(url.pathname + url.search);
  const path = url.pathname;
  if (path === "/api/analysis/sessions") return json(sessions);
  if (path === "/api/analysis/sessions/s1") return json({ ...sessions[0], trades, orders: [], cycles: [] });
  if (path === "/api/analysis/sessions/s2") return json({ ...sessions[1], trades: [leg("b1", "BUY", 3, { session_id: "s2", symbol: "BANKNIFTY" }), leg("b2", "SELL", 9, { session_id: "s2", symbol: "BANKNIFTY" })], orders: [], cycles: [] });
  if (path === "/api/analysis/round-trips") return json(trips);
  if (path === "/api/pattern/ohlc/equity") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/pattern/ohlc/options") return json({ symbol: url.searchParams.get("symbol"), candles });
  if (path === "/api/data/historical") return json({ symbol: "NIFTY", dates: [], candles });
  if (path === "/api/data/pre-session") return json({ candles });
  if (path === "/api/analysis/labels") return json([]);
  if (path === "/api/whatif" || path === "/api/whatif/range") return json({ scenarios: [] });
  if (path.startsWith("/api/day-notes")) return notes(path, options, url);
  if (path === "/api/analysis/day-scores") { w.scoreRanges.push(url.search); return json({ scores: scoreMode === "none" ? [] : [{ date: "2026-10-16", mode: "sim", score: 68, limit_source: "saved", partial: false, computed_at: "t" }], pending: 0 }); }
  // The symbols catalogue and the drawings service (the charts look the instrument up, then read and write their drawings).
  if (path === "/api/data/symbols") return json({ symbols: [{ symbol: "NIFTY", chart_type: "index" }, { symbol: "BANKNIFTY", chart_type: "index" }] });
  if (path === "/api/desktop/v1/chart-settings") return json({ settings: {} });
  if (path === "/api/desktop/v1/drawings") return json({ drawing_id: "d1", revision: 1, drawing: JSON.parse(options.body ?? "{}").drawing });
  if (path.startsWith("/api/desktop/v1/drawings")) return json({ version: 1, drawings: [] });
  if (path === "/api/analysis/day-score") { w.scoreReads.push(url.searchParams.get("date")); w.scoreModes.push(url.searchParams.get("mode")); return json({ ...dayScore(), mode: url.searchParams.get("mode") }); }
  return json({});
};
createRoot(document.getElementById("test-root")!).render(
  <div style={{ height: "100vh" }}><TradeAnalysis onClose={() => undefined} /></div>);
