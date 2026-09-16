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
