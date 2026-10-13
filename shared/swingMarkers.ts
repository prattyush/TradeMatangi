export type SwingMarkerMode = "open" | "all" | "off";
export interface SwingOpeningBasis {
  session_id?: string;
  symbol: string;
  instrument_type?: string;
  right?: string | null;
  strike?: number | null;
  expiry?: string | null;
  quantity: number;
  timestamp: number;
}
export interface SwingExecution {
  trade_id: string;
  symbol: string;
  session_id?: string;
  side: string;
  quantity: number;
  price: number;
  timestamp: number;
  right?: string | null;
  strike?: number | null;
  expiry?: string | null;
  instrument_type?: string;
  underlying_price?: number | null;
  source?: string | null;
}

/** All timestamps encode IST wall time as UTC, matching candles and executions. */
export function swingMarkerTrades<T extends SwingExecution>(
  trades: T[],
  pane: {
    symbol: string;
    instrument_type: string;
    right?: string;
    strike?: number;
    expiry?: string;
    as_of_date: string;
  },
  mode: SwingMarkerMode = "open",
  openingBasis: SwingOpeningBasis[] = [],
): T[] {
  const cutoff = Date.parse(`${pane.as_of_date}T00:00:00Z`) / 1000 + 86400;
  if (mode === "off" || !Number.isFinite(cutoff)) return [];
  const eligible = trades.filter(
    (t) =>
      t.symbol === pane.symbol &&
      Number.isFinite(t.timestamp) &&
      t.timestamp < cutoff &&
      Number.isFinite(t.quantity) &&
      t.quantity > 0 &&
      Number.isFinite(t.price) &&
      t.price > 0 &&
      (t.side === "BUY" || t.side === "SELL") &&
      // Synthetic import basis is not an executed order.
      t.source !== "IMPORT" &&
      t.source !== "SETTLEMENT" &&
      (pane.instrument_type !== "options" ||
        (t.right === pane.right &&
          t.strike === pane.strike &&
          t.expiry === pane.expiry)) &&
      (pane.instrument_type !== "futures" ||
        (t.instrument_type === "futures" && t.expiry === pane.expiry)),
  );
  const cycles = new Map<string, { quantity: number; fills: T[] }>();
  const contractKey = (t: SwingOpeningBasis) =>
    JSON.stringify([
      t.session_id,
      t.symbol,
      t.instrument_type ?? (t.right ? "options" : "equity"),
      t.right ?? "",
      t.strike ?? "",
      t.expiry ?? "",
    ]);
  const events: Array<{
    timestamp: number;
    fill?: T;
    basis?: SwingOpeningBasis;
  }> = eligible.map((fill) => ({ timestamp: fill.timestamp, fill }));
  for (const basis of openingBasis) {
    if (
      basis.symbol === pane.symbol &&
      Number.isFinite(basis.timestamp) &&
      basis.timestamp < cutoff &&
      Number.isFinite(basis.quantity) &&
      basis.quantity >= 0
    )
      events.push({ timestamp: basis.timestamp, basis });
  }
  for (const event of events.sort((a, b) => a.timestamp - b.timestamp)) {
    const t = event.fill ?? event.basis!;
    const key = contractKey(t);
    const cycle = cycles.get(key) ?? { quantity: 0, fills: [] };
    if (event.basis) {
      // Capture is current imported inventory, not a fabricated execution or acquisition date.
      cycle.quantity = event.basis.quantity;
      cycle.fills = [];
    } else {
      const fill = event.fill!;
      const next =
        cycle.quantity + (fill.side === "BUY" ? fill.quantity : -fill.quantity);
      if (next === 0) cycle.fills = [];
      else if (cycle.quantity && Math.sign(next) !== Math.sign(cycle.quantity))
        cycle.fills = [fill];
      else cycle.fills.push(fill);
      cycle.quantity = next;
    }
    cycles.set(key, cycle);
  }
  const open = new Set([...cycles.values()].flatMap((c) => c.fills));
  // Underlying panes can show derivative executions only at the captured spot price.
  return eligible
    .filter(
      (t) =>
        (mode === "all" || open.has(t)) &&
        (pane.instrument_type !== "equity" ||
          !(t.right || t.instrument_type === "futures") ||
          (Number.isFinite(t.underlying_price) &&
            Number(t.underlying_price) > 0)),
    )
    .map((t) => ({ ...t, is_open: open.has(t) }));
}
