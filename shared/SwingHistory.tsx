import { swingToday } from "./SwingWorkspace";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { SwingRequest } from "./SwingPortfolioPanel";
import type { SwingChartProps, SwingPane, SwingCandle } from "./SwingWorkspace";
import { swingMoney } from "./SwingStats";
import "./swingAnalytics.css";
const fields = [
  "expected_category",
  "expected_strategy",
  "actual_category",
  "actual_strategy",
  "entry_tag",
  "exit_tag",
];
export default function SwingHistory({
  request,
  portfolioId,
  Renderer,
  initialCycleId,
  sessionId,
  onClose,
  onAnalyse,
  onReconcile,
  onDraftStateChange,
}: {
  request: SwingRequest;
  portfolioId: string;
  Renderer: ComponentType<SwingChartProps>;
  initialCycleId?: string;
  sessionId?: string;
  onClose: () => void;
  onAnalyse?: (pid: string, sid?: string) => void;
  onReconcile?: () => Promise<unknown>;
  onDraftStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const [data, setData] = useState<any>(null),
    [selected, setSelected] = useState(initialCycleId ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [date, setDate] = useState(""),
    [interval, setInterval] = useState<SwingPane["interval"]>("1D"),
    [candles, setCandles] = useState<SwingCandle[]>([]),
    [chartError, setChartError] = useState(""),
    [loading, setLoading] = useState(false),
    [metadata, setMetadata] = useState<any>({});
  const owner = useRef(0);
  const savedDraft = useRef("{}");
  const initialized = useRef("");
  const [baseline, setBaseline] = useState("{}");
  const dirty = JSON.stringify(draft) !== baseline;
  const notify = useRef(onDraftStateChange);
  notify.current = onDraftStateChange;
  useEffect(() => {
    notify.current?.({ dirty, saving: busy });
  }, [dirty, busy]);
  useEffect(() => () => notify.current?.({ dirty: false, saving: false }), []);
  const identity = `${portfolioId}:${selected}`;
  const liveIdentity = useRef(identity);
  liveIdentity.current = identity;
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const discard = () =>
    !busy &&
    (JSON.stringify(draft) === savedDraft.current ||
      window.confirm("Discard unsaved trade labels?"));
  useEffect(() => {
    let cancelled = false;
    void request<any>(`${portfolioId}/execution-history`, "GET")
      .then((value) => {
        if (cancelled) return;
        value = {
          ...value,
          cycles: sessionId
            ? value.cycles.filter((c: any) => c.session_id === sessionId)
            : value.cycles,
          contexts: sessionId
            ? value.contexts.filter((c: any) => c.session_id === sessionId)
            : value.contexts,
        };
        if (
          !value.cycles.some((c: any) => c.cycle_id === selectedNow.current) &&
          JSON.stringify(draftNow.current) !== savedDraft.current
        ) {
          if (
            !window.confirm(
              "The selected cycle changed. Discard unsaved trade labels?",
            )
          ) {
            setError(
              "History changed. Save or discard your draft before selecting another cycle.",
            );
            return;
          }
          setDraft({});
          setBaseline("{}");
          savedDraft.current = "{}";
          initialized.current = "";
        }
        setData(value);
        setError("");
        setSelected((previous) =>
          value.cycles.some((c: any) => c.cycle_id === previous)
            ? previous
            : (value.cycles[0]?.cycle_id ?? ""),
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [request, portfolioId, sessionId, retry]);
  useEffect(() => {
    let cancelled = false;
    void request<any>("label-metadata", "GET")
      .then((value) => {
        if (!cancelled) setMetadata(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request]);
  const cycle = data?.cycles.find((c: any) => c.cycle_id === selected);
  useEffect(() => {
    if (!cycle) return;
    const fresh = initialized.current !== identity;
    if (!fresh && (dirty || busy)) return;
    const next = Object.fromEntries(
      fields.map((name) => [
        name,
        cycle.label?.[name] ?? (name.endsWith("_tag") ? "AS_PER_PATTERN" : ""),
      ]),
    );
    if (fresh) setDate(cycle.exit_date ?? swingToday());
    initialized.current = identity;
    savedDraft.current = JSON.stringify(next);
    setBaseline(savedDraft.current);
    setDraft(next);
  }, [cycle, identity]);
  const pane: SwingPane = {
    symbol: cycle?.symbol ?? "HDFCBANK",
    instrument_type: cycle?.instrument_type === "futures" ? "futures" : cycle?.right ? "options" : "equity",
    right: cycle?.right ?? undefined,
    strike: cycle?.strike ?? undefined,
    expiry: cycle?.expiry ?? undefined,
    interval,
    as_of_date: date,
  };
  useEffect(() => {
    const version = ++owner.current;
    if (!cycle || !date) return;
    setLoading(true);
    setCandles([]);
    setChartError("");
    void request<any>(
      `${portfolioId}/charts/history`,
      "POST",
      pane as unknown as Record<string, unknown>,
    )
      .then((value) => {
        if (owner.current === version) setCandles(value.candles);
      })
      .catch((cause) => {
        if (owner.current === version) setChartError(String(cause));
      })
      .finally(() => {
        if (owner.current === version) setLoading(false);
      });
    return () => {
      owner.current++;
    };
  }, [request, portfolioId, selected, date, interval]);
  const save = async () => {
    if (!cycle || busy || initialized.current !== identity) return;
    const savingIdentity = identity;
    setBusy(true);
    try {
      await request(`${portfolioId}/labels`, "POST", {
        session_id: cycle.session_id,
        analytics_cycle_id: cycle.cycle_id,
        ...draft,
      });
      if (!alive.current || liveIdentity.current !== savingIdentity) return;
      savedDraft.current = JSON.stringify(draft);
      setBaseline(savedDraft.current);
      setRetry((n) => n + 1);
      setError("");
    } catch (cause) {
      if (alive.current && liveIdentity.current === savingIdentity)
        setError(String(cause));
    } finally {
      if (alive.current && liveIdentity.current === savingIdentity)
        setBusy(false);
    }
  };
  const rows = (data?.contexts ?? [])
    .flatMap((context: any) =>
      context.trades.map((trade: any) => ({
        ...trade,
        session_id: context.session_id,
      })),
    )
    .sort((a: any, b: any) => a.timestamp - b.timestamp);
  return (
    <section className="swing-history" aria-label="Swing execution history">
      <header>
        <h2>Execution history and labels</h2>
        <button disabled={busy} onClick={() => setRetry((n) => n + 1)}>
          Refresh history
        </button>
        {onReconcile && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onReconcile()
                .then(() => setRetry((n) => n + 1))
                .catch((cause) => setError(String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            Reconcile with broker
          </button>
        )}
        {onAnalyse && (
          <button
            onClick={() => {
              if (discard()) onAnalyse(portfolioId, cycle?.session_id);
            }}
          >
            Open Analysis
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => {
            if (discard()) onClose();
          }}
        >
          Close history
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {data?.history_warning && <p role="status">{data.history_warning}</p>}
      {!data && !error && <p>Reading committed execution history…</p>}
      <div className="swing-history-grid">
        <aside className="swing-history-list">
          {data?.cycles.map((c: any) => (
            <button
              key={c.cycle_id}
              aria-pressed={selected === c.cycle_id}
              onClick={() => {
                if (busy || !discard()) return;
                setSelected(c.cycle_id);
              }}
            >
              {c.symbol} {c.right} {c.strike}
              <br />
              {c.entry_date} → {c.exit_date ?? "Open"}
              <br />
              {c.state} · {swingMoney(c.net_pnl)}
            </button>
          ))}
        </aside>
        <div>
          {cycle && (
            <>
              <h3>
                {cycle.symbol} {cycle.right} {cycle.strike} {cycle.expiry}
              </h3>
              <p>
                {cycle.imported
                  ? "Imported opening basis; original acquisition date and fees are unknown."
                  : "One cycle includes all scale-ins and partial exits until flat."}
              </p>
              <div className="swing-history-label">
                {fields.map((name) => (
                  <label key={name}>
                    {name.replace(/_/g, " ")}
                    <input
                      aria-label={name.replace(/_/g, " ")}
                      list={`swing-label-${name}`}
                      value={draft[name] ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft((previous) => ({
                          ...previous,
                          [name]: e.target.value,
                        }))
                      }
                    />
                    <datalist id={`swing-label-${name}`}>
                      {(
                        metadata[
                          name.endsWith("category")
                            ? "categories"
                            : name.endsWith("strategy")
                              ? "strategies"
                              : name === "entry_tag"
                                ? "entry_tags"
                                : "exit_tags"
                        ] ?? []
                      ).map((value: string) => (
                        <option key={value}>{value}</option>
                      ))}
                    </datalist>
                  </label>
                ))}
                <button
                  disabled={busy || initialized.current !== identity}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save trade label"}
                </button>
              </div>
              <div className="swing-stat-filters">
                <label>
                  Chart date{" "}
                  <input
                    aria-label="Swing history chart date"
                    max={swingToday()}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Swing history interval"
                  value={interval}
                  onChange={(e) =>
                    setInterval(e.target.value as SwingPane["interval"])
                  }
                >
                  {["1D", "1m", "3m", "5m", "15m", "30m", "1h"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
                <button onClick={() => setDate(cycle.entry_date)}>
                  Entry day
                </button>
                {cycle.exit_date && (
                  <button onClick={() => setDate(cycle.exit_date)}>
                    Exit day
                  </button>
                )}
              </div>
              <div className="swing-history-chart">
                <Renderer
                  key={`${selected}:${interval}`}
                  pane={pane}
                  drawingScope={`swing:${portfolioId}:history`}
                  candles={candles}
                  loading={loading}
                  message={chartError}
                  live={false}
                  showHistoricalTrades
                  active={true}
                  picking={false}
                  orders={[]}
                  trades={cycle.executions.filter((r: any) => !r.opening_basis)}
                  onPick={() => {}}
                  onActivate={() => {}}
                  loadOlder={async (before) => {
                    const version = owner.current;
                    const value = await request<any>(
                      `${portfolioId}/charts/history`,
                      "POST",
                      { ...pane, before },
                    );
                    if (owner.current !== version)
                      return { candles: [], more: false };
                    const older = value.candles.filter(
                      (row: SwingCandle) => row.time < before,
                    );
                    setCandles((previous) => [
                      ...older,
                      ...previous.filter(
                        (row) =>
                          !older.some(
                            (old: SwingCandle) => old.time === row.time,
                          ),
                      ),
                    ]);
                    return { candles: older, more: value.more };
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
      <h3>Actual fills</h3>
      <p>
        Import basis is shown with its cycle; it is not an execution. Historical
        warnings and missing fees remain visible.
      </p>
      <table>
        <thead>
          <tr>
            <th>Date / IST time</th>
            <th>Instrument</th>
            <th>Side</th>
            <th>Quantity</th>
            <th>Price</th>
            <th>Known fees</th>
            <th>Broker order / execution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={`${r.session_id}:${r.execution_id ?? r.trade_id}`}>
              <td>
                {new Date(r.timestamp * 1000)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)}
              </td>
              <td>
                {r.symbol} {r.right} {r.strike} {r.expiry}
              </td>
              <td>{r.side}</td>
              <td>{r.quantity}</td>
              <td>{swingMoney(r.price)}</td>
              <td>{swingMoney(r.commission)}</td>
              <td>
                {r.broker_order_id ?? r.kotak_order_id ?? r.order_id ?? "—"} /{" "}
                {r.execution_id ?? r.trade_id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Recorded order status</h3>
      {data?.contexts.map((context: any) => (
        <table key={context.session_id}>
          <tbody>
            {context.orders.map((o: any) => (
              <tr key={o.order_id}>
                <td>
                  {o.symbol} {o.right} {o.strike}
                </td>
                <td>{o.status}</td>
                <td>{o.quantity}</td>
                <td>{o.broker_order_id ?? o.kotak_order_id ?? o.order_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
