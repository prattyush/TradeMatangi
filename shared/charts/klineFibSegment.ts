import { registerOverlay } from "klinecharts";
import { FIB_SEGMENT_OVERLAY } from "./klineFibSegment-name";

/**
 * Fibonacci retracement drawn as line segments. klinecharts' built-in `fibonacciLine` runs every level across the whole pane, which
 * buries the chart in lines; this one draws each level only over the span the user clicked, a little past the later click so the
 * last touch point is not on the line's very end, with the price and percent label just left of each level (outside the segment, so it never hides the line). A thin dashed
 * line joins the two clicked points. Saved drawings store the tool name "Fib Retracement" (never the overlay name), so every existing
 * drawing is drawn this way too, on every chart that maps that tool through `overlayName`.
 */
export { FIB_SEGMENT_OVERLAY };
export const FIB_LEVELS = [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0];

/** How far (px) a level runs past the right-hand click: a quarter of the span drawn, at least 28. */
export const fibOverrun = (spanPx: number) => Math.max(28, Math.abs(spanPx) * 0.25);

let registered = false;
export function registerFibSegmentOverlay() {
  if (registered) return;
  registered = true;
  registerOverlay({
    name: FIB_SEGMENT_OVERLAY,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, overlay, yAxis }) => {
      const points = overlay.points;
      if (coordinates.length < 2 || typeof points[0]?.value !== "number" || typeof points[1]?.value !== "number") return [];
      let precision = 2;
      try {
        precision = (yAxis?.isInCandle?.() ?? true) ? (chart.getSymbol()?.pricePrecision ?? 2) : 2;
      } catch {
        /* keep the default */
      }
      const left = Math.min(coordinates[0].x, coordinates[1].x);
      const right = Math.max(coordinates[0].x, coordinates[1].x);
      const endX = right + fibOverrun(right - left);
      const yDif = coordinates[0].y - coordinates[1].y;
      const valueDif = points[0].value - points[1].value;
      const lines: Array<{ coordinates: Array<{ x: number; y: number }> }> = [];
      const texts: Array<{ x: number; y: number; text: string; align: "right"; baseline: "middle" }> = [];
      for (const percent of FIB_LEVELS) {
        const y = coordinates[1].y + yDif * percent;
        const value = (points[1].value + valueDif * percent).toFixed(precision);
        lines.push({ coordinates: [{ x: left, y }, { x: endX, y }] });
        texts.push({ x: left - 6, y, text: `${value} (${(percent * 100).toFixed(1)}%)`, align: "right", baseline: "middle" });
      }
      return [
        { type: "line", attrs: lines },
        { type: "line", attrs: { coordinates: [coordinates[0], coordinates[1]] }, styles: { style: "dashed" }, ignoreEvent: true },
        { type: "text", isCheckEvent: false, attrs: texts },
      ];
    },
  });
}
