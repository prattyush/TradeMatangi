import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import { registerExtensions } from "react-klinecharts-ui/extensions";
import type { Chart } from "klinecharts";
import { allIndicators } from "./catalogue";

/** `PositionPnL` only makes sense on a live trading chart. */
export const analysisIndicators = allIndicators.filter((name) => name !== "PositionPnL");
/** EMA 9/21 stays on by default: it was hard-wired on the Analysis charts before. */
export const defaultAnalysisIndicators = ["EMA"];

/** Idempotent (the library guards re-registration); needed before creating extension indicators. */
export const ensureKLineExtensions = () => registerExtensions();

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultAnalysisIndicators;
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === "string" && analysisIndicators.includes(name))
      : defaultAnalysisIndicators;
  } catch {
    return defaultAnalysisIndicators;
  }
}
const write = (key: string, names: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(names));
  } catch {
    /* Optional local UI preference. */
  }
};

export function applyAnalysisIndicators(chart: Chart, names: string[]) {
  ensureKLineExtensions();
  chart.removeIndicator();
  names.forEach((name) => {
    if (name === "MA")
      chart.createIndicator({ name: "MA", calcParams: [5, 10, 20], paneId: "candle_pane" }, true);
    else if (name === "EMA")
      chart.createIndicator({ name: "EMA", calcParams: [9, 21], paneId: "candle_pane" }, true);
    else chart.createIndicator(name);
  });
}

/**
 * Indicator selection for an Analysis KLine chart, persisted in localStorage
 * under `storageKey`. Call after the chart has been created.
 */
export function useKLineIndicators(chartRef: MutableRefObject<Chart | null>, storageKey: string) {
  const [state, setState] = useState(() => ({ key: storageKey, names: read(storageKey) }));
  // The key changes when one chart instance switches between underlying and option contracts.
  const names = state.key === storageKey ? state.names : read(storageKey);
  if (state.key !== storageKey) setState({ key: storageKey, names });
  const signature = names.join("|");
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) applyAnalysisIndicators(chart, names);
  }, [signature]);
  const update = useCallback(
    (next: (current: string[]) => string[]) =>
      setState((current) => {
        const names = next(current.key === storageKey ? current.names : read(storageKey));
        write(storageKey, names);
        return { key: storageKey, names };
      }),
    [storageKey],
  );
  return {
    names,
    toggle: (name: string) => update((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name])),
    clear: () => update(() => []),
  };
}
