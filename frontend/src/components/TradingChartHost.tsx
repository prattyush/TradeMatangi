import { useChartActivity } from "../../../shared/charts/chartActivity";
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Chart, { type Props, type LightweightChartState } from "./Chart";
import { useWebsiteChartRenderer } from "../hooks/useWebsiteChartRenderer";
import type { OHLCCandle, Order, BrokerSnapshot } from "../services/api";
import { flashError } from "../services/notifications";
class ChartBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("KLine chart failed", error, info.componentStack);
    flashError(error, "KLine chart");
  }
  render() {
    return this.state.error ? <div role="alert">
      KLine could not load or render. Trading controls remain available.{' '}
      <button onClick={this.props.onRetry}>Retry chart</button>
      <div>Change chart renderer in Settings. If Retry fails, refresh the page.</div>
      <details><summary>Chart error details</summary>{this.state.error.message}</details>
    </div> : this.props.children;
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
  const [attempt, setAttempt] = useState(0);
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
  const KLine = useMemo(() => lazy(() => import("./WebsiteKLineChart")), [attempt, identity]);
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
  return renderer === "kline" ? (
    <ChartBoundary key={`${identity}:${attempt}`} onRetry={() => setAttempt(v => v + 1)}>
      <Suspense
        fallback={
          <div role="status">
            Loading KLine… Change renderer in Settings if loading does not finish.
          </div>
        }
      >
        <KLine
          key={identity}
          {...props}
          retained={retained}
        />
      </Suspense>
    </ChartBoundary>
  ) : (
    <>
      <Chart
        {...props}
        lightweightState={lightweightState}
        onCandleState={capture}
        retainedCandles={retained}
      />
    </>
  );
}
