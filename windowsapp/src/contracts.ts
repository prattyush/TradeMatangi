/** Renderer-neutral desktop API contracts. Timestamps are UTC-labelled IST wall-clock seconds. */
export type InstrumentKey =
  | { kind: 'equity' | 'index'; exchange: 'NSE' | 'BSE'; symbol: string }
  | { kind: 'option'; exchange: 'NSE' | 'BSE'; underlying: string; expiry: string; strike: number; right: 'CE' | 'PE' }

export interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume?: number }
export interface ChartSnapshot { instrument: InstrumentKey; interval: string; candles: Candle[]; generation: number; eventId: number }
export interface CandleUpdate { type: 'candle'; candle: Candle; generation: number; eventId: number }
export interface ConnectionUpdate { type: 'connection'; state: 'connected' | 'reconnecting' | 'offline' | 'authentication_required'; generation: number; eventId: number }
export type ChartEvent = CandleUpdate | ConnectionUpdate

export interface DrawingDefinition {
  id: string; instrument: InstrumentKey; tool: string; points: Array<{ timestamp: number; price: number }>
  style: Record<string, unknown>; visible: boolean; locked: boolean; groupId?: string; revision: number
}
export interface IndicatorDefinition { type: string; parameters: Record<string, number>; visible: boolean; pane: 'main' | 'separate'; order: number; styles: Record<string, unknown> }
export interface ViewportState { from?: number; to?: number; priceScale?: 'normal' | 'log' }
export interface BrowseState { mode: 'browse'; anchorDate: string; interval: string; viewport: ViewportState }
export interface RunState { mode: 'live' | 'replay' | 'stepwise' | 'stopped'; date: string; cursor: number; interval: string; paused: boolean; speed?: number; barIndex?: number }

export interface DesktopOrder {
  order_id: string; session_id: string; user_id: string; symbol: string
  side: 'BUY' | 'SELL'; order_type: 'TARGET' | 'LIMIT' | 'STOPLOSS'
  quantity: number; trigger_price: number; limit_price: number
  status: 'PENDING' | 'FILLED' | 'CANCELLED'; created_at: number
  filled_at?: number | null; filled_price?: number | null
  is_stoploss: boolean; right?: 'CE' | 'PE' | null; strike?: number | null; expiry?: string | null
  source?: string | null
  quote_price?: number | null; quote_timestamp?: number | null; quote_source?: string | null
}

export interface DesktopPosition {
  symbol: string; quantity: number; avg_entry_price: number
  side: 'LONG' | 'SHORT' | 'FLAT'; entry_commission: number
}

export interface DesktopTrade {
  [key: string]: unknown
  trade_id: string; symbol: string; side: 'BUY' | 'SELL'; quantity: number
  price: number; timestamp: number; right?: 'CE' | 'PE' | null
  strike?: number | null; expiry?: string | null; underlying_price?: number | null
}

export interface DesktopStrategy {
  strategy_id: string; strategy_type: string; symbol: string
  right: 'CE' | 'PE' | null; status: string; triggered: boolean
  price?: number | null; strike?: number | null; expiry?: string | null; contract_key?: string | null
}

export interface DesktopTradingSession {
  session_id: string; symbol: string; date: string; start_time: string
  speed: number; session_capital: number; instrument_type: 'equity' | 'options'
  strike: number | null; expiry: string | null; right: 'CE' | 'PE' | null
  strike_ce: number | null; strike_pe: number | null
  brokerage_per_order?: number; session_type: string
  state?: 'idle' | 'running' | 'paused' | 'ended' | null
  stepwise: boolean; total_bars: number | null
  group_id: string | null; wallet_ledger_id: string
  lot_size: number
}

export interface DesktopTradingSettings {
  desktop_hide_chart_labels: boolean
  desktop_order_size_mode: 'quantity' | 'funds_ratio' | 'risk_ratio'
  desktop_pnl_display_mode: 'currency' | 'percent'
  desktop_confirm_flatten: boolean
  context_menu_sl_mode: 'longOnly' | 'both'
  target_deviation_pct: number
  funds_ratio_l_pct: number; funds_ratio_m_pct: number; funds_ratio_h_pct: number
  risk_ratio_l_pct: number; risk_ratio_m_pct: number; risk_ratio_h_pct: number
  default_sl_pct: number
}

export interface DesktopTradingSnapshot {
  version: number
  desktop_mode?: 'stepwise' | 'replay' | string
  source?: 'desktop_stepwise' | 'desktop_replay' | string
  session: DesktopTradingSession
  current_time: number
  current_bar_index: number
  current_price: number; current_price_ce: number; current_price_pe: number
  contract_quotes: Record<string, { symbol: string; expiry: string; strike: number; right: 'CE' | 'PE'; contract_key: string; price: number; timestamp: number; source: string }>
  trades: DesktopTrade[]
  open_orders: DesktopOrder[]
  strategies: DesktopStrategy[]
  positions: { equity: DesktopPosition; CE: DesktopPosition; PE: DesktopPosition }
  contracts: Array<{ symbol: string; expiry: string; strike: number; right: 'CE' | 'PE'; contract_key: string }>
  positions_by_contract: Record<string, DesktopPosition>
  wallet_balance: number
  pnl: { equity: number; ce: number; pe: number; day: number; day_pct: number; contracts?: Record<string, number> }
  settings: DesktopTradingSettings
}
