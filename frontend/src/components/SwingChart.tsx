import { useRef, useEffect, useState } from "react";
import Chart from "./Chart";
import type { SwingChartProps } from "../../../shared/SwingWorkspace";
export default function SwingChart(props: SwingChartProps) {
  const element = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(350);
  useEffect(() => {
    if (!element.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0].contentRect.height > 0)
        setHeight(Math.max(120, entries[0].contentRect.height - 38));
    });
    observer.observe(element.current);
    return () => observer.disconnect();
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
      style={{ display: "flex", minHeight: 0, flex: 1 }}
    >
      <Chart
        symbol={pane.symbol}
        candleAnchorSeconds={pane.interval==='1D'?0:33300}
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
        position={props.position}
        height={height}
      />
    </div>
  );
}
