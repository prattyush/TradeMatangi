import { useAnalysisEnvironment } from './environment'
import { AnalysisChart, OptionsChart } from "./TradeAnalysis";
import type { AnalysisTrade } from "./api";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cyclesCsv,
  type Comparison,
  type PerformanceCycle,
  type PerformanceFilters,
  type PerformanceReport,
} from "./performance";
import "./performance.css";

interface Props {
  onClose: () => void;
  defaultSymbol: string;
  defaultStartDate: string;
  defaultEndDate: string;
  defaultInstrumentType: string;
  defaultSessionType: string;
}
type View = "Overview" | "Entries" | "Exits" | "Sizing" | "Behavior";
const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(2)}%`;
const label = (s: string) =>
  s === "CAPITAL"
    ? "Capital %"
    : s === "RISK"
      ? "Risk %"
      : s === "QUANTITY"
        ? "Fixed quantity"
        : s === "sim"
          ? "Replay"
          : s === "stepwise"
            ? "Stepwise"
            : s === "UNKNOWN"
              ? "Unknown"
              : s.replace(/_/g, " ");
const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
const tint = (n: number | null | undefined) =>
  n == null ? "" : n >= 0 ? "positive" : "negative";
function dateAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function ComparisonTable({
  rows,
  onSelect,
  title,
  dimension,
}: {
  rows: Comparison[];
  title: string;
  dimension?: string;
  onSelect: (key: string, dimension?: string) => void;
}) {
  const [sort, setSort] = useState<"expectancy" | "count" | "net_pnl">(
    "expectancy",
  );
  return (
    <section className="pa-card">
      <div className="pa-card-title">
        <div>
          <h3>{title}</h3>
          <p>
            Net outcomes after allocated fees · click a row to inspect trades
          </p>
        </div>
        <select
          aria-label={`Sort ${title}`}
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
        >
          <option value="expectancy">Expectancy</option>
          <option value="count">Sample size</option>
          <option value="net_pnl">Net P&amp;L</option>
        </select>
      </div>
      <div className="pa-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Method / group</th>
              <th>Closed N</th>
              <th>Realized P&amp;L</th>
              <th>Win %</th>
              <th>Mean / position</th>
              <th>Median</th>
              <th>Mean capital %</th>
              <th title="Net outcome divided by captured initial monetary risk">
                Mean R
              </th>
              <th>Fees</th>
              <th>Associated cycle mean*</th>
            </tr>
          </thead>
          <tbody>
            {[...rows]
              .sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity))
              .map((r) => (
                <tr key={r.key}>
                  <td>
                    <button onClick={() => onSelect(r.key, dimension)}>
                      {label(r.key)}
                    </button>
                    {r.exploratory && (
                      <small className="pa-badge">Exploratory</small>
                    )}
                    {r.days != null && <small>{r.days} market dates</small>}
                  </td>
                  <td>{r.count}</td>
                  <td className={tint(r.realized_pnl ?? r.net_pnl)}>
                    {money(r.realized_pnl ?? r.net_pnl)}
                  </td>
                  <td>{pct(r.win_pct)}</td>
                  <td className={tint(r.expectancy)}>{money(r.expectancy)}</td>
                  <td>{money(r.median_pnl)}</td>
                  <td>{pct(r.mean_pnl_pct)}</td>
                  <td>
                    {r.mean_r?.toFixed(2) ?? "—"}
                    <small>{r.r_count ?? 0} with initial risk</small>
                  </td>
                  <td>{money(r.fees)}</td>
                  <td>
                    {money(r.associated?.expectancy)}
                    {r.mean_interval && (
                      <small>
                        95% interval {money(r.mean_interval[0])} to{" "}
                        {money(r.mean_interval[1])}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="pa-muted">No executions in this selection.</p>
      )}
      <p className="pa-footnote">
        *Unique completed cycles containing this method. Cycles can appear in
        several groups; these contextual results are not additive.
      </p>
    </section>
  );
}

function Curve({
  report,
  select,
}: {
  report: PerformanceReport;
  select: (id: string) => void;
}) {
  const points = report.curve;
  const low = Math.min(0, ...points.map((p) => p.pnl)),
    high = Math.max(1, ...points.map((p) => p.pnl));
  const xy = (i: number, pnl: number) =>
    `${30 + ((i + 1) / Math.max(1, points.length)) * 930},${190 - ((pnl - low) / (high - low)) * 155}`;
  return (
    <section className="pa-card">
      <h3>How results accumulated</h3>
      <p>
        Cumulative closed-cycle net P&amp;L · realized-P&amp;L drawdown excludes
        open equity risk
      </p>
      <svg
        className="pa-curve"
        viewBox="0 0 1000 225"
        role="img"
        aria-label="Cumulative net P and L"
      >
        <line
          x1="30"
          x2="960"
          y1={190 - ((0 - low) / (high - low)) * 155}
          y2={190 - ((0 - low) / (high - low)) * 155}
          stroke="#334155"
          strokeDasharray="4 5"
        />
        <polyline
          points={`30,${190 - ((0 - low) / (high - low)) * 155} ${points.map((p, i) => xy(i, p.pnl)).join(" ")}`}
          fill="none"
          stroke="#8b9dff"
          strokeWidth="3"
        />
        {points.map((p, i) => {
          const [x, y] = xy(i, p.pnl).split(",").map(Number);
          return (
            <circle
              key={p.cycle_id}
              cx={x}
              cy={y}
              r="5"
              fill="#a5b4fc"
              tabIndex={0}
              role="button"
              aria-label={`Inspect cycle ${p.cycle_id}: ${money(p.pnl)}`}
              onClick={() => select(p.cycle_id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") select(p.cycle_id);
              }}
            >
              <title>
                {money(p.pnl)} · drawdown {money(p.drawdown)}
              </title>
            </circle>
          );
        })}
        <text x="30" y="220" fill="#94a3b8">
          {points.length} completed cycles
        </text>
        <text x="740" y="220" fill="#94a3b8">
          {money(points[points.length - 1]?.pnl ?? 0)}
        </text>
      </svg>
    </section>
  );
}

export default function PerformanceDashboard(props: Props) {
  const { getPerformance, getPerformanceCycles, getPerformanceDetail } = useAnalysisEnvironment().performance
  const [filters, setFilters] = useState<PerformanceFilters>({
    symbol: props.defaultSymbol,
    start_date: props.defaultStartDate || dateAgo(29),
    end_date: props.defaultEndDate || dateAgo(0),
    instrument_type: props.defaultInstrumentType,
    session_type:
      props.defaultSessionType === "desktop_stepwise"
        ? "stepwise"
        : props.defaultSessionType,
  });
  const [view, setView] = useState<View>("Overview");
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [cycles, setCycles] = useState<PerformanceCycle[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<PerformanceCycle | null>(null);
  const [detailError, setDetailError] = useState("");
  const [showChart, setShowChart] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [focus, setFocus] = useState<{
    key: string;
    dimension?: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const revision = ++generation.current;
    setLoading(true);
    setError("");
    setFocus(null);
    setDetail(null);
    setReport(null);
    setCycles([]);
    void Promise.all([
      getPerformance(filters, controller.signal),
      getPerformanceCycles(filters, 0, controller.signal),
    ])
      .then(([r, page]) => {
        if (generation.current !== revision) return;
        setReport(r);
        setCycles(page.items);
        setNextOffset(page.next_offset);
        setTotal(page.total);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (generation.current === revision) setLoading(false);
      });
    return () => {
      controller.abort();
      detailGeneration.current++;
    };
  }, [filters, refresh]);
  const select = (key: string, dimension?: string) =>
    setFocus({ key, dimension });
  const showDetail = async (c: PerformanceCycle, enrich = false) => {
    const revision = ++detailGeneration.current;
    setDetail(c);
    if (!enrich) setShowChart(false);
    setDetailBusy(true);
    setDetailError("");
    try {
      const d = await getPerformanceDetail(c, enrich);
      if (detailGeneration.current === revision) setDetail(d);
    } catch (e) {
      if (detailGeneration.current === revision) setDetailError(String(e));
    } finally {
      if (detailGeneration.current === revision) setDetailBusy(false);
    }
  };
  const loadMore = async () => {
    if (nextOffset == null) return;
    const revision = generation.current;
    setLoading(true);
    try {
      const page = await getPerformanceCycles(filters, nextOffset);
      if (revision === generation.current) {
        setCycles((c) => [...c, ...page.items]);
        setNextOffset(page.next_offset);
      }
    } catch (e) {
      if (revision === generation.current) setError(String(e));
    } finally {
      if (revision === generation.current) setLoading(false);
    }
  };
  const exportCsv = async () => {
    const revision = generation.current;
    setExporting(true);
    try {
      let rows = [...cycles],
        offset = nextOffset;
      while (offset != null) {
        const page = await getPerformanceCycles(filters, offset);
        if (revision !== generation.current) return;
        rows.push(...page.items);
        offset = page.next_offset;
      }
      const url = URL.createObjectURL(
        new Blob([cyclesCsv(rows)], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "trade-matangi-performance.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };
  const visible = useMemo(
    () =>
      cycles.filter(
        (c) =>
          !focus ||
          (focus.dimension === "matrix"
            ? c.matches.some(
                (m) => `${m.entry_method} → ${m.exit_method}` === focus.key,
              )
            : focus.dimension === "entry_method"
              ? c.entries.some((e) => e.entry_method === focus.key)
              : focus.dimension === "exit_method"
                ? c.matches.some((m) => m.exit_method === focus.key)
                : focus.dimension === "requested_size"
                  ? c.matches.some((m) => m.requested_size === focus.key)
                  : focus.dimension === "sizing_method"
                    ? c.entries.some((e) => e.sizing_method === focus.key)
                    : focus.dimension === "requested_pct"
                      ? c.entries.some(
                          (e) => String(e.requested_pct) === focus.key,
                        )
                      : focus.dimension === "client"
                        ? c.entries.some((e) => e.client === focus.key)
                        : focus.dimension === "mode"
                          ? c.mode === focus.key
                          : focus.dimension === "date"
                            ? c.date === focus.key
                            : focus.dimension?.startsWith("label:")
                              ? (c.label?.[focus.dimension.slice(6)] ||
                                  "Unlabeled") === focus.key
                              : focus.dimension === "cycle"
                                ? c.cycle_id === focus.key
                                : c.behavior?.some(
                                    (b) =>
                                      b.dimension === focus.dimension &&
                                      b.key === focus.key,
                                  )),
      ),
    [cycles, focus],
  );
  const field = (name: string, value: string) =>
    setFilters((f) => ({ ...f, [name]: value }));
  return (
    <div
      className="pa-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Trading performance"
    >
      <header className="pa-header">
        <div>
          <span className="pa-eyebrow">TRADE MATANGI / ANALYSIS</span>
          <h1>Your trading, understood.</h1>
          <p>
            Find your strengths. Trace the losses. Improve one decision at a
            time.
          </p>
        </div>
        <button
          className="pa-close"
          aria-label="Close analytics"
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <div className="pa-filters">
        <label>
          From
          <input
            type="date"
            value={filters.start_date}
            onChange={(e) => field("start_date", e.target.value)}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            value={filters.end_date}
            onChange={(e) => field("end_date", e.target.value)}
          />
        </label>
        <label>
          Mode
          <select
            value={filters.session_type}
            onChange={(e) => field("session_type", e.target.value)}
          >
            <option value="">All modes</option>
            {["paper", "real", "stepwise", "sim"].map((m) => (
              <option key={m} value={m}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Origin
          <select
            value={filters.client ?? ""}
            onChange={(e) => field("client", e.target.value)}
          >
            <option value="">Both clients</option>
            <option value="website">Website</option>
            <option value="desktop">Desktop</option>
          </select>
        </label>
        <label>
          Symbol
          <select
            value={filters.symbol}
            onChange={(e) => field("symbol", e.target.value)}
          >
            <option value="">All symbols</option>
            {["NIFTY", "BSESEN", "TATPOW", "TATMOT", "RELIND"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Instrument
          <select
            value={filters.instrument_type}
            onChange={(e) => field("instrument_type", e.target.value)}
          >
            <option value="">All</option>
            <option value="equity">Equity</option>
            <option value="options">Options</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={filters.direction ?? ""}
            onChange={(e) => field("direction", e.target.value)}
          >
            <option value="">Both</option>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
        </label>
        <details className="pa-more-filters">
          <summary>Method / labels / coverage</summary>
          <div className="pa-filters">
            <label>
              Entry method
              <select
                value={filters.entry_method || ""}
                onChange={(e) => field("entry_method", e.target.value)}
              >
                <option value="">All entries</option>
                {[
                  "MARKET",
                  "LIMIT",
                  "TARGET",
                  "AUTOSTOP",
                  "AUTOSTOP_LIMIT",
                  "UNKNOWN",
                ].map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Exit controller
              <select
                value={filters.exit_method || ""}
                onChange={(e) => field("exit_method", e.target.value)}
              >
                <option value="">All exits</option>
                {[
                  "MARKET",
                  "LIMIT",
                  "TARGET",
                  "STOPLOSS",
                  "AggressiveStoploss",
                  "TargetProfit",
                  "UnderlyingTargetProfit",
                  "UnderlyingStoploss",
                  "BreakEven",
                  "LockProfit",
                  "SESSION_CLOSE",
                  "EOD_CLOSE",
                  "UNKNOWN",
                ].map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sizing
              <select
                value={filters.sizing_method || ""}
                onChange={(e) => field("sizing_method", e.target.value)}
              >
                <option value="">All sizing</option>
                <option value="CAPITAL">Capital %</option>
                <option value="RISK">Risk %</option>
                <option value="QUANTITY">Fixed quantity</option>
                <option value="UNKNOWN">Unknown</option>
              </select>
            </label>
            <label>
              Requested %
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                placeholder="Any"
                value={filters.requested_pct || ""}
                onChange={(e) => field("requested_pct", e.target.value)}
              />
            </label>
            <label>
              Coverage
              <select
                value={filters.data_quality || ""}
                onChange={(e) => field("data_quality", e.target.value)}
              >
                <option value="">Include unknowns</option>
                <option value="known">Known entry and sizing</option>
                <option value="executions">Individual executions</option>
              </select>
            </label>
            {[
              "entry_tag",
              "exit_tag",
              "expected_strategy",
              "actual_strategy",
            ].map((name) => (
              <label key={name}>
                {label(name)}
                <input
                  placeholder="Exact saved label"
                  value={filters[name] || ""}
                  onChange={(e) => field(name, e.target.value)}
                />
              </label>
            ))}
          </div>
        </details>
        <button disabled={loading} onClick={() => setRefresh((r) => r + 1)}>
          Refresh
        </button>
        <button
          disabled={!cycles.length || exporting}
          onClick={() => void exportCsv()}
        >
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>
      <nav className="pa-tabs" aria-label="Performance sections">
        {(["Overview", "Entries", "Exits", "Sizing", "Behavior"] as View[]).map(
          (t) => (
            <button
              key={t}
              aria-pressed={view === t}
              className={view === t ? "active" : ""}
              onClick={() => {
                setView(t);
                setFocus(null);
              }}
            >
              {t}
            </button>
          ),
        )}
      </nav>
      <main className="pa-main">
        {error && (
          <div role="alert" className="pa-error">
            {error}
            <button onClick={() => setRefresh((r) => r + 1)}>Retry</button>
          </div>
        )}
        {loading && !report && <p role="status">Reading your executions…</p>}
        {report && (
          <>
            <div className="pa-kpis">
              {[
                [
                  "Realized P&L",
                  money(report.summary.realized_pnl),
                  "Includes closed portions of open cycles",
                ],
                [
                  "Expectancy",
                  money(report.summary.expectancy),
                  "Mean net outcome per completed cycle",
                ],
                [
                  "Win rate",
                  pct(report.summary.win_pct),
                  `${report.summary.wins} wins / ${report.summary.losses} losses / ${report.summary.breakeven} flat`,
                ],
                [
                  "Profit factor",
                  report.summary.profit_factor?.toFixed(2) ?? "—",
                  "Net winning outcomes ÷ absolute net losing outcomes",
                ],
                [
                  "Realized drawdown",
                  money(report.summary.drawdown),
                  "Closed-cycle P&L peak to trough; excludes open equity",
                ],
                [
                  "Open cycles",
                  String(report.summary.open_cycles),
                  `${money(report.summary.open_entry_fees)} entry fees remain allocated to open inventory`,
                ],
              ].map(([name, value, note]) => (
                <section key={name} className="pa-kpi" title={note}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                  <small>{note}</small>
                </section>
              ))}
            </div>
            <div className="pa-coverage">
              <span>
                {report.summary.count} completed cycles · {report.summary.days}{" "}
                market dates
              </span>
              <span>
                Entry provenance {report.coverage.known_entries}/
                {report.coverage.entries} · labeled cycles{" "}
                {report.coverage.labeled_cycles}/{total} ·{" "}
                {report.coverage.order_level_cycles} order-level histories
              </span>
            </div>
            {!filters.session_type && (
              <p className="pa-footnote">
                The overview pools selected outcomes. Compare methods within a
                single trading mode; Paper, Replay and Real have different
                execution conditions.
              </p>
            )}
            {view === "Overview" && (
              <>
                <Curve report={report} select={(id) => select(id, "cycle")} />
                <div className="pa-columns">
                  <section className="pa-card">
                    <h3>Daily rhythm</h3>
                    <p>Completed-cycle outcomes by market date</p>
                    <div className="pa-calendar">
                      {report.daily.map((d) => (
                        <button
                          key={d.date}
                          className={tint(d.net_pnl)}
                          onClick={() => select(d.date, "date")}
                          title={`${d.cycles} cycles · fees ${money(d.fees)}`}
                        >
                          <span>{d.date.slice(5)}</span>
                          <strong>{money(d.net_pnl)}</strong>
                          <small>{d.cycles} cycles</small>
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="pa-card">
                    <h3>Outcome distribution</h3>
                    <p>
                      Each bar is a completed trade cycle; click to inspect.
                    </p>
                    <div className="pa-distribution">
                      {report.distributions.map((d) => (
                        <button
                          key={d.cycle_id}
                          onClick={() => select(d.cycle_id, "cycle")}
                          title={`${d.date} · ${label(d.mode)} · ${money(d.pnl)}`}
                          style={{
                            height: `${12 + (100 * Math.abs(d.pnl)) / Math.max(1, ...report.distributions.map((p) => Math.abs(p.pnl)))}px`,
                            background: d.pnl >= 0 ? "#36c9a0" : "#ef7c8e",
                          }}
                          aria-label={`Trade ${money(d.pnl)}`}
                        />
                      ))}
                    </div>
                  </section>
                </div>
                <ComparisonTable
                  rows={report.comparisons.modes}
                  title="Keep trading modes in perspective"
                  dimension="mode"
                  onSelect={select}
                />
              </>
            )}
            {view === "Entries" && (
              <>
                <ComparisonTable
                  rows={report.comparisons.entries}
                  title="Which entry methods work?"
                  dimension="entry_method"
                  onSelect={select}
                />
                <section className="pa-card">
                  <h3>Entry → exit combinations</h3>
                  <p>
                    Attributed matched-portion outcomes; select a combination to
                    inspect its entry cohort.
                  </p>
                  <div className="pa-heatmap">
                    {report.matrix.map((r) => (
                      <button
                        key={`${r.entry}:${r.exit}`}
                        className={tint(r.net_pnl)}
                        onClick={() =>
                          select(`${r.entry} → ${r.exit}`, "matrix")
                        }
                      >
                        <span>
                          {label(r.entry)} → {label(r.exit)}
                        </span>
                        <strong>{money(r.net_pnl)}</strong>
                        <small>{r.count} matched portions</small>
                      </button>
                    ))}
                  </div>
                </section>
                <ComparisonTable
                  rows={report.comparisons.entry_tag}
                  title="Your existing entry tags"
                  dimension="label:entry_tag"
                  onSelect={select}
                />
                <ComparisonTable
                  rows={report.comparisons.expected_strategy}
                  title="Expected setup"
                  dimension="label:expected_strategy"
                  onSelect={select}
                />
              </>
            )}
            {view === "Exits" && (
              <>
                <ComparisonTable
                  rows={report.comparisons.exits}
                  title="Which exits preserve your results?"
                  dimension="exit_method"
                  onSelect={select}
                />
                <ComparisonTable
                  rows={report.comparisons.exit_sizes}
                  title="Half versus Full exit intent"
                  dimension="requested_size"
                  onSelect={select}
                />
                <section className="pa-card">
                  <h3>Beyond the final P&amp;L</h3>
                  <p>
                    Open a cycle below and select “Analyze price path” for
                    sampled MFE (best movement), MAE (worst movement), profit
                    giveback and initial-risk multiples. Missing observations
                    stay unavailable.
                  </p>
                  <p className="pa-footnote">
                    A target and a stoploss occur in different conditions.
                    Compare within an entry method, mode and setup; a higher
                    mean alone does not establish a better exit.
                  </p>
                </section>
                <ComparisonTable
                  rows={report.comparisons.exit_tag}
                  title="Your existing exit tags"
                  dimension="label:exit_tag"
                  onSelect={select}
                />
              </>
            )}
            {view === "Sizing" && (
              <>
                <ComparisonTable
                  rows={report.comparisons.sizing}
                  title="Capital %, Risk %, or fixed quantity?"
                  dimension="sizing_method"
                  onSelect={select}
                />
                <ComparisonTable
                  rows={report.comparisons.percentages}
                  title="Requested percentage and outcomes"
                  dimension="requested_pct"
                  onSelect={select}
                />
                <section className="pa-card">
                  <h3>Size versus outcome</h3>
                  <p>
                    Effective capital allocation % at fill versus attributed
                    entry-position net P&amp;L. Points from open cycles retain
                    partial realized outcomes.
                  </p>
                  <svg
                    viewBox="0 0 1000 230"
                    className="pa-curve"
                    role="img"
                    aria-label="Position sizing scatterplot"
                  >
                    {(() => {
                      const entries = cycles
                        .flatMap((c) => c.entries.map((e) => ({ e, c })))
                        .filter(
                          ({ e }) =>
                            e.analytics.effective_allocation_pct != null,
                        );
                      const maxX = Math.max(
                        1,
                        ...entries.map(
                          ({ e }) => e.analytics.effective_allocation_pct!,
                        ),
                      );
                      const maxY = Math.max(
                        1,
                        ...entries.map(({ e }) => Math.abs(e.net_pnl)),
                      );
                      return (
                        <>
                          <line
                            x1="30"
                            x2="960"
                            y1="115"
                            y2="115"
                            stroke="#334155"
                          />
                          {entries.map(({ e, c }) => (
                            <circle
                              key={`${c.cycle_id}:${e.entry_id}`}
                              cx={
                                30 +
                                (e.analytics.effective_allocation_pct! / maxX) *
                                  930
                              }
                              cy={115 - (e.net_pnl / maxY) * 95}
                              r="6"
                              fill={
                                e.analytics.budget_exceeded
                                  ? "#fbbf24"
                                  : e.net_pnl >= 0
                                    ? "#36c9a0"
                                    : "#ef7c8e"
                              }
                              onClick={() => void showDetail(c)}
                              tabIndex={0}
                              role="button"
                              aria-label={`Allocation ${pct(e.analytics.effective_allocation_pct)}, outcome ${money(e.net_pnl)}`}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void showDetail(c);
                              }}
                            >
                              <title>
                                {label(e.sizing_method)} {pct(e.requested_pct)}{" "}
                                requested ·{" "}
                                {pct(e.analytics.effective_allocation_pct)}{" "}
                                effective · {money(e.net_pnl)}
                                {e.analytics.budget_exceeded
                                  ? " · budget exceeded"
                                  : ""}
                              </title>
                            </circle>
                          ))}
                          <text x="30" y="225" fill="#94a3b8">
                            0% capital allocation
                          </text>
                          <text x="820" y="225" fill="#94a3b8">
                            {pct(maxX)} allocation
                          </text>
                        </>
                      );
                    })()}
                  </svg>
                  <p className="pa-footnote">
                    Amber points exceeded the requested sizing budget. Capital
                    allocation uses captured margin; it is separate from
                    notional value.
                  </p>
                </section>
              </>
            )}
            {view === "Behavior" && (
              <>
                <section className="pa-card">
                  <h3>Patterns worth reviewing</h3>
                  {report.insights.length ? (
                    report.insights.map((i, n) => (
                      <button
                        className="pa-insight"
                        key={n}
                        onClick={() => select(i.key, i.dimension)}
                      >
                        {i.text}
                      </button>
                    ))
                  ) : (
                    <p>
                      No supported negative-outcome patterns yet. Explore the
                      groups below; small samples are not conclusions.
                    </p>
                  )}
                </section>
                {[...new Set(report.behavior.map((r) => r.dimension))].map(
                  (d) => (
                    <ComparisonTable
                      key={d}
                      title={label(d ?? "Behavior")}
                      rows={report.behavior.filter((r) => r.dimension === d)}
                      dimension={d}
                      onSelect={select}
                    />
                  ),
                )}
                <ComparisonTable
                  rows={report.comparisons.actual_strategy}
                  title="Your actual strategy labels"
                  dimension="label:actual_strategy"
                  onSelect={select}
                />
              </>
            )}
            <section className="pa-card">
              <div className="pa-card-title">
                <div>
                  <h3>
                    {focus
                      ? `Trades behind “${label(focus.key)}”`
                      : "Trace the individual trades"}
                  </h3>
                  <p>
                    {cycles.length} of {total} cycles loaded · quantities are
                    contracts/shares
                  </p>
                </div>
                {focus && (
                  <button onClick={() => setFocus(null)}>
                    Clear selection
                  </button>
                )}
              </div>
              <div className="pa-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date / mode</th>
                      <th>Contract</th>
                      <th>Direction</th>
                      <th>Entry / exit decisions</th>
                      <th>Net realized</th>
                      <th>Capital contribution</th>
                      <th>State</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => (
                      <tr key={c.cycle_id}>
                        <td>
                          {c.date}
                          <small>{label(c.mode)}</small>
                        </td>
                        <td>
                          {c.symbol} {c.strike} {c.right}
                          <small>{c.expiry}</small>
                        </td>
                        <td>{c.direction}</td>
                        <td>
                          {c.entry_count} / {c.exit_count}
                        </td>
                        <td className={tint(c.net_pnl)}>{money(c.net_pnl)}</td>
                        <td>{pct(c.pnl_pct)}</td>
                        <td>
                          {c.state}
                          {c.open_quantity > 0 && ` · ${c.open_quantity} open`}
                        </td>
                        <td>
                          <button onClick={() => void showDetail(c)}>
                            Details →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!visible.length && (
                <p>
                  No loaded cycles match this selection. Load more cycles below
                  if available.
                </p>
              )}
              {nextOffset != null && (
                <button disabled={loading} onClick={() => void loadMore()}>
                  {loading ? "Loading…" : "Load more cycles"}
                </button>
              )}
            </section>
          </>
        )}
        {!loading && !error && report && total === 0 && (
          <section className="pa-card">
            <h3>A clear view starts with your trades.</h3>
            <p>
              No executions were found for these filters. Broaden the date range
              or choose another trading mode.
            </p>
          </section>
        )}
      </main>
      {detail && (
        <aside
          className="pa-drawer"
          role="dialog"
          aria-label="Trade cycle details"
        >
          <div className="pa-card-title">
            <div>
              <span className="pa-eyebrow">EXECUTION STORY</span>
              <h2>
                {detail.symbol} {detail.strike} {detail.right}
              </h2>
              <p>
                {detail.date} · {label(detail.mode)} · {detail.direction}
              </p>
            </div>
            <button
              aria-label="Close trade details"
              onClick={() => {
                detailGeneration.current++;
                setDetail(null);
              }}
            >
              ×
            </button>
          </div>
          <strong className={`pa-detail-pnl ${tint(detail.net_pnl)}`}>
            {money(detail.net_pnl)}{" "}
            <small>{pct(detail.pnl_pct)} of captured capital</small>
          </strong>
          <p>
            {detail.entry_count} entry decisions · {detail.exit_count} exit
            decisions · {money(detail.fees)} allocated fees
          </p>
          {detail.label && (
            <p>
              Expected: {detail.label.expected_strategy || "—"} · Actual:{" "}
              {detail.label.actual_strategy || "—"}
              <br />
              Entry: {detail.label.entry_tag || "—"} · Exit:{" "}
              {detail.label.exit_tag || "—"}
            </p>
          )}
          {detail.entries.map((e) => (
            <section className="pa-card" key={e.entry_id}>
              <h3>
                {clock(e.timestamp)} · {label(e.entry_method)}
              </h3>
              <p>
                {e.quantity} @ {money(e.average_price)} · {label(e.client)}
              </p>
              <p>
                {label(e.sizing_method)} {pct(e.requested_pct)} requested ·{" "}
                {pct(e.analytics.effective_allocation_pct)} capital allocation ·{" "}
                {pct(e.analytics.effective_risk_pct)} initial risk
              </p>
              <p>
                Initial sizing stop {money(e.analytics.initial_stop)} · budget{" "}
                {money(e.analytics.requested_budget)}
                {e.analytics.budget_exceeded && " · budget exceeded"}
              </p>
              <p className={tint(e.net_pnl)}>
                Attributed {money(e.net_pnl)} · {e.open_quantity} remain open ·
                R {e.r_multiple?.toFixed(2) ?? "—"}
              </p>
            </section>
          ))}
          <button onClick={() => setShowChart((value) => !value)}>
            {showChart ? "Hide execution chart" : "Show execution chart"}
          </button>
          {showChart &&
            (() => {
              const trades: AnalysisTrade[] = (detail.executions || []).map(
                (row) => ({
                  ...row,
                  trade_id: row.execution_id || row.trade_id,
                  analysis_cycle_id: detail.cycle_id,
                  session_id: detail.session_id,
                  user_id: "",
                  symbol: detail.symbol,
                  instrument_type: detail.right ? "options" : "equity",
                  right: detail.right,
                  strike: detail.strike,
                  expiry: detail.expiry,
                }),
              );
              return (
                <section className="pa-card">
                  {detail.right && detail.strike && detail.expiry ? (
                    <OptionsChart
                      symbol={detail.symbol}
                      date={detail.date}
                      strike={detail.strike}
                      expiry={detail.expiry}
                      right={detail.right}
                      trades={trades}
                      historicalDays={0}
                    />
                  ) : (
                    <AnalysisChart
                      symbol={detail.symbol}
                      date={detail.date}
                      trades={trades}
                      historicalDays={0}
                    />
                  )}
                </section>
              );
            })()}
          <h3>FIFO matched portions</h3>
          {detail.matches.map((m, i) => (
            <section className="pa-card" key={i}>
              <p>
                {clock(m.entry_time)} → {clock(m.exit_time)} · {m.quantity}{" "}
                units
                <br />
                {label(m.entry_method)} → {label(m.exit_method)}{" "}
                {m.requested_size ?? ""}
              </p>
              <p>
                {money(m.entry_price)} → {money(m.exit_price)} · fees{" "}
                {money(m.fees)}
              </p>
              <strong className={tint(m.net_pnl)}>{money(m.net_pnl)}</strong> ·
              R {m.r_multiple?.toFixed(2) ?? "—"}
              {m.excursion && (
                <p>
                  {m.excursion.status === "unavailable" ? (
                    m.excursion.reason
                  ) : (
                    <>
                      Sampled MFE {money(m.excursion.mfe)} · MAE{" "}
                      {money(m.excursion.mae)}
                      <br />
                      Giveback {money(m.excursion.giveback)} · capture{" "}
                      {pct(m.excursion.capture_pct)}
                    </>
                  )}
                </p>
              )}
            </section>
          ))}
          <button
            disabled={detailBusy}
            onClick={() => void showDetail(detail, true)}
          >
            {detailBusy ? "Reading detail…" : "Analyze cached price path"}
          </button>
          {detail.excursion && (
            <p>
              {detail.excursion.status === "unavailable" ? (
                detail.excursion.reason
              ) : (
                <>
                  Cycle sampled MFE {money(detail.excursion.mfe)} · MAE{" "}
                  {money(detail.excursion.mae)} · giveback{" "}
                  {money(detail.excursion.giveback)}
                </>
              )}
            </p>
          )}
          {detailError && (
            <p role="alert" className="pa-error">
              {detailError}
            </p>
          )}
          <p className="pa-footnote">
            Price-path analysis uses available exact-contract caches. Boundary
            bars and missing observations are excluded. Sampled peaks are not
            guaranteed executable prices.
          </p>
        </aside>
      )}
    </div>
  );
}
