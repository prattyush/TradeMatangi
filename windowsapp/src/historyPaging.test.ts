import { describe, expect, it } from "vitest";
import {
  BoundedHistoryCache,
  browseCandles,
  browseHistoryPath,
  browseHorizonDays,
  historyLowerBound,
  mergeHistory,
} from "./historyPaging";
const candle = (date: string, close = 1) => ({
  timestamp: Date.parse(`${date}T09:15:00Z`) / 1000,
  open: 1,
  high: 2,
  low: 0,
  close,
});
describe("calendar-bounded underlying history", () => {
  it("keeps 14 calendar dates, not 14 trading dates", () => {
    expect(
      new Date(historyLowerBound("2026-10-06") * 1000)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-09-23");
    expect(
      mergeHistory(
        [candle("2026-09-22"), candle("2026-09-23")],
        [candle("2026-10-06")],
        "2026-10-06",
      ),
    ).toHaveLength(2);
  });
  it("preserves current live candle on overlap", () => {
    const rows = mergeHistory(
      [candle("2026-10-05"), candle("2026-10-06", 1)],
      [candle("2026-10-06", 9)],
      "2026-10-06",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].close).toBe(9);
  });
  it("bounds cached entries and aggregate candles and removes failures", async () => {
    const cache = new BoundedHistoryCache(2, 3);
    cache.set(
      "a",
      Promise.resolve([candle("2026-10-01"), candle("2026-10-02")]),
    );
    cache.set(
      "b",
      Promise.resolve([candle("2026-10-03"), candle("2026-10-04")]),
    );
    await Promise.resolve();
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    cache.set("bad", Promise.reject(new Error("unavailable")));
    await Promise.resolve();
    expect(cache.get("bad")).toBeUndefined();
  });
});

describe("Browse scroll-back to a year", () => {
  it("keeps the interval's horizon, not 14 days", () => {
    expect(browseHorizonDays(1)).toBe(90);
    expect(browseHorizonDays(3)).toBe(365);
    expect(browseHorizonDays(15)).toBe(550);
    expect(browseHorizonDays(7)).toBe(365);
    const rows = mergeHistory([candle("2025-11-10"), candle("2025-10-01")], [candle("2026-11-09")], "2026-11-09", 365);
    expect(rows.map((c) => new Date(c.timestamp * 1000).toISOString().slice(0, 10))).toEqual(["2025-11-10", "2026-11-09"]);
    // The existing 13-day behaviour is the default.
    expect(mergeHistory([candle("2026-09-01")], [candle("2026-10-06")], "2026-10-06")).toHaveLength(1);
  });

  it("asks the paged route for the days before the oldest candle held", () => {
    expect(browseHistoryPath("NIFTY", 3, "2026-11-09", 1794401700)).toBe("browse/history?symbol=NIFTY&interval=3&date=2026-11-09&before=1794401700");
  });

  it("turns a page into tile candles, using time when timestamp is absent", () => {
    const rows = browseCandles({ candles: [{ time: 100, open: 1, high: 2, low: 0, close: 1, volume: 5 }, { time: 160, timestamp: 161, open: 1, high: 2, low: 0, close: 1 }], more: true, before: 100, oldest_date: "2026-11-09" });
    expect(rows.map((c) => c.timestamp)).toEqual([100, 161]);
    expect(rows[0].volume).toBe(5);
  });
});
