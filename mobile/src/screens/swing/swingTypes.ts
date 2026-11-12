/** What the swing routes send (`/api/desktop/v1/swing/portfolios/*`), reduced to what the phone reads. */

export type SwingMode = 'paper' | 'real'
export type Broker = 'kite' | 'kotak'
export type Instrument = 'equity' | 'options' | 'futures'
export type Side = 'BUY' | 'SELL'
export type OrderKind = 'LIMIT' | 'TARGET' | 'STOPLOSS'

export interface Portfolio {
  session_id: string
  mode: SwingMode
  state: 'running' | 'closing' | 'stopped' | 'ended' | string
  entries_paused: boolean
  guardrail_ban?: boolean
  session_capital: number
  guardrail_epoch: number
  paper_broker?: Broker
  execution_broker?: Broker
  history_warning?: string
  loss_limit_pct?: number | null
}

export interface Position {
  session_id: string
  symbol: string
  instrument_type: Instrument
  side: 'LONG' | 'SHORT' | 'FLAT'
  quantity: number
  avg_entry_price: number
  right?: 'CE' | 'PE' | null
  strike?: number | null
  expiry?: string | null
  mark_price?: number | null
  mark_time?: number | null
  quote_status?: 'live' | 'stale' | 'unavailable'
  invested_value?: number
  unrealized_pnl?: number | null
  unrealized_pnl_pct?: number | null
  /** Futures only. */
  held_margin?: number
  notional_exposure?: number | null
}

export interface PendingOrder {
  order_id: string
  session_id: string
  symbol: string
  side: Side
  order_type: OrderKind
  quantity: number
  trigger_price: number
  limit_price: number
  status: string
  instrument_type: Instrument
  right?: 'CE' | 'PE' | null
  strike?: number | null
  expiry?: string | null
  tick_size?: number
  lot_size?: number
  execution_role?: 'entry' | 'exit' | null
  broker_filled_quantity?: number
  filled_quantity?: number
  swing_reconcile_pending?: boolean
}

export interface FundingStatus {
  state: string
  entries_allowed: boolean
  shortfall?: number
}

export interface Snapshot {
  portfolio: Portfolio | null
  wallet_balance?: number | null
  pnl?: number | null
  pnl_pct?: number | null
  valuation_status?: 'live' | 'stale' | 'unavailable'
  positions?: Position[]
  open_orders?: PendingOrder[]
  reconciliation_pending?: string[]
  funding_status?: FundingStatus | null
  restrictions_enabled?: boolean
  closure_blocked?: boolean
  current_submission_ids?: string[]
  undated_submission_ids?: string[]
  delivery_review_context_ids?: string[]
  contexts?: Array<{ session_id: string; symbol: string; instrument_type: Instrument }>
}

export interface ListedContract {
  expiry: string
  lot_size: number
  tick_size?: number
  right?: 'CE' | 'PE'
  strike?: number
  entry_eligible?: boolean
}

export interface ContractList {
  contracts: ListedContract[]
  /** Futures only: the server's switches. */
  execution_enabled?: boolean
  paper_enabled?: boolean
  real_enabled?: boolean
}

/** `order-preview` for capital-% sizing and for every futures order. */
export interface OrderPreview {
  quantity: number
  lot_size: number
  budget: number
  fees: number
  required_funds: number
  capital_revision: number
  unused_budget?: number
  minimum_funds?: number
  margin?: number
  fee_hash?: string
  execution_enabled?: boolean
  message?: string
}

export interface AmendPreview {
  margin?: number
  fees?: number
  required_funds: number
  existing_reservation?: number
  additional_funds?: number
  capital_revision: number
  fee_hash?: string
  order_fingerprint?: string
  message?: string
}

export interface Capabilities {
  real_trading_enabled: boolean
}

export interface BrokerStatus {
  broker: string
  authenticated: boolean
}

export interface ChartCandle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface ChartHistory { candles: ChartCandle[]; more?: boolean; before?: number | null; provider?: string; partial?: boolean }
