export type PerformanceFilters = Record<string, string>;
export interface Metrics {
  mean_r?: number | null;
  r_count?: number;
  count: number;
  net_pnl: number;
  fees: number;
  wins: number;
  losses: number;
  breakeven: number;
  win_pct: number | null;
  expectancy: number | null;
  median_pnl: number | null;
  mean_pnl_pct: number | null;
  median_pnl_pct: number | null;
  profit_factor: number | null;
  quantity: number;
}
export interface Comparison extends Metrics {
  key: string;
  dimension?: string;
  exploratory?: boolean;
  days?: number;
  cycle_count?: number;
  realized_pnl?: number;
  associated?: Metrics;
  mean_interval?: number[] | null;
}
export interface Excursion {
  interval_seconds?: number
  status: string;
  reason?: string;
  mfe?: number;
  mae?: number;
  giveback?: number;
  capture_pct?: number | null;
  provider?: string;
  coverage?: number;
}
export interface AnalyticsMetadata {
  [key: string]: unknown
  version?: number
  capital?: number
  calculated_quantity?: number
  reference_price?: number
  initial_risk?: number
  lot_size?: number
  margin_rate?: number
  stop_source?: string
  entry_method?: string
  exit_method?: string
  action_id?: string
  exit_action_id?: string
  strategy_id?: string
  execution_type?: string
  controller_history?: Array<Record<string, unknown>>
  sizing_method?: string;
  requested_pct?: number;
  initial_stop?: number;
  requested_budget?: number;
  effective_allocation_pct?: number;
  effective_risk_pct?: number;
  budget_exceeded?: boolean;
  strategy_interval_seconds?: number;
  requested_size?: string;
}
export interface EntryPosition {
  entry_id: string;
  entry_method: string;
  client: string;
  timestamp: number;
  quantity: number;
  matched_quantity: number;
  open_quantity: number;
  average_price: number;
  net_pnl: number;
  pnl_pct: number | null;
  sizing_method: string;
  requested_pct: number | null;
  r_multiple: number | null;
  analytics: AnalyticsMetadata;
}
export interface MatchedPortion {
  gross_pnl?: number
  pnl_pct?: number | null
  capital?: number | null
  initial_risk?: number | null
  entry_execution_id?: string
  exit_execution_id?: string
  entry_id: string;
  exit_id: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  entry_time: number;
  exit_time: number;
  entry_method: string;
  exit_method: string;
  fees: number;
  net_pnl: number;
  r_multiple: number | null;
  excursion: Excursion | null;
  requested_size?: string;
}
export interface PerformanceCycle {
  shared?: boolean
  owner_email?: string | null
  user_id?: string
  cycle_id: string;
  session_id: string;
  symbol: string;
  right: string | null;
  strike: number | null;
  expiry: string | null;
  date: string;
  mode: string;
  direction: string;
  state: string;
  entry_time: number;
  exit_time: number | null;
  entry_count: number;
  exit_count: number;
  net_pnl: number;
  pnl_pct: number | null;
  fees: number;
  open_quantity: number;
  capital?: number
  exchange?: string
  product?: string
  exits?: Array<{ exit_id: string; exit_method: string; quantity: number; price: number; timestamp: number; analytics: AnalyticsMetadata }>
  executions: Array<{
    role?: 'entry' | 'exit'
    analytics?: AnalyticsMetadata
    order_id?: string
    kotak_order_id?: string
    execution_sort_time?: number
    trade_id: string;
    execution_id?: string;
    timestamp: number;
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    commission: number;
    underlying_price?: number;
  }>;
  entries: EntryPosition[];
  matches: MatchedPortion[];
  label: Record<string, string> | null;
  excursion?: Excursion;
  behavior?: { dimension: string; key: string }[];
}
export interface PerformanceReport {
  version: number;
  summary: Metrics & {
    realized_pnl: number;
    open_cycles: number;
    open_entry_fees: number;
    drawdown: number;
    days: number;
    mean_interval: number[] | null;
  };
  comparisons: Record<string, Comparison[]>;
  behavior: Comparison[];
  curve: { time: number; pnl: number; drawdown: number; cycle_id: string }[];
  daily: { date: string; net_pnl: number; fees: number; cycles: number }[];
  matrix: (Metrics & { entry: string; exit: string })[];
  distributions: {
    cycle_id: string;
    pnl: number;
    pnl_pct: number | null;
    date: string;
    mode: string;
  }[];
  coverage: {
    entries: number;
    known_entries: number;
    labeled_cycles: number;
    order_level_cycles: number;
  };
  insights: { text: string; dimension: string; key: string }[];
}
export function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}
export function cyclesCsv(cycles: PerformanceCycle[]): string {
  const fields: (keyof PerformanceCycle)[] = [
    "cycle_id",
    "date",
    "mode",
    "symbol",
    "right",
    "strike",
    "expiry",
    "direction",
    "state",
    "entry_count",
    "exit_count",
    "net_pnl",
    "pnl_pct",
    "fees",
    "open_quantity",
  ];
  return (
    "\uFEFF" +
    [
      fields.map(csvCell).join(","),
      ...cycles.map((c) => fields.map((f) => csvCell(c[f])).join(",")),
    ].join("\r\n")
  );
}
