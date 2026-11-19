export const drawingTools = [
  { label: "Horizontal line", icon: "━", tool: "Horizontal" },
  { label: "Trend line", icon: "╱", tool: "Trend" },
  { label: "Ray", icon: "↗", tool: "ray" },
  { label: "Arrow", icon: "➜", tool: "arrow" },
  { label: "Text", icon: "T", tool: "Text" },
  { label: "Rectangle", icon: "▭", tool: "rect" },
  { label: "Brush", icon: "✎", tool: "brush" },
  { label: "Fibonacci retracement", icon: "Φ", tool: "Fib Retracement" },
  { label: "Fibonacci extension", icon: "Φ+", tool: "fibonacciExtension" },
  { label: "Fibonacci fan", icon: "◿", tool: "fibonacciSpeedResistanceFan" },
  { label: "Parallel channel", icon: "∥", tool: "parallelChannel" },
  { label: "Measure", icon: "⌁", tool: "measure" },
  { label: "Gann box", icon: "▦", tool: "gannBox" },
  { label: "Long position", icon: "L", tool: "longPosition" },
  { label: "Short position", icon: "S", tool: "shortPosition" },
];

export const allIndicators = [
  "MA",
  "EMA",
  "BOLL_TV",
  "VOL",
  "VWAP",
  "SuperTrend",
  "Ichimoku",
  "MA_Ribbon",
  "HMA",
  "PivotPoints",
  "PositionPnL",
  "PnLTargets",
  "RSI_TV",
  "MACD_TV",
  "Stochastic",
  "CCI_TV",
];

/** Indicators computed from traded volume; meaningless on instruments that report none (indices). */
export const volumeIndicators = ["VOL", "VWAP"];

/** Price-scale indicators drawn over the candles (a shared pane), not in a sub-pane of their own. */
export const overlayIndicators = ["VWAP"];

/**
 * True when an indicator would draw nothing useful: volume indicators on an instrument with no volume (an index),
 * and VWAP on daily bars, where it restarts every day and is just each bar's typical price.
 * `hasVolume` unspecified means "unknown", so nothing is hidden for it.
 */
export const indicatorUnavailable = (name: string, options: { hasVolume?: boolean; interval?: string } = {}) =>
  (volumeIndicators.includes(name) && options.hasVolume === false) || (name === "VWAP" && options.interval === "1D");

export const indicatorLabel = (name: string) =>
  name === "PositionPnL"
    ? "Position P&L levels"
    : name === "PnLTargets"
      ? "Target P&L levels"
      : name === "VOL"
        ? "Volume"
        : name.replace("_TV", "").replace("_Ribbon", " Ribbon");
