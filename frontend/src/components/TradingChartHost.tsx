import { useChartActivity } from "../../../shared/charts/chartActivity";
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Chart, { type Props, type LightweightChartState } from "./Chart";
import { useWebsiteChartRenderer } from "../hooks/useWebsiteChartRenderer";
import type { OHLCCandle, Order, BrokerSnapshot } from "../services/api";
const KLine = lazy(() => import("./WebsiteKLineChart"));
class ChartBoundary extends Component<
  { children: ReactNode; onFallback: () => void },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div role="alert">
        KLine could not load. Your session is still running.{" "}
        <button onClick={this.props.onFallback}>Use Lightweight</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export interface TradingChartProps extends Props {
  pendingStrategyIds?: ReadonlySet<string>;
  drawingRefreshKey?: number;
  onBrokerSnapshot?: (sessionId: string, snapshot: BrokerSnapshot) => void;
  liveChart?: boolean;
  realTrading?: boolean;
  chartKind?: string;
  drawingScope?: string;
  legacyDrawingScope?: string;
  swingChart?: boolean;
  onOrderDrag?: (order: Order, price: number) => Promise<Order | void>;
  onStrategyDrag?: (id: string, price: number) => Promise<void>;
  onStrategyCancel?: (id: string) => Promise<void>;
  onStrategyTargetProfitPct?: (id: string, pct: number) => Promise<void>;
}
export default function TradingChartHost(props: TradingChartProps) {
  const requestedRenderer = useWebsiteChartRenderer();
  const activity = useChartActivity();
  const [renderer, setRenderer] = useState(requestedRenderer);
  useEffect(() => {
    if (!activity) setRenderer(requestedRenderer);
  }, [requestedRenderer, activity]);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (renderer === "lightweight") setFallback(false);
  }, [renderer]);
  const lightweightState = useRef<LightweightChartState>({});
  const retained = useRef(new Map<number, OHLCCandle>());
  const identity = JSON.stringify([
    props.symbol,
    props.paneType,
    props.strike,
    props.expiry,
    props.right,
    props.intervalMinutes,
    props.tradingDate,
    props.markerSessionKey,
  ]);
  const last = useRef(identity);
  if (last.current !== identity) {
    last.current = identity;
    retained.current = new Map();
  }
  const capture = useCallback((candles: OHLCCandle[], replace: boolean) => {
    if (replace) retained.current = new Map(candles.map((c) => [c.time, c]));
    else
      for (const candle of candles) retained.current.set(candle.time, candle);
  }, []);
  return renderer === "kline" && !fallback ? (
    <ChartBoundary onFallback={() => setFallback(true)}>
      <Suspense
        fallback={
          <div role="status">
            Loading KLine…{" "}
            <button onClick={() => setFallback(true)}>Use Lightweight</button>
          </div>
        }
      >
        <KLine
          key={identity}
          {...props}
          retained={retained}
          onFallback={() => setFallback(true)}
        />
      </Suspense>
    </ChartBoundary>
  ) : (
    <>
      {fallback && (
        <div role="status">
          Using Lightweight for this chart.{" "}
          <button onClick={() => setFallback(false)}>Retry KLine</button>
        </div>
      )}
      <Chart
        {...props}
        lightweightState={lightweightState}
        onCandleState={capture}
        retainedCandles={retained}
      />
    </>
  );
}
