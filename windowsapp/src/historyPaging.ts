import type { Candle } from "./contracts";
export interface UnderlyingHistoryPage {
  candles: Candle[];
  next_before_date: string | null;
  scanned_dates: string[];
  loaded_dates: string[];
  unavailable_dates: string[];
}
export function historyLowerBound(anchor: string): number {
  return Date.parse(`${anchor}T00:00:00Z`) / 1000 - 13 * 86400;
}
export function mergeHistory(
  older: Candle[],
  current: Candle[],
  anchor: string,
): Candle[] {
  const lower = historyLowerBound(anchor);
  const map = new Map<number, Candle>();
  for (const c of [...older, ...current])
    if (c.timestamp >= lower && c.timestamp < lower + 14 * 86400)
      map.set(c.timestamp, c);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
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
