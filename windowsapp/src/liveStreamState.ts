import type { Candle } from './contracts'

export interface LiveTileState { tile_id: string; availability: string; reason?: string; candles?: Candle[]; current_date_seconds?: Candle[]; latest_tick?: Candle; instrument?: Record<string, unknown>; interval_minutes?: number }
export interface FeedStatus { selected_provider: string; actual_provider: string | null; connection: string; generation: number; reason?: string | null }
export interface LiveSnapshot { feed?: FeedStatus | null; stream_id: string; event_id: number; tiles: LiveTileState[] }
export interface LiveStreamEvent { version: number; stream_id: string; generation?: number; event_id: number; timestamp: number; type: string; tile_id: string; payload: unknown }

export const sameLiveTileConfiguration = (left: Pick<LiveTileState, 'instrument' | 'interval_minutes'>, right: Pick<LiveTileState, 'instrument' | 'interval_minutes'>): boolean => {
  if (left.interval_minutes !== right.interval_minutes || !left.instrument || !right.instrument) return false
  const keys = Object.keys(left.instrument)
  return keys.length === Object.keys(right.instrument).length && keys.every(key => left.instrument![key] === right.instrument![key])
}

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
  if (payload.type === 'feed_status' && current?.stream_id === payload.stream_id && payload.event_id > current.event_id) return { ...current, feed: payload.payload as FeedStatus, event_id: payload.event_id }
  if (payload.type !== 'candle' || !isCandle(payload.payload)) return current
  if (!current || current.stream_id !== payload.stream_id || current.event_id >= payload.event_id) return current
  return {
    ...current,
    event_id: payload.event_id,
    tiles: current.tiles.map(tile => tile.tile_id === payload.tile_id ? { ...tile, latest_tick: payload.payload as Candle, availability: 'available', reason: undefined } : tile),
  }
}

/** Keep the HTTP history baseline, then replay observations received in flight. */
export class LiveEventJournal {
  private events: LiveStreamEvent[] = []
  record(payload: unknown): void {
    if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'batch') {
      for (const event of (payload as { events?: unknown[] }).events ?? []) this.record(event)
    } else if (isLiveStreamEvent(payload) && payload.type !== 'snapshot') {
      if (!this.events.some(event => event.stream_id === payload.stream_id && event.event_id === payload.event_id)) this.events.push(payload)
      this.events.sort((a, b) => a.event_id - b.event_id)
      this.events = this.events.slice(-2048)
    }
  }
  reconcile(current: LiveSnapshot | null, baseline: LiveSnapshot): LiveSnapshot {
    let next = baseline
    for (const event of this.events) {
      if (event.stream_id === baseline.stream_id && event.event_id > baseline.event_id) next = applyLiveStreamPayloadToSnapshot(next, event) ?? next
    }
    if (current?.stream_id === baseline.stream_id && current.event_id > baseline.event_id && current.event_id >= next.event_id) {
      // Recover evicted observations without discarding the historical baseline.
      next = { ...next, event_id: current.event_id, feed: current.event_id > next.event_id ? current.feed ?? next.feed : next.feed ?? current.feed,
        tiles: next.tiles.map(tile => {
          const observed = current.tiles.find(item => item.tile_id === tile.tile_id && JSON.stringify(item.instrument) === JSON.stringify(tile.instrument))
          return observed ? { ...tile, latest_tick: observed.latest_tick && (!tile.latest_tick || observed.latest_tick.timestamp >= tile.latest_tick.timestamp) ? observed.latest_tick : tile.latest_tick, availability: current.event_id > next.event_id ? observed.availability : tile.availability, reason: current.event_id > next.event_id ? observed.reason : tile.reason } : tile
        }) }
    }
    return next
  }
}
