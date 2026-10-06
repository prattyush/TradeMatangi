import { describe, expect, it } from "vitest";
import {
  BoundedHistoryCache,
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
