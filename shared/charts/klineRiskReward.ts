import { registerOverlay } from "klinecharts";
import { RISK_REWARD_OVERLAY, riskRewardLevels } from "./klineRiskRewardModel";

export { RISK_REWARD_OVERLAY };

/** How far (px) the levels run when both clicks are on the same bar, and the gap before a level's label. */
const MIN_WIDTH = 70;
const LABEL_GAP = 6;
const LABEL_STYLE = { size: 11, weight: "bold", backgroundColor: "transparent", borderSize: 0, borderColor: "transparent" } as const;

let registered = false;
/**
 * Risk : Reward on the KLine chart: **click the stop, then the entry** (as on the Lightweight chart). It draws the stop and the entry,
 * and the 1 : 1, 1.5 : 1 and 2 : 1 levels, as lines from the earlier to the later click with each level's price at its right end,
 * over a faint red risk zone (stop to entry) and green reward zone (entry to 2 : 1). The built-in Long Position asks for entry, target
 * and stop in that order; this one needs only two clicks. Saved drawings store the tool name "Risk Reward" with the two points.
 */
export function registerRiskRewardOverlay() {
  if (registered) return;
  registered = true;
  registerOverlay({
    name: RISK_REWARD_OVERLAY,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, overlay }) => {
      const stop = overlay.points[0]?.value;
      const entry = overlay.points[1]?.value;
      if (coordinates.length < 2 || typeof stop !== "number" || typeof entry !== "number" || stop === entry) return [];
      let precision = 2;
      try {
        precision = chart.getSymbol()?.pricePrecision ?? 2;
      } catch {
        /* keep the default */
      }
      const { levels } = riskRewardLevels(stop, entry);
      // Price to y from the two clicked points (a straight line between the two), so no axis lookup is needed.
      const yOf = (price: number) => coordinates[1].y + ((price - entry) * (coordinates[0].y - coordinates[1].y)) / (stop - entry);
      const left = Math.min(coordinates[0].x, coordinates[1].x);
      const right = Math.max(Math.max(coordinates[0].x, coordinates[1].x), left + MIN_WIDTH);
      const ys = levels.map((level) => yOf(level.price));
      const zone = (fromY: number, toY: number, color: string) => ({
        type: "rect",
        attrs: { x: left, y: Math.min(fromY, toY), width: right - left, height: Math.abs(fromY - toY) },
        styles: { style: "fill", color },
        ignoreEvent: true,
      });
      return [
        zone(ys[0], ys[1], "rgba(248,81,73,0.14)"), // stop to entry: the risk
        zone(ys[1], ys[4], "rgba(63,185,80,0.10)"), // entry to 2 : 1: the reward
        ...levels.map((level, i) => ({
          type: "line",
          attrs: { coordinates: [{ x: left, y: ys[i] }, { x: right, y: ys[i] }] },
          styles: { color: level.color, size: level.key === "stop" || level.key === "entry" ? 2 : 1.5, style: "solid" },
        })),
        ...levels.map((level, i) => ({
          type: "text",
          ignoreEvent: true,
          attrs: { x: right + LABEL_GAP, y: ys[i], text: `${level.label} ${level.price.toFixed(precision)}`, align: "left", baseline: "middle" },
          styles: { ...LABEL_STYLE, color: level.color },
        })),
      ];
    },
  });
}
