import { SwingIconButton } from "../../shared/SwingIcon";
import { flashError } from "../../shared/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChartTile } from "./ChartTile";
import type { SwingChartProps } from "../../shared/SwingWorkspace";
const settings = {
  background: "#151a23",
  textColor: "#aeb8ca",
  gridColor: "#ffffff",
  gridOpacity: 0.12,
  gridStyle: "solid" as const,
  gridSize: 1,
  movingAverageType: "MA" as const,
  movingAveragePeriods: "5,10,20",
  showChartInfo: true,
  horizontalLineColor: "#facc15",
  horizontalLineWidth: 2,
  trendLineColor: "#60a5fa",
  trendLineWidth: 2,
  drawingLineColor: "#60a5fa",
  drawingLineWidth: 2,
  drawingFillColor: "#60a5fa",
  drawingFillOpacity: 0.16,
};
// Stable sentinel: content never varies, so there's no need to reallocate
// it (and force the KLineChart effects keyed on it) on every render.
const PICKING_ACTION = { ticket: {} };
type DrawingRequest = (
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
) => Promise<unknown>;
export default function SwingChart(
  props: SwingChartProps & { drawingRequest: DrawingRequest },
) {
  const storageKey = `swing-indicators:${props.drawingScope}:${props.pane.symbol}:${props.pane.right}:${props.pane.strike}:${props.pane.expiry}:${props.pane.interval}`;
  const [drawingError, setDrawingError] = useState("");
  const reportDrawingError = useCallback(
    (error: unknown) => { setDrawingError(String(error)); flashError(error, "Desktop Swing drawings"); },
    [],
  );
  const [indicator, setIndicator] = useState<string[]>(() => {
      try {
        return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      } catch {
        return [];
      }
    }),
    [draw, setDraw] = useState<{ id: number; tool: string } | null>(null),
    [action, setAction] = useState<{
      id: number;
      action: "delete" | "hide" | "lock";
    } | null>(null),
    [chartSettings, setChartSettings] = useState(settings);
  const lastIndicatorKey = useRef(storageKey);
  useEffect(() => {
    if (lastIndicatorKey.current !== storageKey) {
      lastIndicatorKey.current = storageKey;
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        setIndicator(Array.isArray(saved) ? saved.filter((name): name is string => typeof name === "string") : []);
      } catch { setIndicator([]); }
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(indicator));
    } catch {
      /* Storage can be disabled. */
    }
  }, [storageKey, indicator]);
  useEffect(() => {
    void props
      .drawingRequest("chart-settings", "GET")
      .then((value: any) =>
        setChartSettings({ ...settings, ...value.settings }),
      )
      .catch(() => undefined);
  }, [props.drawingRequest]);
  const pane = props.pane;
  const instrument = useMemo(
    () =>
      pane.instrument_type === "futures"
        ? {kind: "future", underlying: pane.symbol, exchange: pane.symbol === "BSESEN" ? "BFO" : "NFO", expiry: pane.expiry}
        : pane.instrument_type === "options"
        ? {
            kind: "option",
            underlying: pane.symbol,
            exchange: pane.symbol === "BSESEN" ? "BFO" : "NFO",
            right: pane.right,
            strike: pane.strike,
            expiry: pane.expiry,
          }
        : {
            kind: props.chartKind === "index" ? "index" : "equity",
            symbol: pane.symbol,
            exchange: pane.symbol === "BSESEN" ? "BSE" : "NSE",
          },
    [pane.instrument_type, pane.symbol, pane.expiry, pane.right, pane.strike, props.chartKind],
  );
  const tools = (
<div className="swing-pane-bar">
        <select
          aria-label="Add chart indicator"
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (value)
              setIndicator((previous) =>
                previous.includes(value)
                  ? previous.filter((name) => name !== value)
                  : [...previous, value],
              );
          }}
        >
          <option value="">Indicators</option>
          {[
            "MA",
            "EMA",
            "BOLL_TV",
            "VWAP",
            "SuperTrend",
            "Ichimoku",
            "MA_Ribbon",
            "HMA",
            "PivotPoints",
            "PositionPnL",
            "RSI_TV",
            "MACD_TV",
            "Stochastic",
            "CCI_TV",
          ].map((name) => (
            <option key={name} value={name}>
              {indicator.includes(name) ? "✓ " : ""}
              {name.replace("_TV", "")}
            </option>
          ))}
        </select>
        <SwingIconButton label="Toggle moving average" icon="Indicator" aria-pressed={indicator.includes("MA")} onClick={() => setIndicator((v) => (v.length ? [] : ["MA"]))} />
        {["Horizontal", "Trend", "Fib Retracement"].map((tool) => (
          <SwingIconButton key={tool} label={tool} icon={tool === "Fib Retracement" ? "Fib" : tool === "Trend" ? "Trend" : "Horizontal"} onClick={() => setDraw({ id: Date.now(), tool })} />
        ))}
        <SwingIconButton label="Delete selected" icon="Delete" onClick={() => setAction({ id: Date.now(), action: "delete" })} />
      </div>
  );
  return (
    <div
      className="swing-renderer"
      style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      {props.toolsContainer === undefined ? tools : props.active && props.toolsContainer && createPortal(tools, props.toolsContainer)}
      {drawingError && <p role="alert">{drawingError}</p>}
      <ChartTile
        drawingRefreshKey={props.refreshKey}
        shareDayDrawings
        legacyDrawingScope={props.drawingScope}
        candleAnchorSeconds={pane.interval === "1D" ? 0 : 33300}
        showHistoricalMarkers={props.showHistoricalTrades}
        externalTradeMarkers={props.showHistoricalTrades === true}
        hideInstrumentPicker
        hideMaximizeButton
        readOnlyOrders
        symbol={pane.symbol}
        interval={
          pane.interval === "1D"
            ? "1D"
            : String(
                pane.interval === "1h"
                  ? 60
                  : Number(pane.interval.slice(0, -1)),
              )
        }
        supportedIntervals={[]}
        onIntervalChange={() => {}}
        candles={props.candles}
        loadOlder={props.loadOlder}
        loading={props.loading}
        message={props.message}
        settings={chartSettings}
        isReplaying={false}
        isLive={props.live && pane.interval !== "1D"}
        instrument={instrument}
        baseUrl=""
        drawingRequest={props.drawingRequest}
        onDrawingError={reportDrawingError}
        onConfigure={() => {}}
        onMaximize={() => {}}
        maximized={false}
        active={props.active}
        indicators={indicator}
        drawingCommand={draw}
        drawingAction={action}
        drawingMode="once"
        onDrawingComplete={() => setDraw(null)}
        onActivate={props.onActivate}
        position={props.position}
        openOrders={props.orders}
        onOrderSelect={props.onOrderSelect}
        onOrderDrag={props.onOrderDrag}
        onSwingChartContext={props.onChartContext}
        trades={props.trades}
        pricePickAction={props.picking ? PICKING_ACTION : null}
        onPricePickCancel={props.onCancelPick}
        onPricePick={props.onPick}
      />
    </div>
  );
}
