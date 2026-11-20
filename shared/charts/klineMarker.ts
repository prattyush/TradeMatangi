import { registerOverlay, type OverlayFigure } from "klinecharts";
import { annotationFigures } from "../analysis/kline/annotationFigures";
import { BUY_MARKER_OVERLAY, SELL_MARKER_OVERLAY, markerDefaults } from "./klineMarker-name";

export { BUY_MARKER_OVERLAY, SELL_MARKER_OVERLAY };

let registered = false;
/**
 * Buy and Sell marker drawings: one click, an arrow at the clicked price (a Buy points up from below the point, a Sell points down from
 * above it) with a short text and no box, the same look as the pattern marks and the Lightweight markers. The text and colour travel in
 * `extendData` (`markerExtendData` in `klineDrawingModel.ts` builds it from the saved drawing, whose `text` is stored).
 */
export function registerMarkerOverlays() {
  if (registered) return;
  registered = true;
  for (const [name, tool, buy] of [[BUY_MARKER_OVERLAY, "Buy Marker", true], [SELL_MARKER_OVERLAY, "Sell Marker", false]] as const) {
    registerOverlay({
      name,
      totalStep: 2,
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ coordinates, overlay }) => {
        if (!coordinates.length) return [];
        const extend = (overlay.extendData ?? {}) as { text?: string; color?: string };
        const defaults = markerDefaults(tool);
        // `annotationFigures` marks its figures as ignoring the pointer (pattern marks are not selectable); a drawing has to be selectable.
        return annotationFigures(coordinates[0], {
          color: extend.color ?? defaults.color,
          text: extend.text ?? defaults.text,
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
        }).map((figure) => ({ ...figure, ignoreEvent: false })) as unknown as OverlayFigure[];
      },
    });
  }
}
