import React from "react";
import { createRoot } from "react-dom/client";
import Results from "../../../shared/deepdive/ui/Results";
import StatsPanel from "../../../shared/deepdive/ui/StatsPanel";
import { DeepDiveHostProvider } from "../../../shared/deepdive/ui/host";
import { toDiveSetup, withSetups } from "../../../shared/deepdive/model";

// The Group view of Deep Dive Results and of the label popups, on a fixed set of days (A = Second leg, B = Exhaustive bar).
const w = window as any;
w.opened = [] as string[];
const tag = (tag_id: string, name: string) => ({ tag_id, name, status: "active", sort_order: 0, created_at: "", archived_at: null });
const tags = [tag("a", "Second leg"), tag("b", "Exhaustive bar")];
const day = (date: string, side: string, tag_values: Record<string, boolean>) => ({ category: "Breakout", strategy: "ORB", symbol: "NIFTY", date, side, strike_ce: null, strike_pe: null,
  strike_mode: null, interval_minutes: 3, annotations: [], outcome: null, tag_values, notes: "", created_at: "", updated_at: "" });
const days = [
  day("2026-10-01", "buy", { a: true, b: true }), day("2026-10-02", "buy", { a: true, b: true }), day("2026-10-03", "buy", { a: true, b: false }),
  day("2026-10-04", "sell", { a: false, b: true }), day("2026-10-05", "sell", { a: false, b: false }), day("2026-10-06", "sell", { a: false }),
  day("2026-10-07", "buy", { b: true }), day("2026-10-08", "buy", { a: true, b: true }),
] as any[];
const dive = withSetups({ category: "Breakout", strategy: "ORB", owner_id: "u", can_edit: true, setups: [], tags, incomplete_days: 0, unmarked_total: 0 } as any, days.map((s) => toDiveSetup(s, tags as any)));
const host: any = { api: {}, names: {}, expiry: async () => "", resolveStrikes: async () => ({}), settings: { mode: "otm", ceCap: 0, peCap: 0, historicalDays: 2, loaded: true }, Chart: () => null };
const params = new URLSearchParams(location.search);
const block = (n: number) => ({ days: n, buy_days: 0, sell_days: 0, tags: [{ tag_id: "a", name: "Second leg", valid: 1, not_valid: 0, marked: 1, pct: 100, few_days: true }, { tag_id: "b", name: "Exhaustive bar", valid: 1, not_valid: 0, marked: 1, pct: 100, few_days: true }],
  success: 0, failed: 0, with_outcome: 0, success_pct: null, outcome_few_days: true });
const entry: any = { category: "Breakout", strategy: "ORB", owner_id: "u", shared: false, all: block(8), buy: block(5), sell: block(3),
  days: params.get("older") === "1" ? undefined : days.map(({ date, side, tag_values }) => ({ date, side, tag_values })) };
createRoot(document.getElementById("test-root")!).render(
  <DeepDiveHostProvider host={host}>
    {params.get("view") === "popup"
      ? <div style={{ width: 360, padding: 8 }}><StatsPanel entries={[entry]} category="Breakout" strategy="ORB" trade={{ right: "CE", action: "BUY" }} /></div>
      : <div style={{ padding: 12 }}><Results dive={dive} onOpenDay={(d: any) => w.opened.push(d.date + "|" + d.side)} /></div>}
  </DeepDiveHostProvider>);
