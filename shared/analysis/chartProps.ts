import type { AnalysisTrade, PatternAnnotation, TopPatterns } from './api'
import type { WhatIfMarker } from './whatif/whatIfModel'

/** What If on a chart (KLine only; other renderers ignore these): listen for a price pick and draw the edited legs. */
export type WhatIfChartProps = {
  pickMode?: boolean
  onPick?: (point: { time: number; price: number }) => void
  onPickCancel?: () => void
  pickHint?: string
  whatIfMarkers?: WhatIfMarker[]
}
export type InstFilter = 'underlying' | 'CE' | 'PE'
export interface StrikeTab { key: string; label: string; right: string; strike: number; expiry: string; trades: AnalysisTrade[] }

export type AnalysisChartProps = {
  symbol: string
  date: string
  trades: AnalysisTrade[]
  historicalDays?: number
  title?: string
  isMaximized?: boolean
  onMaximize?: () => void
  /** Marker text for an execution. `forOption` is true on an option-contract (CE / PE) chart of a KLine host that labels contracts (Label Trades), where the colour already says buy or sell. */
  getMarkerText?: (trade: AnalysisTrade, forOption?: boolean) => string
  /** Fill the parent's height instead of the width-derived default (Label Trades stacked panes). */
  fill?: boolean
  /** Epoch seconds (candle clock) to centre the chart on, e.g. the entry of the round trip being labeled. */
  focusTime?: number
  labelContractMarkers?: boolean
} & WhatIfChartProps

export type OptionsChartProps = {
  symbol: string
  date: string
  strike: number
  expiry: string
  right: string
  trades: AnalysisTrade[]
  historicalDays?: number
  isMaximized?: boolean
  onMaximize?: () => void
  getMarkerText?: (trade: AnalysisTrade, forOption?: boolean) => string
  fill?: boolean
  focusTime?: number
  labelContractMarkers?: boolean
} & WhatIfChartProps

export type AnalysisChartPanelProps = {
  symbol: string
  date: string
  allTrades: AnalysisTrade[]
  isOptions: boolean
  historicalDays?: number
}

export type SnapshotChartProps = {
  snapshotEventId?: string; snapshotEventTime?: number
  symbol: string; date: string
  sessionId?: string
  observationResolution?: number
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  position: { side: string; quantity: number; avg_entry_price: number; pnl: number; pnl_pct: number } | null
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}

export type SnapshotOptionsChartProps = {
  snapshotEventId?: string; snapshotEventTime?: number
  symbol: string; date: string
  sessionId?: string
  observationResolution?: number
  barTime: number
  barOhlc: { open: number; high: number; low: number; close: number } | null
  currentPrice: number
  openOrders: { side: string; order_type: string; trigger_price: number; limit_price: number; is_stoploss: boolean; right?: string; quantity: number }[]
  position?: {side:string;quantity:number;avg_entry_price:number} | null
  strike: number; expiry: string; right: string
  filledTrades: { trade_id: string; side: 'BUY' | 'SELL'; price: number; timestamp: number; right?: string; strike?: number; underlying_price?: number; quantity: number }[]
}

export type TradesChartProps = {symbol:string;date:string;trades:AnalysisTrade[];getMarkerText:(t:AnalysisTrade,forOption?:boolean)=>string;strikeTabs:StrikeTab[];isOpt:boolean;onMax?:()=>void}

export type PatternChartProps = {symbol:string;date:string;annotations:PatternAnnotation[];topPatterns:TopPatterns;activeStrategy:string|null;activeCategory:string|null;instFilter:InstFilter;setInstFilter:(f:InstFilter)=>void;isOpt:boolean;patternStrike:{ce:number|null;pe:number|null;exp:string|null};onMax?:()=>void}
