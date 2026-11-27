import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useBrowseCandles } from "../../src/components/browse/useBrowseCandles";
import type { BrowsePane } from "../../src/services/browseWorkspace";

// The data hook of the website's Browse with a mocked backend: first load of a pane (the day and two before) and scroll-back pages.
// `probe.data` is what the chart would be given in the latest render; `probe.setInterval(n)` is the interval buttons.
const w = window as any;
localStorage.setItem("auth_user", JSON.stringify({ userId: "owner" }));
w.requests = [] as string[];
const FIRST_DELAY = Number(new URLSearchParams(location.search).get("delay") ?? 150);

const stamp = (date: string, minutes: number) => Date.parse(`${date}T09:15:00Z`) / 1000 + minutes * 60;
const day = (date: string, interval: number) => [0, 1, 2].map(k => ({ time: stamp(date, k * interval), open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const dates = (from: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10)).reverse();
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  w.requests.push(url);
  const query = new URL(url, location.origin).searchParams;
  if (url.includes("/api/data/historical")) {
    await sleep(FIRST_DELAY);
    const interval = Number(query.get("interval_minutes"));
    return json({ symbol: "NIFTY", dates: ["2026-11-18", "2026-11-19"], candles: ["2026-11-18", "2026-11-19"].flatMap(date => day(date, interval)) });
  }
  if (url.includes("/api/data/pre-session")) return json({ candles: day("2026-11-20", Number(query.get("interval_minutes"))) });
  if (url.includes("/browse/history")) {
    const interval = Number(query.get("interval"));
    const before = Number(query.get("before"));
    const lastDay = new Date((before - 86400) * 1000).toISOString().slice(0, 10); // the day before the cursor's day
    const candles = dates(lastDay, 3).flatMap(date => day(date, interval)).filter(row => row.time < before);
    return json({ candles, more: true });
  }
  return json({});
}) as typeof fetch;

function Probe() {
  const [interval, setInterval] = useState(3);
  const pane: BrowsePane = { id: 1, symbol: "NIFTY", kind: "spot", date: "2026-11-20", expiry: null, strike: null, pick: { mode: "manual", cap: null }, interval };
  const data = useBrowseCandles(pane, interval, true);
  w.probe = { data, interval, setInterval };
  return <div data-testid="state">{interval}m · {data.loading ? "loading" : "ready"} · {data.candles.length} candles</div>;
}

createRoot(document.getElementById("test-root")!).render(<Probe />);
