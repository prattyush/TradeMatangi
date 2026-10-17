import { snapSwingPrice } from './swingOrderPrice';
import type { SwingSubscribe } from "./swingStream";
import { SwingIconButton } from "./SwingIcon";
import { flashError } from "./notifications";
import { swingMarkerTrades, type SwingMarkerMode } from "./swingMarkers";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { SymbolSearch, type SymbolChoice } from "./SymbolSearch";
import type { SwingRequest } from "./SwingPortfolioPanel";
import "./swingWorkspace.css";

export type SwingInterval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "1D";
export interface SwingPane {
  symbol: string;
  instrument_type: "equity" | "options" | "futures";
  right?: string;
  strike?: number;
  expiry?: string;
  interval: SwingInterval;
  as_of_date: string;
  follow_today?: boolean;
  marker_mode?: SwingMarkerMode;
}
export interface SwingCandle {
  time: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
export interface SwingChartProps {
  pane: SwingPane;
  drawingScope: string;
  chartKind?: string;
  candles: SwingCandle[];
  loading: boolean;
  message: string;
  live: boolean;
  active: boolean;
  picking: boolean;
  position?: any;
  orders: any[];
  trades?: any[];
  showHistoricalTrades?: boolean;
  toolsContainer?: HTMLElement | null;
  onPick: (price: number) => void;
  onActivate: () => void;
  onOrderDrag?: (order: any, price: number) => Promise<void>;
  onChartContext?: (price: number, x: number, y: number) => void;
  onOrderSelect?: (order: any) => void;
  loadOlder: (
    before: number,
  ) => Promise<{ candles: SwingCandle[]; more: boolean }>;
}
interface History {
  candles: SwingCandle[];
  provider: string;
  more: boolean;
  partial: boolean;
}
interface Quote {
  instrument: Record<string, any>;
  time: number;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  candles?: Record<
    string,
    { time: number; open: number; high: number; low: number; close: number }
  >;
}
const intervals: SwingInterval[] = ["1m", "3m", "5m", "15m", "30m", "1h", "1D"];
export const swingToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const paneKey = (p: SwingPane) =>
  `${p.symbol}:${p.instrument_type}:${p.right ?? ""}:${p.strike ?? ""}:${p.expiry ?? ""}`;
const money = (n?: number | null) =>
  n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
function exact(p: SwingPane, row: any) {
  return (
    row.symbol === p.symbol &&
    (row.right ?? "") === (p.right ?? "") &&
    (row.strike ?? "") === (p.strike ?? "") &&
    (row.expiry ?? "") === (p.expiry ?? "")
  );
}
function fromRow(row: any, base: SwingPane): SwingPane {
  return {
    ...base,
    symbol: row.symbol,
    instrument_type:
      row.instrument_type === "futures" || row.analytics?.futures
        ? "futures"
        : row.right
          ? "options"
          : "equity",
    right: row.right ?? undefined,
    strike: row.strike ?? undefined,
    expiry: row.expiry ?? undefined,
  };
}
export function swingBucket(time: number, interval: SwingInterval) {
  const day = Math.floor(time / 86400) * 86400;
  if (interval === "1D") return day;
  const seconds = (interval === "1h" ? 60 : Number(interval.slice(0, -1))) * 60;
  return day + 33300 + Math.floor((time - day - 33300) / seconds) * seconds;
}
export function mergeSwingQuote(
  rows: SwingCandle[],
  quote: Quote,
  interval: SwingInterval,
): SwingCandle[] {
  const bar = quote.candles?.[interval];
  quote = bar ? { ...quote, ...bar, time: quote.time } : quote;
  const stamp = swingBucket(quote.time, interval);
  const last = rows[rows.length - 1];
  if (last && stamp < last.time) return rows;
  const close = Number(quote.close);
  if (!Number.isFinite(close) || close <= 0) return rows;
  const next =
    last && last.time === stamp
      ? {
          ...last,
          high: Math.max(last.high, quote.high ?? close),
          low: Math.min(last.low, quote.low ?? close),
          close,
        }
      : {
          time: stamp,
          timestamp: stamp,
          open: quote.open ?? close,
          high: quote.high ?? close,
          low: quote.low ?? close,
          close,
        };
  return last && last.time === stamp
    ? [...rows.slice(0, -1), next]
    : [...rows, next];
}

function PaneChart({
  pane,
  request,
  prefix,
  drawingScope,
  Renderer,
  quote,
  marketOpen,
  chartKind,
  active,
  picking,
  position,
  orders,
  trades,
  markerBasis,
  surface,
  toolsContainer,
  onPick,
  onActivate,
  onOrderSelect, onOrderDrag, onChartContext,
}: {
  pane: SwingPane;
  request: SwingRequest;
  prefix: string;
  drawingScope: string;
  Renderer: ComponentType<SwingChartProps>;
  quote?: Quote;
  marketOpen: boolean;
  chartKind?: string;
  active: boolean;
  picking: boolean;
  position?: any;
  orders: any[];
  trades: any[];
  markerBasis: any[];
  surface: "website" | "desktop";
  toolsContainer?: HTMLElement | null;
  onPick: (price: number) => void;
  onActivate: () => void;
  onOrderDrag?: (order: any, price: number) => Promise<void>;
  onChartContext?: (price: number, x: number, y: number) => void;
  onOrderSelect?: (order: any) => void;
}) {
  const [history, setHistory] = useState<History>({
      candles: [],
      provider: "",
      more: false,
      partial: false,
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const owner = useRef(0);
  const more = useRef(false);
  const latestQuote = useRef(quote);
  latestQuote.current = quote;
  const key = JSON.stringify({ ...pane, marker_mode: undefined });
  useEffect(() => {
    const version = ++owner.current;
    if (
      (pane.instrument_type === "options" &&
        !(pane.right && pane.strike && pane.expiry)) ||
      (pane.instrument_type === "futures" && !pane.expiry)
    ) {
      setLoading(false);
      setHistory({ candles: [], provider: "", more: false, partial: false });
      more.current = false;
      setError("Choose an exact contract");
      return;
    }
    more.current = false;
    setLoading(true);
    setError("");
    setHistory({ candles: [], provider: "", more: false, partial: false });
    void request<History>(
      `${prefix}/charts/history`,
      "POST",
      pane as unknown as Record<string, unknown>,
    )
      .then((value) => {
        if (owner.current === version) {
          more.current = value.more;
          const q = latestQuote.current;
          setHistory({
            ...value,
            candles:
              q && pane.as_of_date === swingToday()
                ? mergeSwingQuote(value.candles, q, pane.interval)
                : value.candles,
          });
        }
      })
      .catch((cause) => {
        if (owner.current === version) setError(String(cause));
      })
      .finally(() => {
        if (owner.current === version) setLoading(false);
      });
    return () => {
      owner.current++;
    };
  }, [key, prefix, request, retry]);
  useEffect(() => {
    if (quote && pane.as_of_date === swingToday())
      setHistory((previous) => ({
        ...previous,
        candles: mergeSwingQuote(previous.candles, quote, pane.interval),
      }));
  }, [quote, key]);
  const loadOlder = async (before: number) => {
    if (!more.current) return { candles: [], more: false };
    const version = owner.current;
    const page = await request<History>(`${prefix}/charts/history`, "POST", {
      ...pane,
      before,
    });
    if (version !== owner.current) return { candles: [], more: false };
    more.current = page.more;
    const older = page.candles.filter((c) => c.time < before);
    setHistory((previous) => ({
      ...previous,
      candles: [
        ...older,
        ...previous.candles.filter(
          (c) => !older.some((old) => old.time === c.time),
        ),
      ],
      more: page.more,
    }));
    return { candles: older, more: page.more };
  };
  return (
    <>
      {(surface !== "desktop" || error) && (
        <div className="swing-data-label">
          {surface !== "desktop" && (
            <>
              {loading ? "Loading" : history.provider || "History"} ·{" "}
              {pane.as_of_date === swingToday()
                ? quote
                  ? marketOpen && Date.now() / 1000 + 19800 - quote.time < 120
                    ? "Live quote"
                    : "Last quote"
                  : "Today"
                : "Historical"}
            </>
          )}
          {error && (
            <button onClick={() => setRetry((v) => v + 1)}>Retry</button>
          )}
        </div>
      )}
      <Renderer
        key={`${paneKey(pane)}:${pane.interval}`}
        pane={pane}
        drawingScope={drawingScope}
        toolsContainer={toolsContainer}
        chartKind={chartKind}
        candles={history.candles}
        loading={loading}
        message={
          error ||
          (!loading && !history.candles.length
            ? "No history available for this exact instrument"
            : "")
        }
        live={
          Boolean(quote) &&
          marketOpen &&
          Date.now() / 1000 + 19800 - (quote?.time ?? 0) < 120 &&
          pane.as_of_date === swingToday()
        }
        active={active}
        picking={picking}
        position={position}
        orders={orders}
        onOrderSelect={onOrderSelect}
        onOrderDrag={onOrderDrag}
        onChartContext={onChartContext}
        trades={swingMarkerTrades(
          trades,
          pane,
          pane.marker_mode ?? "open",
          markerBasis,
        )}
        showHistoricalTrades
        onPick={onPick}
        onActivate={onActivate}
        loadOlder={loadOlder}
      />
    </>
  );
}

export default function SwingWorkspace({
  request,
  subscribe,
  snapshot,
  symbols,
  Renderer,
  surface,
  workspaceId,
  portfolioControls,
  navigationControls,
  companion = false,
  onSaveReady,
  onCreateLinked,
  onPopOut,
  onSelect,
  onPick,
  picking,
  ticket,
  onManage,
  onHistory,
  onStats,
  onDetach,
  error,
  busy,
  onPause,
  onOrderSelect, onOrderEdit, onOrderCancel, onOrderDrag, onChartTicket, pickOrder, quoteOrder, onOrderQuote,
}: {
  request: SwingRequest;
  subscribe: SwingSubscribe;
  snapshot: any;
  symbols: SymbolChoice[];
  Renderer: ComponentType<SwingChartProps>;
  surface: "website" | "desktop";
  workspaceId?: string;
  portfolioControls?: ReactNode;
  navigationControls?: ReactNode;
  companion?: boolean;
  onSaveReady?: (save: (() => Promise<unknown>) | null) => void;
  onCreateLinked?: (portfolioId: string) => void;
  onPopOut?: (portfolioId: string) => void;
  onSelect: (pane: SwingPane) => void;
  onPick: (price: number) => void;
  picking: boolean;
  ticket: ReactNode;
  onManage: () => void;
  onHistory?: () => void;
  onStats?: () => void;
  onDetach: () => void;
  error?: string;
  busy?: boolean;
  onPause: () => void;
  onOrderDrag?: (order: any, price: number) => Promise<void>;
  onChartTicket?: (pane: SwingPane, price: number, side: "BUY" | "SELL", type: "LIMIT" | "TARGET" | "STOPLOSS", tick?: number) => void;
  pickOrder?: any;
  quoteOrder?: any;
  onOrderQuote?: (quote: {price: number; time: number} | null) => void;
  onOrderSelect: (order: any) => void;
  onOrderEdit: (order: any) => void;
  onOrderCancel: (order: any) => void;
}) {
  const [chartMenu, setChartMenu] = useState<{pane: SwingPane; price: number; tick: number; x: number; y: number} | null>(null);
  const prefix = snapshot.portfolio.session_id;
  const today = swingToday();
  const [panes, setPanes] = useState<SwingPane[]>([
    {
      symbol: snapshot.positions?.[0]?.symbol ?? "HDFCBANK",
      instrument_type:
        snapshot.positions?.[0]?.instrument_type === "futures"
          ? "futures"
          : snapshot.positions?.[0]?.right
            ? "options"
            : "equity",
      right: snapshot.positions?.[0]?.right,
      strike: snapshot.positions?.[0]?.strike,
      expiry: snapshot.positions?.[0]?.expiry,
      interval: snapshot.positions?.[0]?.right ? "15m" : "1D",
      as_of_date: today,
      follow_today: true,
    },
  ]);
  const [active, setActive] = useState(0),
    [maximized, setMaximized] = useState<number | null>(null),
    [tab, setTab] = useState("Positions"),
    [ticketOpen, setTicketOpen] = useState(true),
    [railOpen, setRailOpen] = useState(true),
    [toolsCollapsed, setToolsCollapsed] = useState(false),
    [restored, setRestored] = useState(false),
    [quotes, setQuotes] = useState<Quote[]>([]),
    [marketOpen, setMarketOpen] = useState(false),
    [feed, setFeed] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    if (surface === "desktop" && notice)
      flashError(notice, "Desktop Swing workspace", { sessionId: prefix });
  }, [notice, surface, prefix]);
  const [toolsContainer, setToolsContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [metadata, setMetadata] = useState<any[]>([]);
  const current = panes[active] ?? panes[0];
  const currentSymbol = symbols.find((s) => s.symbol === current.symbol);
  const paneSignature = JSON.stringify(panes);
  const [clock, setClock] = useState(today);
  useEffect(() => {
    const timer = setInterval(() => {
      const next = swingToday();
      setClock(next);
      setPanes((previous) =>
        previous.map((p) =>
          p.follow_today && p.as_of_date !== next
            ? { ...p, as_of_date: next }
            : p,
        ),
      );
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void request<{
      workspace: {
        panes: SwingPane[];
        active: number;
        rail_open?: boolean;
        ticket_open?: boolean;
        tools_collapsed?: boolean;
      } | null;
    }>(
      `${prefix}/charts/workspace?surface=${surface}${workspaceId ? `&workspace_id=${encodeURIComponent(workspaceId)}` : ""}`,
      "GET",
    )
      .then((value) => {
        if (!cancelled && value.workspace?.panes?.length) {
          const saved = value.workspace.panes.slice(0, 4).map((p) => ({
            ...p,
            as_of_date: p.follow_today ? swingToday() : p.as_of_date,
          }));
          setRailOpen(value.workspace.rail_open ?? true);
          setTicketOpen(value.workspace.ticket_open ?? true);
          setToolsCollapsed(value.workspace.tools_collapsed ?? false);
          setPanes(saved);
          setActive(Math.min(value.workspace.active, saved.length - 1));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, surface, workspaceId, request]);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(
      () =>
        void request(`${prefix}/charts/workspace`, "PUT", {
          surface,
          panes,
          active,
          rail_open: railOpen,
          ticket_open: ticketOpen,
          tools_collapsed: toolsCollapsed,
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        }).catch((cause) => setNotice(`Workspace not saved: ${String(cause)}`)),
      700,
    );
    return () => clearTimeout(timer);
  }, [
    paneSignature,
    active,
    railOpen,
    ticketOpen,
    toolsCollapsed,
    restored,
    prefix,
    surface,
    workspaceId,
    request,
  ]);
  useEffect(() => {
    if (!restored) return;
    onSaveReady?.(() =>
      request(`${prefix}/charts/workspace`, "PUT", {
        surface,
        panes,
        active,
        rail_open: railOpen,
        ticket_open: ticketOpen,
        tools_collapsed: toolsCollapsed,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      }),
    );
    return () => onSaveReady?.(null);
  }, [
    paneSignature,
    active,
    railOpen,
    ticketOpen,
    toolsCollapsed,
    restored,
    prefix,
    surface,
    workspaceId,
    request,
    onSaveReady,
  ]);
  useEffect(() => {
    onSelect(current);
  }, [paneKey(current), active]);
  useEffect(() => {
    let cancelled = false;
    setMetadata([]);
    if (current.instrument_type !== "equity")
      void request<{ contracts: any[] }>(
        current.instrument_type === "futures"
          ? `contracts/futures?symbol=${encodeURIComponent(current.symbol)}&provider=${snapshot.portfolio.execution_broker ?? snapshot.portfolio.paper_broker ?? "kite"}`
          : `contracts/metadata?symbol=${encodeURIComponent(current.symbol)}`,
        "GET",
      )
        .then((value) => {
          if (!cancelled) setMetadata(value.contracts);
        })
        .catch((cause) => {
          if (!cancelled) setNotice(String(cause));
        });
    return () => {
      cancelled = true;
    };
  }, [
    current.symbol,
    current.instrument_type,
    snapshot.portfolio.execution_broker,
    snapshot.portfolio.paper_broker,
    request,
  ]);
  const watchSignature = JSON.stringify(
    panes
      .filter(
        (p) =>
          p.as_of_date === clock &&
          (p.instrument_type === "equity" ||
            (p.instrument_type === "futures"
              ? Boolean(p.expiry)
              : Boolean(p.right && p.strike && p.expiry))),
      )
      .map(({ marker_mode: _markerMode, ...pane }) => pane),
  );
  useEffect(() => {
    let cancelled = false, id: string | undefined;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout>;
    setQuotes([]);
    if (snapshot.portfolio.state === "ended") return;
    const start = async () => {
      try {
        const created = await request<{ watch_id: string }>(`${prefix}/charts/watch`, "POST", { items: JSON.parse(watchSignature) });
        id = created.watch_id;
        if (cancelled) { void request(`${prefix}/charts/watch/${id}`, "DELETE"); return; }
        stop = subscribe(`${prefix}/charts/watch/${id}/events`, value => {
          if (cancelled) return;
          if (value.type === "chart_watch_expired") {
            stop?.();
            void request(`${prefix}/charts/watch/${id}`, "DELETE").catch(() => undefined);
            timer = setTimeout(start, 1000);
          } else if (value.quotes) {
            setQuotes(value.quotes);
            setMarketOpen(value.market_open);
            setFeed(value.provider);
            if (value.error) setNotice(value.error);
          }
        }, cause => { if (!cancelled) setNotice(String(cause)); });
      } catch (cause) {
        if (!cancelled) { setNotice(String(cause)); timer = setTimeout(start, 5000); }
      }
    };
    void start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop?.();
      if (id) void request(`${prefix}/charts/watch/${id}`, "DELETE").catch(() => undefined);
    };
  }, [watchSignature, prefix, request, subscribe, snapshot.portfolio.state]);
  const update = (change: Partial<SwingPane>) => {
    setPanes((previous) =>
      previous.map((p, i) => (i === active ? { ...p, ...change } : p)),
    );
    setNotice("");
  };
  const selectRow = (row: any) => {
    setPanes((previous) =>
      previous.map((p, i) => (i === active ? fromRow(row, p) : p)),
    );
    setTicketOpen(true);
  };
  useEffect(() => {
    if (pickOrder) selectRow(pickOrder);
  }, [pickOrder]);
  const quoteCallback = useRef(onOrderQuote);
  quoteCallback.current = onOrderQuote;
  useEffect(() => {
    const quote = quoteOrder && marketOpen && quotes.find(q =>
      (q.instrument.underlying ?? q.instrument.symbol) === quoteOrder.symbol &&
      (q.instrument.right ?? "") === (quoteOrder.right ?? "") &&
      (q.instrument.strike ?? "") === (quoteOrder.strike ?? "") &&
      (q.instrument.expiry ?? "") === (quoteOrder.expiry ?? ""));
    quoteCallback.current?.(quote ? {price:quote.close, time:quote.time} : null);
  }, [quotes, quoteOrder, marketOpen]);
  useEffect(() => {
    if (!chartMenu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setChartMenu(null) };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [chartMenu]);
  const sizes = [1, 2, 3, 4];
  return (
    <div className="swing-workspace">
      {chartMenu && <div style={{position:'fixed',inset:0,zIndex:1400}} onClick={() => setChartMenu(null)}>
        <div role="menu" aria-label="Swing chart orders" style={{position:'absolute',left:Math.max(0, Math.min(chartMenu.x, window.innerWidth - 210)),top:Math.max(0, Math.min(chartMenu.y, window.innerHeight - 240)),background:'#161b22',padding:12,border:'1px solid #30363d',display:'grid',gap:8}}>
          {(["BUY", "SELL"] as const).flatMap(side => {
            const held = snapshot.positions?.find((p: any) => exact(chartMenu.pane, p));
            const exit = held?.quantity > 0 && ((held.side === 'LONG' && side === 'SELL') || (held.side === 'SHORT' && side === 'BUY'));
            if (chartMenu.pane.instrument_type !== 'futures' && side === 'SELL' && !exit) return [];
            if (!exit && snapshot.portfolio.entries_paused) return [];
            return (exit ? ['LIMIT','STOPLOSS'] as const : ['LIMIT','TARGET'] as const).map(type => <button role="menuitem" key={side+type} onClick={() => {
              onSelect(chartMenu.pane); setTicketOpen(true); onChartTicket?.(chartMenu.pane,chartMenu.price,side,type,chartMenu.tick); setChartMenu(null);
            }}>{side} {type === 'STOPLOSS' ? 'Stoploss' : type === 'TARGET' ? 'Target' : 'Limit'} · ₹{chartMenu.price.toFixed(2)}</button>);
          })}
        </div>
      </div>}
      <div className="swing-workspace-bar">
        {navigationControls}
        {portfolioControls}
        <strong>
          {snapshot.portfolio.mode === "real"
            ? `${snapshot.portfolio.execution_broker} Real`
            : "Paper"}{" "}
          Swing
        </strong>
        <span className={marketOpen ? "swing-live" : "swing-muted"}>
          {marketOpen ? "Market open" : "Market closed"} · {feed}
        </span>
        <select
          aria-label="Swing chart layout"
          value={panes.length}
          onChange={(e) => {
            const size = Number(e.target.value);
            setPanes((previous) =>
              Array.from(
                { length: size },
                (_, i) =>
                  previous[i] ?? {
                    symbol: "HDFCBANK",
                    instrument_type: "equity",
                    interval: "1D",
                    as_of_date: today,
                    follow_today: true,
                  },
              ),
            );
            setActive((i) => Math.min(i, size - 1));
            setMaximized(null);
          }}
        >
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size} chart{size > 1 ? "s" : ""}
            </option>
          ))}
        </select>
        <SwingIconButton
          label={snapshot.portfolio.entries_paused ? "Resume entries" : "Pause entries"}
          icon={snapshot.portfolio.entries_paused ? "Play" : "Pause"}
          disabled={busy || snapshot.portfolio.state !== "running"}
          onClick={onPause}
          style={{ display: companion ? "none" : undefined }}
        />
        {!companion && onPopOut && <SwingIconButton label="Pop out Swing" icon="PopOut" disabled={busy} onClick={() => onPopOut(prefix)} />}
        {!companion && onCreateLinked && <SwingIconButton label="Create linked window" icon="Link" onClick={() => onCreateLinked(prefix)} />}
        {onHistory && <SwingIconButton label="Execution history" icon="History" onClick={onHistory} />}
        {onStats && <SwingIconButton label="Swing Stats" icon="Stats" onClick={onStats} />}
        <SwingIconButton label="Manage portfolio" icon="Manage" onClick={onManage} />
        <SwingIconButton label="Detach" icon="Detach" onClick={onDetach} />
      </div>
      {surface === "desktop" && (
        <div className="swing-tools-bar" aria-label="Active chart tools">
          <SwingIconButton
            label={toolsCollapsed ? "Show chart tools" : "Hide chart tools"}
            icon={toolsCollapsed ? "ToolsShow" : "ToolsHide"}
            aria-expanded={!toolsCollapsed}
            onClick={() => setToolsCollapsed((v) => !v)}
          />
          <span>Chart {active + 1} tools</span>
          <select
            aria-label="Active chart markers"
            value={current.marker_mode ?? "open"}
            onChange={(e) =>
              update({ marker_mode: e.target.value as SwingMarkerMode })
            }
          >
            <option value="open">Open markers</option>
            <option value="all">All markers</option>
            <option value="off">Markers off</option>
          </select>
          <div
            ref={setToolsContainer}
            className="swing-tools-slot"
            style={{ display: toolsCollapsed ? "none" : "flex" }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="swing-hint">
          {error}
        </p>
      )}
      {(snapshot.futures ?? [])
        .filter((f: any) => f.warning)
        .map((f: any) => (
          <p key={f.session_id} role="status" className="swing-hint">
            {f.symbol} {f.expiry} · {f.warning}
          </p>
        ))}
      {snapshot.portfolio.history_warning && (
        <p role="status" className="swing-hint">
          {snapshot.portfolio.history_warning}
        </p>
      )}
      {snapshot.funding_status && !snapshot.funding_status.entries_allowed && (
        <p role="status" className="swing-hint">
          Entries wait for shared funding reconciliation; exits remain
          available.
        </p>
      )}
      <div className="swing-workspace-body">
        {!railOpen && <div className="swing-panel-reopen swing-panel-reopen-left">
          <SwingIconButton label="Show portfolio panel" icon="LeftShow" aria-expanded={false} onClick={() => setRailOpen(true)} />
        </div>}
        <aside
          className="swing-portfolio-rail"
          hidden={!railOpen}
          aria-label="Portfolio panel"
        >
          <div className="swing-panel-heading">
            <strong>Portfolio</strong>
            <SwingIconButton label="Hide portfolio panel" icon="LeftHide" aria-expanded={true} onClick={() => setRailOpen(false)} />
          </div>
          <section className="swing-funds-info" aria-label="Portfolio summary">
            <strong>Portfolio summary</strong>
            <dl>
              <div><dt>Funds</dt><dd>₹{money(snapshot.wallet_balance)}</dd></div>
              <div><dt>Capital</dt><dd>₹{money(snapshot.portfolio.session_capital)}</dd></div>
              <div><dt>P&amp;L</dt><dd className={snapshot.pnl == null || snapshot.pnl === 0 ? "swing-muted" : snapshot.pnl > 0 ? "swing-profit" : "swing-loss"}>
                ₹{money(snapshot.pnl)}
                {snapshot.pnl != null && snapshot.portfolio.session_capital > 0 && <small> ({money((snapshot.pnl / snapshot.portfolio.session_capital) * 100)}%)</small>}
              </dd></div>
            </dl>
            {snapshot.positions?.length > 0 && snapshot.valuation_status && <small className="swing-muted">{snapshot.valuation_status === "unavailable" ? "Waiting for position prices" : snapshot.valuation_status === "stale" || !marketOpen ? "P&L at last known prices" : "P&L at live prices"}</small>}
          </section>
          <nav>
            {["Positions", "Orders", "Trades"].map((value) => (
              <button
                key={value}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {value}
              </button>
            ))}
          </nav>
          {tab === "Positions" &&
            (snapshot.positions?.length ? (
              snapshot.positions.map((p: any) => (
                <button
                  className="swing-position-row"
                  key={`${p.session_id}:${p.right}:${p.strike}:${p.expiry}`}
                  onClick={() => selectRow(p)}
                >
                  <strong>
                    {p.symbol}{" "}
                    {p.instrument_type === "futures" ? "FUT" : p.right}{" "}
                    {p.strike}
                  </strong>
                  <small>
                    {p.expiry} · {p.quantity} at ₹{money(p.avg_entry_price)}
                  </small>
                  <span
                    className={
                      p.unrealized_pnl == null ? "swing-muted" : p.unrealized_pnl >= 0
                        ? "swing-profit"
                        : "swing-loss"
                    }
                  >
                    ₹{money(p.unrealized_pnl)}{" "}
                    {p.unrealized_pnl_pct != null &&
                      `(${money(p.unrealized_pnl_pct)}%)`}
                  </span>
                  <small>
                    Mark ₹{money(p.mark_price)} · {p.quote_status === "live" && !marketOpen ? "stale" : p.quote_status ?? "Waiting"}
                  </small>
                </button>
              ))
            ) : (
              <p>No open positions.</p>
            ))}
          {tab === "Orders" &&
            (snapshot.open_orders?.length ? (
              snapshot.open_orders.map((o: any) => (
                <div className="swing-order-row" key={o.order_id}><button
                  className="swing-position-row"
                  onClick={() => selectRow(o)}
                >
                  <strong>
                    {o.symbol} {o.right} {o.strike}
                  </strong>
                  <small>
                    {o.side}{" "}
                    {Math.max(0, o.quantity - (o.broker_filled_quantity ?? o.filled_quantity ?? 0))} ·{" "}
                    {o.order_type} ₹{money(o.limit_price)}
                  </small>
                </button>
                <SwingIconButton label={`Edit order ${o.symbol}`} icon="Edit" disabled={busy || ['stopped', 'ended'].includes(snapshot.portfolio.state)} onClick={() => onOrderEdit(o)}/>
                <SwingIconButton label={`Cancel order ${o.symbol}`} icon="Delete" disabled={busy || ['stopped', 'ended'].includes(snapshot.portfolio.state)} onClick={() => onOrderCancel(o)}/>
                </div>
              ))
            ) : (
              <p>No pending intentions.</p>
            ))}
          {tab === "Trades" &&
            (snapshot.trades?.length ? (
              snapshot.trades.map((t: any) => (
                <button
                  className="swing-position-row"
                  key={t.trade_id}
                  onClick={() => selectRow(t)}
                >
                  <strong>
                    {t.symbol} {t.right} {t.strike}
                  </strong>
                  <small>
                    {t.side} {t.quantity} at ₹{money(t.price)}
                  </small>
                </button>
              ))
            ) : (
              <p>No recorded trades.</p>
            ))}
          <p className="swing-muted">
            {snapshot.futures?.length
              ? "Futures % uses held margin; other positions use cost."
              : "Position % is relative to cost."}{" "}
            Pause and detach keep portfolio protection active.
          </p>
        </aside>
        <section
          className={`swing-chart-deck swing-panes-${panes.length}`}
          aria-label="Swing charts"
        >
          {panes.map((pane, index) => {
            const quote = quotes.find(
              (q) =>
                (q.instrument.underlying ?? q.instrument.symbol) ===
                  pane.symbol &&
                (q.instrument.right ?? "") === (pane.right ?? "") &&
                (q.instrument.strike ?? "") === (pane.strike ?? "") &&
                (q.instrument.expiry ?? "") === (pane.expiry ?? ""),
            );
            return (
              <div
                key={index}
                className={`swing-chart-pane ${active === index ? "swing-pane-active" : ""} ${maximized === index ? "swing-maximized" : ""}`}
                style={{
                  display:
                    maximized != null && maximized !== index
                      ? "none"
                      : undefined,
                }}
                onPointerDown={() => setActive(index)}
              >
                <div className="swing-pane-bar">
                  <strong>
                    {pane.symbol} {pane.right} {pane.strike}
                  </strong>
                  {surface === "website" && (
                    <select
                      aria-label={`Chart ${index + 1} markers`}
                      value={pane.marker_mode ?? "open"}
                      onChange={(e) =>
                        setPanes((previous) =>
                          previous.map((p, i) =>
                            i === index
                              ? {
                                  ...p,
                                  marker_mode: e.target
                                    .value as SwingMarkerMode,
                                }
                              : p,
                          ),
                        )
                      }
                    >
                      <option value="open">Open markers</option>
                      <option value="all">All markers</option>
                      <option value="off">Markers off</option>
                    </select>
                  )}
                  <input
                    aria-label={`Chart ${index + 1} date`}
                    type="date"
                    max={today}
                    value={pane.as_of_date}
                    onChange={(e) =>
                      setPanes((previous) =>
                        previous.map((p, i) =>
                          i === index
                            ? {
                                ...p,
                                as_of_date: e.target.value,
                                follow_today: e.target.value === today,
                              }
                            : p,
                        ),
                      )
                    }
                  />
                  <select
                    aria-label={`Chart ${index + 1} interval`}
                    value={pane.interval}
                    onChange={(e) =>
                      setPanes((previous) =>
                        previous.map((p, i) =>
                          i === index
                            ? {
                                ...p,
                                interval: e.target.value as SwingInterval,
                              }
                            : p,
                        ),
                      )
                    }
                  >
                    {intervals.map((interval) => (
                      <option key={interval}>{interval}</option>
                    ))}
                  </select>
                  <SwingIconButton
                    label="Use today’s chart"
                    icon="Today"
                    onClick={() =>
                      setPanes((previous) =>
                        previous.map((p, i) =>
                          i === index
                            ? { ...p, as_of_date: today, follow_today: true }
                            : p,
                        ),
                      )
                    }
                  />
                  <SwingIconButton
                    icon={maximized === index ? "Restore" : "Maximize"}
                    label={
                      maximized === index ? "Restore chart" : "Maximize chart"
                    }
                    onClick={() =>
                      setMaximized(maximized === index ? null : index)
                    }
                  />
                </div>
                <PaneChart
                  pane={pane}
                  request={request}
                  prefix={prefix}
                  drawingScope={`swing:${prefix}:${workspaceId ?? "primary"}`}
                  Renderer={Renderer}
                  surface={surface}
                  toolsContainer={toolsContainer}
                  quote={quote}
                  marketOpen={marketOpen}
                  chartKind={
                    symbols.find((s) => s.symbol === pane.symbol)?.chart_type
                  }
                  active={active === index}
                  picking={picking && (pickOrder ? exact(pane, pickOrder) : active === index)}
                  onPick={onPick}
                  onActivate={() => setActive(index)}
                  position={snapshot.positions?.find((p: any) =>
                    exact(pane, p),
                  )}
                  trades={snapshot.trades ?? []}
                  markerBasis={snapshot.marker_basis ?? []}
                  onOrderSelect={!["stopped", "ended"].includes(snapshot.portfolio.state) && !picking ? onOrderSelect : undefined}
                  onOrderDrag={!busy && !picking && !["stopped", "ended"].includes(snapshot.portfolio.state) ? onOrderDrag : undefined}
                  onChartContext={snapshot.portfolio.state === 'running' && !busy && !picking && (pane.instrument_type !== 'equity' || symbols.find(s => s.symbol === pane.symbol)?.chart_type !== 'index') ? (price,x,y) => {
                    if (!Number.isFinite(price) || price <= 0) return;
                    const order = snapshot.open_orders?.find((o: any) => exact(pane,o));
                    const contract = metadata.find(c => (!c.symbol || c.symbol === pane.symbol) && (c.right ?? '') === (pane.right ?? '') && (c.strike ?? '') === (pane.strike ?? '') && (c.expiry ?? '') === (pane.expiry ?? ''));
                    const tick = Number(order?.tick_size ?? order?.analytics?.futures?.contract?.tick_size ?? contract?.tick_size ?? .05);
                    setActive(index);setChartMenu({pane,price:snapSwingPrice(price,tick),tick,x,y});
                  } : undefined}
                  orders={(snapshot.open_orders ?? []).filter((o: any) =>
                    exact(pane, o),
                  )}
                />
              </div>
            );
          })}
        </section>
        {!ticketOpen && <div className="swing-panel-reopen swing-panel-reopen-right">
          <SwingIconButton label="Show trade ticket" icon="RightShow" aria-expanded={false} onClick={() => setTicketOpen(true)} />
        </div>}
        {ticketOpen && (
          <aside className="swing-trade-ticket" aria-label="Trade ticket">
            <div className="swing-panel-heading">
              <h3>Chart {active + 1} · {current.symbol}</h3>
              <SwingIconButton label="Hide trade ticket" icon="RightHide" aria-expanded={true} onClick={() => setTicketOpen(false)} />
            </div>
            <SymbolSearch
              value={current.symbol}
              options={symbols}
              onChange={(symbol) =>
                update({
                  symbol,
                  instrument_type: "equity",
                  right: undefined,
                  strike: undefined,
                  expiry: undefined,
                  interval: "1D",
                })
              }
            />
            <label>
              Instrument{" "}
              <select
                aria-label="Chart instrument"
                value={current.instrument_type}
                onChange={(e) =>
                  update({
                    instrument_type: e.target
                      .value as SwingPane["instrument_type"],
                    right: undefined,
                    strike: undefined,
                    expiry: undefined,
                    interval: e.target.value === "options" ? "15m" : "1D",
                  })
                }
              >
                <option value="equity">
                  {currentSymbol?.chart_type === "index"
                    ? "Underlying"
                    : "Equity"}
                </option>
                <option
                  value="options"
                  disabled={currentSymbol?.option_eligible === false}
                >
                  Options
                </option>
                <option value="futures">Futures</option>
              </select>
            </label>
            {current.instrument_type !== "equity" && (
              <label>
                Listed contract{" "}
                <select
                  aria-label={
                    current.instrument_type === "futures"
                      ? "Chart Futures contract"
                      : "Chart option contract"
                  }
                  value={metadata.findIndex(
                    (c) =>
                      c.right === current.right &&
                      c.strike === current.strike &&
                      c.expiry === current.expiry,
                  )}
                  onChange={(e) => {
                    const c = metadata[Number(e.target.value)];
                    if (c)
                      update({
                        right: c.right,
                        strike: c.strike,
                        expiry: c.expiry,
                      });
                  }}
                >
                  <option value="-1">Choose exact contract</option>
                  {metadata.map((c, i) => (
                    <option
                      key={`${c.expiry}:${c.strike}:${c.right}`}
                      value={i}
                      disabled={
                        current.instrument_type === "futures" &&
                        c.entry_eligible === false
                      }
                    >
                      {c.expiry}{" "}
                      {current.instrument_type === "futures"
                        ? "FUT"
                        : `${c.strike} ${c.right}`}{" "}
                      · lot {c.lot_size}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {current.as_of_date !== today && (
              <p className="swing-hint">
                Historical chart — orders execute now.
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {currentSymbol?.chart_type === "index" &&
            current.instrument_type === "equity" ? (
              <p>
                Underlying chart is research-only. Select an exact option to
                trade.
              </p>
            ) : (
              ticket
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
