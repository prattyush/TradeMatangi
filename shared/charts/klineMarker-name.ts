/** The Buy and Sell marker drawings (pure: no klinecharts import). One click; a Buy is a blue up arrow below the point, a Sell an orange down arrow above it. */
export const BUY_MARKER_OVERLAY = "tmBuyMarker";
export const SELL_MARKER_OVERLAY = "tmSellMarker";
export const MARKER_TOOLS = ["Buy Marker", "Sell Marker"] as const;
export const isMarkerTool = (tool: string) => tool === "Buy Marker" || tool === "Sell Marker";
/** Same label and colours as the Lightweight markers. */
export const markerDefaults = (tool: string) =>
  tool === "Buy Marker" ? { text: "Buy UL", color: "#3b82f6" } : { text: "Sell UL", color: "#f97316" };
