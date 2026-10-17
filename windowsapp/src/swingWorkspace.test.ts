import { describe, expect, it } from "vitest";
import {
  mergeSwingQuote,
  paneKey,
  swingBucket,
  type SwingCandle,
} from "../../shared/SwingWorkspace";

const time = (clock: string) => Date.parse(`2026-10-12T${clock}Z`) / 1000;
const candle: SwingCandle = {
  time: time("09:15:00"),
  timestamp: time("09:15:00"),
  open: 100,
  high: 115,
  low: 95,
  close: 110,
  volume: 100,
};

describe("Swing chart continuity", () => {
  it("uses the same session anchor as backend history, including hourly candles", () => {
    expect(swingBucket(time("10:00:00"), "1h")).toBe(time("09:15:00"));
    expect(swingBucket(time("10:16:00"), "1h")).toBe(time("10:15:00"));
    expect(swingBucket(time("15:29:59"), "3m")).toBe(
      Math.floor(time("15:29:59") / 180) * 180,
    );
    expect(swingBucket(time("15:29:59"), "1D")).toBe(time("00:00:00"));
  });

  it("retains historical extremes when the live viewer starts partway through a candle", () => {
    const result = mergeSwingQuote(
      [candle],
      {
        instrument: {},
        time: time("09:15:30"),
        close: 112,
        high: 112,
        low: 112,
      },
      "1m",
    );
    expect(result[0]).toEqual({ ...candle, close: 112 });
    expect(candle.close).toBe(110);
  });

  it("uses retained viewer extremes rather than just the latest second", () => {
    const result = mergeSwingQuote(
      [candle],
      {
        instrument: {},
        time: time("09:15:30"),
        close: 111,
        candles: {
          "1m": {
            time: candle.time,
            open: 101,
            high: 120,
            low: 90,
            close: 111,
          },
        },
      },
      "1m",
    );
    expect(result[0]).toEqual({ ...candle, high: 120, low: 90, close: 111 });
  });

  it("does not backfill stale quotes into later history or create zero-price bars", () => {
    expect(
      mergeSwingQuote(
        [candle],
        { instrument: {}, time: time("09:14:59"), close: 100 },
        "1m",
      ),
    ).toEqual([candle]);
    expect(
      mergeSwingQuote(
        [candle],
        { instrument: {}, time: time("09:16:00"), close: 0 },
        "1m",
      ),
    ).toEqual([candle]);
  });

  it("keeps exact fractional option contracts separate", () => {
    const pane = {
      symbol: "CANBK",
      instrument_type: "options" as const,
      right: "CE",
      strike: 125.5,
      expiry: "2026-10-27",
      interval: "15m" as const,
      as_of_date: "2026-10-12",
    };
    expect(paneKey(pane)).not.toBe(paneKey({ ...pane, strike: 125 }));
    expect(paneKey(pane)).not.toBe(paneKey({ ...pane, right: "PE" }));
    expect(paneKey(pane)).not.toBe(paneKey({ ...pane, expiry: "2026-11-24" }));
  });
});
