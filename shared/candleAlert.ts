/**
 * Candle-close alert timing, driven by the session's market clock (IST-as-UTC
 * epoch seconds, same epoch-aligned boundaries as the chart candles). Using the
 * market clock means replay fires at the same market time at any speed and a
 * paused session stays silent.
 */
export const CANDLE_ALERT_INTERVALS = [1, 3, 5, 10, 15, 30] as const;

export interface CandleAlertConfig {
  enabled: boolean;
  intervalMin: number;
  secondsBefore: number;
}

export function candleAlertConfigValid(config: CandleAlertConfig): boolean {
  return (
    config.enabled &&
    Number.isFinite(config.intervalMin) &&
    config.intervalMin > 0 &&
    Number.isFinite(config.secondsBefore) &&
    config.secondsBefore > 0 &&
    config.secondsBefore < config.intervalMin * 60
  );
}

/** End (exclusive close) of the candle containing `time`. */
export function candleEnd(time: number, intervalMin: number): number {
  const seconds = intervalMin * 60;
  return Math.floor(time / seconds) * seconds + seconds;
}

export interface CandleAlertTracker {
  /** Feed the latest market-clock second; returns true when the alert should sound now. */
  observe(time: number | null | undefined, config: CandleAlertConfig): boolean;
  /** Forget history, e.g. when the session changes, restarts or stops. */
  reset(): void;
}

export function createCandleAlertTracker(): CandleAlertTracker {
  let previous: number | null = null;
  let lastFiredEnd: number | null = null;
  return {
    observe(time, config) {
      if (time == null || !Number.isFinite(time)) return false;
      const before = previous;
      previous = time;
      if (!candleAlertConfigValid(config)) return false;
      // The first sample only establishes where the session is: starting or
      // resuming already inside the window must not sound immediately.
      if (before === null) return false;
      const end = candleEnd(time, config.intervalMin);
      const threshold = end - config.secondsBefore;
      if (time < threshold || before >= threshold) return false;
      // before < threshold <= time. A clock that jumped backwards then forwards
      // is guarded by the once-per-candle record.
      if (lastFiredEnd === end) return false;
      lastFiredEnd = end;
      return true;
    },
    reset() {
      previous = null;
      lastFiredEnd = null;
    },
  };
}
