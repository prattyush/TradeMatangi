import { describe, expect, it } from "vitest";
import { canonicalDrawingKey, drawingIdentity } from "./drawingIdentity";

describe("Day/Swing drawing namespaces", () => {
  it.each([
    ["NFO", "NSE"],
    ["BFO", "BSE"],
  ])(
    "shares %s option drawings with Day without changing the feed venue",
    (feed, day) => {
      const instrument = {
        kind: "option",
        exchange: feed,
        underlying: "NIFTY",
        expiry: "2026-10-27",
        strike: 22000,
        right: "CE",
      };
      const identity = drawingIdentity(
        instrument,
        undefined,
        "swing:p:window",
        true,
      );
      expect(identity.writeInstrument).toEqual({
        ...instrument,
        exchange: day,
      });
      expect(identity.readKeys).toEqual([
        canonicalDrawingKey({ ...instrument, exchange: day }),
        canonicalDrawingKey(instrument),
        canonicalDrawingKey({ ...instrument, drawing_scope: "swing:p:window" }),
      ]);
      expect(instrument.exchange).toBe(feed);
    },
  );
  it("preserves Day keys and keeps Futures distinct from options", () => {
    const day = {
      kind: "option",
      exchange: "NSE",
      underlying: "NIFTY",
      expiry: "2026-10-27",
      strike: 22000,
      right: "CE",
    };
    expect(drawingIdentity(day).readKeys).toEqual([canonicalDrawingKey(day)]);
    const future = {
      kind: "future",
      exchange: "NFO",
      underlying: "NIFTY",
      expiry: "2026-10-27",
    };
    expect(
      drawingIdentity(future, undefined, undefined, true).writeInstrument,
    ).toEqual(future);
  });
});

it("reads unscoped legacy Swing records from a canonical Day key without changing new writes", () => {
  const day = {
    kind: "option",
    exchange: "NSE",
    underlying: "NIFTY",
    right: "CE",
    strike: 24000,
    expiry: "2026-10-20",
  };
  const result = drawingIdentity(day, undefined, undefined, true);
  expect(result.writeInstrument).toEqual(day);
  expect(result.readKeys).toContain(
    canonicalDrawingKey({ ...day, exchange: "NFO" }),
  );
  expect(result.readKeys.every((key) => !key.includes("drawing_scope"))).toBe(
    true,
  );
});
