import { useEffect, useState, type ComponentType } from "react";
import type { SwingChartProps, SwingCandle, SwingPane } from "./SwingWorkspace";
import type { SwingRequest } from "./SwingPortfolioPanel";

/** Owned exact-contract history, rather than substituting the underlying chart. */
export default function FuturesExecutionChart({
  request,
  Renderer,
  cycle,
  trades,
}: {
  request: SwingRequest;
  Renderer: ComponentType<SwingChartProps>;
  cycle: any;
  trades: any[];
}) {
  const [candles, setCandles] = useState<SwingCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pane: SwingPane = {
    symbol: cycle.symbol,
    instrument_type: "futures",
    expiry: cycle.expiry,
    interval: "1D",
    as_of_date: cycle.date,
  };
  const identity = JSON.stringify([cycle.cycle_id, pane]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCandles([]);
    setError("");
    void request<{ candles: SwingCandle[] }>(
      `${cycle.portfolio_id}/charts/history`,
      "POST",
      pane as unknown as Record<string, unknown>,
    )
      .then((result) => {
        if (active) setCandles(result.candles);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identity, request]);
  return (
    <div style={{ height: 420, display: "flex", flexDirection: "column" }}>
      <Renderer
        pane={pane}
        drawingScope={`swing:${cycle.portfolio_id}:history`}
        candles={candles}
        loading={loading}
        message={error}
        live={false}
        active
        picking={false}
        orders={[]}
        trades={trades}
        showHistoricalTrades
        onPick={() => {}}
        onActivate={() => {}}
        loadOlder={async (before) =>
          request(`${cycle.portfolio_id}/charts/history`, "POST", {
            ...pane,
            before,
          })
        }
      />
    </div>
  );
}
