import { useEffect, useRef, useState } from "react";
import { swingToday } from "./SwingWorkspace";
import "./swingAnalytics.css";
export const swingMoney = (value?: number | null) =>
  value == null
    ? "—"
    : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const number = (value?: number | null) =>
  value == null
    ? "—"
    : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const percent = (value?: number | null) =>
  value == null ? "—" : `${number(value)}%`;
export interface SwingStatsProps {
  load: (filters: Record<string, string>, signal?: AbortSignal) => Promise<any>;
  portfolioId?: string;
  initialPortfolioId?: string;
  onPortfolioChange?: (id: string) => void;
  onCycle?: (cycle: any) => void;
  onClose?: () => void;
  onDraftStateChange?: (state: { dirty: boolean; saving: boolean }) => void;
  saveLabel?: (cycle: any, draft: Record<string, string>) => Promise<unknown>;
}
function Curve({
  rows,
  field,
  label,
}: {
  rows: any[];
  field: string;
  label: string;
}) {
  const points = rows.map((row, index) => ({ ...row, plotIndex: index }));
  const values = points.filter((row) => row[field] != null);
  const scaled = field === "nav" || field === "growth100";
  const low =
    scaled && values.length
      ? Math.min(...values.map((row) => row[field])) * 0.995
      : Math.min(0, ...values.map((row) => row[field]));
  const high =
    scaled && values.length
      ? Math.max(...values.map((row) => row[field])) * 1.005
      : Math.max(1, ...values.map((row) => row[field]));
  const [hover, setHover] = useState<any>(null);
  const segments: any[][] = [[]];
  for (const row of points) {
    if (row[field] == null) {
      if (segments[segments.length - 1].length) segments.push([]);
    } else segments[segments.length - 1].push(row);
  }
  const x = (i: number) => 30 + (i / Math.max(1, rows.length - 1)) * 840,
    y = (v: number) => 190 - ((v - low) / Math.max(1, high - low)) * 160;
  return (
    <section className="swing-stat-card">
      <h3>{label}</h3>
      <svg viewBox="0 0 900 230" role="img" aria-label={label}>
        {segments
          .filter((segment) => segment.length)
          .map((segment, index) => (
            <polyline
              key={index}
              points={segment
                .map((row) => `${x(row.plotIndex)},${y(row[field])}`)
                .join(" ")}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2"
            />
          ))}
        {values.map((row) => (
          <circle
            key={row.date}
            cx={x(row.plotIndex)}
            cy={y(row[field])}
            r="4"
            fill="#38bdf8"
            tabIndex={0}
            onFocus={() => setHover(row)}
            onMouseEnter={() => setHover(row)}
          >
            <title>
              {row.date}: {number(row[field])}
            </title>
          </circle>
        ))}
        <text x="30" y="220" fill="#94a3b8">
          {values[0]?.date}
        </text>
        <text x="760" y="220" fill="#94a3b8">
          {values[values.length - 1]?.date}
        </text>
      </svg>
      {hover && (
        <p>
          {hover.date} · {number(hover[field])}
        </p>
      )}
      {!values.length && <p>Waiting for complete valuation evidence.</p>}
    </section>
  );
}
export default function SwingStats({
  load,
  portfolioId,
  initialPortfolioId,
  onPortfolioChange,
  onCycle,
  onClose,
  saveLabel,
  onDraftStateChange,
}: SwingStatsProps) {
  const today = swingToday(),
    [filters, setFilters] = useState({
      portfolio_id: portfolioId ?? initialPortfolioId ?? "",
      start_date: "",
      end_date: today,
      session_type: "",
      execution_broker: "",
    }),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [view, setView] = useState("Overview"),
    [selectedCycle, setSelectedCycle] = useState<any>(null),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [saving, setSaving] = useState(false);
  const [baseline, setBaseline] = useState("{}");
  const dirty = Boolean(selectedCycle) && JSON.stringify(draft) !== baseline;
  const notify = useRef(onDraftStateChange);
  notify.current = onDraftStateChange;
  useEffect(() => {
    notify.current?.({ dirty, saving });
  }, [dirty, saving]);
  useEffect(() => () => notify.current?.({ dirty: false, saving: false }), []);
  const savingRef = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const navigate = (action: () => void) => {
    if (
      savingRef.current ||
      (dirty && !window.confirm("Discard unsaved trade labels?"))
    )
      return;
    setSelectedCycle(null);
    setDraft({});
    setBaseline("{}");
    action();
  };
  const portfolioNotify = useRef(onPortfolioChange);
  portfolioNotify.current = onPortfolioChange;
  useEffect(() => {
    portfolioNotify.current?.(filters.portfolio_id);
  }, [filters.portfolio_id]);
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController(),
      version = ++revision.current;
    setBusy(true);
    setData(null);
    setError("");
    void load(
      { ...filters, history: view === "Overview" ? "true" : "false" },
      controller.signal,
    )
      .then((value) => {
        if (version !== revision.current) return;
        setData(value);
        if (!filters.portfolio_id && value.portfolios?.length)
          setFilters((previous) => ({
            ...previous,
            portfolio_id:
              value.portfolios.find((p: any) => p.state === "running")
                ?.portfolio_id ?? value.portfolios[0].portfolio_id,
          }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted && version === revision.current)
          setError(String(cause));
      })
      .finally(() => {
        if (version === revision.current) setBusy(false);
      });
    return () => {
      controller.abort();
      revision.current++;
    };
  }, [load, JSON.stringify(filters), retry, view]);
  const report = data?.report,
    metrics = report?.closed_trades,
    nav = report?.portfolio_performance;
  const field = (key: string, value: string) =>
    navigate(() => {
      setData(null);
      setFilters((previous) => ({
        ...previous,
        [key]: value,
        ...(["session_type", "execution_broker"].includes(key)
          ? { portfolio_id: portfolioId ?? "" }
          : {}),
      }));
    });
  const card = (label: string, value: string, hint: string) => (
    <article className="swing-stat-card" key={label} title={hint}>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
  return (
    <section className="swing-statistics" aria-label="Swing statistics">
      <header>
        <h2>Swing performance</h2>
        {onClose && (
          <button onClick={() => navigate(onClose)}>Close statistics</button>
        )}
      </header>
      <div className="swing-stat-filters">
        <label>
          Portfolio{" "}
          <select
            aria-label="Swing stats portfolio"
            disabled={Boolean(portfolioId)}
            value={filters.portfolio_id}
            onChange={(e) => field("portfolio_id", e.target.value)}
          >
            <option value="">Choose portfolio</option>
            {(data?.portfolios ?? []).map((p: any) => (
              <option value={p.portfolio_id} key={p.portfolio_id}>
                {p.mode} {p.broker ?? ""} · {p.date ?? ""} · {p.state}
              </option>
            ))}
          </select>
        </label>
        <label>
          From{" "}
          <input
            aria-label="Swing stats from"
            type="date"
            value={filters.start_date}
            max={filters.end_date}
            onChange={(e) => field("start_date", e.target.value)}
          />
        </label>
        <label>
          Through{" "}
          <input
            aria-label="Swing stats through"
            type="date"
            max={today}
            min={filters.start_date}
            value={filters.end_date}
            onChange={(e) => field("end_date", e.target.value)}
          />
        </label>
        {!portfolioId && (
          <>
            <label>
              Mode{" "}
              <select
                value={filters.session_type}
                onChange={(e) => field("session_type", e.target.value)}
              >
                <option value="">All</option>
                <option value="paper">Paper</option>
                <option value="real">Real</option>
              </select>
            </label>
            <label>
              Broker{" "}
              <select
                value={filters.execution_broker}
                onChange={(e) => field("execution_broker", e.target.value)}
              >
                <option value="">All</option>
                <option value="kite">Kite</option>
                <option value="kotak">Kotak</option>
              </select>
            </label>
          </>
        )}
        <button onClick={() => navigate(() => setRetry((n) => n + 1))}>
          Refresh
        </button>
      </div>
      <nav>
        {["Overview", "Trades", "Exposure"].map((name) => (
          <button
            key={name}
            aria-pressed={view === name}
            onClick={() => navigate(() => setView(name))}
          >
            {name}
          </button>
        ))}
      </nav>
      {busy && <p role="status">Reading executions and daily valuations…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button onClick={() => navigate(() => setRetry((n) => n + 1))}>
            Retry
          </button>
        </p>
      )}
      {!busy && !report && !error && (
        <p>No Swing portfolio is available for this selection.</p>
      )}
      {report && (
        <>
          {report.history_warning && (
            <p role="status">{report.history_warning}</p>
          )}
          {report.funding_status && !report.funding_status.entries_allowed && (
            <p role="status">
              Shared broker funding requires reconciliation. Figures describe
              the recorded managed portfolio; broker cash differences remain
              unresolved.
            </p>
          )}
          {view === "Overview" && (
            <>
              <p>
                {report.start_date}–{report.end_date} · known fee estimates ·{" "}
                {nav?.return_method} · daily valuations through{" "}
                {nav?.series?.at(-1)?.date ?? "no completed trading day"}.
                Dividends and corporate actions are not included.
              </p>
              <div className="swing-stat-grid">
                {card(
                  "Realized in this period",
                  swingMoney(report.period_realized_pnl),
                  "Matched partial and full exits executed within the report dates.",
                )}
                {card(
                  "Valued period P&L",
                  swingMoney(nav?.period_pnl),
                  "Portfolio-value change after classified transfers, through the last completed daily valuation; includes changes in unrealized value.",
                )}
                {card(
                  "Unrealized at valuation",
                  swingMoney(nav?.unrealized_pnl_at_end),
                  "Remaining holdings at the last completed daily valuation, after known remaining entry fees. This is a balance, not the change during the period.",
                )}
                {card(
                  "Known period fees",
                  swingMoney(report.known_period_fees),
                  "Known application-estimated execution fees within the report dates. Imported fees and finalized Swing charges may be unavailable.",
                )}
                {card(
                  "Portfolio return",
                  percent(nav?.return_pct),
                  "Cash-flow-adjusted portfolio return, including open holdings. Risk-capital resets are not profits.",
                )}
                {card(
                  "Maximum drawdown",
                  percent(nav?.max_drawdown_pct),
                  "Peak-to-trough decline of the cash-flow-adjusted portfolio curve, including open positions.",
                )}
                {card(
                  "Drawdown ₹",
                  swingMoney(nav?.max_drawdown_rupees),
                  "Largest decline in managed portfolio value after removing capital transfers.",
                )}
                {card(
                  "Longest drawdown",
                  `${number(nav?.drawdown_duration_trading_days)} trading days`,
                  "Consecutive valued trading days below the previous peak.",
                )}
                {card(
                  "Ending portfolio value",
                  swingMoney(nav?.series?.at(-1)?.nav),
                  "Cash plus marked holdings at the last report valuation.",
                )}
              </div>
              {nav && !nav.coverage_complete && (
                <p role="status" className="swing-hint">
                  Some valuation or funding evidence is missing. Return and
                  drawdown metrics are unavailable; recorded executions remain
                  visible.
                </p>
              )}
              <div className="swing-stat-grid swing-stat-curves">
                <Curve
                  rows={nav?.series ?? []}
                  field="nav"
                  label="Daily portfolio value"
                />
                <Curve
                  rows={(nav?.series ?? []).map((row: any) => ({
                    ...row,
                    growth100: row.growth == null ? null : row.growth * 100,
                  }))}
                  field="growth100"
                  label="Cash-flow-adjusted growth (base 100)"
                />
                <Curve
                  rows={nav?.series ?? []}
                  field="drawdown_pct"
                  label="Portfolio drawdown %"
                />
              </div>
              <h3>Monthly returns</h3>
              <div className="swing-months">
                {nav?.monthly_returns?.map((m: any) => (
                  <article key={m.month}>
                    <strong>{m.month}</strong>
                    <span>
                      {percent(m.return_pct)}
                      {m.partial ? " · partial" : ""}
                    </span>
                  </article>
                ))}
              </div>
              <h3>Longer-term risk and return</h3>
              <p>
                Available after one year and 252 complete daily returns.
                Risk-free rate and downside target: 0%.
              </p>
              <div className="swing-stat-grid">
                {card(
                  "CAGR",
                  percent(nav?.annual?.cagr_pct),
                  "Annualized portfolio growth; never annualized for periods shorter than a year.",
                )}
                {card(
                  "Annualized volatility",
                  percent(nav?.annual?.volatility_pct),
                  "Standard deviation of daily returns × √252.",
                )}
                {card(
                  "Sharpe",
                  number(nav?.annual?.sharpe),
                  "Mean daily excess return divided by its standard deviation × √252; 0% risk-free assumption.",
                )}
                {card(
                  "Sortino",
                  number(nav?.annual?.sortino),
                  "Mean daily return divided by downside deviation × √252; 0% target.",
                )}
              </div>
              {nav?.missing?.length > 0 && (
                <details>
                  <summary>Valuation gaps ({nav.missing.length})</summary>
                  {nav.missing.slice(0, 30).map((m: any, i: number) => (
                    <p key={i}>
                      {m.date} · {m.symbol} · {m.reason}
                    </p>
                  ))}
                </details>
              )}
            </>
          )}
          {view === "Trades" && metrics && (
            <>
              <p>
                Completed cycles by final exit date. A cycle may contain several
                entries and partial exits; open cycles are listed separately and
                do not count as wins or losses.
              </p>
              <div className="swing-stat-grid">
                {[
                  ["Completed cycles", number(metrics.count)],
                  ["Win rate", percent(metrics.win_pct)],
                  ["Closed-cycle P&L", swingMoney(metrics.net_pnl)],
                  ["Average win", swingMoney(metrics.average_win)],
                  ["Average loss", swingMoney(metrics.average_loss)],
                  ["Payoff ratio", number(metrics.payoff_ratio)],
                  ["Profit factor", number(metrics.profit_factor)],
                  ["Expectancy", swingMoney(metrics.expectancy)],
                  [
                    "Mean trade return %",
                    percent(metrics.average_return_on_cost_pct),
                  ],
                  ["Median holding days", number(metrics.median_holding_days)],
                  [
                    "Average trading days",
                    number(metrics.average_trading_days),
                  ],
                  ["Best trade", swingMoney(metrics.best)],
                  ["Worst trade", swingMoney(metrics.worst)],
                  ["Mean R", number(metrics.mean_r)],
                  ["Longest winning streak", number(metrics.streaks.winning)],
                  ["Longest losing streak", number(metrics.streaks.losing)],
                ].map(([name, value]) =>
                  card(
                    name,
                    value,
                    "Computed from completed exact-instrument cycles. Undefined ratios and unknown acquisition periods show —.",
                  ),
                )}
              </div>
              <p>
                Wins {metrics.wins} · Losses {metrics.losses} · Breakeven{" "}
                {metrics.breakeven} · captured risk samples {metrics.r_count} ·
                known holding-period samples {metrics.holding_count ?? 0}
              </p>
              {Object.entries(metrics.groups).map(
                ([name, rows]: [string, any]) => (
                  <section className="swing-stat-card" key={name}>
                    <h3>{name.replace(/_/g, " ")}</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Group</th>
                          <th>Sample</th>
                          <th>Net P&L</th>
                          <th>Win %</th>
                          <th>Expectancy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r: any) => (
                          <tr key={r.key}>
                            <td>{r.key}</td>
                            <td>{r.count}</td>
                            <td>{swingMoney(r.net_pnl)}</td>
                            <td>{percent(r.win_pct)}</td>
                            <td>{swingMoney(r.expectancy)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                ),
              )}
              <h3>Trade cycles · open positions are current</h3>
              <table>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>State</th>
                    <th>Net realized</th>
                    <th>Label</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cycles
                    .filter(
                      (c: any) =>
                        c.state === "open" ||
                        ((!filters.start_date ||
                          c.exit_date >= filters.start_date) &&
                          c.exit_date <= filters.end_date),
                    )
                    .map((c: any) => (
                      <tr key={c.cycle_id}>
                        <td>
                          <button
                            onClick={() =>
                              navigate(() => {
                                if (onCycle) onCycle(c);
                                else {
                                  setSelectedCycle(c);
                                  const nextDraft = Object.fromEntries(
                                    [
                                      "expected_category",
                                      "expected_strategy",
                                      "actual_category",
                                      "actual_strategy",
                                      "entry_tag",
                                      "exit_tag",
                                    ].map((name) => [
                                      name,
                                      c.label?.[name] ??
                                        (name.endsWith("_tag")
                                          ? "AS_PER_PATTERN"
                                          : ""),
                                    ]),
                                  );
                                  setDraft(nextDraft);
                                  setBaseline(JSON.stringify(nextDraft));
                                }
                              })
                            }
                            disabled={!onCycle && !saveLabel}
                          >
                            {c.symbol} {c.right} {c.strike}
                          </button>
                        </td>
                        <td>{c.imported ? "Imported basis" : c.entry_date}</td>
                        <td>{c.exit_date ?? "Open"}</td>
                        <td>{c.state}</td>
                        <td>{swingMoney(c.net_pnl)}</td>
                        <td>{c.label?.actual_strategy ?? "Unlabelled"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
          {selectedCycle && saveLabel && (
            <section className="swing-stat-card">
              <h3>
                Label {selectedCycle.symbol} · {selectedCycle.state}
              </h3>
              <div className="swing-history-label">
                {Object.keys(draft).map((name) => (
                  <label key={name}>
                    {name.replace(/_/g, " ")}
                    <input
                      disabled={saving}
                      value={draft[name]}
                      onChange={(e) =>
                        setDraft((previous) => ({
                          ...previous,
                          [name]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
                <button
                  disabled={saving}
                  onClick={() => {
                    if (savingRef.current) return;
                    savingRef.current = true;
                    setSaving(true);
                    void saveLabel(selectedCycle, draft)
                      .then(() => {
                        if (!alive.current) return;
                        setBaseline(JSON.stringify(draft));
                        setSelectedCycle(null);
                        setRetry((n) => n + 1);
                      })
                      .catch((cause) => {
                        if (alive.current) setError(String(cause));
                      })
                      .finally(() => {
                        savingRef.current = false;
                        if (alive.current) setSaving(false);
                      });
                  }}
                >
                  Save trade label
                </button>
                <button
                  disabled={saving}
                  onClick={() => navigate(() => setSelectedCycle(null))}
                >
                  Cancel label
                </button>
              </div>
            </section>
          )}
          {view === "Exposure" && (
            <>
              <p>
                Current exposure ·{" "}
                {new Date(report.exposure.as_of * 1000)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)}{" "}
                IST. This view shows the current book, independently of report
                dates.
              </p>
              <div className="swing-stat-grid">
                {card(
                  "Available cash",
                  swingMoney(report.exposure.cash),
                  "Current available cash; pending reservations may reduce it.",
                )}
                {card(
                  "Invested cost",
                  swingMoney(report.exposure.invested_cost),
                  "Remaining purchase basis of held positions.",
                )}
                {card(
                  "Largest position",
                  percent(report.exposure.largest_position_pct),
                  "Largest held cost as a percentage of total held cost.",
                )}
                {report.exposure.allocation.map((a: any) =>
                  card(
                    a.kind,
                    swingMoney(a.cost),
                    "Current held cost by instrument type.",
                  ),
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Quantity</th>
                    <th>Cost</th>
                    <th>Mark</th>
                    <th>Unrealized</th>
                    <th>Freshness</th>
                    <th>Holding days</th>
                  </tr>
                </thead>
                <tbody>
                  {report.exposure.positions.map((p: any, i: number) => (
                    <tr key={i}>
                      <td>
                        {p.symbol} {p.right} {p.strike} {p.expiry}
                      </td>
                      <td>{p.quantity}</td>
                      <td>{swingMoney(p.invested_value)}</td>
                      <td>{swingMoney(p.mark_price)}</td>
                      <td>{swingMoney(p.unrealized_pnl)}</td>
                      <td>{p.quote_status}</td>
                      <td>{number(p.holding_days)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
