import React from "react";
import { createRoot } from "react-dom/client";
import DayPathBehavior from "../../../shared/analysis/DayPathBehavior";
import { AnalysisProvider } from "../../../shared/analysis/environment";

// The Stats > Behavior day-path section with a fake day-score source: one stored day, the rest scored in rounds.
const w = window as any;
const params = new URLSearchParams(location.search);
w.rangeCalls = [] as any[];
const dates = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
const bucket = { entries: 0, median_allocation: null, median_risk: null };
const path = (date: string, i: number) => ({ id: `p${i}`, user_id: "u", date, mode: "paper", execution_broker: null, broker_account_id: null, completed: 1, net_pnl: 100, net_pnl_pct: 1,
  max_drawdown: 10, max_drawdown_pct: 0.1, downward: 0, downward_pct: 0, giveback: 0, giveback_pct: 0, sizing: { down: bucket, up: bucket, flat: bucket, unknown: bucket },
  sizing_ratio: { allocation: null, risk: null }, capital: 100000, sessions: 1, points: [], open_cycles: 0 });
const paths = dates.map(path);
const scoreOf: Record<string, number> = { "2026-11-10": 55, "2026-11-11": 62, "2026-11-13": 80, "2026-11-16": 91 }; // 11-12 is not scorable yet
let round = 0;
const dayScore = {
  day: async () => { throw new Error("not used"); },
  range: async (start?: string, end?: string, compute?: boolean) => {
    w.rangeCalls.push({ start, end, compute });
    if (params.get("fail") === "1") throw new Error("scores are down");
    round += 1;
    const known = Object.entries(scoreOf).filter(([d]) => compute ? (params.get("rounds") === "2" ? (round >= 2 || d <= "2026-11-11") : true) : false);
    return { scores: known.map(([date, score]) => ({ date, score, limit_source: "saved", partial: false, computed_at: "t" })), pending: params.get("rounds") === "2" && round < 2 ? 2 : 0 };
  },
};
createRoot(document.getElementById("test-root")!).render(
  <AnalysisProvider value={(params.get("nosource") === "1" ? {} : { dayScore }) as any}>
    <div style={{ padding: 12, width: 900 }}><DayPathBehavior paths={paths as any} onSelect={() => undefined} /></div>
  </AnalysisProvider>);
