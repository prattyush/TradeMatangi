import { describe, it, expect } from "vitest";
import { pinnedSwingPortfolio, updateDayScreens } from "./swingScreens";
import { buildTradeMarkers } from "./tradeMarkers";
import type { DesktopTrade } from "./contracts";
describe("Swing screen separation", () => {
  const day = { id: "day", saved: {} },
    linked = {
      id: "linked",
      saved: { workspace_kind: "swing", portfolio_id: "book-one" },
    };
  it("keeps Swing companions when the last Day screen is deleted", () =>
    expect(updateDayScreens([day, linked], [])).toEqual([linked]));
  it("applies Day edits without converting companions into execution screens", () =>
    expect(
      updateDayScreens([day, linked], (rows) =>
        rows.map((row) => ({ ...row, id: "updated" })),
      ),
    ).toEqual([{ ...day, id: "updated" }, linked]));
  it("never resolves an unpinned linked window to an active replacement portfolio", () => {
    expect(pinnedSwingPortfolio(linked)).toBe("book-one");
    expect(
      pinnedSwingPortfolio({ saved: { workspace_kind: "swing" } }),
    ).toBeNull();
    expect(pinnedSwingPortfolio(day)).toBeNull();
  });
  it("anchors hourly Swing execution markers to the actual 09:15 session candle", () => {
    const timestamp = Date.parse("2026-10-12T10:00:00Z") / 1000;
    const row = {
      trade_id: "fill",
      symbol: "HDFCBANK",
      side: "BUY",
      quantity: 1,
      price: 100,
      timestamp,
    } as DesktopTrade;
    expect(
      buildTradeMarkers([row], { kind: "equity" }, 3600, true, 33300)[0]
        .timestamp,
    ).toBe(Date.parse("2026-10-12T09:15:00Z") / 1000);
    expect(
      buildTradeMarkers([row], { kind: "equity" }, 3600, true)[0].timestamp,
    ).toBe(timestamp);
  });
});
