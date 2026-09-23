import type { Candle } from './contracts'

export interface LiveTileState { tile_id: string; availability: string; reason?: string; candles?: Candle[]; current_date_seconds?: Candle[]; latest_tick?: Candle; instrument?: Record<string, unknown>; interval_minutes?: number }
export interface LiveSnapshot { stream_id: string; event_id: number; tiles: LiveTileState[] }
export interface LiveStreamEvent { version: number; stream_id: string; generation?: number; event_id: number; timestamp: number; type: string; tile_id: string; payload: unknown }

export const isLiveSnapshot = (value: unknown): value is LiveSnapshot =>
  Boolean(value && typeof value === 'object' && Array.isArray((value as LiveSnapshot).tiles) && typeof (value as LiveSnapshot).stream_id === 'string')

const isLiveStreamEvent = (value: unknown): value is LiveStreamEvent =>
  Boolean(value && typeof value === 'object' && typeof (value as LiveStreamEvent).type === 'string' && typeof (value as LiveStreamEvent).stream_id === 'string' && typeof (value as LiveStreamEvent).event_id === 'number')

const isCandle = (value: unknown): value is Candle => {
  const candle = value as Candle
  return Boolean(value && typeof value === 'object' && typeof candle.timestamp === 'number' && typeof candle.open === 'number' && typeof candle.high === 'number' && typeof candle.low === 'number' && typeof candle.close === 'number')
}

export const applyLiveStreamPayloadToSnapshot = (current: LiveSnapshot | null, payload: unknown): LiveSnapshot | null => {
  if (isLiveSnapshot(payload)) return payload
  if (payload && typeof payload === 'object' && (payload as { type?: unknown }).type === 'batch' && Array.isArray((payload as { events?: unknown[] }).events)) {
    return (payload as { events: unknown[] }).events.reduce<LiveSnapshot | null>(
      (snapshot, event) => applyLiveStreamPayloadToSnapshot(snapshot, event), current,
    )
  }
  if (!isLiveStreamEvent(payload)) return current
  if (payload.type === 'snapshot' && isLiveSnapshot(payload.payload)) return payload.payload
  if (payload.type !== 'candle' || !isCandle(payload.payload)) return current
  if (!current || current.stream_id !== payload.stream_id || current.event_id >= payload.event_id) return current
  return {
    ...current,
    event_id: payload.event_id,
    tiles: current.tiles.map(tile => tile.tile_id === payload.tile_id ? { ...tile, latest_tick: payload.payload as Candle, availability: 'available', reason: undefined } : tile),
  }
}
