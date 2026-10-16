import { describe, expect, it } from "vitest";
import {
  mergeKLineHistory,
  mergeKLineTick,
} from "../../frontend/src/services/klineCandles";
import { PendingOrderEdits } from "../../shared/charts/pendingOrderEdits";
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
describe("Real order line evidence", () => {
  it("keeps solid old and requested prices after HTTP acknowledgment", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.acknowledged("session", "o1", { ...order, limit_price: 120 });
    expect(edits.get("session", "o1")).toMatchObject({
      oldPrice: 100,
      requestedPrice: 120,
      phase: "unconfirmed",
    });
  });
  it("waits until acknowledgment even if a snapshot arrives while sending", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.reconcile("session", [report()]);
    expect(edits.get("session", "o1")?.phase).toBe("sending");
  });
  it("confirms by exact broker identity and requested field, not a local echo", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.acknowledged("session", "o1");
    edits.reconcile("session", [{ ...report(), broker_order_id: "unrelated" }]);
    expect(edits.get("session", "o1")).toBeDefined();
    edits.reconcile("session", [report()]);
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("updates confirmed broker price but preserves an unresolved proposal", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.acknowledged("session", "o1");
    edits.reconcile("session", [report(105)]);
    expect(edits.get("session", "o1")).toMatchObject({
      oldPrice: 105,
      requestedPrice: 120,
    });
  });
  it.each(["filled", "complete", "cancelled", "rejected", "expired"])(
    "removes the proposal on terminal broker status %s",
    (status) => {
      const edits = new PendingOrderEdits();
      edits.begin(order, 120);
      edits.acknowledged("session", "o1");
      edits.reconcile("session", [report(100, status)]);
      expect(edits.get("session", "o1")).toBeUndefined();
    },
  );
  it("keeps ambiguous outcomes and prevents another modification", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.failed("session", "o1", false);
    expect(() => edits.begin(order, 125)).toThrow(/unconfirmed/);
    expect(edits.get("session", "o1")).toMatchObject({
      oldPrice: 100,
      requestedPrice: 120,
    });
  });
  it("clears a definitively rejected edit", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.failed("session", "o1", true);
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("does not create broker-pending presentation for a backend-only target", () => {
    const edits = new PendingOrderEdits();
    edits.begin(
      { ...order, order_type: "TARGET", broker_order_id: undefined },
      120,
    );
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("confirms a triggered target using the computed broker LIMIT price", () => {
    const edits = new PendingOrderEdits();
    edits.begin({ ...order, order_type: "TARGET", trigger_price: 102 }, 120);
    edits.acknowledged("session", "o1", {
      ...order,
      order_type: "TARGET",
      trigger_price: 120,
      limit_price: 121,
    });
    edits.reconcile("session", [report(121)]);
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("follows a broker replacement ID already handled by the existing API", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.acknowledged("session", "o1", {
      ...order,
      broker_order_id: "replacement",
      limit_price: 120,
    });
    edits.reconcile("session", [report()]);
    expect(edits.get("session", "o1")).toBeDefined();
    edits.reconcile("session", [
      { ...report(), broker_order_id: "replacement" },
    ]);
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("rejects stale and retired-generation snapshots", () => {
    const edits = new PendingOrderEdits();
    edits.reconcile("session", [], { state_version: 4, state_generation: "a" });
    edits.begin(order, 120);
    edits.acknowledged("session", "o1");
    edits.reconcile("session", [report()], {
      state_version: 3,
      state_generation: "a",
    });
    expect(edits.get("session", "o1")).toBeDefined();
    edits.reconcile("session", [report(105)], {
      state_version: 1,
      state_generation: "b",
    });
    edits.reconcile("session", [report()], {
      state_version: 5,
      state_generation: "a",
    });
    expect(edits.get("session", "o1")).toBeDefined();
    edits.reconcile("session", [report()], {
      state_version: 2,
      state_generation: "b",
    });
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("isolates sessions and clears presentation when account/server changes", () => {
    const edits = new PendingOrderEdits();
    edits.setScope("server:user");
    edits.begin(order, 120);
    edits.acknowledged("session", "o1");
    edits.reconcile("other-session", [report()]);
    expect(edits.get("session", "o1")).toBeDefined();
    edits.setScope("other-server:user");
    expect(edits.get("session", "o1")).toBeUndefined();
  });
  it("removes pending presentation after an authoritative terminal event or snapshot", () => {
    const edits = new PendingOrderEdits();
    edits.begin(order, 120);
    edits.terminal("session", "o1");
    expect(edits.get("session", "o1")).toBeUndefined();
    edits.begin(order, 120);
    edits.prune("session", []);
    expect(edits.get("session", "o1")).toBeUndefined();
  });
});

it("accepts only a verified broker mismatch without issuing another request", () => {
  const edits = new PendingOrderEdits();
  edits.begin(order, 120);
  edits.acceptBrokerPrice("session", "o1");
  expect(edits.get("session", "o1")).toBeDefined();
  edits.acknowledged("session", "o1");
  edits.acceptBrokerPrice("session", "o1");
  expect(edits.get("session", "o1")).toBeDefined();
  edits.reconcile("session", [report(105)]);
  edits.acceptBrokerPrice("session", "o1");
  expect(edits.get("session", "o1")).toBeUndefined();
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

it("confirms a stop-loss trigger independently of its accompanying broker limit", () => {
  const edits = new PendingOrderEdits();
  const stop = {
    ...order,
    order_type: "STOPLOSS",
    trigger_price: 100,
    limit_price: 99,
  };
  edits.begin(stop, 120);
  edits.acknowledged("session", "o1", {
    ...stop,
    trigger_price: 120,
    limit_price: 119,
  });
  edits.reconcile("session", [{ ...report(120), trigger_price: 110 }]);
  expect(edits.get("session", "o1")).toBeDefined();
  edits.reconcile("session", [{ ...report(119), trigger_price: 120 }]);
  expect(edits.get("session", "o1")).toBeUndefined();
});
