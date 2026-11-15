import { useEffect, useState } from "react";
import api, { type GuardRailSettings, type UserSettingsResponse } from "../services/api";
import { rendererAccountKey } from "../services/websiteChartPreferences";
import {
  CANDLE_ALERT_INTERVALS,
  type CandleAlertConfig,
} from "../../../shared/candleAlert";
import type { MaxSizeSettings } from "../../../shared/maxSizeAlert";
import {
  DEFAULT_MAX_LOSS_PCT,
  DEFAULT_MAX_WIN_PCT,
  type PnlDisplayMode,
} from "../../../shared/pnlMilestone";

/** How P&L is shown on the trading screen. Max loss is the GuardRails "Capital loss limit (%)". */
export interface PnlDisplaySettings {
  mode: PnlDisplayMode;
  maxWinPct: number;
  maxLossPct: number;
  /** Draw the live position's P&L above the current bar. */
  showBarLabel: boolean;
}

/** Per-user chart/alert preferences the trading screen reads outside the Settings modal. */
export interface TradingDisplaySettings {
  pnl: PnlDisplaySettings;
  pnlTargetLevels: string;
  candleAlert: CandleAlertConfig;
  /** Guardrail MAX SIZE, loaded here so the header alert works before Settings is ever opened. */
  maxSize: MaxSizeSettings;
}

const PNL_MODES: readonly string[] = ["currency", "percent", "milestones"];

/** First paint before the server answers: the older browser-only toggle still says percent or not. */
function legacyPnlMode(): PnlDisplayMode {
  try {
    return localStorage.getItem("pnlPctMode") === "true" ? "percent" : "currency";
  } catch {
    return "currency";
  }
}

export const DEFAULT_TRADING_DISPLAY: TradingDisplaySettings = {
  pnl: { mode: "currency", maxWinPct: DEFAULT_MAX_WIN_PCT, maxLossPct: DEFAULT_MAX_LOSS_PCT, showBarLabel: true },
  pnlTargetLevels: "",
  candleAlert: { enabled: false, intervalMin: 3, secondsBefore: 15 },
  maxSize: { enabled: false, alertEnabled: false, mode: "percentage", pct: 20, value: 0 },
};

type Incoming = Partial<UserSettingsResponse> & Partial<GuardRailSettings>;

const EVENT = "website-trading-display-settings";
const cacheKey = (owner: string) => `website-trading-display:${owner}`;
const pending = new Map<string, Promise<UserSettingsResponse>>();

function merge(
  base: TradingDisplaySettings,
  s: Incoming,
): TradingDisplaySettings {
  const interval = Number(s.candle_alert_interval_min ?? base.candleAlert.intervalMin);
  const seconds = Number(s.candle_alert_seconds_before ?? base.candleAlert.secondsBefore);
  const maxWin = Number(s.pnl_max_win_pct);
  const maxLoss = Number(s.guardrail_ban_capital_pct);
  return {
    pnl: {
      mode: PNL_MODES.includes(s.desktop_pnl_display_mode as string)
        ? (s.desktop_pnl_display_mode as PnlDisplayMode)
        : base.pnl.mode,
      maxWinPct: Number.isFinite(maxWin) && maxWin > 0 ? maxWin : base.pnl.maxWinPct,
      maxLossPct: Number.isFinite(maxLoss) && maxLoss > 0 ? maxLoss : base.pnl.maxLossPct,
      showBarLabel:
        typeof s.show_bar_pnl_label === "boolean" ? s.show_bar_pnl_label : base.pnl.showBarLabel,
    },
    pnlTargetLevels:
      typeof s.pnl_target_levels === "string"
        ? s.pnl_target_levels
        : base.pnlTargetLevels,
    candleAlert: {
      enabled:
        typeof s.candle_alert_enabled === "boolean"
          ? s.candle_alert_enabled
          : base.candleAlert.enabled,
      intervalMin: (CANDLE_ALERT_INTERVALS as readonly number[]).includes(interval)
        ? interval
        : base.candleAlert.intervalMin,
      secondsBefore:
        Number.isFinite(seconds) && seconds > 0
          ? seconds
          : base.candleAlert.secondsBefore,
    },
    maxSize: {
      enabled: s.guardrail_maxsize_enabled ?? base.maxSize.enabled,
      alertEnabled: s.guardrail_maxsize_alert_enabled ?? base.maxSize.alertEnabled,
      mode: s.guardrail_maxsize_mode ?? base.maxSize.mode,
      pct: s.guardrail_maxsize_pct ?? base.maxSize.pct,
      value: s.guardrail_maxsize_value ?? base.maxSize.value,
    },
  };
}

export function cachedTradingDisplaySettings(owner = rendererAccountKey()): TradingDisplaySettings {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey(owner)) ?? "null");
    if (raw && typeof raw === "object")
      return merge(DEFAULT_TRADING_DISPLAY, {
        desktop_pnl_display_mode: raw.pnl?.mode,
        pnl_max_win_pct: raw.pnl?.maxWinPct,
        guardrail_ban_capital_pct: raw.pnl?.maxLossPct,
        show_bar_pnl_label: raw.pnl?.showBarLabel,
        pnl_target_levels: raw.pnlTargetLevels,
        candle_alert_enabled: raw.candleAlert?.enabled,
        candle_alert_interval_min: raw.candleAlert?.intervalMin,
        candle_alert_seconds_before: raw.candleAlert?.secondsBefore,
        guardrail_maxsize_enabled: raw.maxSize?.enabled,
        guardrail_maxsize_alert_enabled: raw.maxSize?.alertEnabled,
        guardrail_maxsize_mode: raw.maxSize?.mode,
        guardrail_maxsize_pct: raw.maxSize?.pct,
        guardrail_maxsize_value: raw.maxSize?.value,
      });
  } catch {
    /* Server remains authoritative. */
  }
  return { ...DEFAULT_TRADING_DISPLAY, pnl: { ...DEFAULT_TRADING_DISPLAY.pnl, mode: legacyPnlMode() } };
}

function store(owner: string, value: TradingDisplaySettings) {
  try {
    localStorage.setItem(cacheKey(owner), JSON.stringify(value));
  } catch {
    /* Storage can be disabled. */
  }
}

/** Called by the Settings modal after the server accepted new values. */
export function publishTradingDisplaySettings(s: Incoming) {
  const owner = rendererAccountKey();
  const next = merge(cachedTradingDisplaySettings(owner), s);
  store(owner, next);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { owner, value: next } }));
}

export function useTradingDisplaySettings(): TradingDisplaySettings {
  const [value, setValue] = useState(() => cachedTradingDisplaySettings());
  useEffect(() => {
    let active = true;
    const owner = rendererAccountKey();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; value: TradingDisplaySettings }>).detail;
      if (active && detail.owner === owner) setValue(detail.value);
    };
    window.addEventListener(EVENT, changed);
    let request = pending.get(owner);
    if (!request) {
      request = api.getUserSettings();
      pending.set(owner, request);
      void request.finally(() => pending.delete(owner)).catch(() => undefined);
    }
    const apply = (settings: Incoming) => {
      if (!active || rendererAccountKey() !== owner) return;
      const next = merge(cachedTradingDisplaySettings(owner), settings);
      store(owner, next);
      setValue(next);
    };
    void request.then(apply).catch(() => undefined);
    void api.getGuardRailSettings().then(apply).catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener(EVENT, changed);
    };
  }, []);
  return value;
}
