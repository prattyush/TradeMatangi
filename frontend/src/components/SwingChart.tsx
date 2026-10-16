import ChartRendererSetting from "./ChartRendererSetting";
import { useRef, useEffect, useState } from "react";
import TradingChartHost from "./TradingChartHost";
import type { SwingChartProps } from "../../../shared/SwingWorkspace";
export default function SwingChart(props: SwingChartProps) {
  const element = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(350);
  useEffect(() => {
    if (!element.current) return;
    let frame: number | undefined;
    const observer = new ResizeObserver((entries) => {
      const available = entries[0]?.contentRect.height;
      if (!available || available <= 0) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const next = Math.max(120, Math.floor(available - 38));
        setHeight(previous => previous === next ? previous : next);
      });
    });
    observer.observe(element.current);
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);
  const { pane } = props;
  const minutes =
    pane.interval === "1D"
      ? 1440
      : pane.interval === "1h"
        ? 60
        : Number(pane.interval.slice(0, -1));
  return (
    <div
      ref={element}
      className="swing-renderer"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
      }}
    >
      <ChartRendererSetting />
      <TradingChartHost
        drawingRefreshKey={props.refreshKey}
        liveChart={props.live && minutes !== 1440}
        swingChart
        chartKind={props.chartKind}
        legacyDrawingScope={props.drawingScope}
        symbol={pane.symbol}
        candleAnchorSeconds={pane.interval === "1D" ? 0 : 33300}
        defaultShowAllMarkers={props.showHistoricalTrades}
        externalTradeMarkers={props.showHistoricalTrades === true}
        tradingDate={pane.as_of_date}
        startTime={null}
        intervalMinutes={minutes}
        historyMode="live"
        paneType={pane.instrument_type}
        right={pane.right as "CE" | "PE"}
        strike={pane.strike}
        expiry={pane.expiry}
        latestTick={null}
        trades={props.trades}
        externalCandles={props.candles}
        externalLoading={props.loading}
        externalMessage={props.message}
        externalLoadOlder={props.loadOlder}
        drawingStorageKey={`swing-drawings:${props.drawingScope}:${pane.symbol}:${pane.right}:${pane.strike}:${pane.expiry}:${pane.interval}`}
        isActive={props.active}
        onActivate={props.onActivate}
        onPriceSelect={props.picking ? props.onPick : null}
        pricePickLabel="Pick a price for the confirmed Swing ticket"
        openOrders={props.orders}
        onOrderSelect={props.onOrderSelect}
        onSwingOrderDrag={props.onOrderDrag}
        onOrderDrag={props.onOrderDrag}
        onContextMenu={props.onChartContext}
        position={props.position}
        height={height}
      />
    </div>
  );
}
