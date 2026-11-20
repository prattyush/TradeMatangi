import { registerOverlay } from "klinecharts";
import { TEXT_OVERLAY } from "./klineText-name";

export { TEXT_OVERLAY };
export interface TextExtend {
  text: string;
  color: string;
}

let registered = false;
/**
 * A one-click Text drawing: a short label placed at a price and time, with no box behind it. The text and its colour travel in
 * `extendData` (`textExtendData` in `klineDrawingModel.ts` builds it from the saved drawing, whose `text` field is what is stored).
 */
export function registerTextOverlay() {
  if (registered) return;
  registered = true;
  registerOverlay({
    name: TEXT_OVERLAY,
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const extend = overlay.extendData as Partial<TextExtend> | undefined;
      if (!coordinates.length || !extend?.text) return [];
      return [
        {
          type: "text",
          attrs: { x: coordinates[0].x + 8, y: coordinates[0].y, text: extend.text, align: "left", baseline: "middle" },
          styles: {
            color: extend.color ?? "#e6edf3",
            size: 13,
            weight: "bold",
            backgroundColor: "transparent",
            borderSize: 0,
            borderColor: "transparent",
          },
        },
      ];
    },
  });
}
