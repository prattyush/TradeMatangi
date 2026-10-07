import type { AnalysisTrade, PatternAnnotation, TopPatterns } from './api'
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
  getMarkerText?: (trade: AnalysisTrade) => string
}

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
}

export type AnalysisChartPanelProps = {
  symbol: string
  date: string
  allTrades: AnalysisTrade[]
  isOptions: boolean
  historicalDays?: number
}

export type SnapshotChartProps = {
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

export type TradesChartProps = {symbol:string;date:string;trades:AnalysisTrade[];getMarkerText:(t:AnalysisTrade)=>string;strikeTabs:StrikeTab[];isOpt:boolean;onMax?:()=>void}

export type PatternChartProps = {symbol:string;date:string;annotations:PatternAnnotation[];topPatterns:TopPatterns;activeStrategy:string|null;activeCategory:string|null;instFilter:InstFilter;setInstFilter:(f:InstFilter)=>void;isOpt:boolean;patternStrike:{ce:number|null;pe:number|null;exp:string|null};onMax?:()=>void}
