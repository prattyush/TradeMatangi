import SwingStats from "./SwingStats";
import SwingHistory from "./SwingHistory";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import SwingWorkspace, {
  type SwingChartProps,
  type SwingPane,
} from "./SwingWorkspace";
import { SymbolSearch, type SymbolChoice } from "./SymbolSearch";

export type SwingRequest = <T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
) => Promise<T>;
interface Portfolio {
  mode?: string;
  execution_broker?: string;
  history_warning?: string;
  session_id: string;
  state: string;
  entries_paused: boolean;
  guardrail_ban?: boolean;
  session_capital: number;
  guardrail_epoch: number;
}
interface Position {
  symbol: string;
  right?: string;
  strike?: number;
  expiry?: string;
  quantity: number;
  avg_entry_price: number;
  mark_price?: number;
}
interface ListedContract {
  strike: number;
  expiry: string;
  right: string;
  lot_size: number;
}
interface PendingOrder {
  order_id: string;
  symbol: string;
  side: string;
  order_type: string;
  quantity: number;
  limit_price: number;
  right?: string;
  strike?: number;
  expiry?: string;
}
interface Snapshot {
  current_submission_ids?: string[];
  undated_submission_ids?: string[];
  closure_blocked?: boolean;
  allocation_pct?: number;
  recovery_issues?: {
    session_id: string;
    message: string;
    verified_flat: boolean;
  }[];
  funding_status?: {
    state: string;
    entries_allowed: boolean;
    shortfall?: number;
  };
  portfolio: Portfolio | null;
  wallet_balance?: number;
  pnl?: number | null;
  guardrail_pnl?: number | null;
  reconciliation_pending?: string[];
  positions?: Position[];
  open_orders?: PendingOrder[];
}
const money = (value?: number | null) =>
  value == null
    ? "Waiting for prices"
    : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Account-owned controls: dismissing this view never stops the portfolio. */
