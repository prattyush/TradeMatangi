import { useEffect, useState } from "react";
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
  useEffect(() => {
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
  const instrument =
    pane.instrument_type === "options"
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
        };
  return (
    <div
      className="swing-renderer"
      style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
    >
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
        <button
          aria-pressed={indicator.includes("MA")}
          onClick={() => setIndicator((v) => (v.length ? [] : ["MA"]))}
        >
          MA
        </button>
        {["Horizontal", "Trend", "Fib Retracement"].map((tool) => (
          <button key={tool} onClick={() => setDraw({ id: Date.now(), tool })}>
            {tool}
          </button>
        ))}
        <button onClick={() => setAction({ id: Date.now(), action: "delete" })}>
          Delete selected
        </button>
      </div>
      {drawingError && <p role="alert">{drawingError}</p>}
      <ChartTile
        candleAnchorSeconds={pane.interval==='1D'?0:33300}
        showHistoricalMarkers={props.showHistoricalTrades}
        hideWindowActions
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
        onDrawingError={(error) => setDrawingError(String(error))}
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
        trades={props.trades}
        pricePickAction={props.picking ? { ticket: {} } : null}
        onPricePick={props.onPick}
      />
    </div>
  );
}
