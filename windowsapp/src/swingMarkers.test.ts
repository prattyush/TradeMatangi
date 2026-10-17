import { describe, expect, it } from "vitest";
import {
  swingMarkerTrades,
  type SwingExecution,
} from "../../shared/swingMarkers";
const stamp = (date: string) => Date.parse(date + "Z") / 1000;
const pane = {
  symbol: "RELIND",
  instrument_type: "equity",
  as_of_date: "2026-10-12",
};
const fill = (
  id: string,
  side: string,
  date: string,
  quantity = 10,
  extra = {},
) =>
  ({
    trade_id: id,
    session_id: "child",
    symbol: "RELIND",
    side,
    quantity,
    price: 100,
    timestamp: stamp(date),
    ...extra,
  }) satisfies SwingExecution;
describe("Swing selected-date markers", () => {
  it("reconstructs a position closed after the selected date", () => {
    const rows = [
      fill("entry", "BUY", "2026-10-10T09:15:00"),
      fill("exit", "SELL", "2026-10-13T09:15:00"),
    ];
    expect(swingMarkerTrades(rows, pane).map((t) => t.trade_id)).toEqual([
      "entry",
    ]);
    expect(
      swingMarkerTrades(rows, { ...pane, as_of_date: "2026-10-13" }),
    ).toEqual([]);
  });
  it("keeps partial exits in the open cycle and excludes earlier flat cycles", () => {
    const rows = [
      fill("old", "BUY", "2026-10-09T09:15:00"),
      fill("old-exit", "SELL", "2026-10-09T10:15:00"),
      fill("new", "BUY", "2026-10-10T09:15:00"),
      fill("partial", "SELL", "2026-10-12T15:29:00", 5),
    ];
    expect(swingMarkerTrades(rows, pane).map((t) => t.trade_id)).toEqual([
      "new",
      "partial",
    ]);
    expect(swingMarkerTrades(rows, pane, "all")).toHaveLength(4);
    expect(swingMarkerTrades(rows, pane, "off")).toEqual([]);
  });
  it("includes the whole selected day but excludes next midnight", () => {
    const rows = [
      fill("last", "BUY", "2026-10-12T23:59:59"),
      fill("next", "BUY", "2026-10-13T00:00:00"),
    ];
    expect(swingMarkerTrades(rows, pane, "all").map((t) => t.trade_id)).toEqual(
      ["last"],
    );
  });
  it("isolates exact contracts and never invents underlying prices", () => {
    const option = { right: "CE", strike: 100, expiry: "2026-10-27" };
    const rows = [
      fill("ce", "BUY", "2026-10-12T09:15:00", 10, option),
      fill("pe", "BUY", "2026-10-12T09:15:00", 10, {
        ...option,
        right: "PE",
        underlying_price: 110,
      }),
      fill("nov", "BUY", "2026-10-12T09:15:00", 10, {
        ...option,
        expiry: "2026-11-24",
      }),
      fill("other", "BUY", "2026-10-12T09:15:00", 10, { symbol: "NIFTY" }),
    ];
    expect(
      swingMarkerTrades(
        rows,
        { ...pane, instrument_type: "options", ...option },
        "all",
      ).map((t) => t.trade_id),
    ).toEqual(["ce"]);
    expect(swingMarkerTrades(rows, pane, "all").map((t) => t.trade_id)).toEqual(
      ["pe"],
    );
  });
  it("handles short positions and rejects bad fills/dates", () => {
    const rows = [
      fill("short", "SELL", "2026-10-12T09:15:00"),
      fill("partial", "BUY", "2026-10-12T09:16:00", 5),
      fill("bad", "BUY", "2026-10-12T09:17:00", NaN),
    ];
    expect(swingMarkerTrades(rows, pane).map((t) => t.trade_id)).toEqual([
      "short",
      "partial",
    ]);
    expect(swingMarkerTrades(rows, { ...pane, as_of_date: "bad" })).toEqual([]);
  });
});

it("uses imported inventory only as cycle evidence, never as an execution marker", () => {
  const rows = [
    fill("partial", "SELL", "2026-10-12T09:16:00", 5),
    fill("close", "SELL", "2026-10-13T09:16:00", 5),
  ];
  const basis = [
    {
      session_id: "child",
      symbol: "RELIND",
      instrument_type: "equity",
      quantity: 10,
      timestamp: stamp("2026-10-11T09:15:00"),
    },
  ];
  expect(
    swingMarkerTrades(rows, pane, "open", basis).map((t) => t.trade_id),
  ).toEqual(["partial"]);
  expect(
    swingMarkerTrades(
      rows,
      { ...pane, as_of_date: "2026-10-13" },
      "open",
      basis,
    ),
  ).toEqual([]);
  expect(
    swingMarkerTrades(rows, pane, "all", basis).map((t) => t.trade_id),
  ).toEqual(["partial"]);
});
