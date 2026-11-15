import type { Candle } from "./contracts";
export interface UnderlyingHistoryPage {
  candles: Candle[];
  next_before_date: string | null;
  scanned_dates: string[];
  loaded_dates: string[];
  unavailable_dates: string[];
}
/** Calendar days the existing scroll-back (underlying-pages) reaches back. */
export const LEGACY_HORIZON_DAYS = 13;

/**
 * Browse scroll-back (`browse/history`): calendar days back from the tile's date, by interval in minutes. The same table
 * as the server (`HORIZON_DAYS` in backend/app/services/browse_history.py): it bounds memory and the chart's indicator cost,
 * and a tile's own date moves the window anywhere.
 */
export const BROWSE_HORIZON_DAYS: Record<number, number> = { 1: 90, 3: 365, 5: 365, 15: 550, 30: 550, 60: 550, 1440: 550 };
export const browseHorizonDays = (intervalMinutes: number): number => BROWSE_HORIZON_DAYS[intervalMinutes] ?? 365;

export function historyLowerBound(anchor: string, horizonDays = LEGACY_HORIZON_DAYS): number {
  return Date.parse(`${anchor}T00:00:00Z`) / 1000 - horizonDays * 86400;
}
export function mergeHistory(
  older: Candle[],
  current: Candle[],
  anchor: string,
  horizonDays = LEGACY_HORIZON_DAYS,
): Candle[] {
  const lower = historyLowerBound(anchor, horizonDays);
  const map = new Map<number, Candle>();
  for (const c of [...older, ...current])
    if (c.timestamp >= lower && c.timestamp < lower + (horizonDays + 1) * 86400)
      map.set(c.timestamp, c);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}
/** One page of `browse/history` (spot, minute or daily candles) as the tile wants it. */
export interface BrowseHistoryPage {
  candles: Array<{ time: number; timestamp?: number; open: number; high: number; low: number; close: number; volume?: number }>;
  more: boolean;
  before: number | null;
  oldest_date: string | null;
}
export function browseHistoryPath(symbol: string, intervalMinutes: number, anchor: string, before: number): string {
  return `browse/history?${new URLSearchParams({ symbol, interval: String(intervalMinutes), date: anchor, before: String(before) })}`;
}
export function browseCandles(page: BrowseHistoryPage): Candle[] {
  return page.candles.map((c) => ({ timestamp: c.timestamp ?? c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}
export function oldestDate(candles: Candle[], anchor: string): string {
  return candles.length
    ? new Date(candles[0].timestamp * 1000).toISOString().slice(0, 10)
    : anchor;
}
export class BoundedHistoryCache {
  private items = new Map<
    string,
    { promise: Promise<Candle[]>; count: number; expires: number }
  >();
  constructor(
    private readonly maxEntries = 32,
    private readonly maxCandles = 100000,
  ) {}
  get(key: string): Promise<Candle[]> | undefined {
    const item = this.items.get(key);
    if (!item) return;
    if (Date.now() > item.expires) {
      this.items.delete(key);
      return;
    }
    this.items.delete(key);
    this.items.set(key, item);
    return item.promise;
  }
  set(key: string, promise: Promise<Candle[]>): void {
    const item = { promise, count: 0, expires: Date.now() + 600000 };
    this.items.set(key, item);
    void promise.then(
      (rows) => {
        if (this.items.get(key) !== item) return;
        item.count = rows.length;
        this.trim();
      },
      () => {
        if (this.items.get(key) === item) this.items.delete(key);
      },
    );
    this.trim();
  }
  private trim() {
    while (
      this.items.size > this.maxEntries ||
      [...this.items.values()].reduce((sum, item) => sum + item.count, 0) >
        this.maxCandles
    ) {
      const key = this.items.keys().next().value;
      if (key === undefined) break;
      this.items.delete(key);
    }
  }
  get size() {
    return this.items.size;
  }
}
