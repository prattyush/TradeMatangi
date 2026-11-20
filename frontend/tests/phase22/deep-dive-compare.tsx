import React from "react";
import { createRoot } from "react-dom/client";
import Compare from "../../../shared/deepdive/ui/Compare";
import { AnalysisProvider, useAnalysisEnvironment } from "../../../shared/analysis/environment";

// Compare on a stub host: two strategies, one chart stub that prints what it was given (so the test can read the strike, marks and interval).
const w = window as any;
const params = new URLSearchParams(location.search);
w.writes = [] as string[]; w.strikeCalls = [] as string[]; w.getDives = [] as string[];
const mark = (id: string, instrument: string) => ({ id, time: 1, price: 1, type: "entry", instrument, strategy_name: "x", category: "y", text: "" });
const day = (date: string, side: string, extra: any = {}) => ({ category: "Breakout", strategy: "ORB", symbol: "NIFTY", date, side, strike_ce: null, strike_pe: null, strike_mode: null,
  interval_minutes: 3, annotations: [], outcome: null, tag_values: {}, notes: "", created_at: "", updated_at: "", missing: [], complete: true, ...extra });
const dives: Record<string, any> = {
  "Breakout|ORB": { category: "Breakout", strategy: "ORB", owner_id: "me", can_edit: true, tags: [], incomplete_days: 0, unmarked_total: 0, setups: [
    day("2026-10-06", "buy", { strike_ce: 24500, strike_pe: 24400, interval_minutes: 5, annotations: [mark("a", "underlying"), mark("b", "CE"), mark("c", "CE")], outcome: "success", strength: "ideal", notes: "clean break" }),
    day("2026-10-08", "sell", { interval_minutes: 3, annotations: [mark("d", "PE")], outcome: "failed" }),
  ] },
  "Reversal|Trap": { category: "Reversal", strategy: "Trap", owner_id: "me", can_edit: true, tags: [], incomplete_days: 0, unmarked_total: 0, setups: [
    day("2026-10-09", "sell", { category: "Reversal", strategy: "Trap", interval_minutes: 15, strike_ce: 24600, strike_pe: 24500, annotations: [mark("e", "underlying")] }),
  ] },
};
const summary = (d: any) => ({ category: d.category, strategy: d.strategy, owner_id: d.owner_id, can_edit: true, days: d.setups.length, buy_days: 0, sell_days: 0, tags: 0, incomplete_days: 0 });
const api: any = new Proxy({
  listDives: async () => (params.get("empty") === "1" ? [] : Object.values(dives).map(summary)),
  getDive: async (ref: any) => { w.getDives.push(`${ref.category}|${ref.strategy}`); return JSON.parse(JSON.stringify(dives[`${ref.category}|${ref.strategy}`])); },
}, { get: (target: any, name: string) => target[name] ?? (async () => { w.writes.push(String(name)); throw new Error("Compare must not write"); }) });
const host: any = {
  api, names: {}, expiry: async () => "2026-10-13",
  resolveStrikes: async (symbol: string, date: string) => { w.strikeCalls.push(`${symbol}|${date}`); return { ce: 24700, pe: 24300, atm: 24500, expiry: "2026-10-13" }; },
  settings: { mode: "otm", ceCap: 0, peCap: 0, historicalDays: 2, loaded: true },
  Chart: (props: any) => {
    const env = useAnalysisEnvironment();
    return <div data-testid="chart" data-title={props.title}>
      <span data-testid="chart-text">{`${props.symbol} ${props.date} right=${props.right ?? "-"} strike=${props.strike ?? "-"} marks=${(props.annotations ?? []).length} interval=${env.intervalMinutes} pick=${props.pickMode ? "yes" : "no"}`}</span>
      <button onClick={() => env.setIntervalMinutes?.(10)}>Set 10m</button>
    </div>;
  },
};
const Probe = () => <span data-testid="shared-interval">{String(useAnalysisEnvironment().intervalMinutes)}</span>;
createRoot(document.getElementById("test-root")!).render(
  <AnalysisProvider value={{} as any}>
    <Probe />
    <div style={{ height: "100vh", padding: 8 }}><Compare host={host} /></div>
  </AnalysisProvider>);
