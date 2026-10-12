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
  instrument_type: "equity" | "options";
  right?: string;
  strike?: number;
  expiry?: string;
  interval: SwingInterval;
  as_of_date: string;
  follow_today?: boolean;
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
  onPick: (price: number) => void;
  onActivate: () => void;
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
    instrument_type: row.right ? "options" : "equity",
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
  Renderer,
  quote,
  marketOpen,
  chartKind,
  active,
  picking,
  position,
  orders,
  onPick,
  onActivate,
}: {
  pane: SwingPane;
  request: SwingRequest;
  prefix: string;
  Renderer: ComponentType<SwingChartProps>;
  quote?: Quote;
  marketOpen: boolean;
  chartKind?: string;
  active: boolean;
  picking: boolean;
  position?: any;
  orders: any[];
  onPick: (price: number) => void;
  onActivate: () => void;
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
  const key = JSON.stringify(pane);
  useEffect(() => {
    const version = ++owner.current;
    if (
      pane.instrument_type === "options" &&
      !(pane.right && pane.strike && pane.expiry)
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
      <div className="swing-data-label">
        {loading ? "Loading" : history.provider || "History"} ·{" "}
        {pane.as_of_date === swingToday()
          ? quote
            ? marketOpen && Date.now() / 1000 + 19800 - quote.time < 120
              ? "Live quote"
              : "Last quote"
            : "Today"
          : "Historical"}
        {error && <button onClick={() => setRetry((v) => v + 1)}>Retry</button>}
      </div>
      <Renderer
        key={`${paneKey(pane)}:${pane.interval}`}
        pane={pane}
        drawingScope={prefix}
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
        onPick={onPick}
        onActivate={onActivate}
        loadOlder={loadOlder}
      />
    </>
  );
}

export default function SwingWorkspace({
  request,
  snapshot,
  symbols,
  Renderer,
  surface,
  workspaceId,
  companion = false,
  onSaveReady,
  onCreateLinked,
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
}: {
  request: SwingRequest;
  snapshot: any;
  symbols: SymbolChoice[];
  Renderer: ComponentType<SwingChartProps>;
  surface: "website" | "desktop";
  workspaceId?: string;
  companion?: boolean;
  onSaveReady?: (save: (() => Promise<unknown>) | null) => void;
  onCreateLinked?: (portfolioId: string) => void;
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
}) {
  const prefix = snapshot.portfolio.session_id;
  const today = swingToday();
  const [panes, setPanes] = useState<SwingPane[]>([
    {
      symbol: snapshot.positions?.[0]?.symbol ?? "HDFCBANK",
      instrument_type: snapshot.positions?.[0]?.right ? "options" : "equity",
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
    [restored, setRestored] = useState(false),
    [quotes, setQuotes] = useState<Quote[]>([]),
    [marketOpen, setMarketOpen] = useState(false),
    [feed, setFeed] = useState(""),
    [notice, setNotice] = useState("");
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
    void request<{ workspace: { panes: SwingPane[]; active: number } | null }>(
      `${prefix}/charts/workspace?surface=${surface}${workspaceId ? `&workspace_id=${encodeURIComponent(workspaceId)}` : ""}`,
      "GET",
    )
      .then((value) => {
        if (!cancelled && value.workspace?.panes?.length) {
          const saved = value.workspace.panes.slice(0, 4).map((p) => ({
            ...p,
            as_of_date: p.follow_today ? swingToday() : p.as_of_date,
          }));
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
          ...(workspaceId ? { workspace_id: workspaceId } : {}),
        }).catch((cause) => setNotice(`Workspace not saved: ${String(cause)}`)),
      700,
    );
    return () => clearTimeout(timer);
  }, [paneSignature, active, restored, prefix, surface, workspaceId, request]);
  useEffect(() => {
    if (!restored) return;
    onSaveReady?.(() =>
      request(`${prefix}/charts/workspace`, "PUT", {
        surface,
        panes,
        active,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      }),
    );
    return () => onSaveReady?.(null);
  }, [
    paneSignature,
    active,
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
    if (current.instrument_type === "options")
      void request<{ contracts: any[] }>(
        `contracts/metadata?symbol=${encodeURIComponent(current.symbol)}`,
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
  }, [current.symbol, current.instrument_type, request]);
  const watchSignature = JSON.stringify(
    panes.filter(
      (p) =>
        p.as_of_date === clock &&
        (p.instrument_type === "equity" ||
          Boolean(p.right && p.strike && p.expiry)),
    ),
  );
  useEffect(() => {
    let cancelled = false,
      id: string | undefined,
      timer: ReturnType<typeof setTimeout>;
    setQuotes([]);
    if (snapshot.portfolio.state === "ended") return;
    const start = async () => {
      try {
        const created = await request<{ watch_id: string }>(
          `${prefix}/charts/watch`,
          "POST",
          { items: JSON.parse(watchSignature) },
        );
        id = created.watch_id;
        if (cancelled) {
          void request(`${prefix}/charts/watch/${id}`, "DELETE");
          return;
        }
        await poll();
      } catch (cause) {
        if (!cancelled) {
          setNotice(String(cause));
          timer = setTimeout(start, 5000);
        }
      }
    };
    const poll = async () => {
      if (cancelled || !id) return;
      try {
        const value = await request<{
          quotes: Quote[];
          market_open: boolean;
          provider: string;
          error?: string;
        }>(`${prefix}/charts/watch/${id}`, "GET");
        if (!cancelled) {
          setQuotes(value.quotes);
          setMarketOpen(value.market_open);
          setFeed(value.provider);
          if (value.error) setNotice(value.error);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(start, 5000);
          return;
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (id)
        void request(`${prefix}/charts/watch/${id}`, "DELETE").catch(
          () => undefined,
        );
    };
  }, [watchSignature, prefix, request, snapshot.portfolio.state]);
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
  const sizes = [1, 2, 3, 4];
  return (
    <div className="swing-workspace">
      <div className="swing-workspace-bar">
        <strong>
          {snapshot.portfolio.mode === "real"
            ? `${snapshot.portfolio.execution_broker} Real`
            : "Paper"}{" "}
          Swing
        </strong>
        <span>
          Funds ₹{money(snapshot.wallet_balance)} · Capital ₹
          {money(snapshot.portfolio.session_capital)} · P&amp;L ₹
          {money(snapshot.pnl)}
          {snapshot.pnl != null &&
            snapshot.portfolio.session_capital > 0 &&
            ` (${money((snapshot.pnl / snapshot.portfolio.session_capital) * 100)}%)`}
        </span>
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
        <button onClick={() => setTicketOpen((v) => !v)}>Trade ticket</button>
        <button
          disabled={busy || snapshot.portfolio.state !== "running"}
          onClick={onPause}
          style={{ display: companion ? "none" : undefined }}
        >
          {snapshot.portfolio.entries_paused
            ? "Resume entries"
            : "Pause entries"}
        </button>
        {!companion && onCreateLinked && (
          <button onClick={() => onCreateLinked(prefix)}>
            Create linked window
          </button>
        )}
        {onHistory && <button onClick={onHistory}>Execution history</button>}
        {onStats && <button onClick={onStats}>Swing Stats</button>}
        <button onClick={onManage}>Manage portfolio</button>
        <button onClick={onDetach}>Detach</button>
      </div>
      {error && (
        <p role="alert" className="swing-hint">
          {error}
        </p>
      )}
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
        <aside className="swing-portfolio-rail">
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
                    {p.symbol} {p.right} {p.strike}
                  </strong>
                  <small>
                    {p.expiry} · {p.quantity} at ₹{money(p.avg_entry_price)}
                  </small>
                  <span
                    className={
                      (p.unrealized_pnl ?? 0) >= 0
                        ? "swing-profit"
                        : "swing-loss"
                    }
                  >
                    ₹{money(p.unrealized_pnl)}{" "}
                    {p.unrealized_pnl_pct != null &&
                      `(${money(p.unrealized_pnl_pct)}%)`}
                  </span>
                  <small>
                    Mark ₹{money(p.mark_price)} · {p.quote_status ?? "Waiting"}
                  </small>
                </button>
              ))
            ) : (
              <p>No open positions.</p>
            ))}
          {tab === "Orders" &&
            (snapshot.open_orders?.length ? (
              snapshot.open_orders.map((o: any) => (
                <button
                  className="swing-position-row"
                  key={o.order_id}
                  onClick={() => selectRow(o)}
                >
                  <strong>
                    {o.symbol} {o.right} {o.strike}
                  </strong>
                  <small>
                    {o.side}{" "}
                    {Math.max(0, o.quantity - (o.filled_quantity ?? 0))} ·{" "}
                    {o.order_type} ₹{money(o.limit_price)}
                  </small>
                </button>
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
            Position % is relative to cost. Pause and detach keep portfolio
            protection active.
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
                  <button
                    title="Use today’s chart"
                    onClick={() =>
                      setPanes((previous) =>
                        previous.map((p, i) =>
                          i === index
                            ? { ...p, as_of_date: today, follow_today: true }
                            : p,
                        ),
                      )
                    }
                  >
                    Today
                  </button>
                  <button
                    title={
                      maximized === index ? "Restore chart" : "Maximize chart"
                    }
                    onClick={() =>
                      setMaximized(maximized === index ? null : index)
                    }
                  >
                    {maximized === index ? "↙" : "↗"}
                  </button>
                </div>
                <PaneChart
                  pane={pane}
                  request={request}
                  prefix={prefix}
                  Renderer={Renderer}
                  quote={quote}
                  marketOpen={marketOpen}
                  chartKind={
                    symbols.find((s) => s.symbol === pane.symbol)?.chart_type
                  }
                  active={active === index}
                  picking={picking && active === index}
                  onPick={onPick}
                  onActivate={() => setActive(index)}
                  position={snapshot.positions?.find((p: any) =>
                    exact(pane, p),
                  )}
                  orders={(snapshot.open_orders ?? []).filter((o: any) =>
                    exact(pane, o),
                  )}
                />
              </div>
            );
          })}
        </section>
        {ticketOpen && (
          <aside className="swing-trade-ticket">
            <h3>
              Chart {active + 1} · {current.symbol}
            </h3>
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
                    instrument_type: e.target.value as "equity" | "options",
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
              </select>
            </label>
            {current.instrument_type === "options" && (
              <label>
                Listed contract{" "}
                <select
                  aria-label="Chart option contract"
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
                    >
                      {c.expiry} {c.strike} {c.right} · lot {c.lot_size}
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
