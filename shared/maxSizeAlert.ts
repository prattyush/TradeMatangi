/**
 * Client-side mirror of backend guardrail_service._get_capital_in_use and the
 * MAX SIZE limit: equity intraday margin counts 20% of notional, option
 * positions count their full premium.
 */
export const EQUITY_MIS_MARGIN_RATE = 0.2;
export const MAXSIZE_ALERT_FRACTION = 0.5;

export interface SizedPosition {
  side: "LONG" | "SHORT" | "FLAT";
  quantity: number;
  avg_entry_price: number;
  /** True for CE/PE contracts, false for the underlying/equity position. */
  isOption: boolean;
}

export interface MaxSizeSettings {
  enabled: boolean;
  alertEnabled: boolean;
  mode: string;
  pct: number;
  value: number;
}

export function maxSizeCapitalInUse(
  positions: readonly SizedPosition[],
  instrumentType: string | null | undefined,
): number {
  let total = 0;
  for (const position of positions) {
    if (position.side === "FLAT" || !(position.quantity > 0) || !(position.avg_entry_price > 0)) continue;
    const rate = instrumentType === "equity" && !position.isOption ? EQUITY_MIS_MARGIN_RATE : 1;
    total += position.avg_entry_price * position.quantity * rate;
  }
  return total;
}

export function maxSizeLimit(settings: MaxSizeSettings, sessionCapital: number): number {
  return settings.mode === "percentage" ? (settings.pct / 100) * sessionCapital : settings.value;
}

/** True when MAX SIZE and its 50% alert are enabled and capital in use reached half the limit. */
export function maxSizeAlertActive(
  settings: MaxSizeSettings | null | undefined,
  positions: readonly SizedPosition[],
  sessionCapital: number,
  instrumentType: string | null | undefined,
): boolean {
  if (!settings?.enabled || !settings.alertEnabled) return false;
  const limit = maxSizeLimit(settings, sessionCapital);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return maxSizeCapitalInUse(positions, instrumentType) >= MAXSIZE_ALERT_FRACTION * limit;
}

/** Header colour: existing red states always win over the orange MAX SIZE alert. */
export function headerAlertColor(opts: {
  redAlert: boolean;
  banActive: boolean;
  maxSizeAlert: boolean;
}): "red" | "orange" | null {
  if (opts.redAlert) return "red";
  if (opts.banActive) return null; // BAN outranks MAX SIZE; no orange while banned.
  return opts.maxSizeAlert ? "orange" : null;
}
