import type { OHLCCandle, TickEvent } from "./api";
/** Existing IST-labelled epoch boundaries; never apply a second timezone conversion. */
export function mergeKLineTick(
  rows: OHLCCandle[],
  tick: TickEvent,
  minutes: number,
): OHLCCandle[] {
  const time = Math.floor(tick.time / (minutes * 60)) * minutes * 60;
  const last = rows[rows.length - 1];
  if (last && time < last.time) return rows;
  if (last?.time === time) {
    const high = Math.max(last.high, tick.high);
    const low = Math.min(last.low, tick.low);
    // A duplicate/heartbeat tick that doesn't move the current bucket is the
    // common steady-state case; keep the array reference stable so callers
    // relying on identity (e.g. React effect deps) don't redo work for it.
    if (high === last.high && low === last.low && tick.close === last.close)
      return rows;
    return [...rows.slice(0, -1), { ...last, high, low, close: tick.close }];
  }
  return [
    ...rows,
    { time, open: tick.open, high: tick.high, low: tick.low, close: tick.close },
  ];
}
export function mergeKLineHistory(
  history: OHLCCandle[],
  retained: OHLCCandle[],
  cutoff?: number,
  boundedPartialTime?: number,
): OHLCCandle[] {
  const byTime = new Map(
    history
      .filter(
        (c) =>
          cutoff === undefined ||
          c.time < cutoff ||
          (c.time === cutoff && c.time === boundedPartialTime),
      )
      .map((c) => [c.time, c]),
  );
  // Only the partial/missing tail is retained. A refreshed historical bucket is authoritative.
  for (const candle of retained) {
    if (cutoff !== undefined && candle.time > cutoff) continue;
    const saved = byTime.get(candle.time);
    if (!saved) byTime.set(candle.time, candle);
    else if (candle.time === boundedPartialTime)
      byTime.set(candle.time, {
        ...saved,
        high: Math.max(saved.high, candle.high),
        low: Math.min(saved.low, candle.low),
        close: candle.close,
      });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Lets a caller holding a previous candle array keep its reference when a
 * fresh merge produced byte-identical content, so React effects keyed on
 * array identity don't redo work for a no-op merge. */
export function sameCandles(a: OHLCCandle[], b: OHLCCandle[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (
      x.time !== y.time ||
      x.open !== y.open ||
      x.high !== y.high ||
      x.low !== y.low ||
      x.close !== y.close
    )
      return false;
  }
  return true;
}

/** Keep malformed reconnect responses out of the renderer, without inventing prices. */
export function checkedChartCandles(rows: unknown): OHLCCandle[] {
  if (!Array.isArray(rows) || rows.some(row => !row || !['time','open','high','low','close'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key])))) {
    throw new Error('Chart history contains invalid candles. Retry chart data.');
  }
  return rows;
}
