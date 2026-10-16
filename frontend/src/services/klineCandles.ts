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
  const candle =
    last?.time === time
      ? {
          ...last,
          high: Math.max(last.high, tick.high),
          low: Math.min(last.low, tick.low),
          close: tick.close,
        }
      : {
          time,
          open: tick.open,
          high: tick.high,
          low: tick.low,
          close: tick.close,
        };
  return last?.time === time
    ? [...rows.slice(0, -1), candle]
    : [...rows, candle];
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

/** Keep malformed reconnect responses out of the renderer, without inventing prices. */
export function checkedChartCandles(rows: unknown): OHLCCandle[] {
  if (!Array.isArray(rows) || rows.some(row => !row || !['time','open','high','low','close'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key])))) {
    throw new Error('Chart history contains invalid candles. Retry chart data.');
  }
  return rows;
}
