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
    // what the server does: a grade makes the day a success, and a failed or cleared day has no grade
    if (fields.strength) s.outcome = "success";
    else if ("outcome" in fields && fields.outcome !== "success") delete s.strength;
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
  const renamed = /^tags\/(\w+)\/update$/.exec(path);
  if (renamed) {
    const t = store.tags.find((x) => x.tag_id === renamed[1]);
    if (store.tags.some((x) => x.status === "active" && x.tag_id !== t.tag_id && x.name.toLowerCase() === String(body.name).trim().toLowerCase())) throw new Error("An active tag with this name already exists");
    t.name = String(body.name).trim();
    w.renames = [...(w.renames ?? []), t.name];
    return t;
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

// ── Strategy Practice (S15): stub routes, and a host that records the starts the page asks for ──
w.practicePicks = [] as any[];
w.practiceStarts = [] as any[];
const practiceStrategies = [{ category: "Breakout", strategy: "Opening range", days: 3, grades: { ideal: 1, average: 0, poor: 0, ungraded: 1, failed: 1, open: 0 }, symbols: [{ symbol: "BSESEN", days: 1 }, { symbol: "NIFTY", days: 2 }], negative_days: [{ symbol: "NIFTY", days: 6 }] }];
const practicePlan = { symbol: "NIFTY", date: "2026-10-16", start_time: "09:33:00", interval_minutes: 3, instrument_type: "options", strike_ce: 24500, strike_pe: 24400, expiry: "2026-10-20",
  practice: { category: "Breakout", strategy: "Opening range", start_offset_min: 12 }, days_available: 2, repeated: params.get("repeated") === "1" };
const at = (minutes: number) => base + minutes * 60; // minutes after 09:15
const mk = (id: string, type: string, instrument: string, time: number, price: number) => ({ id, time, price, type, instrument, strategy_name: "Opening range", category: "Breakout", text: "" });
const clockOf = (time: number) => new Date(time * 1000).toISOString().slice(11, 16);
const recorded = { entry: { time: at(30), clock: clockOf(at(30)), price: 100, instrument: "underlying" }, exit: { time: at(75), clock: clockOf(at(75)), price: 112, instrument: "underlying" }, marks: [] as any[] };
const trade = (index: number, extra: any = {}) => ({ index, instrument: "CE", right: "CE", strike: 24500, expiry: "2026-10-20", action: "BUY", side: "buy", state: "closed", quantity: 75, pnl: 1500, pnl_pct: 2,
  entry: { time: at(36) + 20, price: 55 }, exit: { time: at(69) + 5, price: 75 }, points: 20, entry_delta_min: 6, exit_delta_min: -6, capture_pct: 50, theoretical_points: 40, theoretical_rupees: 3000, ...extra });
const review = {
  session_id: "ended1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: "2026-10-16", start_time: "09:33:00", start_offset_min: 12,
  setups: [
    { side: "buy", interval_minutes: 3, outcome: "success", strength: "ideal", strike_ce: 24500, strike_pe: null, recorded,
      annotations: [mk("a1", "entry", "underlying", at(30), 100), mk("a2", "exit", "underlying", at(75), 112), mk("a3", "entry", "CE", at(30), 50)],
      theoretical: [
        { instrument: "underlying", strike: null, expiry: null, entry: { time: at(30), clock: clockOf(at(30)), price: 100 }, exit: { time: at(75), clock: clockOf(at(75)), price: 112 }, points: 12, pct: 12 },
        { instrument: "CE", strike: 24500, expiry: "2026-10-20", unavailable: "No price data for this instrument on that day" }],
      trades: [trade(0)] },
    { side: "sell", interval_minutes: 3, outcome: "failed", strength: null, strike_ce: null, strike_pe: 24400, recorded: { entry: null, exit: null, marks: [] },
      annotations: [], theoretical: [{ instrument: "underlying", strike: null, expiry: null, unavailable: "Needs both an Entry and an Exit mark" }], trades: [] }],
  other_trades: [trade(1, { action: "SELL", side: "sell", instrument: "PE", right: "PE", strike: 24400, points: -3, pnl: -225, entry_delta_min: null, exit_delta_min: null, capture_pct: null, theoretical_points: null, theoretical_rupees: null })],
  summary: { traded: true, side: "buy", entry_delta_min: 6, exit_delta_min: -6, capture_pct: 50, points: 20, theoretical_points: 40 },
};
const negativeReview = (traded: boolean) => ({ session_id: "negative1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: "2026-10-16", start_time: "09:41:00", start_offset_min: 9,
  negative: true, setups: [], other_trades: traded ? [trade(0, { points: -5, pnl: -375, entry_delta_min: null, exit_delta_min: null, capture_pct: null, theoretical_points: null, theoretical_rupees: null })] : [],
  summary: { traded, negative: true, correct: !traded, points: traded ? -5 : null } });
const practiceRuns = [
  { session_id: "running1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: "2026-10-15", start_time: "09:40:00", start_offset_min: 8, state: "running", ended: false, created_at: 2, result: null },
  { session_id: "ended1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: "2026-10-16", start_time: "09:33:00", start_offset_min: 12, state: "ended", ended: true, created_at: 1,
    result: { traded: true, side: "buy", entry_delta_min: 6, exit_delta_min: -6, capture_pct: 50, points: 20, theoretical_points: 40 } },
  { session_id: "negative1", category: "Breakout", strategy: "Opening range", symbol: "NIFTY", date: "2026-10-14", start_time: "09:41:00", start_offset_min: 9, state: "ended", ended: true, created_at: 3,
    result: { traded: false, negative: true, correct: true, points: null } }
];
function practice(path: string, body: any, query: Record<string, string>): any {
  if (path === "practice/strategies") return { strategies: practiceStrategies };
  if (path === "practice/pick") {
    w.practicePicks.push(body);
    if (params.get("pickerror")) throw new Error("No day of this strategy with an Entry mark matches your choice");
    return practicePlan;
  }
  if (path === "practice/runs") return { runs: practiceRuns };
  if (path === "practice/evaluate") {
    if (query.session_id === "running1") return json({ detail: "Stop the session first: the review shows the recorded answer" }, 409);
    if (query.session_id === "negative1") return negativeReview(false);
    if (query.session_id === "negative2") return negativeReview(true);
    return review;
  }
  throw new Error(`unknown practice route ${path}`);
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
  // ?server=old: a backend that has not got the Deep Dive or traded-pattern routes yet. ?server=down: a connection that does not get through.
  const isNew = path.startsWith("/api/deep-dive/") || path.startsWith("/api/pattern/traded");
  if (params.get("server") === "old" && isNew) return json({ detail: "Not Found" }, 404);
  if (params.get("server") === "down" && isNew) throw new TypeError("Failed to fetch");
  try {
    if (path.startsWith("/api/deep-dive/practice/")) { const out = practice(path.replace("/api/deep-dive/", ""), body, query); return out instanceof Response ? out : json(out); }
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
const practiceHost = params.get("practice") === "1" ? {
  startPractice: async (plan: any, speed: number) => { w.practiceStarts.push({ plan, speed }); if (params.get("startfail")) throw new Error(params.get("startfail") === "running" ? "A session is running on this screen. Stop it before you start a practice run." : "Could not load that day's data"); },
  blockedReason: params.get("blocked") === "1" ? "A session is running. Stop it before you start a practice run." : null,
  reviewSessionId: params.get("review"), onReviewOpened: () => { w.reviewOpened = true; },
} : undefined;
createRoot(document.getElementById("test-root")!).render(<PatternLibrary practice={practiceHost} />);
