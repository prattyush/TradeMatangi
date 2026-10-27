import { chartAppearanceEvent } from './WebsiteChartAppearanceSettings';
import { createPortal } from "react-dom";
import { useWebsiteChartTools } from "./WebsiteChartTools";
import { beginChartActivity } from "../../../shared/charts/chartActivity";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { KLineChart } from "../../../shared/charts/KLineChart";
import {
  allIndicators,
  drawingTools,
  indicatorLabel,
} from "../../../shared/charts/catalogue";
import { openPositionTrades } from "../services/tradingChartState";
import { useKLineCandles } from "../hooks/useKLineCandles";
import type { TradingChartProps } from "./TradingChartHost";
import api, {
  _authHeaders,
  ApiError,
  type OHLCCandle,
  type Order,
  type SymbolInfo,
} from "../services/api";
import { rendererAccountKey } from "../services/websiteChartPreferences";
import type { Time } from "lightweight-charts";
import { BACKEND_URL } from "../config";
import { flashError } from "../services/notifications";
import { pendingOrderEdits } from "../../../shared/charts/pendingOrderEdits";
import type {
  DesktopOrder,
  DesktopTrade,
  DesktopTradingSettings,
  DesktopStrategy,
  Candle,
} from "../../../windowsapp/src/contracts";
import "../../../shared/charts/websiteKLine.css";
let catalogueRequest: Promise<SymbolInfo[]> | undefined;
// Stable sentinel: avoids a fresh [] (and the KLineChart effect re-runs that
// come with it) every render when props.openOrders is absent.
const EMPTY_ORDERS: DesktopOrder[] = [];
const defaults = {
  background: "#0d1117",
  textColor: "#c9d1d9",
  gridColor: "#30363d",
  gridOpacity: 0.5,
  gridStyle: "solid" as const,
  gridSize: 1,
  movingAverageType: "MA" as const,
  movingAveragePeriods: "9,21",
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
async function drawingRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${BACKEND_URL}/api/desktop/v1/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ..._authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : `Drawing request failed (${response.status})`,
    );
  return data;
}
export default function WebsiteKLineChart(
  props: TradingChartProps & {
    retained: MutableRefObject<Map<number, OHLCCandle>>;
  },
) {
  const sharedTools = useWebsiteChartTools();
  const toolsName = `${props.symbol}${props.paneType === "options" ? ` ${props.strike} ${props.right} · ${props.expiry}` : props.paneType === "futures" ? ` FUT · ${props.expiry}` : ""}`;
  useEffect(() => {
    if (sharedTools && (props.isActive ?? true)) return sharedTools.register(toolsName);
  }, [sharedTools, props.isActive, toolsName]);
  const [refresh, setRefresh] = useState(0);
  const { rows, loading, message } = useKLineCandles(
    { ...props, reloadKey: (props.reloadKey ?? 0) + refresh },
    props.retained,
  );
  const [catalogue, setCatalogue] = useState<SymbolInfo[]>([]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const attempt = () => {
      const request = catalogueRequest ?? (catalogueRequest = api.getSymbols().catch(error => { catalogueRequest = undefined; throw error; }));
      void request
        .then((value) => {
          if (!active) return;
          if (Array.isArray(value)) setCatalogue(value);
          else
            reportError(
              new Error(
                "Instrument catalogue is unavailable; retry chart data or change renderer in Settings",
              ),
            );
        })
        .catch((error) => {
          if (!active) return;
          reportError(error);
          delay = Math.min(delay * 2, 30000);
          timer = setTimeout(() => { if (active) attempt(); }, delay);
        });
    };
    attempt();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);
  const [settings, setSettings] = useState(defaults),
    [collapsed, setCollapsed] = useState(true);
  const indicatorKey = `website-kline-indicators:${rendererAccountKey()}:${props.symbol}:${props.paneType}:${props.right ?? ""}:${props.strike ?? ""}:${props.expiry ?? ""}`;
  const [indicators, setIndicators] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(indicatorKey) ?? "[]",
      );
      return Array.isArray(value)
        ? value.filter(
            (name): name is string =>
              typeof name === "string" && allIndicators.includes(name),
          )
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(indicatorKey, JSON.stringify(indicators));
    } catch {
      /* Optional local UI preference. */
    }
  }, [indicators, indicatorKey]);
  const [command, setCommand] = useState<{ id: number; tool: string } | null>(
    null,
  );
  const toggleIndicator = useCallback((name: string) => {
    setIndicators((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }, []);
  const selectDrawingTool = useCallback((tool: string) => {
    setCommand({ id: ++sequence.current, tool });
  }, []);
  const [action, setAction] = useState<{
    id: number;
    action: "delete" | "hide" | "lock";
  } | null>(null);
  const [mode, setMode] = useState<"once" | "repeat">("once"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const sequence = useRef(0),
    current = useRef(props);
  current.current = props;
  const reportError = useCallback((error: unknown) => {
    setError(String(error));
    flashError(error, "KLine");
  }, []);
  useEffect(() => {
    let active = true;
    const owner = rendererAccountKey();
    let changed = false;
    const apply = (next: Partial<typeof defaults> = {}) => {
      if (!active || rendererAccountKey() !== owner) return;
      setSettings({ ...defaults, ...next });
    };
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.owner === owner) { changed = true; apply(detail.settings); }
    };
    window.addEventListener(chartAppearanceEvent, onChange);
    void drawingRequest("chart-settings", "GET")
      .then((data) => {
        if (!changed) apply(data.settings);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.removeEventListener(chartAppearanceEvent, onChange);
    };
  }, []);
  const symbolInfo = catalogue.find((s) => s.symbol === props.symbol);
  const instrument = useMemo(
    () =>
      props.paneType === "options"
        ? {
            kind: "option",
            underlying: props.symbol,
            exchange: props.swingChart
              ? props.symbol === "BSESEN"
                ? "BFO"
                : "NFO"
              : props.symbol === "BSESEN"
                ? "BSE"
                : "NSE",
            right: props.right,
            strike: props.strike,
            expiry: props.expiry,
          }
        : props.paneType === "futures"
          ? {
              kind: "future",
              underlying: props.symbol,
              exchange: props.symbol === "BSESEN" ? "BFO" : "NFO",
              expiry: props.expiry,
            }
          : {
              kind: props.chartKind ?? symbolInfo?.chart_type ?? "equity",
              symbol: props.symbol,
              exchange: props.symbol === "BSESEN" ? "BSE" : "NSE",
            },
    [
      props.paneType,
      props.symbol,
      props.swingChart,
      props.right,
      props.strike,
      props.expiry,
      props.chartKind,
      symbolInfo?.chart_type,
    ],
  );
  const dragOrder = useCallback(async (order: DesktopOrder, price: number) => {
    if (busy || !current.current.onOrderDrag) return;
    if (pendingOrderEdits.get(order.session_id, order.order_id)) {
      reportError(
        new Error("Refresh Trade History before editing this order again"),
      );
      return;
    }
    const brokerOwned =
      props.realTrading &&
      Boolean(order.broker_order_id ?? order.kotak_order_id);
    const endActivity = beginChartActivity();
    setBusy(true);
    setError("");
    try {
      if (brokerOwned) pendingOrderEdits.begin(order, price);
      const updated = await current.current.onOrderDrag(
        order as unknown as Order,
        price,
      );
      if (brokerOwned) {
        pendingOrderEdits.acknowledged(
          order.session_id,
          order.order_id,
          updated || undefined,
        );
        try {
          const result = await api.reconcileKotakOrders(order.session_id);
          current.current.onBrokerSnapshot?.(order.session_id, result);
          pendingOrderEdits.reconcile(order.session_id, result.orders, result);
        } catch (e) {
          reportError(e);
        }
      }
    } catch (e) {
      if (brokerOwned)
        pendingOrderEdits.failed(
          order.session_id,
          order.order_id,
          e instanceof ApiError &&
            e.status >= 400 &&
            e.status < 500 &&
            ![408, 409, 429].includes(e.status),
        );
      reportError(e);
    } finally {
      setBusy(false);
      endActivity();
    }
  }, [busy, props.realTrading, reportError]);
  const convertedCandles = useMemo(
    () => rows.map((c) => ({ ...c, timestamp: c.time })),
    [rows],
  );
  const markerTrades = useMemo(() => {
    const trades = props.trades ?? [];
    const open = new Set(
      openPositionTrades(trades).map((trade) => trade.trade_id),
    );
    return trades.map((trade) => ({
      ...trade,
      is_open: open.has(trade.trade_id),
    })) as unknown as DesktopTrade[];
  }, [props.trades]);
  const position = props.position ?? null;
  const strategies = useMemo(
    () =>
      (props.targetProfitStrategies ?? []).filter(
        (s) =>
          s.symbol === props.symbol &&
          s.status === "RUNNING" &&
          (!s.expiry ||
            s.expiry === props.expiry ||
            props.paneType !== "options") &&
          (s.strike == null ||
            props.paneType !== "options" ||
            s.strike === props.strike) &&
          props.strategyPaneActive &&
          (["UnderlyingTargetProfit", "UnderlyingStoploss"].includes(
            s.strategy_type,
          )
            ? props.paneType !== "options"
            : (s.right ?? null) === (props.right ?? null)),
      ),
    [
      props.targetProfitStrategies,
      props.symbol,
      props.expiry,
      props.paneType,
      props.strike,
      props.strategyPaneActive,
      props.right,
    ],
  );
  const chartSettings = useMemo(
    () =>
      ({
        desktop_hide_chart_labels: !settings.showChartInfo,
        desktop_pnl_display_mode: props.pnlPctMode ? "percent" : "currency",
      }) as DesktopTradingSettings,
    [settings.showChartInfo, props.pnlPctMode],
  );
  const pricePickAction = useMemo(
    () => (props.onPriceSelect ? { label: props.pricePickLabel } : null),
    [props.onPriceSelect, props.pricePickLabel],
  );
  const handleStrategyDrag = useCallback(
    async (id: string, price: number) => {
      try {
        await props.onStrategyDrag!(id, price);
      } catch (e) {
        reportError(e);
      }
    },
    [props.onStrategyDrag, reportError],
  );
  const context = (price: number, x: number, y: number) =>
    props.onContextMenu?.(price, x, y, {
      paneType: props.paneType ?? "equity",
      right: props.right,
      hasPosition: Boolean(
        position && position.side !== "FLAT" && position.quantity,
      ),
      hasOpenOrders: Boolean(props.openOrders?.length),
      hasSLOrders: !!props.openOrders?.some(
        (o) => o.is_stoploss || o.order_type === "STOPLOSS",
      ),
    });
  const drawingAndIndicatorTools = (
    <aside
            onPointerDownCapture={() => props.onActivate?.()}
            className="website-kline-tools"
            aria-label="KLine drawing and indicator tools"
          >
            <label>
              Drawing mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "once" | "repeat")}
              >
                <option value="once">Once</option>
                <option value="repeat">Repeat</option>
              </select>
            </label>
            <div>
              {drawingTools.map((t) => (
                <button
                  key={t.tool}
                  title={
                    rows.length ? t.label : "Load chart candles before drawing"
                  }
                  aria-label={t.label}
                  disabled={!rows.length || loading || !!props.onPriceSelect}
                  onClick={() => selectDrawingTool(t.tool)}
                >
                  {t.icon}
                </button>
              ))}
            </div>
            <div>
              {(["lock", "hide", "delete"] as const).map((value) => (
                <button
                  key={value}
                  title={`${value} selected drawing`}
                  onClick={() =>
                    setAction({ id: ++sequence.current, action: value })
                  }
                >
                  {value === "lock" ? "🔒" : value === "hide" ? "◌" : "⌫"}
                </button>
              ))}
            </div>
            <strong>Indicators</strong>
            <div className="website-kline-indicator-grid">
            {allIndicators.map((name) => (
              <button
                key={name}
                aria-pressed={indicators.includes(name)}
                onClick={() => toggleIndicator(name)}
              >
                {indicatorLabel(name)}
              </button>
            ))}
            <button onClick={() => setIndicators([])}>Clear indicators</button>
            </div>
          </aside>
  );
  if (
    props.paneType === "options" &&
    (!props.strike || !props.expiry || !props.right)
  )
    return (
      <div role="status">
        Choose an exact option contract to display this chart.
      </div>
    );
  if (props.paneType === "futures" && !props.expiry)
    return (
      <div role="status">
        Choose an exact Futures contract to display this chart.
      </div>
    );
  if (!props.chartKind && !symbolInfo)
    return (
      <div role="status">
        {error || "Loading chart instrument…"}{" "}
        <button onClick={() => { catalogueRequest = undefined; setRefresh(v => v + 1); }}>Retry chart data</button> <span>Change chart renderer in Settings.</span>
      </div>
    );
  return (
    <div className="website-kline" style={{ height: props.height ?? 350 }}>
      {message && rows.length > 0 && (
        <div role="status" className="website-kline-error">
          {message}
        </div>
      )}
      {error && (
        <div role="alert" className="website-kline-error">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      <div className="website-kline-body">
        {sharedTools
          ? (props.isActive ?? true) && sharedTools.container && createPortal(drawingAndIndicatorTools, sharedTools.container)
          : !collapsed && drawingAndIndicatorTools}
        <KLineChart
          symbol={
            props.paneType === "options"
              ? `${props.symbol} ${props.strike} ${props.right} · ${props.expiry}`
              : props.paneType === "futures"
                ? `${props.symbol} FUT · ${props.expiry}`
                : props.symbol
          }
          interval={
            props.intervalMinutes === 1440 ? "1D" : `${props.intervalMinutes}m`
          }
          supportedIntervals={
            props.onIntervalChange
              ? [...new Set([1, 3, 5, 15, 30, 60, props.intervalMinutes])].sort(
                  (a, b) => a - b,
                )
              : []
          }
          onIntervalChange={(v) => props.onIntervalChange?.(Number(v))}
          candles={convertedCandles}
          loading={loading && !rows.length}
          message={rows.length ? "" : message}
          loadOlder={
            props.externalLoadOlder
              ? async (before) =>
                  (await props.externalLoadOlder!(before)) as {
                    candles: Candle[];
                    more: boolean;
                  }
              : undefined
          }
          initialTimeRange={
            props.initialVisibleRange &&
            Number.isFinite(Number(props.initialVisibleRange.from)) &&
            Number.isFinite(Number(props.initialVisibleRange.to))
              ? {
                  from: Number(props.initialVisibleRange.from),
                  to: Number(props.initialVisibleRange.to),
                }
              : undefined
          }
          onTimeRangeChange={(range) =>
            props.onVisibleRangeChange?.({
              from: range.from as Time,
              to: range.to as Time,
            })
          }
          viewportResetKey={`${props.symbol}:${props.intervalMinutes}:${props.tradingDate}`}
          drawingRefreshKey={(props.drawingRefreshKey ?? 0) + refresh}
          settings={settings}
          isReplaying={props.historyMode === "replay"}
          isLive={props.intervalMinutes < 1440 && (props.liveChart ?? props.historyMode === "live")}
          countdownTime={props.intervalMinutes < 1440 && props.historyMode !== "live" ? props.currentSimTime ?? props.latestTick?.time ?? undefined : undefined}
          instrument={instrument}
          baseUrl={BACKEND_URL}
          drawingRequest={drawingRequest}
          onDrawingError={reportError}
          hideInstrumentPicker
          hideMaximizeButton={!props.onMaximize}
          onConfigure={() => {}}
          onMaximize={() => props.onMaximize?.()}
          maximized={props.isMaximized ?? false}
          active={props.isActive ?? true}
          onActivate={() => props.onActivate?.()}
          onTogglePanel={!sharedTools ? () => setCollapsed((v) => !v) : undefined}
          onToggleIndicator={toggleIndicator}
          onSelectDrawingTool={selectDrawingTool}
          onReload={() => {
            props.retained.current.clear();
            setRefresh((v) => v + 1);
            props.onManualRefresh?.();
          }}
          busy={busy}
          swapTargets={props.swapTargets?.map((t) => ({ ...t, label: "Move chart" }))}
          indicators={indicators}
          drawingCommand={command}
          drawingAction={action}
          drawingMode={mode}
          onDrawingComplete={() => setCommand(null)}
          shareDayDrawings
          legacyDrawingScope={props.legacyDrawingScope}
          candleAnchorSeconds={props.candleAnchorSeconds}
          externalTradeMarkers={props.externalTradeMarkers}
          showHistoricalMarkers={props.defaultShowAllMarkers}
          trades={markerTrades}
          openOrders={(props.openOrders as DesktopOrder[] | undefined) ?? EMPTY_ORDERS}
          strategies={strategies as DesktopStrategy[]}
          position={position}
          authoritativePnl={props.pnl}
          pnlAvailable={props.pnlAvailable}
          pendingStrategyIds={props.pendingStrategyIds}
          levelsPosition={props.positionLevelsMatch === false ? null : position}
          sessionCapital={props.sessionCapital}
          brokeragePerOrder={props.brokeragePerOrder}
          aggregatePnl={props.aggregatePnl}
          tradingSettings={chartSettings}
          readOnlyOrders
          tradingEnabled={!!props.onContextMenu || !!props.onPriceSelect}
          pricePickAction={pricePickAction}
          onPricePickCancel={props.onCancelPricePick}
          onPricePick={(price) => {
            if (Number.isFinite(price) && price > 0)
              props.onPriceSelect?.(price);
          }}
          onSwingChartContext={context}
          onOrderSelect={
            props.onOrderSelect as ((o: DesktopOrder) => void) | undefined
          }
          onOrderDrag={props.onOrderDrag ? dragOrder : undefined}
          onStrategyDrag={props.onStrategyDrag ? handleStrategyDrag : undefined}
          onStrategyCancel={props.onStrategyCancel}
          onStrategyTargetProfitPct={props.onStrategyTargetProfitPct}
        />
      </div>
    </div>
  );
}
