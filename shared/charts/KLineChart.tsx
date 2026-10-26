import { bindChartMenu, ChartMenuButton, useChartMenuGesture, type MenuPoint } from "./ChartMenuGesture";
import { beginChartActivity } from "./chartActivity";
import { usePendingOrderEdits } from "./pendingOrderEdits";
import { snapSwingPrice, swingOrderTick } from "../swingOrderPrice";
import {
  beginPerformanceSample,
  endPerformanceSample,
} from "../../frontend/src/services/performanceDiagnostics";
import {
  canonicalDrawingKey as canonicalInstrumentKey,
  drawingIdentity,
} from "./drawingIdentity";
import {
  announceDrawingChange as localAnnounce,
  watchDrawingChanges as localWatch,
} from "./drawingEvents";
import { useEffect, useRef, useState } from "react";
import { useDismissMessage } from "./useDismissMessage";
import {
  dispose,
  init,
  registerOverlay,
  type Chart,
  type KLineData,
} from "klinecharts";
import { registerExtensions } from "react-klinecharts-ui/extensions";
import type {
  Candle,
  DesktopOrder,
  DesktopPosition,
  DesktopStrategy,
  DesktopTrade,
  DesktopTradingSettings,
} from "../../windowsapp/src/contracts";
import { formatCandleCloseCountdown } from "../../windowsapp/src/liveCountdown";
import { buildTradeMarkers } from "./tradeMarkers";
import { targetProfitLabel, targetProfitLinePrice } from "./targetProfitLabel";
import { positionPnlLevels, type PositionPnlLevel } from "./positionPnlLevels";
import { TradingOverlayRegistry } from "./tradingOverlays";
import { drawingTools, indicatorLabel } from "./catalogue";

interface ChartSettings {
  background: string;
  textColor: string;
  gridColor: string;
  gridOpacity: number;
  gridStyle: "solid" | "dashed";
  gridSize: number;
  movingAverageType: "MA" | "EMA";
  movingAveragePeriods: string;
  showChartInfo: boolean;
  horizontalLineColor: string;
  horizontalLineWidth: number;
  trendLineColor: string;
  trendLineWidth: number;
  drawingLineColor: string;
  drawingLineWidth: number;
  drawingFillColor: string;
  drawingFillOpacity: number;
}
const withOpacity = (hex: string, opacity: number) =>
  `${hex}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;
const applyChartStyles = (chart: Chart, settings: ChartSettings) =>
  chart.setStyles({
    grid: {
      horizontal: {
        show: true,
        color: withOpacity(settings.gridColor, settings.gridOpacity),
        style: settings.gridStyle,
        size: settings.gridSize,
        dashedValue: [2, 2],
      },
      vertical: {
        show: true,
        color: withOpacity(settings.gridColor, settings.gridOpacity),
        style: settings.gridStyle,
        size: settings.gridSize,
        dashedValue: [2, 2],
      },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true,
        line: {
          show: true,
          color: "#94a3b8",
          style: "dashed",
          size: 1,
          dashedValue: [4, 2],
        },
      },
      vertical: {
        show: true,
        line: {
          show: true,
          color: "#94a3b8",
          style: "dashed",
          size: 1,
          dashedValue: [4, 2],
        },
      },
    },
    candle: {
      tooltip: { showRule: settings.showChartInfo ? "always" : "none" },
    },
    indicator: {
      tooltip: { showRule: settings.showChartInfo ? "always" : "none" },
    },
    xAxis: { tickText: { color: settings.textColor } },
    yAxis: { tickText: { color: settings.textColor } },
  });

const demo: Candle[] = [
  { timestamp: 1746522900, open: 23100, high: 23124, low: 23080, close: 23112 },
  { timestamp: 1746522960, open: 23112, high: 23140, low: 23101, close: 23132 },
  { timestamp: 1746523020, open: 23132, high: 23148, low: 23120, close: 23125 },
];

let extensionsRegistered = false;
const ensureExtensions = () => {
  if (extensionsRegistered) return;
  registerExtensions();
  registerOverlay({
    name: "desktopTradeMarker",
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const coordinate = coordinates[0];
      const marker = overlay.extendData as { color: string; text: string };
      if (!coordinate || !marker) return [];
      return [
        {
          type: "circle",
          attrs: { x: coordinate.x, y: coordinate.y, r: 3 },
          styles: { style: "fill", color: marker.color },
          ignoreEvent: true,
        },
        ...(marker.text
          ? [
              {
                type: "text",
                attrs: {
                  x: coordinate.x,
                  y: coordinate.y - 6,
                  text: marker.text,
                  align: "center",
                  baseline: "bottom",
                },
                styles: {
                  color: marker.color,
                  size: 8,
                  family: "Inter, system-ui, sans-serif",
                  weight: "bold",
                },
                ignoreEvent: true,
              },
            ]
          : []),
      ];
    },
  });
  extensionsRegistered = true;
};

interface DrawingCommand {
  id: number;
  tool: string;
}
interface DrawingAction {
  id: number;
  action: "delete" | "hide" | "lock";
}
type DrawingMode = "once" | "repeat";
type OrderAction =
  | "FILL_MISSING_SL"
  | "USE_SL_BUY"
  | "USE_SL_SELL"
  | "BULK_LIMIT"
  | "BULK_MOVE_SL"
  | "START_TARGET_PROFIT"
  | "START_TARGET_PROFIT_HALF"
  | "START_UNDERLYING_TARGET_HALF"
  | "START_LOCK_PROFIT"
  | "START_AGGRESSIVE_SL"
  | "START_BREAKEVEN"
  | "START_UNDERLYING_TARGET"
  | "START_UNDERLYING_SL"
  | "START_UNDERLYING_SL_HALF";
type ConversionTarget = "LIMIT" | "STOPLOSS" | "TARGET";
type PricePickAction = {
  label?: string;
  orderId?: string;
  conversion?: ConversionTarget;
  ticket?: unknown;
  missingSl?: { quantity: number };
};
interface FloatingLabel {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
}
interface PersistedDrawing {
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
interface DrawingRecord {
  drawing_id: string;
  revision: number;
  drawing: PersistedDrawing;
}
interface TileSwap {
  dir: string;
  label: string;
  onClick: () => void;
}
interface LocalDrawing {
  dirty?: boolean;
  id: string;
  backendId?: string;
  revision?: number;
  drawing: PersistedDrawing;
  locked: boolean;
  hidden: boolean;
}
type DrawingRequest = (
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
) => Promise<unknown>;
const overlayName = (tool: string) =>
  tool === "Trend"
    ? "segment"
    : tool === "Horizontal"
      ? "horizontalStraightLine"
      : tool === "Fib Retracement"
        ? "fibonacciLine"
        : tool;
const drawingPoints = (drawing: PersistedDrawing) =>
  drawing.points.map((point) => ({
    timestamp: point.timestamp * 1000,
    value: point.price,
  }));
const orderPrice = (order: DesktopOrder) =>
  order.order_type === "LIMIT" ? order.limit_price : order.trigger_price;
const orderLineLabel = (
  order: DesktopOrder,
  position?: DesktopPosition | null,
  settings?: DesktopTradingSettings | null,
  sessionCapital = 0,
) => {
  const qty = compactQty(order.quantity);
  const isSl = order.order_type === "STOPLOSS" || order.is_stoploss;
  if (
    position &&
    position.side !== "FLAT" &&
    ((position.side === "LONG" && order.side === "SELL") ||
      (position.side === "SHORT" && order.side === "BUY"))
  ) {
    const dir = position.side === "LONG" ? 1 : -1;
    const pnl =
      dir *
      (orderPrice(order) - position.avg_entry_price) *
      Math.min(order.quantity, position.quantity);
    if (settings?.desktop_pnl_display_mode === "percent") {
      const base = Math.max(1, sessionCapital);
      return `${isSl ? "SL" : order.order_type === "LIMIT" ? "L" : "T"}${isSl ? ` ${qty}` : ""} ${pnl >= 0 ? "+" : ""}${((pnl / base) * 100).toFixed(1)}%`;
    }
    return `${isSl ? "SL" : order.order_type === "LIMIT" ? "L" : "T"}${isSl ? ` ${qty}` : ""} ${pnl >= 0 ? "+" : ""}${Math.round(pnl)}`;
  }
  return `${order.side === "BUY" ? "B" : "S"}${order.order_type === "LIMIT" ? "L" : order.order_type === "STOPLOSS" ? "SL" : "T"} ${qty}`;
};
const compactQty = (value: number) =>
  value >= 100000
    ? `${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L`
    : value >= 1000
      ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`
      : String(value);
const orderColor = (order: DesktopOrder, selected: boolean) =>
  selected
    ? "#facc15"
    : order.order_type === "STOPLOSS" || order.is_stoploss
      ? "#ef4444"
      : order.order_type === "TARGET"
        ? "#22c55e"
        : "#60a5fa";
const placeNearPoint = (
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const preferredLeft =
    x + 10 + width <= window.innerWidth - 8 ? x + 10 : x - width - 10;
  const preferredTop =
    y + 10 + height <= window.innerHeight - 8 ? y + 10 : y - height - 10;
  return {
    left: Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8)),
    top: Math.max(56, Math.min(preferredTop, window.innerHeight - height - 8)),
  };
};

