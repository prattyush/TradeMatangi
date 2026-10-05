import type { UserSettingsResponse } from './api'

const preferenceKeys = {
  brokerage_per_order: 'brokeragePerOrder',
  strategy_interval_secs: 'strategyIntervalSecs',
  autostop_trigger_type: 'autostopTriggerType',
  autostop_deviation_pct: 'autostopDeviationPct',
  breakeven_mode: 'breakevenMode',
  target_profit_buffer_ticks: 'targetProfitBufferTicks',
  aggr_sl_only_in_profit: 'aggrSlOnlyInProfit',
  auto_start_event_snapshots: 'autoStartEventSnapshots',
  trade_labeling_mode_by_type: 'tradeLabelingModeByType',
  trading_roc_ratio_mode: 'tradingRocRatioMode'
} as const

/** Read actual legacy values, not default-producing UI loaders. */
export function legacyBrowserSettings(
  storage: Pick<Storage, 'getItem'>
): Partial<UserSettingsResponse> {
  const values: Record<string, unknown> = {}
  for (const [field, key] of Object.entries(preferenceKeys)) {
    const raw = storage.getItem(key)
    if (raw === null || !raw.trim()) continue
    if (
      [
        'brokerage_per_order',
        'strategy_interval_secs',
        'autostop_deviation_pct',
        'target_profit_buffer_ticks'
      ].includes(field)
    ) {
      const value = Number(raw)
      const valid =
        Number.isFinite(value) &&
        (field === 'brokerage_per_order'
          ? value >= 0
          : field === 'strategy_interval_secs'
            ? [120, 180, 300].includes(value)
            : field === 'autostop_deviation_pct'
              ? value >= 0 && value <= 20
              : Number.isInteger(value) && value >= 1 && value <= 5)
      if (valid) values[field] = value
    } else if (
      ['aggr_sl_only_in_profit', 'auto_start_event_snapshots'].includes(field)
    ) {
      if (raw === 'true' || raw === 'false') values[field] = raw === 'true'
    } else if (field === 'trade_labeling_mode_by_type') {
      try {
        const parsed = JSON.parse(raw)
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.entries(parsed).every(
            ([kind, mode]) =>
              ['stepwise', 'sim', 'paper', 'real'].includes(kind) &&
              ['off', 'popup', 'button'].includes(String(mode))
          )
        )
          values[field] = parsed
      } catch {
        /* Invalid legacy values use backend defaults. */
      }
    } else if (
      (field === 'autostop_trigger_type' &&
        ['bar', 'deviation'].includes(raw)) ||
      (field === 'breakeven_mode' &&
        ['shift_sl', 'limit_order'].includes(raw)) ||
      (field === 'trading_roc_ratio_mode' &&
        ['normalized', 'raw'].includes(raw))
    )
      values[field] = raw
  }
  if (!values.trade_labeling_mode_by_type) {
    const old = storage.getItem('stepwiseLabelingPopupEnabled')
    if (old === 'true' || old === 'false')
      values.trade_labeling_mode_by_type = {
        stepwise: old === 'false' ? 'off' : 'popup',
        sim: 'button',
        paper: 'button',
        real: 'button'
      }
  }
  return values as Partial<UserSettingsResponse>
}

/** Compatibility cache for existing consumers; the server owns every value. */
export function cacheSharedSettings(
  settings: UserSettingsResponse,
  storage: Pick<Storage, 'setItem'>
): void {
  for (const [field, key] of Object.entries(preferenceKeys)) {
    const value = settings[field as keyof UserSettingsResponse]
    if (value !== undefined)
      storage.setItem(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      )
  }
  if (settings.trade_labeling_mode_by_type)
    storage.setItem(
      'stepwiseLabelingPopupEnabled',
      String(settings.trade_labeling_mode_by_type.stepwise !== 'off')
    )
}