export default function SwingPortfolioPanel({
  request,
  loadSymbols,
  onDetach,
  renderChart,
  surface = "website",
  portfolioId,
  workspaceId,
  companion = false,
  onPortfolioReady,
  onSaveReady,
  onCreateLinked,
  onAnalyse,
  onDraftStateChange,
}: {
  request: SwingRequest;
  loadSymbols: () => Promise<SymbolChoice[]>;
  onDetach: () => void;
  renderChart?: ComponentType<SwingChartProps>;
  surface?: "website" | "desktop";
  portfolioId?: string;
  workspaceId?: string;
  companion?: boolean;
  onPortfolioReady?: (portfolio: Portfolio) => void;
  onSaveReady?: (save: (() => Promise<unknown>) | null) => void;
  onCreateLinked?: (portfolioId: string) => void;
  onAnalyse?: (portfolioId: string, sessionId?: string) => void;
  onDraftStateChange?: (state:{dirty:boolean;saving:boolean})=>void;
}) {
  const [analyticsOpen, setAnalyticsOpen] = useState<
      "stats" | "history" | null
    >(null),
    [selectedCycle, setSelectedCycle] = useState<string | undefined>();
  const labelState = useRef({dirty:false,saving:false});
  const reportDraft = (state:{dirty:boolean;saving:boolean}) => {labelState.current=state;onDraftStateChange?.(state);};
  const mayNavigate = () => !labelState.current.saving && (!labelState.current.dirty || window.confirm('Discard unsaved trade labels?'));
  const [managementOpen, setManagementOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const requestedContract = useRef<SwingPane | null>(null);
  const [mode, setMode] = useState<"paper" | "real">("paper");
  const [broker, setBroker] = useState("kite");
  const [allocation, setAllocation] = useState("100");
  const [realEnabled, setRealEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void request<{ real_trading_enabled: boolean }>("capabilities", "GET")
      .then((value) => {
        if (active) setRealEnabled(value.real_trading_enabled);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [request]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (snapshot?.portfolio) {
      if (portfolioId) {
        setMode(snapshot.portfolio.mode === "real" ? "real" : "paper");
        setBroker(snapshot.portfolio.execution_broker ?? "kite");
      }
      onPortfolioReady?.(snapshot.portfolio);
    }
  }, [snapshot?.portfolio?.session_id, onPortfolioReady, portfolioId]);
  const [symbols, setSymbols] = useState<SymbolChoice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capital, setCapital] = useState("100000");
  const [loss, setLoss] = useState("");
  const [symbol, setSymbol] = useState("HDFCBANK");
  const [kind, setKind] = useState<"equity" | "options">("equity");
  const [right, setRight] = useState("CE");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [contracts, setContracts] = useState<ListedContract[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [side, setSide] = useState("BUY");
  const [type, setType] = useState("LIMIT");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [acknowledgeUndated, setAcknowledgeUndated] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    positions: Position[];
    cost: number;
    fingerprint: string;
    body: Record<string, unknown>;
  } | null>(null);
  const [correctionAmount, setCorrectionAmount] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState<{
    capital: number;
    remaining_shortfall: number;
    funding_version: number;
    body: Record<string, unknown>;
  } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const requestIdentity = useRef<string | null>(null);
  const mounted = useRef(false);
  const mutation = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const started = revision.current;
    const value = await request<Snapshot>(
      portfolioId ?? `active?mode=${mode}&execution_broker=${broker}`,
      "GET",
    );
    if (mounted.current && !mutation.current && started === revision.current)
      setSnapshot((previous) =>
        !value.portfolio &&
        previous?.portfolio?.state === "ended" &&
        previous.portfolio.mode === mode &&
        (mode !== "real" || previous.portfolio.execution_broker === broker)
          ? previous
          : value,
      );
  }, [request, mode, broker, portfolioId]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      try {
        await refresh();
      } catch (reason) {
        if (mounted.current) {
          if (portfolioId) setSnapshot(null);
          setError(String(reason));
        }
      }
      if (!cancelled && mounted.current) timer = setTimeout(poll, 2000);
    };
    void poll();
    void loadSymbols()
      .then((value) => {
        if (mounted.current) setSymbols(value);
      })
      .catch((reason) => {
        if (mounted.current) setError(String(reason));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh, loadSymbols]);
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    if (mutation.current) return false;
    mutation.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      const value = await request<Snapshot>(path, "POST", body);
      if (mounted.current) setSnapshot(value);
      return true;
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const portfolio = snapshot?.portfolio;
  const prefix = portfolio?.session_id;
  const previewImport = async () => {
    setBusy(true);
    setError("");
    const body = {
      symbol,
      instrument_type: kind,
      ...(kind === "options" ? { right, strike: Number(strike), expiry } : {}),
      request_id: crypto.randomUUID(),
    };
    try {
      const value = await request<{
        positions: Position[];
        cost: number;
        fingerprint: string;
      }>(`${prefix}/import-preview`, "POST", body);
      setImportPreview({ ...value, body });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const previewCorrection = async () => {
    setBusy(true);
    setError("");
    const body = {
      adjustment: -Number(correctionAmount),
      reason: correctionReason,
      request_id: crypto.randomUUID(),
    };
    try {
      const value = await request<{
        capital: number;
        remaining_shortfall: number;
        funding_version: number;
      }>(`${prefix}/funding-correction-preview`, "POST", body);
      setCorrectionPreview({ ...value, body });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setAcknowledgeUndated(false);
    setConfirmClose(false);
  }, [prefix, mode, broker]);
  useEffect(() => {
    setImportPreview(null);
    setCorrectionPreview(null);
  }, [
    prefix,
    mode,
    broker,
    symbol,
    kind,
    strike,
    expiry,
    right,
    correctionAmount,
    correctionReason,
  ]);
  const order = async () => {
    requestIdentity.current ??= crypto.randomUUID();
    const sent = await act(`${prefix}/orders`, {
      symbol,
      instrument_type: kind,
      side,
      order_type: type,
      client: surface,
      quantity: Number(quantity),
      price: Number(price),
      request_id: requestIdentity.current,
      ...(kind === "options" ? { right, strike: Number(strike), expiry } : {}),
    });
    if (sent) requestIdentity.current = null;
  };
  const selectedSymbol = symbols.find((item) => item.symbol === symbol);
  const selectedContract = contracts.find(
    (item) =>
      item.expiry === expiry &&
      item.right === right &&
      item.strike === Number(strike),
  );
  useEffect(() => {
    if (selectedSymbol?.chart_type === "index") setKind("options");
    else if (selectedSymbol?.option_eligible === false) setKind("equity");
  }, [selectedSymbol]);
  useEffect(() => {
    if (kind !== "options") {
      setContracts([]);
      return;
    }
    let active = true;
    setMetadataLoading(true);
    setContracts([]);
    setStrike("");
    void request<{ contracts: ListedContract[] }>(
      `contracts/metadata?symbol=${encodeURIComponent(symbol)}`,
      "GET",
    )
      .then((value) => {
        if (!active) return;
        setContracts(value.contracts);
        const wanted = requestedContract.current;
        const matched =
          wanted?.symbol === symbol
            ? value.contracts.find(
                (c) =>
                  c.strike === wanted.strike &&
                  c.expiry === wanted.expiry &&
                  c.right === wanted.right,
              )
            : undefined;
        if (matched) {
          setExpiry(matched.expiry);
          setStrike(String(matched.strike));
          setRight(matched.right);
        } else setExpiry(value.contracts[0]?.expiry ?? "");
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setMetadataLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind, symbol, request]);
  useEffect(() => {
    if (selectedContract && Number(quantity) % selectedContract.lot_size !== 0)
      setQuantity(String(selectedContract.lot_size));
  }, [selectedContract]);
  // Editing instructions starts a new request; retrying unchanged instructions preserves identity.
  useEffect(() => {
    requestIdentity.current = null;
  }, [symbol, kind, right, strike, expiry, side, type, quantity, price]);
  const chooseChart = (pane: SwingPane) => {
    requestedContract.current = pane;
    setPicking(false);
    setSymbol(pane.symbol);
    setKind(pane.instrument_type);
    setPrice("");
    setRight(pane.right ?? "CE");
    setStrike(pane.strike == null ? "" : String(pane.strike));
    setExpiry(pane.expiry ?? "");
  };
  const tradeTicket = portfolio?.state === "running" && (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void order();
      }}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      {!renderChart && (
        <SymbolSearch value={symbol} options={symbols} onChange={setSymbol} />
      )}
      {!renderChart && (
        <label>
          Instrument{" "}
          <select
            aria-label="Instrument"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as "equity" | "options")
            }
          >
            <option
              value="equity"
              disabled={selectedSymbol?.chart_type === "index"}
            >
              Equity
            </option>
            <option
              value="options"
              disabled={selectedSymbol?.option_eligible === false}
            >
              Options
            </option>
          </select>
        </label>
      )}
      {kind === "options" && !renderChart && (
        <>
          <label>
            Right{" "}
            <select
              aria-label="Right"
              value={right}
              onChange={(event) => {
                setRight(event.target.value);
                setStrike("");
              }}
            >
              <option>CE</option>
              <option>PE</option>
            </select>
          </label>
          <label>
            Expiry{" "}
            <select
              aria-label="Expiry"
              required
              disabled={metadataLoading}
              value={expiry}
              onChange={(event) => {
                setExpiry(event.target.value);
                setStrike("");
              }}
            >
              <option value="">Choose expiry</option>
              {[...new Set(contracts.map((item) => item.expiry))].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Strike{" "}
            <select
              aria-label="Strike"
              required
              disabled={metadataLoading}
              value={strike}
              onChange={(event) => setStrike(event.target.value)}
            >
              <option value="">
                {metadataLoading ? "Loading contracts…" : "Choose strike"}
              </option>
              {contracts
                .filter(
                  (item) => item.expiry === expiry && item.right === right,
                )
                .map((item) => (
                  <option key={item.strike} value={item.strike}>
                    {item.strike}
                  </option>
                ))}
            </select>
          </label>
          <span>
            {selectedContract
              ? `Lot ${selectedContract.lot_size}`
              : "Select a listed contract"}
          </span>
        </>
      )}
      {kind === "options" && renderChart && (
        <span>
          {selectedContract
            ? `Lot ${selectedContract.lot_size}`
            : "Select a listed contract"}
        </span>
      )}
      <label>
        Side{" "}
        <select
          aria-label="Side"
          value={side}
          onChange={(event) => {
            setSide(event.target.value);
            if (event.target.value === "SELL" && type === "TARGET")
              setType("LIMIT");
          }}
        >
          <option>BUY</option>
          <option>SELL</option>
        </select>
      </label>
      <label>
        Order{" "}
        <select
          aria-label="Order"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option>LIMIT</option>
          {side === "BUY" && <option>TARGET</option>}
          {side === "SELL" && <option>STOPLOSS</option>}
        </select>
      </label>
      <label>
        Quantity{" "}
        <input
          type="number"
          min={selectedContract?.lot_size ?? 1}
          step={selectedContract?.lot_size ?? 1}
          required
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </label>
      <label>
        {type === "LIMIT" ? "Limit" : "Trigger"} ₹{" "}
        <input
          type="number"
          min="0.01"
          step="0.01"
          required
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => setPicking((v) => !v)}
      >
        {picking ? "Cancel price pick" : "Pick price on chart"}
      </button>
      <button
        disabled={
          busy ||
          (kind === "options" && !selectedContract) ||
          (side === "BUY" &&
            (portfolio.entries_paused ||
              portfolio.guardrail_ban ||
              Boolean(snapshot?.reconciliation_pending?.length) ||
              (mode === "real" && !snapshot?.funding_status?.entries_allowed)))
        }
      >
        Place intention
      </button>
    </form>
  );
  const statsLoad = useCallback(
    async (filters: Record<string, string>) => {
      const query = new URLSearchParams(
        Object.entries(filters).filter(
          ([key, value]) =>
            ["start_date", "end_date", "history"].includes(key) &&
            Boolean(value),
        ),
      );
      const result = await request<any>(`${prefix}/analytics?${query}`, "GET");
      return {
        portfolios: [
          {
            portfolio_id: prefix,
            mode: portfolio?.mode ?? mode,
            broker: portfolio?.execution_broker,
            state: portfolio?.state,
          },
        ],
        report: result,
      };
    },
    [
      prefix,
      request,
      portfolio?.mode,
      portfolio?.execution_broker,
      portfolio?.state,
      mode,
    ],
  );
  const chartWorkspace =
    portfolio && renderChart ? (
      <SwingWorkspace
        key={`${prefix}:${mode}:${broker}`}
        request={request}
        snapshot={snapshot}
        symbols={symbols}
        Renderer={renderChart}
        surface={surface}
        workspaceId={workspaceId}
        companion={companion}
        onSaveReady={onSaveReady}
        onCreateLinked={onCreateLinked}
        onSelect={chooseChart}
        onPick={(value) => {
          if (Number.isFinite(value) && value > 0) setPrice(value.toFixed(2));
          setPicking(false);
        }}
        picking={picking}
        ticket={tradeTicket}
        onHistory={() => {if(mayNavigate())setAnalyticsOpen("history");}}
        onStats={() => {if(mayNavigate())setAnalyticsOpen("stats");}}
        onManage={() => setManagementOpen((v) => !v)}
        onDetach={() => {if(companion || mayNavigate())onDetach();}}
        error={error}
        busy={busy}
        onPause={() =>
          void act(`${prefix}/pause`, { paused: !portfolio.entries_paused })
        }
      />
    ) : null;
  return (
    <section
      aria-label="Swing portfolio"
      style={{
        position: "relative",
        padding: chartWorkspace ? 0 : 20,
        color: "#e5e7eb",
        background: "#0d1117",
        minHeight: 360,
        height: surface === "website" ? "100vh" : "calc(100vh - 48px)",
        overflowY: chartWorkspace ? "hidden" : "auto",
        boxSizing: "border-box",
      }}
    >
      {chartWorkspace}
      {analyticsOpen && portfolio && (
        <div className="swing-analytics-drawer">
          {analyticsOpen === "stats" ? (
            <SwingStats
              onDraftStateChange={reportDraft}
              load={statsLoad}
              portfolioId={prefix}
              onClose={() => setAnalyticsOpen(null)}
              onCycle={(cycle) => {
                setSelectedCycle(cycle.cycle_id);
                setAnalyticsOpen("history");
              }}
            />
          ) : (
            renderChart && (
              <SwingHistory
                onDraftStateChange={reportDraft}
                request={request}
                portfolioId={portfolio.session_id}
                Renderer={renderChart}
                initialCycleId={selectedCycle}
                onAnalyse={onAnalyse}
                onReconcile={
                  !companion && mode === "real"
                    ? async () => {
                        const value = await request<Snapshot>(
                          `${prefix}/reconcile`,
                          "POST",
                        );
                        setSnapshot(value);
                      }
                    : undefined
                }
                onClose={() => setAnalyticsOpen(null)}
              />
            )
          )}
        </div>
      )}
      <div
        className={chartWorkspace ? "swing-management" : undefined}
        style={{
          display: chartWorkspace && !managementOpen ? "none" : undefined,
        }}
      >
        {chartWorkspace && (
          <button onClick={() => setManagementOpen(false)}>
            Close management
          </button>
        )}
        <header style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <h2>{mode === "real" ? "Real" : "Paper"} Swing</h2>
          <button
            title="Detach screen; keep portfolio running"
            onClick={onDetach}
          >
            Detach screen
          </button>
        </header>
        {!portfolioId && (
          <label>
            Mode{" "}
            <select
              aria-label="Swing mode"
              disabled={busy}
              value={mode}
              onChange={(event) => {
                if(!mayNavigate())return;
                setAnalyticsOpen(null);
                revision.current++;
                setSnapshot(null);
                setMode(event.target.value as "paper" | "real");
              }}
            >
              <option value="paper">Paper</option>
              {realEnabled && <option value="real">Real</option>}
            </select>
          </label>
        )}{" "}
        {!portfolioId && mode === "real" && (
          <label>
            Broker{" "}
            <select
              aria-label="Swing broker"
              disabled={busy}
              value={broker}
              onChange={(event) => {
                if(!mayNavigate())return;
                setAnalyticsOpen(null);
                revision.current++;
                setSnapshot(null);
                setBroker(event.target.value);
              }}
            >
              <option value="kite">Kite</option>
              <option value="kotak">Kotak</option>
            </select>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        {!snapshot ? (
          <p role="status">Loading portfolio…</p>
        ) : !portfolio ? (
          portfolioId ? (
            <p>Linked portfolio is unavailable. Return to the main window.</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act("", {
                  mode,
                  execution_broker: broker,
                  allocation_pct: Number(allocation) / 100,
                  capital: Number(capital),
                  ...(loss ? { loss_limit_pct: Number(loss) / 100 } : {}),
                });
              }}
            >
              <p>Hold shares and long options across days in one portfolio.</p>
              {mode === "real" && (
                <label>
                  Shared account allocation %{" "}
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    required
                    value={allocation}
                    onChange={(event) => setAllocation(event.target.value)}
                  />
                </label>
              )}
              {mode === "paper" && (
                <label>
                  Starting capital ₹{" "}
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    value={capital}
                    onChange={(event) => setCapital(event.target.value)}
                  />
                </label>
              )}{" "}
              <label>
                Portfolio loss limit %{" "}
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={loss}
                  onChange={(event) => setLoss(event.target.value)}
                  placeholder="Optional"
                />
              </label>{" "}
              <button disabled={busy}>Start portfolio</button>
            </form>
          )
        ) : (
          <>
            {!portfolioId && portfolio.state === "ended" && (
              <button onClick={() => setSnapshot({ portfolio: null })}>
                Start another portfolio
              </button>
            )}
            <p>
              Funds ₹{money(snapshot.wallet_balance)} · Capital ₹
              {money(portfolio.session_capital)} · P&amp;L ₹
              {money(snapshot.pnl)} · {portfolio.state}
            </p>
            {portfolio.history_warning && (
              <p role="status">{portfolio.history_warning}</p>
            )}
            {!companion && mode === "real" && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void act(`${prefix}/reconcile`)}
                >
                  Reconcile with broker
                </button>
                {snapshot.funding_status &&
                  !snapshot.funding_status.entries_allowed && (
                    <p role="status">
                      Shared account funding: {snapshot.funding_status.state}.
                      Entries wait; exits remain available.
                    </p>
                  )}
              </>
            )}
            {Boolean(snapshot.reconciliation_pending?.length) && (
              <p role="status">
                Execution recovery is pending. Entries wait for valid history;
                no old fill or replacement order has been assumed.
              </p>
            )}
            {portfolio.guardrail_ban && (
              <p role="status">
                Portfolio loss limit reached. Exits remain available.
              </p>
            )}
            {!companion && portfolio.state === "running" && (
              <div style={{ display: "flex", gap: 12 }}>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`${prefix}/pause`, {
                      paused: !portfolio.entries_paused,
                    })
                  }
                >
                  {portfolio.entries_paused
                    ? "Resume entries"
                    : "Pause entries"}
                </button>
                <button
                  onClick={() => {
                    setCapital(String(portfolio.session_capital));
                    setResetOpen(true);
                  }}
                >
                  Reset capital
                </button>
                <button onClick={() => setConfirmClose(true)}>
                  Close portfolio…
                </button>
              </div>
            )}
            {confirmClose && (
              <div role="alertdialog" aria-label="Confirm portfolio closure">
                <p>
                  Close all managed positions at available market quotes and
                  cancel entries? Closure waits for executable prices.
                </p>
                {Boolean(snapshot.current_submission_ids?.length) && (
                  <p>
                    Current-day broker submissions are unconfirmed. Closure
                    stays blocked until they reconcile.
                  </p>
                )}
                {Boolean(snapshot.undated_submission_ids?.length) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledgeUndated}
                      onChange={(event) =>
                        setAcknowledgeUndated(event.target.checked)
                      }
                    />{" "}
                    I acknowledge {snapshot.undated_submission_ids?.length}{" "}
                    undated broker attempt(s). Close only after the broker
                    verifies no current positions or pending orders; retain the
                    history warning.
                  </label>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`${prefix}/close`, {
                      acknowledge_undated_submission_ids: acknowledgeUndated
                        ? (snapshot.undated_submission_ids ?? [])
                        : [],
                    }).then((ok) => {
                      if (ok) setConfirmClose(false);
                    })
                  }
                >
                  Confirm close portfolio
                </button>
                <button onClick={() => setConfirmClose(false)}>
                  Keep portfolio
                </button>
              </div>
            )}
            {resetOpen && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(`${prefix}/capital`, {
                    capital: Number(capital),
                    request_id: crypto.randomUUID(),
                  }).then((ok) => {
                    if (ok) setResetOpen(false);
                  });
                }}
              >
                <p>
                  Reset the sizing reference and loss-limit period. Cash,
                  positions and history stay intact.
                </p>
                {mode === "real" && (
                  <p>Use account allocation percentages for Real funding.</p>
                )}
                <label>
                  Capital ₹{" "}
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    value={capital}
                    onChange={(event) => setCapital(event.target.value)}
                  />
                </label>
                <button disabled={busy}>Confirm reset</button>
                <button type="button" onClick={() => setResetOpen(false)}>
                  Cancel
                </button>
              </form>
            )}
            {!companion && mode === "real" && portfolio.state === "running" && (
              <div>
                <label>
                  Account allocation %{" "}
                  <input
                    aria-label="Swing allocation percent"
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={allocation}
                    onChange={(event) => setAllocation(event.target.value)}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`${prefix}/allocation`, {
                      fraction: Number(allocation) / 100,
                      request_id: crypto.randomUUID(),
                    })
                  }
                >
                  Apply allocation
                </button>
                {snapshot.allocation_pct != null && (
                  <small>
                    {" "}
                    Current {Math.round(snapshot.allocation_pct * 10000) / 100}%
                    of acknowledged account funding.
                  </small>
                )}
                {Boolean(snapshot.funding_status?.shortfall) && (
                  <div>
                    <p>
                      A cash correction acknowledges a confirmed withdrawal or
                      outside cash change against your Swing funding. It keeps
                      the other owner's allocation and all trades intact.
                    </p>
                    <label>
                      Amount ₹{" "}
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={correctionAmount}
                        onChange={(event) =>
                          setCorrectionAmount(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Reason{" "}
                      <input
                        value={correctionReason}
                        onChange={(event) =>
                          setCorrectionReason(event.target.value)
                        }
                      />
                    </label>
                    <button
                      disabled={
                        busy || !correctionAmount || !correctionReason.trim()
                      }
                      onClick={() => void previewCorrection()}
                    >
                      Preview correction
                    </button>
                  </div>
                )}
                {correctionPreview && (
                  <div role="alertdialog" aria-label="Confirm cash correction">
                    <p>
                      New capital ₹{money(correctionPreview.capital)} ·
                      remaining account gap ₹
                      {money(correctionPreview.remaining_shortfall)}. This
                      resets the portfolio loss-limit reference and records your
                      reason.
                    </p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(`${prefix}/funding-correction`, {
                          ...correctionPreview.body,
                          funding_version: correctionPreview.funding_version,
                        }).then((ok) => {
                          if (ok) setCorrectionPreview(null);
                        })
                      }
                    >
                      Confirm correction
                    </button>
                    <button onClick={() => setCorrectionPreview(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            {snapshot.recovery_issues?.map((issue) => (
              <p role="status" key={issue.session_id}>
                {issue.message}{" "}
                {issue.verified_flat
                  ? "Broker currently verifies flat; closing can preserve the history warning."
                  : "Manage current exposure at the broker, then reconcile again."}
              </p>
            ))}
            {mode === "real" && portfolio.state === "closing" && (
              <button disabled={busy} onClick={() => setConfirmClose(true)}>
                Review and verify closure again
              </button>
            )}
            <h3>Positions</h3>
            {snapshot.positions?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Quantity</th>
                    <th>Average</th>
                    <th>Current</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.positions.map((position) => (
                    <tr
                      key={`${position.symbol}:${position.right}:${position.strike}:${position.expiry}`}
                    >
                      <td>
                        {position.symbol} {position.right} {position.strike}{" "}
                        {position.expiry}
                      </td>
                      <td>{position.quantity}</td>
                      <td>{money(position.avg_entry_price)}</td>
                      <td>{money(position.mark_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No open positions.</p>
            )}
            <h3>Pending intentions</h3>
            {snapshot.open_orders?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th>Quantity</th>
                    <th>Limit</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.open_orders.map((order) => (
                    <tr key={order.order_id}>
                      <td>
                        {order.symbol} {order.right} {order.strike}{" "}
                        {order.expiry}
                      </td>
                      <td>{order.side}</td>
                      <td>{order.order_type}</td>
                      <td>{order.quantity}</td>
                      <td>{money(order.limit_price)}</td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `${prefix}/orders/${order.order_id}/cancel`,
                            )
                          }
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No pending orders.</p>
            )}
            {!renderChart && tradeTicket}
            {!companion && mode === "real" && portfolio.state === "running" && (
              <div>
                <button
                  disabled={busy || (kind === "options" && !selectedContract)}
                  onClick={() => void previewImport()}
                >
                  Preview import for {symbol} {kind}
                </button>
                {importPreview && (
                  <div
                    role="alertdialog"
                    aria-label="Confirm opening inventory import"
                  >
                    <p>
                      Import all {symbol} {kind} inventory in this broker book
                      at a total basis of ₹{money(importPreview.cost)}. No
                      historical trades or broker cash debit will be created.
                      The other session's allocation stays intact.
                    </p>
                    {importPreview.positions.map((position) => (
                      <p
                        key={`${position.right}:${position.strike}:${position.expiry}`}
                      >
                        {position.symbol} {position.right} {position.strike}{" "}
                        {position.expiry} · {position.quantity} at ₹
                        {money(position.avg_entry_price)}
                      </p>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(`${prefix}/import`, {
                          ...importPreview.body,
                          fingerprint: importPreview.fingerprint,
                        }).then((ok) => {
                          if (ok) setImportPreview(null);
                        })
                      }
                    >
                      Confirm import
                    </button>
                    <button onClick={() => setImportPreview(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            <p>
              Equity uses full purchase value.{" "}
              {mode === "paper"
                ? "Paper option exits start 15 minutes before expiry-day market close."
                : "Real options require broker-confirmed executions; settlement or authorization issues require broker reconciliation."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