export function KLineChart({
  initialTimeRange,
  onTimeRangeChange,
  drawingRefreshKey,
  reportChartDiagnostic = () => {},
  drawingEvents,
  shareDayDrawings = false,
  externalTradeMarkers = false,
  legacyDrawingScope,
  drawingScope,
  candleAnchorSeconds = 0,
  hideInstrumentPicker = false,
  hideMaximizeButton = false,
  onTogglePanel,
  onToggleIndicator,
  onSelectDrawingTool,
  onReload,
  busy = false,
  readOnlyOrders = false,
  symbol,
  interval,
  supportedIntervals,
  onIntervalChange,
  candles = demo,
  loadOlder,
  viewportResetKey,
  loading,
  message,
  settings,
  isReplaying,
  isLive,
  countdownTime,
  instrument,
  baseUrl,
  drawingRequest,
  onDrawingError,
  onConfigure,
  onMaximize,
  maximized,
  active,
  indicators,
  drawingCommand,
  drawingAction,
  drawingMode,
  onDrawingComplete,
  onActivate,
  trades = [],
  openOrders = [],
  strategies = [],
  position = null,
  levelsPosition = null,
  brokeragePerOrder = 1,
  aggregatePnl,
  positionMarkPrice,
  authoritativePnl,
  pnlAvailable = true,
  pendingStrategyIds,
  sessionCapital = 0,
  lotSize = 1,
  tradingSettings = null,
  tradingEnabled = false,
  orderEntryEnabled = false,
  entryUnavailableReason = null,
  shortEntryEnabled = false,
  underlyingStrategyEnabled = false,
  showHistoricalMarkers = false,
  onToggleHistoricalMarkers,
  pricePickAction = null,
  onPricePick,
  onPricePickCancel,
  onOrderSelect,
  onSwingChartContext,
  onOrderDrag,
  onStrategyDrag,
  onStrategyTargetProfitPct,
  onStrategyCancel,
  onOrderCancel,
  onOrderConvertRequest,
  onOrderQuantityUpdate,
  onChartOrderAction,
  swapTargets = [],
}: {
  initialTimeRange?: { from: number; to: number };
  onTimeRangeChange?: (range: { from: number; to: number }) => void;
  drawingRefreshKey?: number;
  reportChartDiagnostic?: (
    kind: string,
    payload: Record<string, unknown>,
  ) => void;
  drawingEvents?: { announce: typeof localAnnounce; watch: typeof localWatch };
  shareDayDrawings?: boolean;
  externalTradeMarkers?: boolean;
  legacyDrawingScope?: string;
  drawingScope?: string;
  candleAnchorSeconds?: number;
  hideInstrumentPicker?: boolean;
  hideMaximizeButton?: boolean;
  onTogglePanel?: () => void;
  onToggleIndicator?: (name: string) => void;
  onSelectDrawingTool?: (tool: string) => void;
  onReload?: () => void;
  busy?: boolean;
  readOnlyOrders?: boolean;
  symbol: string;
  interval: string;
  supportedIntervals: number[];
  onIntervalChange: (interval: string) => void;
  candles?: Candle[];
  loadOlder?: (
    beforeTimestamp: number,
  ) => Promise<{ candles: Candle[]; more: boolean }>;
  viewportResetKey?: string;
  loading: boolean;
  message: string;
  settings: ChartSettings;
  isReplaying: boolean;
  isLive: boolean;
  /** Replay market clock, in the same seconds used by candles. Omit for live wall clock. */
  countdownTime?: number;
  replayDatasetKey?: string;
  instrument: Record<string, unknown>;
  baseUrl: string;
  drawingRequest: DrawingRequest;
  onDrawingError?: (error: unknown) => void;
  onConfigure: () => void;
  onMaximize: () => void;
  maximized: boolean;
  active: boolean;
  indicators: string[];
  drawingCommand: DrawingCommand | null;
  drawingAction: DrawingAction | null;
  drawingMode: DrawingMode;
  onDrawingComplete: (commandId: number, tool: string) => void;
  onActivate: () => void;
  trades?: DesktopTrade[];
  openOrders?: DesktopOrder[];
  strategies?: DesktopStrategy[];
  position?: DesktopPosition | null;
  levelsPosition?: DesktopPosition | null;
  brokeragePerOrder?: number;
  aggregatePnl?: number;
  positionMarkPrice?: number;
  authoritativePnl?: number;
  pnlAvailable?: boolean;
  pendingStrategyIds?: ReadonlySet<string>;
  sessionCapital?: number;
  lotSize?: number;
  tradingSettings?: DesktopTradingSettings | null;
  tradingEnabled?: boolean;
  orderEntryEnabled?: boolean;
  entryUnavailableReason?: string | null;
  shortEntryEnabled?: boolean;
  underlyingStrategyEnabled?: boolean;
  showHistoricalMarkers?: boolean;
  onToggleHistoricalMarkers?: () => void;
  pricePickAction?: PricePickAction | null;
  onPricePick?: (price: number) => void;
  onPricePickCancel?: () => void;
  onOrderSelect?: (order: DesktopOrder) => void;
  onSwingChartContext?: (price: number, x: number, y: number) => void;
  onOrderDrag?: (order: DesktopOrder, price: number) => void;
  onStrategyDrag?: (strategyId: string, price: number) => void | Promise<void>;
  onStrategyTargetProfitPct?: (
    strategyId: string,
    percentage: number,
  ) => Promise<void>;
  onStrategyCancel?: (strategyId: string) => Promise<void>;
  onOrderCancel?: (order: DesktopOrder) => void;
  onOrderConvertRequest?: (
    order: DesktopOrder,
    target: ConversionTarget,
  ) => void;
  onOrderQuantityUpdate?: (
    order: DesktopOrder,
    quantity: number,
  ) => Promise<void>;
  onChartOrderAction?: (
    action: OrderAction,
    price: number,
    anchor: { x: number; y: number },
  ) => void;
  swapTargets?: TileSwap[];
}) {
  const announceDrawingChange = drawingEvents?.announce ?? localAnnounce;
  const watchDrawingChanges = drawingEvents?.watch ?? localWatch;
  const pendingEdits = usePendingOrderEdits();
  const pendingRevision = pendingEdits.snapshot();
  void baseUrl;
  const element = useRef<HTMLDivElement>(null);
  const [historicalMarkersVisible, setHistoricalMarkersVisible] = useState(
    showHistoricalMarkers,
  );
  const [indicatorsMenuOpen, setIndicatorsMenuOpen] = useState(false);
  const [drawMenuOpen, setDrawMenuOpen] = useState(false);
  const [intervalMenuOpen, setIntervalMenuOpen] = useState(false);
  const indicatorsMenuRef = useRef<HTMLSpanElement>(null);
  const drawMenuRef = useRef<HTMLSpanElement>(null);
  const intervalMenuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!indicatorsMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (
        indicatorsMenuRef.current &&
        !indicatorsMenuRef.current.contains(event.target as Node)
      )
        setIndicatorsMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [indicatorsMenuOpen]);
  useEffect(() => {
    if (!drawMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (drawMenuRef.current && !drawMenuRef.current.contains(event.target as Node))
        setDrawMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [drawMenuOpen]);
  useEffect(() => {
    if (!intervalMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (
        intervalMenuRef.current &&
        !intervalMenuRef.current.contains(event.target as Node)
      )
        setIntervalMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [intervalMenuOpen]);
  const strategySavesRef = useRef(new Set<string>());
  const chartRef = useRef<Chart | null>(null);
  const positionLevelFallbackRef = useRef<{
    key: string;
    timestamp: number;
  } | null>(null);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const [historyError, setHistoryError] = useState("");
  const initialViewportRef = useRef(false);
  const timeRangeCallbackRef = useRef(onTimeRangeChange);
  timeRangeCallbackRef.current = onTimeRangeChange;
  const initialTimeRangeRef = useRef(initialTimeRange);
  const [geometryVersion, setGeometryVersion] = useState(0);
  const viewportResetRef = useRef(viewportResetKey);
  const menuGesture = useChartMenuGesture();
  const candlesRef = useRef(candles);
  const renderedCandlesRef = useRef<Candle[]>([]);
  const subscribeBarRef = useRef<((data: KLineData) => void) | null>(null);
  const lastDrawingCommandRef = useRef(0);
  const lastDrawingActionRef = useRef(0);
  const drawingModeRef = useRef<DrawingMode>(drawingMode);
  const drawingOverlayIdsRef = useRef<Set<string>>(new Set());
  const drawingsRef = useRef<LocalDrawing[]>([]);
  const createPersistedOverlayRef = useRef<(record: DrawingRecord) => void>(
    () => undefined,
  );
  const [drawings, setDrawings] = useState<LocalDrawing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedOrderQty, setSelectedOrderQty] = useState("");
  const [savingOrderQty, setSavingOrderQty] = useState(false);
  const [orderQtyError, setOrderQtyError] = useState("");
  useDismissMessage(orderQtyError, setOrderQtyError, 10_000);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    price: number;
  } | null>(null);
  const [selectedOrderAnchor, setSelectedOrderAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    null,
  );
  const [selectedStrategyAnchor, setSelectedStrategyAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [targetProfitPctDraft, setTargetProfitPctDraft] = useState("");
  const [savingTargetProfitPct, setSavingTargetProfitPct] = useState(false);
  const [deletingTargetProfit, setDeletingTargetProfit] = useState(false);
  const targetProfitBusy = savingTargetProfitPct || deletingTargetProfit;
  const [targetProfitPctError, setTargetProfitPctError] = useState("");
  const [floatingLabels, setFloatingLabels] = useState<FloatingLabel[]>([]);
  const [positionLevelGeometry, setPositionLevelGeometry] = useState<
    Array<
      PositionPnlLevel & {
        x: number;
        y: number;
        width: number;
        labelLeft: boolean;
      }
    >
  >([]);
  const [pnlLabel, setPnlLabel] = useState<FloatingLabel | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const indicatorKey = indicators.join("|");
  const tradingOverlaysRef = useRef(new TradingOverlayRegistry());
  const swingInteractions = useRef({ onOrderSelect, onSwingChartContext });
  swingInteractions.current = { onOrderSelect, onSwingChartContext };
  const swingDragPending = useRef(new Set<string>());
  const swingDragGesture = useRef(
    new Map<string, { price: number; moved: boolean; ignoreUntil: number }>(),
  );
  const tradingOverlayInputsRef = useRef({
    openOrders,
    strategies,
    position,
    sessionCapital,
    onOrderDrag,
    onStrategyDrag,
  });
  tradingOverlayInputsRef.current = {
    openOrders,
    strategies,
    position,
    sessionCapital,
    onOrderDrag,
    onStrategyDrag,
  };
  const tradeMarkersRef = useRef(new TradingOverlayRegistry());
  const pricePickActionRef = useRef(pricePickAction);
  const onPricePickRef = useRef(onPricePick);
  const tradingEnabledRef = useRef(tradingEnabled);
  const onChartOrderActionRef = useRef(onChartOrderAction);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const { writeInstrument: drawingInstrument, readKeys: drawingReadKeys } =
    drawingIdentity(
      instrument,
      drawingScope,
      legacyDrawingScope,
      shareDayDrawings,
    );
  const drawingInstrumentKey = canonicalInstrumentKey(drawingInstrument);
  const drawingReadSignature = JSON.stringify(drawingReadKeys);
  const drawingContextRef = useRef(drawingInstrumentKey);
  drawingContextRef.current = drawingInstrumentKey;
  const previousDrawingContextRef = useRef(drawingInstrumentKey);
  const previousDrawingRefreshRef = useRef(drawingRefreshKey);
  const drawingOwner = useRef(crypto.randomUUID());
  const reloadDrawingsRef = useRef<() => void>(() => undefined);
  const drawingBusyRef = useRef(0);
  const drawingSavesRef = useRef(new Set<string>());
  const [drawingNotice, setDrawingNotice] = useState("");
  const drawingGestureRef = useRef(false);
  const menuEditingUntil = useRef(0);
  const gestureEndRef = useRef<(() => void) | null>(null);
  const setDrawingGesture = (active: boolean) => {
    drawingGestureRef.current = active;
    if (active && !gestureEndRef.current)
      gestureEndRef.current = beginChartActivity();
    if (!active) {
      gestureEndRef.current?.();
      gestureEndRef.current = null;
    }
  };
  useEffect(
    () => () => {
      gestureEndRef.current?.();
    },
    [],
  );
  const latestPositionFill = trades.reduce((latest, trade) => {
    const matches =
      instrument.kind === "future"
        ? trade.instrument_type === "futures" &&
          trade.symbol === instrument.underlying &&
          trade.expiry === instrument.expiry
        : instrument.kind === "option"
          ? trade.symbol === instrument.underlying &&
            trade.right === instrument.right &&
            trade.strike === instrument.strike &&
            (!trade.expiry || trade.expiry === instrument.expiry)
          : trade.symbol === instrument.symbol && !trade.right;
    return matches ? Math.max(latest, trade.timestamp) : latest;
  }, 0);
  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);
  useEffect(() => {
    pricePickActionRef.current = pricePickAction;
    onPricePickRef.current = onPricePick;
    tradingEnabledRef.current = tradingEnabled;
    onChartOrderActionRef.current = onChartOrderAction;
  }, [pricePickAction, onPricePick, tradingEnabled, onChartOrderAction]);
  const fitChart = () => {
    const chart = chartRef.current;
    const container = element.current;
    const data = renderedCandlesRef.current.length
      ? renderedCandlesRef.current
      : candlesRef.current;
    if (!chart || !container || data.length === 0) return;
    const width = Math.max(1, container.clientWidth);
    const nextBarSpace = Math.max(
      1,
      Math.min(18, width / Math.max(data.length + 8, 1)),
    );
    try {
      chart.setBarSpace(nextBarSpace);
      chart.setOffsetRightDistance(8);
      chart.scrollToDataIndex(data.length - 1, 0);
      chart.resize();
      reportChartDiagnostic("fit_success", {
        symbol,
        interval,
        candle_count: data.length,
      });
    } catch (error) {
      reportChartDiagnostic("fit_error", {
        symbol,
        interval,
        candle_count: data.length,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  };
  useEffect(() => {
    drawingModeRef.current = drawingMode;
  }, [drawingMode]);
  useEffect(() => {
    if (!isLive) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive]);
  useEffect(() => {
    if (!element.current) return;
    let chart: Chart | null = null;
    try {
      ensureExtensions();
      chart = init(element.current);
      if (!chart) {
        reportChartDiagnostic("chart_init_empty", { symbol, interval });
        return;
      }
      chartRef.current = chart;
      // Backend candle timestamps deliberately encode IST market wall-clock time
      // as UTC-labelled seconds. Rendering as UTC prevents KLineCharts from
      // applying the machine/Asia-Kolkata offset a second time.
      chart.setTimezone("Etc/UTC");
      applyChartStyles(chart, settings);
      chart.setSymbol({
        ticker: symbol,
        pricePrecision: 2,
        volumePrecision: 0,
      });
      chart.setPeriod(
        interval === "1D"
          ? { span: 1, type: "day" }
          : { span: Number(interval.replace("m", "")), type: "minute" },
      );
      initialViewportRef.current = false;
      chart.setDataLoader({
        getBars: async ({ type, timestamp, callback }) => {
          const toBar = (candle: Candle) => ({
            timestamp: candle.timestamp * 1000,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume ?? 0,
          });
          if (
            type !== "forward" ||
            !loadOlderRef.current ||
            timestamp == null
          ) {
            callback(type === "init" ? candlesRef.current.map(toBar) : [], {
              forward: Boolean(loadOlderRef.current),
              backward: false,
            });
            return;
          }
          const owner = chart;
          try {
            let page = await loadOlderRef.current(timestamp / 1000);
            // Empty holiday buckets advance the cursor rather than requiring a
            // new gesture. The backend enforces a finite calendar window.
            for (let i = 0; !page.candles.length && page.more && i < 7; i++)
              page = await loadOlderRef.current(timestamp / 1000);
            if (chartRef.current !== owner) return;
            const rows = page.candles.filter(
              (c) => c.timestamp * 1000 < timestamp,
            );
            renderedCandlesRef.current = [
              ...rows,
              ...renderedCandlesRef.current,
            ];
            setHistoryError("");
            callback(rows.map(toBar), { forward: page.more, backward: false });
          } catch (error) {
            if (chartRef.current !== owner) return;
            setHistoryError(String(error));
            callback([], { forward: true, backward: false });
          }
        },
        subscribeBar: ({ callback }) => {
          subscribeBarRef.current = callback;
        },
        unsubscribeBar: () => {
          subscribeBarRef.current = null;
        },
      });
      // KLineCharts recreates its canvas for interval changes. Re-apply the
      // already loaded persisted drawings locally; this is not a backend
      // reload, so changing interval or mode cannot duplicate requests.
      queueMicrotask(() => {
        if (chartRef.current !== chart) return;
        drawingsRef.current
          .filter(
            (drawing) => drawing.backendId && drawing.revision !== undefined,
          )
          .forEach((drawing) =>
            createPersistedOverlayRef.current({
              drawing_id: drawing.backendId!,
              revision: drawing.revision!,
              drawing: drawing.drawing,
            }),
          );
      });
      reportChartDiagnostic("chart_init_success", {
        symbol,
        interval,
        candle_count: candlesRef.current.length,
      });
    } catch (error) {
      setHistoryError(`Chart initialization failed: ${String(error)}`);
      reportChartDiagnostic("chart_init_error", {
        symbol,
        interval,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (chart && element.current) {
        try {
          dispose(element.current);
        } catch {}
      }
      chartRef.current = null;
      return;
    }
    const container = element.current;
    const rememberPointer = (event: MouseEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    const pickPrice = (event: MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      if (!pricePickActionRef.current || !chartRef.current || !container)
        return;
      const rect = container.getBoundingClientRect();
      const point = chartRef.current.convertFromPixel(
        [{ x: event.clientX - rect.left, y: event.clientY - rect.top }],
        { paneId: "candle_pane" },
      );
      const value = Array.isArray(point) ? point[0]?.value : undefined;
      if (typeof value === "number" && Number.isFinite(value)) {
        event.preventDefault();
        onPricePickRef.current?.(Number(value.toFixed(2)));
      }
    };
    const openContext = (event: MenuPoint) => {
      if (
        (!tradingEnabledRef.current &&
          !swingInteractions.current.onSwingChartContext) ||
        !chartRef.current ||
        !container
      )
        return;
      const rect = container.getBoundingClientRect();
      const point = chartRef.current.convertFromPixel(
        [{ x: event.clientX - rect.left, y: event.clientY - rect.top }],
        { paneId: "candle_pane" },
      );
      const bars = candlesRef.current;
      const value = event.currentPrice ? bars[bars.length - 1]?.close : Array.isArray(point) ? point[0]?.value : undefined;
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      if (swingInteractions.current.onSwingChartContext) {
        swingInteractions.current.onSwingChartContext(
          value,
          event.clientX,
          event.clientY,
        );
        return;
      }
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        price: Number(value.toFixed(2)),
      });
    };
    container.addEventListener("mousedown", rememberPointer);
    container.addEventListener("click", pickPrice);
    const removeMenu = bindChartMenu(container, menuGesture, openContext, () => menuGesture === "doubleclick" && (Boolean(pricePickActionRef.current) || drawingGestureRef.current || Date.now() < menuEditingUntil.current));
    return () => {
      container.removeEventListener("mousedown", rememberPointer);
      container.removeEventListener("click", pickPrice);
      removeMenu();
      subscribeBarRef.current = null;
      renderedCandlesRef.current = [];
      chartRef.current = null;
      tradingOverlaysRef.current.reset();
      tradeMarkersRef.current.reset();
      try {
        dispose(element.current!);
        reportChartDiagnostic("chart_dispose_success", { symbol, interval });
      } catch (error) {
        reportChartDiagnostic("chart_dispose_error", {
          symbol,
          interval,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    };
  }, [symbol, interval]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const intervalSeconds =
      (interval === "1D" ? 1440 : Number(interval.replace("m", ""))) * 60;
    if (!intervalSeconds) return;
    const retained = new Set<string>();
    buildTradeMarkers(
      trades,
      instrument,
      intervalSeconds,
      externalTradeMarkers || historicalMarkersVisible,
      candleAnchorSeconds,
    ).forEach((marker) => {
      retained.add(marker.id);
      tradeMarkersRef.current.upsert(chart, marker.id, {
        name: "desktopTradeMarker",
        paneId: "candle_pane",
        points: [{ timestamp: marker.timestamp * 1000, value: marker.price }],
        extendData: { color: marker.color, text: marker.text },
        lock: true,
        visible: true,
        zLevel: 10,
      });
    });
    tradeMarkersRef.current.prune(chart, retained);
  }, [
    trades,
    instrument,
    interval,
    candles,
    historicalMarkersVisible,
    externalTradeMarkers,
    candleAnchorSeconds,
  ]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".chart-context-menu"))
        setContextMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [contextMenu]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyChartStyles(chart, settings);
  }, [settings]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeIndicator();
    // MA is drawn over the candle pane. Other indicators get their own pane.
    indicators.forEach((indicator) => {
      if (indicator === "MA") {
        const periods = settings.movingAveragePeriods
          .split(",")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
          .slice(0, 6);
        chart.createIndicator(
          {
            name: settings.movingAverageType,
            calcParams: periods.length ? periods : [5, 10, 20],
            paneId: "candle_pane",
          },
          true,
        );
      } else if (indicator !== "PositionPnL") chart.createIndicator(indicator);
    });
  }, [
    indicatorKey,
    settings.movingAveragePeriods,
    settings.movingAverageType,
    symbol,
    interval,
  ]);
  useEffect(() => {
    const chart = chartRef.current;
    const container = element.current;
    const levels = indicators.includes("PositionPnL")
      ? positionPnlLevels(levelsPosition, sessionCapital, brokeragePerOrder)
      : [];
    if (!chart || !container || !levels.length) {
      positionLevelFallbackRef.current = null;
      setPositionLevelGeometry((current) => (current.length ? [] : current));
      return;
    }
    const seconds =
      (interval === "1D" ? 1440 : Number(interval.replace("m", ""))) * 60;
    const fallbackKey = `${levelsPosition?.side}:${levelsPosition?.quantity}:${levelsPosition?.avg_entry_price}:${levelsPosition?.entry_commission}`;
    if (
      !latestPositionFill &&
      positionLevelFallbackRef.current?.key !== fallbackKey &&
      candles.length
    ) {
      positionLevelFallbackRef.current = {
        key: fallbackKey,
        timestamp:
          Math.floor(candles[candles.length - 1].timestamp / seconds) *
          seconds *
          1000,
      };
    }
    const timestamp = latestPositionFill
      ? Math.floor(latestPositionFill / seconds) * seconds * 1000
      : positionLevelFallbackRef.current?.timestamp;
    if (timestamp === undefined) {
      setPositionLevelGeometry((current) => (current.length ? [] : current));
      return;
    }
    let active = true;
    const update = () => {
      if (!active) return;
      const anchor = chart.convertToPixel(
        [{ timestamp, value: levelsPosition!.avg_entry_price }],
        { paneId: "candle_pane" },
      );
      const center = Array.isArray(anchor) ? anchor[0]?.x : undefined;
      const viewportWidth = container.clientWidth;
      if (typeof center !== "number" || !Number.isFinite(center)) {
        setPositionLevelGeometry([]);
        return;
      }
      const segmentWidth = Math.min(
        viewportWidth,
        Math.max(1, chart.getBarSpace().bar) * 5,
      );
      const x = Math.max(
        0,
        Math.min(viewportWidth - segmentWidth, center - segmentWidth / 2),
      );
      setPositionLevelGeometry(
        levels.flatMap((level) => {
          const converted = chart.convertToPixel(
            [{ timestamp, value: level.price }],
            { paneId: "candle_pane" },
          );
          const y = Array.isArray(converted) ? converted[0]?.y : undefined;
          return typeof y === "number" &&
            Number.isFinite(y) &&
            y >= 0 &&
            y <= container.clientHeight
            ? [{ ...level, x, y, width: segmentWidth, labelLeft: true }]
            : [];
        }),
      );
    };
    update();
    requestAnimationFrame(update);
    const onChartChange = () => requestAnimationFrame(update);
    chart.subscribeAction("onScroll", onChartChange);
    chart.subscribeAction("onZoom", onChartChange);
    chart.subscribeAction("onVisibleRangeChange", onChartChange);
    const observer = new ResizeObserver(onChartChange);
    observer.observe(container);
    return () => {
      active = false;
      chart.unsubscribeAction("onScroll", onChartChange);
      chart.unsubscribeAction("onZoom", onChartChange);
      chart.unsubscribeAction("onVisibleRangeChange", onChartChange);
      observer.disconnect();
    };
  }, [
    indicatorKey,
    levelsPosition?.side,
    levelsPosition?.quantity,
    levelsPosition?.avg_entry_price,
    levelsPosition?.entry_commission,
    sessionCapital,
    brokeragePerOrder,
    latestPositionFill,
    drawingInstrumentKey,
    interval,
    candles.length,
    candles[candles.length - 1]?.high,
    candles[candles.length - 1]?.low,
  ]);
  useEffect(() => {
    const diagnosticStart = beginPerformanceSample("desktop-chart-update");
    try {
      candlesRef.current = candles;
      const chart = chartRef.current;
      if (!chart) return;
      const resetViewport = viewportResetRef.current !== viewportResetKey;
      viewportResetRef.current = viewportResetKey;
      if (
        (!initialViewportRef.current || resetViewport) &&
        candles.length > 0 &&
        element.current
      ) {
        const saved = initialTimeRangeRef.current;
        const savedRows = saved
          ? candles.filter(
              (c) => c.timestamp >= saved.from && c.timestamp <= saved.to,
            )
          : [];
        chart.setBarSpace(
          Math.max(
            1,
            element.current.clientWidth /
              (savedRows.length || Math.min(150, candles.length)),
          ),
        );
        if (savedRows.length)
          chart.scrollToTimestamp(
            savedRows[savedRows.length - 1].timestamp * 1000,
            0,
          );
        else chart.scrollToDataIndex(candles.length - 1, 0);
        initialViewportRef.current = true;
      }
      const latest = candles[candles.length - 1];
      const previous = renderedCandlesRef.current;
      const sameCandle = (left: Candle, right: Candle) =>
        left.timestamp === right.timestamp &&
        left.open === right.open &&
        left.high === right.high &&
        left.low === right.low &&
        left.close === right.close;
      // Live snapshots normally change only the current candle or append one
      // candle. Feed those updates through KLineCharts' incremental loader so
      // the user's scroll position and crosshair remain untouched.
      // Replay and live snapshots commonly update the last candle in place. The
      // previous implementation compared every candle, including that mutable
      // last candle, so every replay tick fell back to resetData() and cleared
      // the crosshair. Permit a same-length last-bar update, or one new bar,
      // while still resetting when history/symbol data is replaced.
      const sameLengthUpdate =
        candles.length === previous.length &&
        previous.length > 0 &&
        previous
          .slice(0, -1)
          .every((candle, index) => sameCandle(candle, candles[index]));
      const appendUpdate =
        candles.length === previous.length + 1 &&
        previous.length > 0 &&
        previous.every((candle, index) => sameCandle(candle, candles[index]));
      const incremental = Boolean(
        subscribeBarRef.current && (sameLengthUpdate || appendUpdate),
      );
      try {
        if (incremental && latest && subscribeBarRef.current) {
          subscribeBarRef.current({
            timestamp: latest.timestamp * 1000,
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
            volume: latest.volume ?? 0,
          });
          renderedCandlesRef.current = candles;
          reportChartDiagnostic("chart_incremental_success", {
            symbol,
            instrument,
            interval,
            candle_count: candles.length,
            latest,
          });
          return;
        }
        const barSpace = chart.getBarSpace().bar;
        const range = chart.getVisibleRange();
        const anchor =
          previous[
            Math.max(0, Math.min(previous.length - 1, Math.floor(range.to) - 1))
          ]?.timestamp;
        chart.resetData();
        chart.setBarSpace(barSpace);
        if (anchor && !resetViewport) chart.scrollToTimestamp(anchor * 1000, 0);
        renderedCandlesRef.current = candles;
        reportChartDiagnostic("chart_reset_success", {
          symbol,
          interval,
          candle_count: candles.length,
          latest: latest ?? null,
        });
      } catch (error) {
        reportChartDiagnostic("chart_data_error", {
          symbol,
          interval,
          candle_count: candles.length,
          latest: latest ?? null,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    } finally {
      endPerformanceSample("desktop-chart-update", diagnosticStart);
    }
  }, [candles, isReplaying, viewportResetKey]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let frame: number | undefined;
    const update = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (chartRef.current !== chart) return;
        setGeometryVersion((v) => v + 1);
        const data = chart.getDataList(),
          range = chart.getVisibleRange();
        const from = data[Math.max(0, Math.ceil(range.from))]?.timestamp;
        const to =
          data[Math.min(data.length - 1, Math.floor(range.to) - 1)]?.timestamp;
        if (from !== undefined && to !== undefined)
          timeRangeCallbackRef.current?.({ from: from / 1000, to: to / 1000 });
      });
    };
    update();
    chart.subscribeAction("onScroll", update);
    chart.subscribeAction("onZoom", update);
    const observer = element.current ? new ResizeObserver(update) : undefined;
    if (element.current) observer?.observe(element.current);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      chart.unsubscribeAction("onScroll", update);
      chart.unsubscribeAction("onZoom", update);
    };
  }, [symbol, interval, candles]);
  const persistDrawing = async (
    path: string,
    method: "POST" | "PUT" | "DELETE",
    drawing: PersistedDrawing,
    revision?: number,
  ) => {
    const endActivity = beginChartActivity();
    const context = drawingInstrumentKey;
    try {
      drawingBusyRef.current++;
      const result = (await drawingRequest(path, method, {
        instrument: drawingInstrument,
        drawing,
        revision,
        mutation_id: crypto.randomUUID(),
      })) as DrawingRecord;
      if (drawingContextRef.current !== context) return null;
      announceDrawingChange({
        owner: drawingOwner.current,
        keys: drawingReadKeys,
      });
      return result;
    } catch (error) {
      onDrawingError?.(error);
      // Keep the local edit visible. Explicit chart refresh/reopen can reload the server revision.
      return null;
    } finally {
      drawingBusyRef.current--;
      endActivity();
    }
  };
  const saveDrawing = async (
    id: string,
    path: string,
    method: "POST" | "PUT" | "DELETE",
    drawing: PersistedDrawing,
    revision?: number,
  ) => {
    if (drawingSavesRef.current.has(id)) {
      setDrawingNotice("This drawing is saving; try again when it finishes.");
      return null;
    }
    drawingSavesRef.current.add(id);
    const context = drawingInstrumentKey;
    chartRef.current?.overrideOverlay({ id, lock: true });
    try {
      return await persistDrawing(path, method, drawing, revision);
    } finally {
      drawingSavesRef.current.delete(id);
      setDrawingNotice("");
      if (drawingContextRef.current === context)
        chartRef.current?.overrideOverlay({
          id,
          lock: Boolean(drawing.locked),
        });
    }
  };
  const saveMovedDrawing = (event: any) => {
    setDrawingGesture(false);
    const item = drawingsRef.current.find((row) => row.id === event.overlay.id);
    if (!item?.backendId || item.revision === undefined) return;
    const drawing = {
      ...item.drawing,
      points: event.overlay.points.map((point: any) => ({
        timestamp: Math.floor(Number(point.timestamp) / 1000),
        price: Number(point.value),
      })),
    };
    setDrawings((items) =>
      items.map((row) =>
        row.id === item.id ? { ...row, drawing, dirty: true } : row,
      ),
    );
    void saveDrawing(
      item.id,
      `drawings/${item.backendId}`,
      "PUT",
      drawing,
      item.revision,
    ).then((record) => {
      if (record)
        setDrawings((items) =>
          items.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  drawing: record.drawing,
                  revision: record.revision,
                  dirty: false,
                }
              : row,
          ),
        );
    });
  };
  const createPersistedOverlay = (record: DrawingRecord) => {
    const style = record.drawing.style ?? {};
    chartRef.current?.removeOverlay({ id: record.drawing_id });
    drawingOverlayIdsRef.current.delete(record.drawing_id);
    const id = chartRef.current?.createOverlay({
      id: record.drawing_id,
      name: overlayName(record.drawing.tool),
      paneId: "candle_pane",
      points: drawingPoints(record.drawing),
      lock: Boolean(record.drawing.locked),
      visible: record.drawing.visible !== false,
      styles: {
        line: {
          color: style.color ?? settings.drawingLineColor,
          size: style.width ?? settings.drawingLineWidth,
          style: "solid",
          dashedValue: [2, 2],
        },
        polygon: {
          color:
            style.fillColor ??
            withOpacity(
              settings.drawingFillColor,
              style.fillOpacity ?? settings.drawingFillOpacity,
            ),
        },
        rect: {
          color:
            style.fillColor ??
            withOpacity(
              settings.drawingFillColor,
              style.fillOpacity ?? settings.drawingFillOpacity,
            ),
        },
        circle: {
          color:
            style.fillColor ??
            withOpacity(
              settings.drawingFillColor,
              style.fillOpacity ?? settings.drawingFillOpacity,
            ),
        },
      },
      onSelected: (event: any) => { menuEditingUntil.current = Date.now() + 500; setSelected(event.overlay.id); },
      onPressedMoveStart: () => {
        menuEditingUntil.current = Date.now() + 500;
        setDrawingGesture(true);
      },
      onPressedMoveEnd: saveMovedDrawing,
      onRemoved: (event: any) => {
        drawingOverlayIdsRef.current.delete(event.overlay.id);
        setDrawings((current) =>
          current.filter((drawing) => drawing.id !== event.overlay.id),
        );
      },
    } as any);
    if (typeof id !== "string") return;
    drawingOverlayIdsRef.current.add(id);
    setDrawings((current) =>
      current.some((item) => item.id === id)
        ? current
        : [
            ...current,
            {
              id,
              backendId: record.drawing_id,
              revision: record.revision,
              drawing: record.drawing,
              locked: Boolean(record.drawing.locked),
              hidden: record.drawing.visible === false,
            },
          ],
    );
  };
  createPersistedOverlayRef.current = createPersistedOverlay;
  useEffect(() => {
    const changedContext =
      previousDrawingContextRef.current !== drawingInstrumentKey;
    const explicitRefresh =
      previousDrawingRefreshRef.current !== drawingRefreshKey;
    previousDrawingContextRef.current = drawingInstrumentKey;
    previousDrawingRefreshRef.current = drawingRefreshKey;
    const discardDirty =
      changedContext ||
      (explicitRefresh &&
        drawingsRef.current.some((item) => item.dirty) &&
        window.confirm(
          "Reload saved drawings and discard local changes that could not be saved?",
        ));
    if (discardDirty) {
      for (const drawing of drawingsRef.current)
        chartRef.current?.removeOverlay({ id: drawing.id });
      drawingsRef.current = [];
      setDrawings([]);
    }
    let disposed = false;
    let generation = 0;
    let retryTimer: number | undefined;
    const refresh = () => {
      if (disposed || !chartRef.current) return;
      if (drawingBusyRef.current || drawingGestureRef.current) {
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(refresh, 250);
        return;
      }
      const version = ++generation;
      const keys = JSON.parse(drawingReadSignature) as string[];
      void Promise.all(
        keys.map((key) =>
          drawingRequest(
            `drawings?instrument=${encodeURIComponent(key)}`,
            "GET",
          ),
        ),
      )
        .then((values) => {
          if (disposed || version !== generation) return;
          if (drawingBusyRef.current || drawingGestureRef.current) {
            refresh();
            return;
          }
          const records = [
            ...new Map(
              values
                .flatMap(
                  (value) =>
                    (value as { drawings?: DrawingRecord[] }).drawings ?? [],
                )
                .map((record) => [record.drawing_id, record]),
            ).values(),
          ];
          // Retain unfinished local drawings; only refresh records already persisted.
          for (const item of drawingsRef.current)
            if (item.backendId && !item.dirty)
              chartRef.current?.removeOverlay({ id: item.id });
          setDrawings((current) =>
            current.filter((item) => !item.backendId || item.dirty),
          );
          const dirtyIds = new Set(
            drawingsRef.current
              .filter((item) => item.dirty)
              .map((item) => item.backendId),
          );
          records
            .filter((record) => !dirtyIds.has(record.drawing_id))
            .forEach((record) => createPersistedOverlayRef.current(record));
          setSelected(null);
        })
        .catch((error) => {
          if (!disposed && version === generation) onDrawingError?.(error);
        });
    };
    reloadDrawingsRef.current = refresh;
    refresh();
    const stop = watchDrawingChanges(
      drawingOwner.current,
      drawingReadKeys,
      refresh,
    );
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      stop();
      reloadDrawingsRef.current = () => undefined;
    };
  }, [drawingReadSignature, drawingRequest, onDrawingError, drawingRefreshKey]);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (
        !active ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,select,[contenteditable=true]"))
      )
        return;
      if (event.key === "Escape") {
        setDrawingGesture(false);
        setContextMenu(null);
        if (pricePickAction) { if (onPricePickCancel) onPricePickCancel(); else onPricePick?.(NaN); }
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedOrderId !== null
      ) {
        const order = openOrders.find(
          (item) => item.order_id === selectedOrderId,
        );
        if (order) onOrderCancel?.(order);
        setSelectedOrderId(null);
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selected !== null
      ) {
        event.preventDefault();
        void deleteDrawing(selected);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const last = drawingsRef.current[drawingsRef.current.length - 1];
        if (last) void deleteDrawing(last.id);
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [
    active,
    selected,
    selectedOrderId,
    drawings,
    openOrders,
    pricePickAction,
    onPricePickCancel,
  ]);
  const deletePendingRef = useRef(new Set<string>());
  const deleteDrawing = async (id: string) => {
    const drawing = drawingsRef.current.find((item) => item.id === id);
    if (!drawing || deletePendingRef.current.has(id)) return;
    if (drawingSavesRef.current.has(id)) {
      setDrawingNotice("This drawing is saving; try again when it finishes.");
      return;
    }
    deletePendingRef.current.add(id);
    try {
      if (drawing.backendId && drawing.revision) {
        const result = await saveDrawing(
          id,
          `drawings/${drawing.backendId}`,
          "DELETE",
          drawing.drawing,
          drawing.revision,
        );
        if (!result) return;
      }
      if (!drawing.drawing.points.length) setDrawingGesture(false);
      chartRef.current?.removeOverlay({ id });
      drawingOverlayIdsRef.current.delete(id);
      setDrawings((current) => current.filter((item) => item.id !== id));
      setSelected((current) => (current === id ? null : current));
    } finally {
      deletePendingRef.current.delete(id);
    }
  };
  const addDrawing = (nextTool: string, commandId: number) => {
    const name = overlayName(nextTool);
    const lineColor =
      nextTool === "Trend"
        ? settings.trendLineColor
        : nextTool === "Horizontal"
          ? settings.horizontalLineColor
          : settings.drawingLineColor;
    const lineWidth =
      nextTool === "Trend"
        ? settings.trendLineWidth
        : nextTool === "Horizontal"
          ? settings.horizontalLineWidth
          : settings.drawingLineWidth;
    const fillColor = withOpacity(
      settings.drawingFillColor,
      settings.drawingFillOpacity,
    );
    const id = chartRef.current?.createOverlay({
      name,
      paneId: "candle_pane",
      // Use a high-contrast explicit line instead of depending on a theme's
      // drawing defaults, which made newly-created overlays hard to see.
      styles: {
        line: {
          color: lineColor,
          size: lineWidth,
          style: "solid",
          dashedValue: [2, 2],
        },
        polygon: { color: fillColor },
        rect: { color: fillColor },
        circle: { color: fillColor },
      },
      onPressedMoveStart: () => {
        menuEditingUntil.current = Date.now() + 500;
        setDrawingGesture(true);
      },
      onPressedMoveEnd: saveMovedDrawing,
      onDrawStart: () => {
        setDrawingGesture(true);
      },
      onDrawEnd: (event) => {
        setDrawingGesture(false);
        const points = event.overlay.points.map((point) => ({
          timestamp: Math.floor(Number(point.timestamp) / 1000),
          price: Number(point.value),
        }));
        const drawing = {
          tool: nextTool,
          points,
          style: {
            color: lineColor,
            width: lineWidth,
            fillColor,
            fillOpacity: settings.drawingFillOpacity,
          },
          visible: true,
          locked: false,
        };
        setDrawings((items) =>
          items.map((item) =>
            item.id === event.overlay.id
              ? { ...item, drawing, dirty: true }
              : item,
          ),
        );
        if (points.length && typeof event.overlay.id === "string")
          void saveDrawing(event.overlay.id, "drawings", "POST", drawing).then(
            (record) => {
              if (!record) return;
              setDrawings((current) =>
                current.map((item) =>
                  item.id === event.overlay.id
                    ? {
                        ...item,
                        backendId: record.drawing_id,
                        revision: record.revision,
                        drawing: record.drawing,
                        dirty: false,
                      }
                    : item,
                ),
              );
            },
          );
        onDrawingComplete(commandId, nextTool);
        if (drawingModeRef.current === "repeat")
          window.setTimeout(() => addDrawing(nextTool, commandId), 0);
      },
      onSelected: (event) => setSelected(event.overlay.id),
      onRemoved: (event) => {
        drawingOverlayIdsRef.current.delete(event.overlay.id);
        setDrawings((current) =>
          current.filter((drawing) => drawing.id !== event.overlay.id),
        );
      },
    });
    if (typeof id !== "string") return;
    drawingOverlayIdsRef.current.add(id);
    setDrawings((current) => [
      ...current,
      {
        id,
        drawing: {
          tool: nextTool,
          points: [],
          style: {
            color: lineColor,
            width: lineWidth,
            fillColor,
            fillOpacity: settings.drawingFillOpacity,
          },
          visible: true,
          locked: false,
        },
        locked: false,
        hidden: false,
      },
    ]);
    setSelected(id);
  };
  const updateSelected = (update: (drawing: LocalDrawing) => LocalDrawing) => {
    const drawing = drawingsRef.current.find((item) => item.id === selected);
    if (!drawing) return;
    if (drawingSavesRef.current.has(drawing.id)) {
      setDrawingNotice("This drawing is saving; try again when it finishes.");
      return;
    }
    const next = update(drawing);
    const persisted = {
      ...next.drawing,
      locked: next.locked,
      visible: !next.hidden,
    };
    chartRef.current?.overrideOverlay({
      id: next.id,
      lock: next.locked,
      visible: !next.hidden,
    });
    setDrawings((current) =>
      current.map((item) =>
        item.id === next.id
          ? { ...next, drawing: persisted, dirty: true }
          : item,
      ),
    );
    if (next.backendId && next.revision)
      void saveDrawing(
        next.id,
        `drawings/${next.backendId}`,
        "PUT",
        persisted,
        next.revision,
      ).then((record) => {
        if (record)
          setDrawings((items) =>
            items.map((item) =>
              item.id === next.id
                ? {
                    ...item,
                    revision: record.revision,
                    drawing: record.drawing,
                    dirty: false,
                  }
                : item,
            ),
          );
      });
  };
  useEffect(() => {
    if (
      !active ||
      !drawingCommand ||
      drawingCommand.id === lastDrawingCommandRef.current
    )
      return;
    lastDrawingCommandRef.current = drawingCommand.id;
    addDrawing(drawingCommand.tool, drawingCommand.id);
  }, [active, drawingCommand]);
  useEffect(() => {
    if (
      !active ||
      !drawingAction ||
      drawingAction.id === lastDrawingActionRef.current ||
      selected === null
    )
      return;
    lastDrawingActionRef.current = drawingAction.id;
    if (drawingAction.action === "delete") void deleteDrawing(selected);
    if (drawingAction.action === "hide")
      updateSelected((drawing) => ({ ...drawing, hidden: !drawing.hidden }));
    if (drawingAction.action === "lock")
      updateSelected((drawing) => ({ ...drawing, locked: !drawing.locked }));
  }, [active, drawingAction, selected, drawings]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const retained = new Set<string>();
    const rendered = renderedCandlesRef.current;
    const currentCandles = candlesRef.current;
    const lastRendered = rendered.length
      ? rendered[rendered.length - 1]
      : undefined;
    const lastCandle = currentCandles.length
      ? currentCandles[currentCandles.length - 1]
      : undefined;
    const timestamp =
      (lastRendered?.timestamp ??
        lastCandle?.timestamp ??
        Math.floor(Date.now() / 1000)) * 1000;
    const nextLabels: FloatingLabel[] = [];
    const pointToPixel = (time: number, value: number) => {
      const converted = (chart as any).convertToPixel?.(
        [{ timestamp: time, value }],
        { paneId: "candle_pane" },
      );
      const pixel = Array.isArray(converted) ? converted[0] : undefined;
      return pixel && Number.isFinite(pixel.y) && Number.isFinite(pixel.x)
        ? pixel
        : undefined;
    };
    for (const order of openOrders.filter(
      (item) => item.status === "PENDING",
    )) {
      const selectedLine = selectedOrderId === order.order_id;
      const color = orderColor(order, selectedLine);
      const pendingEdit = pendingEdits.get(order.session_id, order.order_id);
      const price = pendingEdit?.oldPrice ?? orderPrice(order);
      const label = orderLineLabel(
        pendingEdit
          ? {
              ...order,
              limit_price: pendingEdit.oldPrice,
              trigger_price: pendingEdit.oldPrice,
            }
          : order,
        position,
        tradingSettings,
        sessionCapital,
      );
      const pixel = pointToPixel(timestamp, price);
      if (pixel && typeof pixel.y === "number")
        nextLabels.push({
          key: order.order_id,
          x: Math.max(8, (element.current?.clientWidth ?? 0) - 122),
          y: pixel.y,
          text: label,
          color,
        });
      if (pendingEdit) {
        const proposedKey = `pending:${order.order_id}`;
        retained.add(proposedKey);
        tradingOverlaysRef.current.upsert(chart, proposedKey, {
          name: "horizontalStraightLine",
          paneId: "candle_pane",
          lock: true,
          points: [{ timestamp, value: pendingEdit.requestedPrice }],
          styles: {
            line: {
              color: "#fbbf24",
              size: 1,
              style: "dashed",
              dashedValue: [5, 4],
            },
          },
        });
        const proposedPixel = pointToPixel(
          timestamp,
          pendingEdit.requestedPrice,
        );
        if (proposedPixel)
          nextLabels.push({
            key: proposedKey,
            x: 8,
            y: proposedPixel.y,
            text: `${pendingEdit.requestedPrice.toFixed(2)} · ${pendingEdit.message}`,
            color: "#fbbf24",
          });
      }
      const overlayKey = `order:${order.order_id}`;
      retained.add(overlayKey);
      tradingOverlaysRef.current.upsert(chart, overlayKey, {
        name: "horizontalStraightLine",
        paneId: "candle_pane",
        points: [{ timestamp, value: price }],
        styles: {
          line: {
            color,
            size: selectedLine ? 3 : 2,
            style: pendingEdit ? "solid" : "dashed",
            dashedValue: [6, 3],
          },
        },
        lock: Boolean(pricePickAction) || (readOnlyOrders && !onOrderDrag),
        onClick: onOrderSelect
          ? () => {
              const gesture = swingDragGesture.current.get(order.order_id);
              const latest = tradingOverlayInputsRef.current.openOrders.find(
                (item) => item.order_id === order.order_id,
              );
              if (
                latest &&
                !swingDragPending.current.has(order.order_id) &&
                (!gesture || Date.now() > gesture.ignoreUntil)
              )
                swingInteractions.current.onOrderSelect?.(latest);
              return true;
            }
          : undefined,
        extendData: { orderId: order.order_id, label },
        onSelected: () => {
          menuEditingUntil.current = Date.now() + 500;
          if (readOnlyOrders) return;
          setSelectedOrderId(order.order_id);
          setSelectedOrderAnchor(lastPointerRef.current);
          setSelectedStrategyId(null);
          setSelectedStrategyAnchor(null);
          setSelected(null);
        },
        onDeselected: () => {
          setSelectedOrderId((current) =>
            current === order.order_id ? null : current,
          );
          setSelectedOrderAnchor(null);
        },
        onPressedMoveStart: () => {
          menuEditingUntil.current = Date.now() + 500;
          if (onOrderSelect)
            swingDragGesture.current.set(order.order_id, {
              price: orderPrice(order),
              moved: false,
              ignoreUntil: 0,
            });
        },
        onPressedMoving: (event: any) => {
          const gesture = swingDragGesture.current.get(order.order_id);
          if (
            gesture &&
            Math.abs(event.overlay.points[0]?.value - gesture.price) >
              swingOrderTick(order) / 2
          ) {
            gesture.moved = true;
            gesture.ignoreUntil = Date.now() + 400;
          }
        },
        onPressedMoveEnd: (event: any) => {
          menuEditingUntil.current = Date.now() + 500;
          const value = event.overlay.points[0]?.value;
          const inputs = tradingOverlayInputsRef.current;
          const latest = inputs.openOrders.find(
            (item) => item.order_id === order.order_id,
          );
          if (!latest || typeof value !== "number" || !Number.isFinite(value))
            return;
          if (pendingEdits.get(latest.session_id, latest.order_id)) {
            chart.overrideOverlay({
              id: event.overlay.id,
              points: [{ timestamp, value: price }],
            });
            return;
          }
          if (!onOrderSelect) {
            const snapped = snapSwingPrice(value, swingOrderTick(latest));
            chart.overrideOverlay({
              id: event.overlay.id,
              points: [{ timestamp, value: price }],
            });
            if (snapped > 0 && snapped !== orderPrice(latest))
              inputs.onOrderDrag?.(latest, snapped);
            return;
          }
          const gesture = swingDragGesture.current.get(order.order_id);
          if (!gesture?.moved || swingDragPending.current.has(order.order_id))
            return;
          gesture.ignoreUntil = Date.now() + 400;
          swingDragPending.current.add(order.order_id);
          const restore = () => {
            swingDragPending.current.delete(order.order_id);
            if (chartRef.current !== chart) return;
            const confirmed = tradingOverlayInputsRef.current.openOrders.find(
              (item) => item.order_id === order.order_id,
            );
            if (confirmed)
              chart.overrideOverlay({
                id: event.overlay.id,
                points: [{ timestamp, value: orderPrice(confirmed) }],
              });
            tradingOverlaysRef.current.invalidate(overlayKey);
          };
          const snapped = snapSwingPrice(value, swingOrderTick(latest));
          if (snapped <= 0 || snapped === orderPrice(latest)) {
            restore();
            return;
          }
          void Promise.resolve(inputs.onOrderDrag?.(latest, snapped))
            .catch(() => {})
            .finally(restore);
        },
      } as any);
    }
    for (const strategy of strategies) {
      const price =
        strategy.strategy_type === "TargetProfit"
          ? targetProfitLinePrice(strategy, position, sessionCapital)
          : typeof strategy.price === "number" &&
              Number.isFinite(strategy.price)
            ? strategy.price
            : null;
      if (price === null) continue;
      const selectedLine = selectedStrategyId === strategy.strategy_id;
      const projectedLabel = targetProfitLabel(
        strategy,
        position,
        tradingSettings,
        sessionCapital,
        price,
        positionMarkPrice ?? candles[candles.length - 1]?.close,
        aggregatePnl,
        brokeragePerOrder,
      );
      if (projectedLabel) {
        const pixel = pointToPixel(timestamp, price);
        if (pixel && typeof pixel.y === "number") {
          nextLabels.push({
            key: strategy.strategy_id,
            x: 8,
            y: pixel.y,
            text: projectedLabel,
            color: projectedLabel.startsWith("TP -") ? "#ef4444" : "#22c55e",
          });
        }
      }
      const overlayKey = `strategy:${strategy.strategy_id}`;
      retained.add(overlayKey);
      tradingOverlaysRef.current.upsert(chart, overlayKey, {
        name: "horizontalStraightLine",
        paneId: "candle_pane",
        lock: Boolean(pricePickAction) || !onStrategyDrag || pendingStrategyIds?.has(strategy.strategy_id) || strategySavesRef.current.has(strategy.strategy_id),
        points: [{ timestamp, value: price }],
        styles: {
          line: {
            color: selectedLine ? "#fbbf24" : "#f59e0b",
            size: selectedLine ? 3 : 2,
            style: "dashed",
            dashedValue: [3, 3],
          },
        },
        extendData: {
          strategyId: strategy.strategy_id,
          label:
            projectedLabel ?? `${strategy.strategy_type} @ ${price.toFixed(2)}`,
        },
        onSelected: () => {
          menuEditingUntil.current = Date.now() + 500;
          const inputs = tradingOverlayInputsRef.current;
          const latest = inputs.strategies.find(
            (item) => item.strategy_id === strategy.strategy_id,
          );
          if (
            latest?.strategy_type !== "TargetProfit" ||
            !onStrategyTargetProfitPct
          )
            return;
          setSelectedOrderId(null);
          setSelectedOrderAnchor(null);
          setSelectedStrategyId(strategy.strategy_id);
          setSelectedStrategyAnchor(lastPointerRef.current);
          setTargetProfitPctError("");
          const existingPct = latest.target_profit_is_pct
            ? latest.target_profit_value
            : undefined;
          const currentPosition = inputs.position;
          const direction =
            currentPosition?.side === "LONG"
              ? 1
              : currentPosition?.side === "SHORT"
                ? -1
                : 0;
          const currentPrice =
            targetProfitLinePrice(
              latest,
              currentPosition,
              inputs.sessionCapital,
            ) ?? price;
          const impliedPct =
            currentPosition &&
            direction &&
            currentPosition.quantity > 0 &&
            inputs.sessionCapital > 0
              ? ((direction *
                  (currentPrice - currentPosition.avg_entry_price) *
                  currentPosition.quantity) /
                  inputs.sessionCapital) *
                100
              : 0;
          const initialPct =
            typeof existingPct === "number"
              ? existingPct
              : impliedPct > 0
                ? Number(impliedPct.toFixed(1))
                : "";
          setTargetProfitPctDraft(String(initialPct));
        },
        onPressedMoveEnd: (event: any) => {
          menuEditingUntil.current = Date.now() + 500;
          const value = event.overlay.points[0]?.value;
          const callback = tradingOverlayInputsRef.current.onStrategyDrag;
          const snapped = snapSwingPrice(value);
          chart.overrideOverlay({
            id: event.overlay.id,
            points: [{ timestamp, value: price }],
          });
          tradingOverlaysRef.current.invalidate(overlayKey);
          if (
            !callback ||
            pendingStrategyIds?.has(strategy.strategy_id) ||
            strategySavesRef.current.has(strategy.strategy_id) ||
            !Number.isFinite(snapped) ||
            snapped <= 0 ||
            snapped === price
          )
            return;
          strategySavesRef.current.add(strategy.strategy_id);
          chart.overrideOverlay({ id: event.overlay.id, lock: true });
          const endActivity = beginChartActivity();
          void Promise.resolve().then(() => callback(strategy.strategy_id, snapped))
            .catch((error) => setHistoryError(String(error)))
            .finally(() => {
              strategySavesRef.current.delete(strategy.strategy_id);
              if (chartRef.current === chart) chart.overrideOverlay({ id: event.overlay.id, lock: Boolean(pricePickActionRef.current) || !tradingOverlayInputsRef.current.onStrategyDrag });
              tradingOverlaysRef.current.invalidate(overlayKey);
              endActivity();
            });
        },
      } as any);
    }
    const removed = tradingOverlaysRef.current.prune(chart, retained);
    if (removed.length)
      reportChartDiagnostic("trading_overlays_removed", {
        instrument: drawingInstrumentKey,
        keys: removed,
        removed_at_ms: Date.now(),
        renderer_time_ms: performance.now(),
      });
    setFloatingLabels(nextLabels);
  }, [
    openOrders,
    strategies,
    selectedOrderId,
    selectedStrategyId,
    position,
    tradingSettings,
    sessionCapital,
    aggregatePnl,
    positionMarkPrice,
    brokeragePerOrder,
    symbol,
    interval,
    candles,
    readOnlyOrders,
    onOrderSelect,
    onOrderDrag,
    onStrategyDrag,
    pendingRevision,
    pendingStrategyIds,
    geometryVersion,
    pricePickAction,
  ]);
  useEffect(() => {
    const chart = chartRef.current;
    const latest = candles[candles.length - 1];
    if (
      !chart ||
      !latest ||
      !position ||
      position.side === "FLAT" ||
      position.quantity <= 0
    ) {
      setPnlLabel(null);
      return;
    }
    const dir = position.side === "LONG" ? 1 : -1;
    const pnl = authoritativePnl ?? (
      dir * (latest.close - position.avg_entry_price) * position.quantity -
      (position.entry_commission ?? 0));
    const text = !pnlAvailable || !Number.isFinite(pnl) ? "—" :
      tradingSettings?.desktop_pnl_display_mode === "percent" &&
      sessionCapital > 0
        ? `${pnl >= 0 ? "+" : ""}${((pnl / sessionCapital) * 100).toFixed(2)}%`
        : `${pnl >= 0 ? "+" : ""}${authoritativePnl === undefined ? Math.round(pnl) : pnl.toFixed(2)}`;
    const converted = (chart as any).convertToPixel?.(
      [{ timestamp: latest.timestamp * 1000, value: latest.high }],
      { paneId: "candle_pane" },
    );
    const pixel = Array.isArray(converted) ? converted[0] : undefined;
    if (pixel && Number.isFinite(pixel.x) && Number.isFinite(pixel.y)) {
      setPnlLabel({
        key: "position-pnl",
        x: pixel.x,
        y: Math.max(12, pixel.y - 24),
        text,
        color: !pnlAvailable || !Number.isFinite(pnl) ? "#94a3b8" : pnl >= 0 ? "#22c55e" : "#ef4444",
      });
    } else {
      setPnlLabel(null);
    }
  }, [
    candles,
    position,
    authoritativePnl,
    pnlAvailable,
    tradingSettings,
    sessionCapital,
    symbol,
    interval,
    geometryVersion,
  ]);
  const closeCountdown = formatCandleCloseCountdown(
    isLive ? clock / 1000 : countdownTime ?? clock / 1000,
    interval === "1D" ? 1440 : Number(interval.replace("m", "")),
  );
  const selectedOrder = openOrders.find(
    (order) => order.order_id === selectedOrderId,
  );
  const selectedStrategy = strategies.find(
    (strategy) =>
      strategy.strategy_id === selectedStrategyId &&
      strategy.strategy_type === "TargetProfit",
  );
  useEffect(() => {
    setSelectedOrderQty(selectedOrder ? String(selectedOrder.quantity) : "");
  }, [selectedOrder?.order_id, selectedOrder?.quantity]);
  const selectedOrderIsSl = Boolean(
    selectedOrder &&
      (selectedOrder.is_stoploss || selectedOrder.order_type === "STOPLOSS"),
  );
  const selectedOrderExitSide =
    position?.side === "LONG"
      ? "SELL"
      : position?.side === "SHORT"
        ? "BUY"
        : null;
  const selectedOrderCoveredElsewhere = selectedOrder
    ? openOrders
        .filter(
          (order) =>
            order.order_id !== selectedOrder.order_id &&
            order.status === "PENDING" &&
            order.side === selectedOrderExitSide &&
            (order.is_stoploss ||
              order.order_type === "STOPLOSS" ||
              order.order_type === "LIMIT"),
        )
        .reduce((sum, order) => sum + order.quantity, 0)
    : 0;
  const selectedOrderMaxQty = Math.max(
    0,
    (position?.quantity ?? 0) - selectedOrderCoveredElsewhere,
  );
  const saveSelectedOrderQty = async () => {
    const quantity = Number(selectedOrderQty);
    if (
      !selectedOrder ||
      !selectedOrderIsSl ||
      !Number.isInteger(quantity) ||
      quantity < lotSize ||
      quantity > selectedOrderMaxQty ||
      quantity % lotSize !== 0 ||
      !onOrderQuantityUpdate
    )
      return;
    setSavingOrderQty(true);
    setOrderQtyError("");
    try {
      await onOrderQuantityUpdate(selectedOrder, quantity);
    } catch (error) {
      setOrderQtyError(String(error));
    } finally {
      setSavingOrderQty(false);
    }
  };
  const saveTargetProfitPct = async () => {
    const percentage = Number(targetProfitPctDraft);
    if (targetProfitBusy) return;
    if (
      !selectedStrategy ||
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      !onStrategyTargetProfitPct
    ) {
      setTargetProfitPctError("Enter a percentage greater than zero");
      return;
    }
    setSavingTargetProfitPct(true);
    setTargetProfitPctError("");
    try {
      await onStrategyTargetProfitPct(selectedStrategy.strategy_id, percentage);
      setSelectedStrategyId(null);
      setSelectedStrategyAnchor(null);
    } catch (error) {
      setTargetProfitPctError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setSavingTargetProfitPct(false);
    }
  };
  const closeTargetProfitPctEditor = () => {
    setSelectedStrategyId(null);
    setSelectedStrategyAnchor(null);
    setTargetProfitPctError("");
  };
  const deleteTargetProfit = async () => {
    if (!selectedStrategy || targetProfitBusy || !onStrategyCancel) return;
    setDeletingTargetProfit(true);
    setTargetProfitPctError("");
    try {
      await onStrategyCancel(selectedStrategy.strategy_id);
      closeTargetProfitPctEditor();
    } catch (error) {
      setTargetProfitPctError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setDeletingTargetProfit(false);
    }
  };
  const menuAction = (action: OrderAction) => {
    if (!contextMenu) return;
    onChartOrderActionRef.current?.(action, contextMenu.price, {
      x: contextMenu.x,
      y: contextMenu.y,
    });
    setContextMenu(null);
  };
  const hasClosingOrders = Boolean(
    position &&
      position.side !== "FLAT" &&
      openOrders.some(
        (order) =>
          order.status === "PENDING" &&
          ((position.side === "LONG" && order.side === "SELL") ||
            (position.side === "SHORT" && order.side === "BUY")),
      ),
  );
  const hasSlOrders = Boolean(
    position &&
      position.side !== "FLAT" &&
      openOrders.some(
        (order) =>
          order.status === "PENDING" &&
          order.is_stoploss &&
          ((position.side === "LONG" && order.side === "SELL") ||
            (position.side === "SHORT" && order.side === "BUY")),
      ),
  );
  const uncoveredQuantity = Math.max(
    0,
    (position?.quantity ?? 0) -
      openOrders
        .filter(
          (o) =>
            o.status === "PENDING" &&
            o.side === (position?.side === "LONG" ? "SELL" : "BUY"),
        )
        .reduce((sum, o) => sum + o.quantity, 0),
  );
  const hasPosition = Boolean(
    position && position.side !== "FLAT" && position.quantity > 0,
  );
  const menuPosition = contextMenu
    ? placeNearPoint(
        contextMenu.x,
        contextMenu.y,
        230,
        orderEntryEnabled ? 330 : underlyingStrategyEnabled ? 220 : 180,
      )
    : { left: 0, top: 0 };
  const lineActionPosition = selectedOrderAnchor
    ? placeNearPoint(
        selectedOrderAnchor.x,
        selectedOrderAnchor.y,
        selectedOrderIsSl ? 620 : 360,
        selectedOrderIsSl ? 72 : 46,
      )
    : { left: 12, top: 64 };
  const targetProfitEditorPosition = selectedStrategyAnchor
    ? placeNearPoint(
        selectedStrategyAnchor.x,
        selectedStrategyAnchor.y,
        290,
        112,
      )
    : { left: 12, top: 64 };
  const swapButtons = swapTargets.map((target) => (
    <button
      key={`${target.dir}-${target.label}`}
      className="icon-button"
      title={target.label}
      aria-label={target.label}
      onClick={(event) => {
        event.stopPropagation();
        target.onClick();
      }}
    >
      {target.dir}
    </button>
  ));
  return (
    <section
      className={`chart ${active ? "active-chart" : ""}`}
      style={{ background: settings.background, color: settings.textColor }}
      onPointerDownCapture={(event) => {
        if (
          !(event.target as HTMLElement).closest(
            ".line-actions,.chart-context-menu,.trade-ticket",
          )
        )
          onActivate();
      }}
    >
      <div className="chart-head">
        <span>
          {tradingSettings?.desktop_hide_chart_labels
            ? ""
            : supportedIntervals.length
              ? `${symbol} · IST`
              : `${symbol} · `}
          {supportedIntervals.length ? null : <strong>{interval}</strong>}
          {tradingSettings?.desktop_hide_chart_labels || supportedIntervals.length
            ? ""
            : " · IST"}
        </span>
        <span className="chart-actions">
          {onTogglePanel && (
            <button
              className="icon-button"
              title="Toggle drawing and indicator tools"
              aria-label="Toggle drawing and indicator tools"
              onClick={onTogglePanel}
            >
              ✎
            </button>
          )}
          {onToggleIndicator && (
            <span className="chart-dropdown" ref={indicatorsMenuRef}>
              <button
                className="dropdown-toggle"
                aria-haspopup="true"
                aria-expanded={indicatorsMenuOpen}
                onClick={() => setIndicatorsMenuOpen((v) => !v)}
              >
                Indicators ▾
              </button>
              {indicatorsMenuOpen && (
                <div className="chart-dropdown-menu">
                  {["MA", "PositionPnL"].map((name) => (
                    <label key={name}>
                      <input
                        type="checkbox"
                        checked={indicators.includes(name)}
                        onChange={() => onToggleIndicator(name)}
                      />
                      {indicatorLabel(name)}
                    </label>
                  ))}
                </div>
              )}
            </span>
          )}
          {onSelectDrawingTool && (
            <span className="chart-dropdown" ref={drawMenuRef}>
              <button
                className="dropdown-toggle"
                aria-haspopup="true"
                aria-expanded={drawMenuOpen}
                onClick={() => setDrawMenuOpen((v) => !v)}
              >
                Draw ▾
              </button>
              {drawMenuOpen && (
                <div className="chart-dropdown-menu">
                  {drawingTools
                    .filter((t) => t.tool === "Horizontal" || t.tool === "Trend")
                    .map((t) => (
                      <button
                        key={t.tool}
                        onClick={() => {
                          onSelectDrawingTool(t.tool);
                          setDrawMenuOpen(false);
                        }}
                      >
                        {t.icon} {t.label}
                      </button>
                    ))}
                </div>
              )}
            </span>
          )}
          {supportedIntervals.length > 0 && (
            <span className="chart-dropdown" ref={intervalMenuRef}>
              <button
                className="dropdown-toggle"
                aria-haspopup="listbox"
                aria-expanded={intervalMenuOpen}
                aria-label="Candle interval"
                onClick={() => setIntervalMenuOpen((v) => !v)}
              >
                {interval} ▾
              </button>
              {intervalMenuOpen && (
                <div className="chart-dropdown-menu" role="listbox">
                  {supportedIntervals.map((value) => (
                    <button
                      key={value}
                      role="option"
                      aria-selected={interval.replace("m", "") === String(value)}
                      onClick={() => {
                        onIntervalChange(String(value));
                        setIntervalMenuOpen(false);
                      }}
                    >
                      {value}m
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {onReload && (
            <button
              className="icon-button"
              title="Refresh chart and drawings"
              aria-label="Refresh chart and drawings"
              disabled={busy}
              onClick={onReload}
            >
              ↻
            </button>
          )}
          <button
            className="icon-button"
            title="Fit data to chart"
            aria-label="Fit data to chart"
            onClick={fitChart}
          >
            ⤧
          </button>
          {swapButtons}
          {!externalTradeMarkers && (
            <button
              title="All markers"
              aria-label="All markers"
              aria-pressed={historicalMarkersVisible}
              onClick={() => {
                setHistoricalMarkersVisible((value) => !value);
                onToggleHistoricalMarkers?.();
              }}
            >
              All markers
            </button>
          )}
          {!hideMaximizeButton && (
            <button
              className="icon-button"
              title={maximized ? "Restore chart" : "Maximize chart"}
              aria-label={maximized ? "Restore chart" : "Maximize chart"}
              onClick={onMaximize}
            >
              {maximized ? "⊡" : "⛶"}
            </button>
          )}
          {!hideInstrumentPicker && (
            <button
              className="icon-button"
              title="Choose instrument"
              aria-label="Choose instrument"
              onClick={onConfigure}
            >
              ⌕
            </button>
          )}
          <ChartMenuButton chart={element} visible={tradingEnabled || Boolean(onSwingChartContext)} />
          {pricePickAction && (
            <span className="candle-close">
              {pricePickAction.missingSl
                ? `Click stop-loss price for ${pricePickAction.missingSl.quantity}`
                : (pricePickAction.label ?? "Pick price")}
            </span>
          )}
          {(isLive || (Number.isFinite(countdownTime) && countdownTime! > 0)) && (
            <span
              className="candle-close"
              aria-label={`Candle closes in ${closeCountdown}`}
            >
              {closeCountdown}
            </span>
          )}
          {openOrders.map((order) => {
            const pending = pendingEdits.get(order.session_id, order.order_id);
            return pending?.reportedPrice !== undefined ? (
              <button
                key={`reconcile:${order.order_id}`}
                className="icon-button"
                title={`Use verified broker price ${pending.reportedPrice.toFixed(2)} and dismiss the unconfirmed proposal. This sends no order.`}
                aria-label={`Use verified broker price for order ${order.order_id}`}
                onClick={() =>
                  pendingEdits.acceptBrokerPrice(
                    order.session_id,
                    order.order_id,
                  )
                }
              >
                ↶
              </button>
            ) : null;
          })}
          {busy && <span role="status" className="candle-close">Updating…</span>}
        </span>
      </div>
      <div className="kline-container">
        <div className="kline" ref={element} />
        <div aria-hidden="true" className="position-pnl-levels">
          {positionLevelGeometry.map((level) => (
            <div
              key={level.key}
              className="position-pnl-level"
              style={{
                left: level.x,
                top: level.y,
                width: level.width,
                borderTopColor: level.color,
              }}
            >
              <span
                className={level.labelLeft ? "label-left" : ""}
                style={{ color: level.color, background: settings.background }}
              >
                {level.label}
              </span>
            </div>
          ))}
        </div>
        {floatingLabels.map((label) => (
          <div
            key={label.key}
            className="order-line-label"
            style={{
              left: label.x,
              top: label.y,
              borderColor: label.color,
              color: label.color,
            }}
          >
            {label.text}
          </div>
        ))}
        {pnlLabel && (
          <div
            className="position-pnl-label"
            style={{
              left: pnlLabel.x,
              top: pnlLabel.y,
              color: pnlLabel.color,
              borderColor: pnlLabel.color,
            }}
          >
            {pnlLabel.text}
          </div>
        )}
        {selectedStrategy && (
          <form
            className="line-actions target-profit-editor"
            style={{
              left: targetProfitEditorPosition.left,
              top: targetProfitEditorPosition.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void saveTargetProfitPct();
            }}
          >
            <strong>Take profit (% of capital)</strong>
            <input
              aria-label="Take profit percentage of capital"
              type="number"
              min="0"
              step="any"
              value={targetProfitPctDraft}
              disabled={targetProfitBusy}
              onChange={(event) => {
                setTargetProfitPctDraft(event.target.value);
                setTargetProfitPctError("");
              }}
              autoFocus
            />
            <span>%</span>
            <button
              type="submit"
              className="target-profit-icon"
              aria-label="Save Take Profit"
              title="Save Take Profit"
              disabled={
                targetProfitBusy ||
                !Number.isFinite(Number(targetProfitPctDraft)) ||
                Number(targetProfitPctDraft) <= 0 ||
                !onStrategyTargetProfitPct
              }
            >
              {savingTargetProfitPct ? (
                "…"
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="M3 8l3 3 7-7" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="target-profit-icon"
              aria-label="Cancel Take Profit edits"
              title="Cancel edits"
              disabled={targetProfitBusy}
              onClick={closeTargetProfitPctEditor}
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            <button
              type="button"
              className="target-profit-icon target-profit-delete"
              aria-label="Delete Take Profit strategy"
              title="Delete Take Profit strategy"
              disabled={targetProfitBusy || !onStrategyCancel}
              onClick={() => void deleteTargetProfit()}
            >
              {deletingTargetProfit ? (
                "…"
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <path d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6" />
                </svg>
              )}
            </button>
            {targetProfitPctError && (
              <span className="target-profit-editor-error">
                {targetProfitPctError}
              </span>
            )}
          </form>
        )}
        {selectedOrder && !readOnlyOrders && (
          <div
            className="line-actions"
            style={{
              left: lineActionPosition.left,
              top: lineActionPosition.top,
            }}
          >
            <span>
              {orderLineLabel(
                selectedOrder,
                position,
                tradingSettings,
                sessionCapital,
              )}
            </span>
            {selectedOrderIsSl && (
              <>
                <input
                  aria-label="Stop-loss quantity"
                  type="number"
                  min={lotSize}
                  max={selectedOrderMaxQty}
                  step={lotSize}
                  value={selectedOrderQty}
                  disabled={selectedOrderMaxQty < lotSize || savingOrderQty}
                  onChange={(event) => {
                    setSelectedOrderQty(event.target.value);
                    setOrderQtyError("");
                  }}
                  onWheel={(event) => {
                    if (document.activeElement === event.currentTarget) {
                      event.preventDefault();
                      const current =
                        Number(selectedOrderQty) || selectedOrder.quantity;
                      setSelectedOrderQty(
                        String(
                          Math.max(
                            lotSize,
                            Math.min(
                              selectedOrderMaxQty,
                              current + (event.deltaY < 0 ? lotSize : -lotSize),
                            ),
                          ),
                        ),
                      );
                    }
                  }}
                  style={{ width: 76 }}
                />
                <button
                  disabled={
                    savingOrderQty ||
                    !Number.isInteger(Number(selectedOrderQty)) ||
                    Number(selectedOrderQty) < lotSize ||
                    Number(selectedOrderQty) > selectedOrderMaxQty ||
                    Number(selectedOrderQty) % lotSize !== 0
                  }
                  onClick={() => void saveSelectedOrderQty()}
                >
                  {savingOrderQty ? "…" : "Save Qty"}
                </button>
                {orderQtyError && (
                  <span title={orderQtyError} style={{ color: "#f87171" }}>
                    !
                  </span>
                )}
              </>
            )}
            <button
              title="Convert to limit"
              aria-label="Convert to limit"
              onClick={() => onOrderConvertRequest?.(selectedOrder, "LIMIT")}
            >
              L
            </button>
            <button
              title="Convert to stop-loss"
              aria-label="Convert to stop-loss"
              onClick={() => onOrderConvertRequest?.(selectedOrder, "STOPLOSS")}
            >
              SL
            </button>
            <button
              title="Convert to target"
              aria-label="Convert to target"
              onClick={() => onOrderConvertRequest?.(selectedOrder, "TARGET")}
            >
              T
            </button>
            <button
              title="Delete order"
              aria-label="Delete order"
              onClick={() => onOrderCancel?.(selectedOrder)}
            >
              ×
            </button>
          </div>
        )}
        {contextMenu && (
          <div
            className={`chart-context-menu ${menuPosition.left + 230 + (underlyingStrategyEnabled ? 284 : 142) > window.innerWidth ? "open-left" : ""}`}
            style={{ left: menuPosition.left, top: menuPosition.top }}
          >
            <strong>
              {orderEntryEnabled
                ? `Use as SL ${contextMenu.price.toFixed(2)}`
                : instrument.kind === "option"
                  ? `${instrument.right} ${contextMenu.price.toFixed(2)}`
                  : `Underlying ${contextMenu.price.toFixed(2)}`}
            </strong>
            {entryUnavailableReason && instrument.kind === "option" && (
              <span className="context-menu-reason">
                {entryUnavailableReason}
              </span>
            )}
            {hasPosition && orderEntryEnabled && (
              <button
                disabled={uncoveredQuantity === 0}
                onClick={() => menuAction("FILL_MISSING_SL")}
              >
                SL · {uncoveredQuantity}
              </button>
            )}
            {(hasPosition ||
              orderEntryEnabled ||
              underlyingStrategyEnabled) && (
              <div className="profit-size-menu">
                <button aria-haspopup="true">Strategies ▸</button>
                <div>
                  {hasPosition && (
                    <>
                      <button onClick={() => menuAction("START_AGGRESSIVE_SL")}>
                        Aggressive SL
                      </button>
                      <button onClick={() => menuAction("START_BREAKEVEN")}>
                        Breakeven
                      </button>
                    </>
                  )}
                  {orderEntryEnabled && (
                    <button onClick={() => menuAction("START_LOCK_PROFIT")}>
                      Lock profit here
                    </button>
                  )}
                  {underlyingStrategyEnabled && (
                    <>
                      <div className="profit-size-menu">
                        <button>Underlying target here ▸</button>
                        <div>
                          <button
                            onClick={() =>
                              menuAction("START_UNDERLYING_TARGET_HALF")
                            }
                          >
                            Half
                          </button>
                          <button
                            onClick={() =>
                              menuAction("START_UNDERLYING_TARGET")
                            }
                          >
                            Full
                          </button>
                        </div>
                      </div>
                      <div className="profit-size-menu">
                        <button>Underlying SL here ▸</button>
                        <div>
                          <button
                            onClick={() =>
                              menuAction("START_UNDERLYING_SL_HALF")
                            }
                          >
                            Half
                          </button>
                          <button
                            onClick={() => menuAction("START_UNDERLYING_SL")}
                          >
                            Full
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {orderEntryEnabled && (
              <>
                <button onClick={() => menuAction("USE_SL_BUY")}>
                  Buy entry
                </button>
                {(shortEntryEnabled ||
                  tradingSettings?.context_menu_sl_mode === "both") && (
                  <button onClick={() => menuAction("USE_SL_SELL")}>
                    Sell entry
                  </button>
                )}
                {hasSlOrders && (
                  <button onClick={() => menuAction("BULK_MOVE_SL")}>
                    Move SL here
                  </button>
                )}
                {hasClosingOrders && (
                  <button onClick={() => menuAction("BULK_LIMIT")}>
                    Move exits to Limit here
                  </button>
                )}
                <div className="profit-size-menu">
                  <button>Take profit here ▸</button>
                  <div>
                    <button
                      onClick={() => menuAction("START_TARGET_PROFIT_HALF")}
                    >
                      Half
                    </button>
                    <button onClick={() => menuAction("START_TARGET_PROFIT")}>
                      Full
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {drawingNotice && (
          <div className="tile-notice" role="status">
            {drawingNotice}
          </div>
        )}
        {historyError && (
          <div className="tile-notice" role="alert">
            {historyError}
          </div>
        )}
        {loading && (
          <div className="chart-loading">
            <span className="spinner" />
            Loading candles...
          </div>
        )}
        {!loading && message && (
          <div className="chart-loading chart-message">{message}</div>
        )}
      </div>
    </section>
  );
}
