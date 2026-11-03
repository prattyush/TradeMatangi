/**
 * Pure drawing model shared by chart hosts that persist KLine drawings.
 * The stored shape is library-neutral (unix-second timestamps + prices) and is
 * the same one `KLineChart.tsx` reads/writes through `/api/desktop/v1/drawings`.
 */
export interface PersistedDrawing {
  tool: string;
  points: Array<{ timestamp: number; price: number }>;
  style?: {
    color?: string;
    width?: number;
    fillColor?: string;
    fillOpacity?: number;
  };
  visible?: boolean;
  locked?: boolean;
}
export interface DrawingRecord {
  drawing_id: string;
  revision: number;
  drawing: PersistedDrawing;
}
export interface LocalDrawing {
  dirty?: boolean;
  id: string;
  backendId?: string;
  revision?: number;
  drawing: PersistedDrawing;
  locked: boolean;
  hidden: boolean;
}
export type DrawingRequest = (
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
) => Promise<unknown>;
export type DrawingMode = "once" | "repeat";

export interface DrawingStyleSettings {
  horizontalLineColor: string;
  horizontalLineWidth: number;
  trendLineColor: string;
  trendLineWidth: number;
  drawingLineColor: string;
  drawingLineWidth: number;
  drawingFillColor: string;
  drawingFillOpacity: number;
}
export const defaultDrawingStyle: DrawingStyleSettings = {
  horizontalLineColor: "#facc15",
  horizontalLineWidth: 2,
  trendLineColor: "#60a5fa",
  trendLineWidth: 2,
  drawingLineColor: "#60a5fa",
  drawingLineWidth: 2,
  drawingFillColor: "#60a5fa",
  drawingFillOpacity: 0.16,
};

export const withOpacity = (hex: string, opacity: number) =>
  `${hex}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** Catalogue tool name -> klinecharts overlay name (mirrors KLineChart.tsx). */
export const overlayName = (tool: string) =>
  tool === "Trend"
    ? "segment"
    : tool === "Horizontal"
      ? "horizontalStraightLine"
      : tool === "Fib Retracement"
        ? "fibonacciLine"
        : tool;

export const drawingPoints = (drawing: PersistedDrawing) =>
  drawing.points.map((point) => ({
    timestamp: point.timestamp * 1000,
    value: point.price,
  }));

/** Stored seconds from klinecharts millisecond overlay points. */
export const overlayPointsToStored = (
  points: Array<{ timestamp?: number; value?: number }>,
) =>
  points.map((point) => ({
    timestamp: Math.floor(Number(point.timestamp) / 1000),
    price: Number(point.value),
  }));

export function toolStyle(tool: string, settings: DrawingStyleSettings) {
  const color =
    tool === "Trend"
      ? settings.trendLineColor
      : tool === "Horizontal"
        ? settings.horizontalLineColor
        : settings.drawingLineColor;
  const width =
    tool === "Trend"
      ? settings.trendLineWidth
      : tool === "Horizontal"
        ? settings.horizontalLineWidth
        : settings.drawingLineWidth;
  const fillColor = withOpacity(
    settings.drawingFillColor,
    settings.drawingFillOpacity,
  );
  return { color, width, fillColor, fillOpacity: settings.drawingFillOpacity };
}

/** klinecharts `styles` for a drawing; explicit so themes can't hide it. */
export function overlayStyles(style: PersistedDrawing["style"], settings: DrawingStyleSettings) {
  const fill =
    style?.fillColor ??
    withOpacity(
      settings.drawingFillColor,
      style?.fillOpacity ?? settings.drawingFillOpacity,
    );
  return {
    line: {
      color: style?.color ?? settings.drawingLineColor,
      size: style?.width ?? settings.drawingLineWidth,
      style: "solid",
      dashedValue: [2, 2],
    },
    polygon: { color: fill },
    rect: { color: fill },
    circle: { color: fill },
  };
}

export interface AnalysisInstrumentInput {
  symbol: string;
  /** Present for an option contract. */
  right?: string;
  strike?: number;
  expiry?: string;
  /** Catalogue chart_type of the underlying (e.g. "index"); defaults to "equity". */
  kind?: string;
  /** Catalogue exchange of the underlying; defaults to NSE (BSE for BSESEN). */
  exchange?: string;
}
/**
 * Instrument identity for an Analysis chart. Must produce the same key as the
 * Day/Swing KLine charts (WebsiteKLineChart.tsx / desktop App.tsx) so drawings
 * made while reviewing a trade show up on the trading chart and vice versa.
 */
export function analysisDrawingInstrument(input: AnalysisInstrumentInput): Record<string, unknown> {
  const exchange = input.exchange ?? (input.symbol === "BSESEN" ? "BSE" : "NSE");
  if (input.right && input.strike != null && input.expiry)
    return {
      kind: "option",
      exchange,
      underlying: input.symbol,
      expiry: input.expiry,
      strike: Number(input.strike),
      right: input.right,
    };
  return { kind: input.kind ?? "equity", exchange, symbol: input.symbol };
}
