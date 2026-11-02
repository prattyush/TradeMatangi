import { describe, expect, it } from "vitest";
import {
  mergeKLineHistory,
  mergeKLineTick,
  sameCandles,
} from "../../frontend/src/services/klineCandles";
import { drawingIdentity } from "../../shared/charts/drawingIdentity";
import { buildTradeMarkers } from "./tradeMarkers";
const bar = { time: 180, open: 100, high: 110, low: 90, close: 105 };
const tick = (time: number, close = 106) => ({
  type: "tick" as const,
  time,
  open: 105,
  high: 111,
  low: 99,
  close,
});
const order = {
  order_id: "o1",
  session_id: "session",
  user_id: "owner",
  order_type: "LIMIT",
  limit_price: 100,
  trigger_price: 0,
  broker_order_id: "broker1",
};
const report = (price = 120, status = "open") => ({
  broker_order_id: "broker1",
  status,
  limit_price: price,
  trigger_price: 0,
});
describe("Phase 22 chart data compatibility", () => {
  it("preserves the partial candle open and extremes on the next live tick", () => {
    expect(mergeKLineTick([bar], tick(200), 3)).toEqual([
      { time: 180, open: 100, high: 111, low: 90, close: 106 },
    ]);
  });
  it("starts the next epoch-aligned 3-minute bucket without altering its predecessor", () => {
    const next = mergeKLineTick([bar], tick(360), 3);
    expect(next[0]).toBe(bar);
    expect(next[1]).toEqual({
      time: 360,
      open: 105,
      high: 111,
      low: 99,
      close: 106,
    });
  });
  it("ignores out-of-order ticks", () => {
    const rows = [bar];
    expect(mergeKLineTick(rows, tick(100), 3)).toBe(rows);
  });
  it("keeps the same reference for a duplicate tick that doesn't move the bucket", () => {
    const rows = [bar];
    const duplicate = {
      type: "tick" as const,
      time: 200,
      open: 105,
      high: 108,
      low: 95,
      close: 105,
    };
    expect(mergeKLineTick(rows, duplicate, 3)).toBe(rows);
  });
  it("still updates when a duplicate-bucket tick genuinely moves high/low/close", () => {
    const rows = [bar];
    const next = mergeKLineTick(rows, tick(200, 108), 3);
    expect(next).not.toBe(rows);
    expect(next).toEqual([{ time: 180, open: 100, high: 111, low: 90, close: 108 }]);
  });
  it("sameCandles treats identical-content arrays as equal and detects real changes", () => {
    const a = [bar, { ...bar, time: 360 }];
    const b = [bar, { ...bar, time: 360 }];
    expect(sameCandles(a, a)).toBe(true);
    expect(sameCandles(a, b)).toBe(true);
    expect(sameCandles(a, [bar])).toBe(false);
    expect(sameCandles(a, [bar, { ...bar, time: 360, close: 999 }])).toBe(false);
  });
  it("keeps refreshed history authoritative and deduplicates overlap", () => {
    expect(
      mergeKLineHistory(
        [bar, { ...bar, close: 107 }],
        [
          { ...bar, high: 999 },
          { ...bar, time: 360 },
        ],
      ),
    ).toEqual([
      { ...bar, close: 107 },
      { ...bar, time: 360 },
    ]);
  });
  it("hides future replay history but retains only the current partial candle", () => {
    expect(
      mergeKLineHistory(
        [bar, { ...bar, time: 360 }, { ...bar, time: 540 }],
        [
          { ...bar, time: 360, high: 112 },
          { ...bar, time: 540 },
        ],
        360,
      ),
    ).toEqual([bar, { ...bar, time: 360, high: 112 }]);
  });
  it("uses the same desktop/web drawing identity while keeping expiries distinct", () => {
    const instrument = {
      kind: "option",
      exchange: "NFO",
      underlying: "NIFTY",
      right: "CE",
      strike: 24000,
      expiry: "2026-10-20",
    };
    const swing = drawingIdentity(instrument, undefined, "legacy", true);
    expect(swing.writeInstrument).toEqual({ ...instrument, exchange: "NSE" });
    expect(swing.readKeys).toContain(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(instrument).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    );
    expect(
      drawingIdentity(
        { ...instrument, expiry: "2026-10-27" },
        undefined,
        undefined,
        true,
      ).readKeys[0],
    ).not.toBe(swing.readKeys[0]);
  });
  it("does not draw fills from another underlying or expiry on an option chart", () => {
    const fill = {
      trade_id: "t",
      symbol: "NIFTY",
      side: "BUY" as const,
      quantity: 50,
      price: 100,
      timestamp: 180,
      right: "CE" as const,
      strike: 24000,
      expiry: "2026-10-20",
    };
    expect(
      buildTradeMarkers(
        [
          fill,
          { ...fill, trade_id: "other-symbol", symbol: "CNXBAN" },
          { ...fill, trade_id: "other-expiry", expiry: "2026-10-27" },
        ],
        {
          kind: "option",
          underlying: "NIFTY",
          right: "CE",
          strike: 24000,
          expiry: "2026-10-20",
        },
        180,
      ).map((m) => m.id),
    ).toEqual(["t"]);
  });
});
it("restores a cursor-bounded partial candle without discarding later buffered extremes", () => {
  const bounded = {
    ...bar,
    time: 360,
    open: 100,
    high: 120,
    low: 90,
    close: 110,
  };
  const retained = { ...bounded, open: 115, high: 125, low: 95, close: 121 };
  expect(mergeKLineHistory([bar, bounded], [retained], 360, 360)).toEqual([
    bar,
    { ...bounded, high: 125, close: 121 },
  ]);
  // A delayed response must not overwrite the close of a bar completed meanwhile.
  expect(
    mergeKLineHistory(
      [bar, bounded],
      [retained, { ...bar, time: 540 }],
      540,
      360,
    )[1],
  ).toEqual({ ...bounded, high: 125, close: 121 });
});
