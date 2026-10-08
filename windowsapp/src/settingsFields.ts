export interface SettingsField {
  key: string
  label: string
  type: 'number' | 'boolean' | 'select' | 'text'
  min?: number
  max?: number
  step?: number
  scale?: number
  options?: readonly string[]
}
const number = (
  key: string,
  label: string,
  min: number,
  max?: number,
  step = 1,
  scale = 1
): SettingsField => ({ key, label, type: 'number', min, max, step, scale })
const select = (
  key: string,
  label: string,
  options: string[]
): SettingsField => ({ key, label, type: 'select', options })
const toggle = (key: string, label: string): SettingsField => ({
  key,
  label,
  type: 'boolean'
})
export const sharedSettingsSections: Record<string, SettingsField[]> = {
  General: [
    select('desktop_pnl_display_mode', 'P&L display', ['currency', 'percent']),
    number('historical_days', 'Historical days', 1, 5),
    select('trading_roc_ratio_mode', 'Indicator ratio display', [
      'normalized',
      'raw'
    ]),
    toggle('override_session_enabled', 'Override previous sessions'),
    select('max_price_mode', 'Options price selection', ['otm', 'threshold']),
    number('max_price_threshold_ce', 'CE maximum price (₹)', 1),
    number('max_price_threshold_pe', 'PE maximum price (₹)', 1)
  ],
  Trading: [
    toggle('kotak_automated_protection_enabled', 'Automatic Kotak SL placement and cancelled-exit recovery (off: manage SLs manually)'),
    select('desktop_order_size_mode', 'Order sizing', [
      'quantity',
      'funds_ratio',
      'risk_ratio'
    ]),
    ...(['l', 'm', 'h'] as const).flatMap((size) => [
      number(
        `funds_ratio_${size}_pct`,
        `Capital ${size.toUpperCase()} (%)`,
        0.1,
        100,
        0.1,
        100
      ),
      number(
        `risk_ratio_${size}_pct`,
        `Risk ${size.toUpperCase()} (%)`,
        0.01,
        100,
        0.01
      )
    ]),
    number('default_sl_pct', 'Default stoploss (%)', 1, 50, 1, 100),
    number(
      'target_deviation_pct',
      'Target / Market Limit Gap (%)',
      0,
      10,
      0.1,
      100
    ),
    number(
      'stoploss_limit_gap_pct',
      'Stoploss Trigger-to-Limit Gap (%)',
      0,
      10,
      0.1,
      100
    ),
    number(
      'brokerage_per_order',
      'Brokerage per order (₹)',
      0,
      undefined,
      0.01
    ),
    number(
      'entry_auto_sl_delay_sec',
      'Entry auto-stoploss delay (seconds)',
      1,
      30
    ),
    select('context_menu_sl_mode', 'Right-click SL direction', [
      'longOnly',
      'both'
    ])
  ],
  Analytics: [
    toggle('auto_start_event_snapshots', 'Automatically start event snapshots'),
    select('analysis_price_source', 'Trade analysis price source', [
      'options',
      'underlying'
    ]),
    toggle('experimental_patterns_enabled', 'Experimental pattern detection'),
    {
      key: 'pattern_share_emails',
      label: 'Pattern sharing emails (comma separated)',
      type: 'text'
    },
    {
      key: 'fine_structure_share_emails',
      label: 'Fine-structure sharing emails (comma separated)',
      type: 'text'
    }
  ],
  Strategies: [
    select('strategy_interval_secs', 'Strategy candle interval (seconds)', [
      '120',
      '180',
      '300'
    ]),
    select('autostop_trigger_type', 'AutoStop trigger', ['bar', 'deviation']),
    number(
      'autostop_deviation_pct',
      'AutoStop deviation from close (%)',
      0,
      20,
      0.1
    ),
    select('breakeven_mode', 'BreakEven action', ['shift_sl', 'limit_order']),
    number('target_profit_buffer_ticks', 'Target profit buffer ticks', 1, 5),
    toggle('aggr_sl_only_in_profit', 'Aggressive SL only in profit')
  ],
  'Desktop Options': [
    toggle('desktop_hide_chart_labels', 'Hide chart labels'),
    toggle('desktop_confirm_flatten', 'Confirm Flatten')
  ]
}
export function sectionSettings(
  section: string,
  draft: Record<string, unknown>
): Record<string, unknown> {
  const values = Object.fromEntries(
    (sharedSettingsSections[section] ?? []).map((field) => [
      field.key,
      draft[field.key]
    ])
  )
  if (section === 'Analytics')
    values.trade_labeling_mode_by_type = draft.trade_labeling_mode_by_type
  return values
}

/** Preferences map to strategy request fields; AutoStop deviation remains percentage points. */
export function strategySettingsPayload(
  settings: Record<string, unknown>
): Record<string, unknown> {
  return {
    autostop_trigger_type: settings.autostop_trigger_type,
    autostop_deviation_pct: settings.autostop_deviation_pct,
    breakeven_mode: settings.breakeven_mode,
    target_profit_buffer_ticks: settings.target_profit_buffer_ticks,
    only_in_profit: settings.aggr_sl_only_in_profit
  }
}

export function settingsWalletContext(
  mode: string,
  runDate: string,
  marketDate: string
) {
  const desktopMode = mode === 'Browse' ? 'paper' : mode.toLowerCase()
  const date = desktopMode === 'paper' ? marketDate : runDate
  return {
    desktopMode,
    date,
    label: `${desktopMode === 'paper' ? 'Paper' : mode} wallet — ${date}`
  }
}
