import type { SwingSubscribe } from "./swingStream";
import { flashError } from "./notifications";
import SwingStats from "./SwingStats";
import SwingHistory from "./SwingHistory";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
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
  paper_broker?: "kite" | "kotak";
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
  side?: "LONG" | "SHORT" | "FLAT";
  instrument_type?: string;
  symbol: string;
  right?: string;
  strike?: number;
  expiry?: string;
  quantity: number;
  avg_entry_price: number;
  mark_price?: number;
}
interface ListedContract {
  strike?: number;
  expiry: string;
  right?: string;
  lot_size: number;
  tick_size?: number;
  entry_eligible?: boolean;
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
  delivery_review_context_ids?: string[];
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
  subscribe,
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
  onPopOut,
  navigationControls,
  onAnalyse,
  onDraftStateChange,
  onConnectBroker,
  brokerRevision = 0,
}: {
  request: SwingRequest;
  subscribe: SwingSubscribe;
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
  onPopOut?: (portfolioId: string) => void;
  navigationControls?: ReactNode;
  onAnalyse?: (portfolioId: string, sessionId?: string) => void;
  onDraftStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
  onConnectBroker?: (broker: "kotak" | "kite") => void;
  brokerRevision?: number;
}) {
  const [analyticsOpen, setAnalyticsOpen] = useState<
      "stats" | "history" | null
    >(null),
    [selectedCycle, setSelectedCycle] = useState<string | undefined>();
  const labelState = useRef({ dirty: false, saving: false });
  const reportDraft = (state: { dirty: boolean; saving: boolean }) => {
    labelState.current = state;
    onDraftStateChange?.(state);
  };
  const mayNavigate = () =>
    !labelState.current.saving &&
    (!labelState.current.dirty ||
      window.confirm("Discard unsaved trade labels?"));
  const [managementOpen, setManagementOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const requestedContract = useRef<SwingPane | null>(null);
  const [mode, setMode] = useState<"paper" | "real">("paper");
  const [broker, setBroker] = useState("kite");
  const [paperBroker, setPaperBroker] = useState("kite");
  const [allocation, setAllocation] = useState("100");
  const [connectionRetry, setConnectionRetry] = useState(0);
  const [brokerConnection, setBrokerConnection] = useState<{
    broker: string;
    authenticated: boolean;
  } | null>(null);
  const [connectionError, setConnectionError] = useState("");
  useEffect(() => {
    let active = true;
    setBrokerConnection(null);
    setConnectionError("");
    if (mode !== "real" || portfolioId) return;
    void request<{ broker: string; authenticated: boolean }>(
      `broker-status?execution_broker=${broker}`,
      "GET",
    )
      .then((value) => {
        if (active) setBrokerConnection(value);
      })
      .catch((cause) => {
        if (active) setConnectionError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [request, mode, broker, portfolioId, brokerRevision, connectionRetry]);
  const workspaceSave = useRef<(() => Promise<unknown>) | null>(null);
  const registerWorkspaceSave = useCallback(
    (save: (() => Promise<unknown>) | null) => {
      workspaceSave.current = save;
      onSaveReady?.(save);
    },
    [onSaveReady],
  );
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
  const portfolio = snapshot?.portfolio;
  const prefix = portfolio?.session_id;

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
  useEffect(() => {
    if (surface === "desktop" && error)
      flashError(error, "Desktop Swing", {
        sessionId: snapshot?.portfolio?.session_id,
        symbol,
        mode,
      });
  }, [error, surface]);
  const [busy, setBusy] = useState(false);
  const [capital, setCapital] = useState("100000");
  const [loss, setLoss] = useState("");
  const [symbol, setSymbol] = useState("HDFCBANK");
  const [kind, setKind] = useState<SwingPane["instrument_type"]>("equity");
  const [right, setRight] = useState("CE");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [contracts, setContracts] = useState<ListedContract[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [side, setSide] = useState("BUY");
  const [type, setType] = useState("LIMIT");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [sizingMode, setSizingMode] = useState<"quantity" | "capital_pct">(
    "quantity",
  );
  const [capitalPct, setCapitalPct] = useState("10");
  const [sizingPreview, setSizingPreview] = useState<{
    quantity: number;
    lot_size: number;
    budget: number;
    fees: number;
    required_funds: number;
    unused_budget: number;
    minimum_funds: number;
    capital_revision: number;
    execution_enabled?: boolean;
    fee_hash?: string;
    evidence?: { live: boolean; source: string; as_of?: string };
    margin?: number;
  } | null>(null);
  const [sizingError, setSizingError] = useState("");
  const [sizingLoading, setSizingLoading] = useState(false);
  useEffect(() => {
    if (surface === "desktop" && sizingError)
      flashError(sizingError, "Desktop Swing sizing", {
        sessionId: prefix,
        symbol,
        mode,
      });
  }, [sizingError, surface]);
  const futureExit =
    kind === "futures" &&
    Boolean(
      snapshot?.positions?.some(
        (p) =>
          p.instrument_type === "futures" &&
          p.symbol === symbol &&
          p.expiry === expiry &&
          ((p.side === "LONG" && side === "SELL") ||
            (p.side === "SHORT" && side === "BUY")),
      ),
    );
  const entryIntent = kind === "futures" ? !futureExit : side === "BUY";
  const percentageSizing = sizingMode === "capital_pct" && entryIntent;
  const previewSizing = percentageSizing || kind === "futures";
  useEffect(() => {
    if (
      (!entryIntent && type === "TARGET") ||
      (entryIntent && type === "STOPLOSS")
    )
      setType("LIMIT");
  }, [entryIntent, type]);
  const sizingKey = JSON.stringify([
    prefix,
    symbol,
    kind,
    right,
    strike,
    expiry,
    type,
    price,
    capitalPct,
    snapshot?.portfolio?.guardrail_epoch,
    percentageSizing,
    quantity,
    side,
  ]);
  const [previewKey, setPreviewKey] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSizingPreview(null);
    setSizingError("");
    setPreviewKey("");
    setSizingLoading(false);
    if (!previewSizing || !snapshot?.portfolio) return;
    if (
      !(Number(price) > 0) ||
      (percentageSizing &&
        !(Number(capitalPct) > 0 && Number(capitalPct) <= 100)) ||
      (kind === "options" && !(right && strike && expiry)) ||
      (kind === "futures" && !expiry)
    )
      return;
    setSizingLoading(true);
    const timer = window.setTimeout(
      () =>
        void request<typeof sizingPreview & {}>(
          `${prefix}/order-preview`,
          "POST",
          {
            symbol,
            instrument_type: kind,
            side: kind === "futures" ? side : "BUY",
            order_type: type,
            price: Number(price),
            quantity: percentageSizing ? 1 : Number(quantity),
            ...(percentageSizing
              ? { capital_pct: Number(capitalPct) / 100 }
              : {}),
            capital_revision: snapshot.portfolio!.guardrail_epoch,
            request_id: "preview",
            client: surface,
            ...(kind === "options"
              ? { right, strike: Number(strike), expiry }
              : kind === "futures"
                ? { expiry }
                : {}),
          },
        )
          .then((value) => {
            if (!cancelled) {
              setSizingPreview(value);
              setPreviewKey(sizingKey);
            }
          })
          .catch((reason) => {
            if (!cancelled) setSizingError(String(reason));
          })
          .finally(() => {
            if (!cancelled) setSizingLoading(false);
          }),
      300,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sizingKey, request, surface]);
  const [confirmClose, setConfirmClose] = useState(false);
  const [acknowledgeUndated, setAcknowledgeUndated] = useState(false);
  const [acknowledgeDelivery, setAcknowledgeDelivery] = useState(false);
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
  const streamRevision = useRef(0);
  const priorBrokerRevision = useRef(brokerRevision);
  useEffect(() => {
    if (priorBrokerRevision.current !== brokerRevision) {
      priorBrokerRevision.current = brokerRevision;
      revision.current++;
      setError("");
    }
  }, [brokerRevision]);
  const refresh = useCallback(async () => {
    const started = revision.current;
    const streamed = streamRevision.current;
    const value = await request<Snapshot>(
      portfolioId ?? `active?mode=${mode}&execution_broker=${broker}`,
      "GET",
    );
    if (mounted.current && !mutation.current && started === revision.current && streamed === streamRevision.current)
      setSnapshot((previous) =>
        !value.portfolio &&
        previous?.portfolio?.state === "ended" &&
        previous.portfolio.mode === mode &&
        (mode !== "real" || previous.portfolio.execution_broker === broker)
          ? previous
          : value,
      );
  }, [request, mode, broker, portfolioId, brokerRevision]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (cancelled) return;
      try { await refresh(); }
      catch (reason) {
        if (!cancelled && mounted.current) {
          setError(String(reason));
          timer = setTimeout(load, 5000);
        }
      }
    };
    void load();
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
  const streamedPortfolio = snapshot?.portfolio?.session_id;
  useEffect(() => {
    if (!streamedPortfolio) return;
    return subscribe(`${streamedPortfolio}/events`, event => {
      if (event.type === "portfolio_snapshot" && event.portfolio?.session_id === streamedPortfolio) {
        streamRevision.current++;
        setSnapshot(event as Snapshot);
      } else if (event.type === "portfolio_refresh_required") {
        void refresh().catch(reason => setError(String(reason)));
      } else if (event.type === "portfolio_error") setError(String(event.message));
    }, reason => setError(String(reason)));
  }, [streamedPortfolio, subscribe, refresh]);
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    if (mutation.current) return false;
    mutation.current = true;
    const actionRevision = ++revision.current;
    const streamed = streamRevision.current;
    setBusy(true);
    setError("");
    try {
      const value = await request<Snapshot>(path, "POST", body);
      if (mounted.current && revision.current === actionRevision && (streamed === streamRevision.current || value.portfolio?.session_id !== streamedPortfolio)) setSnapshot(value);
      return true;
    } catch (reason) {
      if (mounted.current) setError(String(reason));
      return false;
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
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
    setAcknowledgeDelivery(false);
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
    if (
      previewSizing &&
      (!sizingPreview?.quantity || previewKey !== sizingKey || sizingLoading)
    ) {
      setError("Review a valid capital sizing estimate before placing");
      return;
    }
    requestIdentity.current ??= crypto.randomUUID();
    const sent = await act(`${prefix}/orders`, {
      symbol,
      instrument_type: kind,
      side,
      order_type: type,
      client: surface,
      quantity: previewSizing ? sizingPreview?.quantity : Number(quantity),
      ...(percentageSizing
        ? {
            capital_pct: Number(capitalPct) / 100,
            capital_revision: sizingPreview?.capital_revision,
          }
        : {}),
      ...(kind === "futures"
        ? {
            expiry,
            approved_budget: sizingPreview?.budget,
            fee_hash: sizingPreview?.fee_hash,
            capital_revision: sizingPreview?.capital_revision,
          }
        : {}),
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
      (kind === "futures" ||
        (item.right === right && item.strike === Number(strike))),
  );
  useEffect(() => {
    if (selectedSymbol?.chart_type === "index" && kind === "equity")
      setKind("options");
    else if (selectedSymbol?.option_eligible === false) setKind("equity");
  }, [selectedSymbol]);
  useEffect(() => {
    if (kind === "equity") {
      setContracts([]);
      return;
    }
    let active = true;
    setMetadataLoading(true);
    setContracts([]);
    setStrike("");
    void request<{ contracts: ListedContract[] }>(
      kind === "futures"
        ? `contracts/futures?symbol=${encodeURIComponent(symbol)}&provider=${portfolio?.execution_broker ?? portfolio?.paper_broker ?? "kite"}`
        : `contracts/metadata?symbol=${encodeURIComponent(symbol)}`,
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
          setStrike(matched.strike == null ? "" : String(matched.strike));
          setRight(matched.right ?? "CE");
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
  }, [
    kind,
    symbol,
    portfolio?.execution_broker,
    portfolio?.paper_broker,
    request,
  ]);
  useEffect(() => {
    if (selectedContract && Number(quantity) % selectedContract.lot_size !== 0)
      setQuantity(String(selectedContract.lot_size));
  }, [selectedContract]);
  // Editing instructions starts a new request; retrying unchanged instructions preserves identity.
  useEffect(() => {
    requestIdentity.current = null;
  }, [
    symbol,
    kind,
    right,
    strike,
    expiry,
    side,
    type,
    quantity,
    price,
    sizingMode,
    capitalPct,
    snapshot?.portfolio?.guardrail_epoch,
  ]);
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
              setKind(event.target.value as SwingPane["instrument_type"])
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
            <option value="futures">Futures</option>
          </select>
        </label>
      )}
      {kind === "futures" && !renderChart && (
        <label>
          Futures expiry{" "}
          <select
            aria-label="Futures expiry"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          >
            <option value="">Choose contract</option>
            {contracts.map((c) => (
              <option
                key={c.expiry}
                disabled={c.entry_eligible === false}
                value={c.expiry}
              >
                {c.expiry} · lot {c.lot_size}
              </option>
            ))}
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
      {kind === "futures" && (
        <p className="swing-hint">
          Futures use overnight margin.{" "}
          {sizingPreview?.evidence?.live
            ? "Broker margin quoted"
            : "Offline intentions wait for a live quote and margin"}
          .{" "}
          {sizingPreview?.execution_enabled === false &&
            "Entries are disabled in Admin Futures settings."}
        </p>
      )}
      <label>
        Side{" "}
        <select
          aria-label="Side"
          value={side}
          onChange={(event) => {
            setSide(event.target.value);
            if (
              kind !== "futures" &&
              event.target.value === "SELL" &&
              type === "TARGET"
            )
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
          {entryIntent && <option>TARGET</option>}
          {!entryIntent && <option>STOPLOSS</option>}
        </select>
      </label>
      {entryIntent && (
        <label>
          Size by{" "}
          <select
            aria-label="Swing sizing mode"
            value={sizingMode}
            onChange={(e) =>
              setSizingMode(e.target.value as "quantity" | "capital_pct")
            }
          >
            <option value="quantity">Quantity</option>
            <option value="capital_pct">Capital %</option>
          </select>
        </label>
      )}
      {percentageSizing && (
        <label>
          Portfolio capital %{" "}
          <input
            aria-label="Portfolio capital percentage"
            type="number"
            required
            min="0.01"
            max="100"
            step="0.01"
            value={capitalPct}
            onChange={(e) => setCapitalPct(e.target.value)}
          />
        </label>
      )}
      {!percentageSizing && (
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
      )}
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
      {previewSizing && (
        <div aria-live="polite" className="swing-muted">
          {sizingLoading
            ? "Calculating size…"
            : sizingError ||
              (sizingPreview && previewKey === sizingKey
                ? `${sizingPreview.quantity} units · budget ₹${money(sizingPreview.budget)} · estimated cost ₹${money(sizingPreview.required_funds)} (fees ₹${money(sizingPreview.fees)}) · unused ₹${money(sizingPreview.unused_budget)}${sizingPreview.quantity === 0 ? ` · Minimum ₹${money(sizingPreview.minimum_funds)} for one lot` : ""}`
                : "Enter a valid percentage and price to calculate size")}
        </div>
      )}
      <button
        type="button"
        title={picking ? "Cancel price pick" : "Pick price on chart"}
        aria-label={picking ? "Cancel price pick" : "Pick price on chart"}
        aria-pressed={picking}
        disabled={busy}
        onClick={() => setPicking((v) => !v)}
      >
        {surface === "desktop" ? (
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M12 3v18M3 12h18" />
            <circle cx="12" cy="12" r="6" />
          </svg>
        ) : picking ? (
          "Cancel price pick"
        ) : (
          "Pick price on chart"
        )}
      </button>
      <button
        disabled={
          busy ||
          (kind === "futures" && !sizingPreview?.execution_enabled) ||
          (previewSizing &&
            (sizingLoading ||
              previewKey !== sizingKey ||
              !sizingPreview?.quantity)) ||
          (kind === "options" && !selectedContract) ||
          (entryIntent &&
            (portfolio.entries_paused ||
              portfolio.guardrail_ban ||
              Boolean(snapshot?.reconciliation_pending?.length) ||
              (mode === "real" && !snapshot?.funding_status?.entries_allowed)))
        }
        title="Place intention"
        aria-label="Place intention"
      >
        {surface === "desktop" ? (
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M4 12l5 5L20 6" />
          </svg>
        ) : (
          "Place intention"
        )}
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
  const switchBook = async (nextMode: "paper" | "real", nextBroker: string) => {
    if (mutation.current || !mayNavigate()) return;
    mutation.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      await workspaceSave.current?.();
      if (!mounted.current) return;
      setAnalyticsOpen(null);
      setManagementOpen(false);
      setSnapshot(null);
      setMode(nextMode);
      setBroker(nextBroker);
    } catch (cause) {
      if (mounted.current)
        setError(`Workspace could not be saved: ${String(cause)}`);
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const startPortfolio = async () => {
    if (mutation.current) return;
    const version = revision.current;
    if (mode === "real") {
      try {
        const status = await request<{
          broker: string;
          authenticated: boolean;
        }>(`broker-status?execution_broker=${broker}`, "GET");
        if (!mounted.current || version !== revision.current) return;
        setBrokerConnection(status);
        if (!status.authenticated) {
          onConnectBroker?.(broker as "kotak" | "kite");
          return;
        }
      } catch (cause) {
        setConnectionError(String(cause));
        return;
      }
    }
    if (!mounted.current || version !== revision.current) return;
    await act("", {
      mode,
      execution_broker: broker,
      paper_broker: paperBroker,
      allocation_pct: Number(allocation) / 100,
      capital: Number(capital),
      ...(loss ? { loss_limit_pct: Number(loss) / 100 } : {}),
    });
  };
  const portfolioControls = (
    <>
      {!portfolioId && (
        <label>
          Mode{" "}
          <select
            aria-label="Swing mode"
            title="Switch portfolio views without closing the other portfolio"
            disabled={busy}
            value={mode}
            onChange={(event) => {
              void switchBook(event.target.value as "paper" | "real", broker);
            }}
          >
            <option value="paper">Paper</option>
            {realEnabled && <option value="real">Real</option>}
          </select>
        </label>
      )}{" "}
      {!portfolioId && mode === "paper" && (
        <label>
          Futures model{" "}
          <select
            aria-label="Paper Futures broker"
            disabled={busy || Boolean(portfolio && portfolio.state !== "ended")}
            value={portfolio?.paper_broker ?? paperBroker}
            onChange={(e) => setPaperBroker(e.target.value)}
          >
            <option value="kite">Kite</option>
            <option value="kotak">Kotak Neo</option>
          </select>
        </label>
      )}
      {!portfolioId && mode === "real" && (
        <label>
          Broker{" "}
          <select
            aria-label="Swing broker"
            disabled={busy}
            value={broker}
            onChange={(event) => {
              void switchBook(mode, event.target.value);
            }}
          >
            <option value="kite">Kite</option>
            <option value="kotak">Kotak</option>
          </select>
        </label>
      )}
      {!portfolioId && mode === "real" && (
        <span className="swing-broker-connection">
          <span role="status">
            {brokerConnection?.broker === broker
              ? `${broker === "kotak" ? "Kotak Neo" : "Kite"} · ${brokerConnection.authenticated ? "Connected" : "Authentication required"}`
              : connectionError || "Checking broker connection…"}
          </span>
          {broker === "kotak" &&
            !brokerConnection?.authenticated &&
            onConnectBroker && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onConnectBroker("kotak")}
              >
                Connect Kotak Neo
              </button>
            )}
          {broker === "kite" && brokerConnection?.authenticated === false && (
            <small>Ask Admin to update the Kite token, then refresh.</small>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setConnectionRetry((n) => n + 1)}
          >
            Refresh broker connection
          </button>
        </span>
      )}
    </>
  );
  const chartWorkspace =
    portfolio && renderChart ? (
      <SwingWorkspace
        key={`${prefix}:${mode}:${broker}`}
        request={request}
        subscribe={subscribe}
        snapshot={snapshot}
        symbols={symbols}
        Renderer={renderChart}
        surface={surface}
        workspaceId={workspaceId}
        companion={companion}
        onSaveReady={registerWorkspaceSave}
        onCreateLinked={onCreateLinked}
        onPopOut={onPopOut}
        navigationControls={navigationControls}
        portfolioControls={portfolioControls}
        onSelect={chooseChart}
        onPick={(value) => {
          if (Number.isFinite(value) && value > 0) setPrice(value.toFixed(2));
          setPicking(false);
        }}
        picking={picking}
        ticket={tradeTicket}
        onHistory={() => {
          if (mayNavigate()) setAnalyticsOpen("history");
        }}
        onStats={() => {
          if (mayNavigate()) setAnalyticsOpen("stats");
        }}
        onManage={() => setManagementOpen((v) => !v)}
        onDetach={() => {
          if (companion || mayNavigate()) onDetach();
        }}
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
        height: surface === "website" || navigationControls ? "100vh" : "calc(100vh - 48px)",
        overflowY: chartWorkspace ? "hidden" : "auto",
        boxSizing: "border-box",
      }}
    >
      {!chartWorkspace && navigationControls && <div className="swing-workspace-bar">{navigationControls}</div>}
      {chartWorkspace}
      {!chartWorkspace && portfolioControls}
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
                void startPortfolio();
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
              <button
                disabled={
                  busy ||
                  (mode === "real" &&
                    (!brokerConnection?.authenticated ||
                      brokerConnection.broker !== broker))
                }
              >
                Start portfolio
              </button>
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
                {Boolean(snapshot.delivery_review_context_ids?.length) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledgeDelivery}
                      onChange={(e) => setAcknowledgeDelivery(e.target.checked)}
                    />
                    I reviewed stock Futures delivery and settlement obligations
                    at the broker. Close only after derivative exposure is
                    verified flat, and retain the history warning.
                  </label>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(`${prefix}/close`, {
                      acknowledge_delivery_context_ids: acknowledgeDelivery
                        ? (snapshot.delivery_review_context_ids ?? [])
                        : [],
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
