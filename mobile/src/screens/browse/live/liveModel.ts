import type { OHLCCandle } from '../../../../../frontend/src/services/api'
import type { Candle } from '../../../../../windowsapp/src/contracts'
import { aggregateLiveTileCandles } from '../../../../../windowsapp/src/liveCandles'
import type { LiveStreamEvent, LiveTileState } from '../../../../../windowsapp/src/liveStreamState'

/** The one tile of a Browse live stream. */
export const LIVE_TILE_ID = 'browse'

/** What the server subscribes the live feed to: the same instrument shapes the desktop sends. */
export type LiveInstrument =
  | { kind: string; exchange: string; symbol: string }
  | { kind: 'option'; exchange: string; underlying: string; expiry: string; strike: number; right: 'CE' | 'PE' }

export function spotInstrument(symbol: string, exchange: string | undefined, chartType: string | undefined): LiveInstrument {
  return { kind: chartType ?? 'equity', exchange: exchange ?? 'NSE', symbol }
}

export function optionInstrument(underlying: string, exchange: string | undefined, expiry: string, strike: number, right: 'CE' | 'PE'): LiveInstrument {
  return { kind: 'option', exchange: exchange ?? 'NSE', underlying, expiry, strike, right }
}

/** Today's date at the exchange (India), whatever time zone the phone is set to. Live data exists only for this day. */
export function marketDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export const toOhlc = (candles: Candle[]): OHLCCandle[] =>
  candles.map(candle => ({ time: candle.timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close, ...(candle.volume !== undefined ? { volume: candle.volume } : {}) }))

/**
 * The candles to draw: the server's history baseline for the tile with the received seconds folded in (the desktop's own
 * aggregation). While the baseline is for another interval (the interval was just changed) there is nothing to draw yet.
 */
export function liveCandles(tile: LiveTileState | undefined, ticks: Candle[], intervalMinutes: number): OHLCCandle[] {
  if (!tile || tile.interval_minutes !== intervalMinutes) return []
  return toOhlc(aggregateLiveTileCandles(tile.candles ?? [], ticks, intervalMinutes, tile.interval_minutes))
}

const isCandle = (value: unknown): value is Candle => {
  const candle = value as Candle
  return !!value && typeof candle.timestamp === 'number' && typeof candle.open === 'number' && typeof candle.high === 'number' && typeof candle.low === 'number' && typeof candle.close === 'number'
}

/** Every one-second candle for `tileId` in an event, including those inside a batch. */
export function ticksIn(payload: unknown, tileId: string): Candle[] {
  const event = payload as Partial<LiveStreamEvent> & { events?: unknown[] }
  if (!event || typeof event !== 'object') return []
  if (event.type === 'batch' && Array.isArray(event.events)) return event.events.flatMap(item => ticksIn(item, tileId))
  return event.type === 'candle' && event.tile_id === tileId && isCandle(event.payload) ? [event.payload] : []
}

export type LivePhase = 'off' | 'starting' | 'waiting' | 'live' | 'error'

/** One line for the status pill. */
export function describeTile(tile: LiveTileState | undefined, hasTick: boolean): { phase: LivePhase; message: string } {
  if (!tile) return { phase: 'starting', message: 'Starting live…' }
  if (tile.availability === 'available' || hasTick) return { phase: 'live', message: 'Live' }
  if (tile.availability === 'pending_subscription') return { phase: 'waiting', message: 'Connecting to the feed…' }
  if (tile.availability === 'provider_error') return { phase: 'error', message: tile.reason ? `Feed problem: ${tile.reason}` : 'The live feed has a problem. Retrying…' }
  if (tile.availability === 'unavailable') return { phase: 'error', message: tile.reason ?? 'Live data is not available for this instrument.' }
  return { phase: 'waiting', message: 'Waiting for the first tick…' }
}

/** Decodes server-sent events (partial chunks, CRLF, comment heartbeats) into JSON payloads. */
export class SseDecoder {
  private decoder = new TextDecoder()
  private buffer = ''
  constructor(private onEvent: (payload: unknown, id: number | undefined) => void, private onInvalid: () => void = () => undefined) {}

  push(bytes: Uint8Array): void {
    this.buffer = (this.buffer + this.decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n')
    for (let end = this.buffer.indexOf('\n\n'); end >= 0; end = this.buffer.indexOf('\n\n')) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const lines = frame.split('\n')
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue // a ": heartbeat" comment
      const idText = lines.find(line => line.startsWith('id:'))?.slice(3).trim()
      let payload: unknown
      try { payload = JSON.parse(data) } catch { this.onInvalid(); continue }
      this.onEvent(payload, idText && Number.isFinite(Number(idText)) ? Number(idText) : undefined)
    }
  }
}
